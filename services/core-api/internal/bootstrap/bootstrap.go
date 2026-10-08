// Package bootstrap seeds the first owner user and default workspace when
// the database is empty. Runs once at process start; intended for fresh
// self-hosted installs.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/passwords"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/accountrules"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/role"
)

const (
	defaultWorkspaceSlug = "main"
	defaultWorkspaceName = "Главный сервер"
	defaultChannelName   = "general"

	roleOwner = "owner"
)

var slugRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])?$`)

// Config is read from env at startup.
type Config struct {
	Email         string
	Username      string
	Password      string
	DisplayName   string
	WorkspaceSlug string
	WorkspaceName string
}

func LoadFromEnv() Config {
	return Config{
		Email:         strings.ToLower(strings.TrimSpace(os.Getenv("RUCORD_BOOTSTRAP_EMAIL"))),
		Username:      strings.ToLower(strings.TrimSpace(os.Getenv("RUCORD_BOOTSTRAP_USERNAME"))),
		Password:      os.Getenv("RUCORD_BOOTSTRAP_PASSWORD"),
		DisplayName:   strings.TrimSpace(os.Getenv("RUCORD_BOOTSTRAP_DISPLAY_NAME")),
		WorkspaceSlug: strings.ToLower(strings.TrimSpace(os.Getenv("RUCORD_BOOTSTRAP_WORKSPACE_SLUG"))),
		WorkspaceName: strings.TrimSpace(os.Getenv("RUCORD_BOOTSTRAP_WORKSPACE_NAME")),
	}
}

// Run creates the first owner + default workspace if the users table is empty
// and a Config is provided. Idempotent: returns nil immediately if any user
// already exists. Returns nil with a warn log if the DB is empty but no
// bootstrap env is set - the operator can still register via /auth/register.
func Run(ctx context.Context, db *postgres.Pool, logger *slog.Logger, cfg Config) error {
	empty, err := isUsersTableEmpty(ctx, db)
	if err != nil {
		return fmt.Errorf("count users: %w", err)
	}
	if !empty {
		return nil
	}

	if !cfg.HasCredentials() {
		logger.Warn("users table is empty and RUCORD_BOOTSTRAP_* env is not set; first admin must self-register via /api/v1/auth/register")
		return nil
	}

	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid bootstrap config: %w", err)
	}
	cfg = cfg.applyDefaults()

	hash, err := passwords.Hash(cfg.Password)
	if err != nil {
		return fmt.Errorf("hash bootstrap password: %w", err)
	}

	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Re-check inside the transaction to close the race with another replica
	// also booting against the same empty DB.
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from users`).Scan(&n); err != nil {
		return fmt.Errorf("recount users: %w", err)
	}
	if n > 0 {
		return nil
	}

	now := time.Now().UTC()
	userID := uuid.New()
	workspaceID := uuid.New()
	channelID := uuid.New()

	if _, err := tx.Exec(ctx,
		`insert into users (id, email, username, display_name, password_hash, is_root, created_at, updated_at)
		 values ($1, $2, $3, nullif($4, ''), $5, true, $6, $6)`,
		userID, cfg.Email, cfg.Username, cfg.DisplayName, hash, now,
	); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`insert into workspaces (id, slug, name, owner_user_id, created_at, updated_at)
		 values ($1, $2, $3, $4, $5, $5)`,
		workspaceID, cfg.WorkspaceSlug, cfg.WorkspaceName, userID, now,
	); err != nil {
		return fmt.Errorf("insert workspace: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`insert into workspace_members (workspace_id, user_id, role_code, joined_at)
		 values ($1, $2, $3, $4)`,
		workspaceID, userID, roleOwner, now,
	); err != nil {
		return fmt.Errorf("insert membership: %w", err)
	}

	if err := role.SeedDefaults(ctx, tx, workspaceID); err != nil {
		return fmt.Errorf("seed roles: %w", err)
	}
	if err := role.AssignSystemRole(ctx, tx, workspaceID, userID, role.CodeOwner); err != nil {
		return fmt.Errorf("assign owner role: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`insert into channels (id, workspace_id, kind, name, is_private, position, created_at, updated_at)
		 values ($1, $2, 'text', $3, false, 0, $4, $4)`,
		channelID, workspaceID, defaultChannelName, now,
	); err != nil {
		return fmt.Errorf("insert default channel: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	logger.Info("bootstrap admin created",
		"email", cfg.Email,
		"username", cfg.Username,
		"workspace_slug", cfg.WorkspaceSlug,
	)
	return nil
}

func (c Config) HasCredentials() bool {
	return c.Email != "" && c.Username != "" && c.Password != ""
}

func (c Config) Validate() error {
	if accountrules.ValidateEmail(c.Email) != nil {
		return errors.New("RUCORD_BOOTSTRAP_EMAIL must be a valid email")
	}
	if accountrules.ValidateUsername(c.Username) != nil {
		return errors.New("RUCORD_BOOTSTRAP_USERNAME must be 3-32 chars of [a-z0-9_]")
	}
	if accountrules.ValidatePassword(c.Password) != nil {
		return errors.New("RUCORD_BOOTSTRAP_PASSWORD must be 8-72 bytes")
	}
	if c.WorkspaceSlug != "" && !slugRE.MatchString(c.WorkspaceSlug) {
		return errors.New("RUCORD_BOOTSTRAP_WORKSPACE_SLUG must match [a-z0-9-], length 3-64")
	}
	return nil
}

func (c Config) applyDefaults() Config {
	if c.WorkspaceSlug == "" {
		c.WorkspaceSlug = defaultWorkspaceSlug
	}
	if c.WorkspaceName == "" {
		c.WorkspaceName = defaultWorkspaceName
	}
	if c.DisplayName == "" {
		c.DisplayName = c.Username
	}
	return c
}

func isUsersTableEmpty(ctx context.Context, db *postgres.Pool) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var n int
	if err := db.QueryRow(ctx, `select count(*) from users`).Scan(&n); err != nil {
		return false, err
	}
	return n == 0, nil
}
