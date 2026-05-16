package workspace

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const (
	RoleOwner     = "owner"
	RoleAdmin     = "admin"
	RoleMember    = "member"
	RoleModerator = "moderator"
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)

type Module struct {
	db     *postgres.Pool
	logger *slog.Logger
}

func NewModule(db *postgres.Pool, logger *slog.Logger) *Module {
	return &Module{db: db, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces", m.handleList)
	router.Protected("POST /api/v1/workspaces", m.handleCreate)
	router.Protected("GET /api/v1/workspaces/{workspaceId}", m.handleGet)
	router.Protected("GET /api/v1/workspaces/{workspaceId}/members", m.handleListMembers)
}

type workspaceView struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"ownerId"`
	Role      string    `json:"role,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type createRequest struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	rows, err := m.db.Query(r.Context(),
		`select w.id, w.slug, w.name, w.owner_user_id, w.created_at, m.role_code
		 from workspaces w
		 join workspace_members m on m.workspace_id = w.id and m.user_id = $1
		 order by w.created_at`,
		userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]workspaceView, 0)
	for rows.Next() {
		var v workspaceView
		var id, ownerID uuid.UUID
		if err := rows.Scan(&id, &v.Slug, &v.Name, &ownerID, &v.CreatedAt, &v.Role); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		v.ID = id.String()
		v.OwnerID = ownerID.String()
		items = append(items, v)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req createRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	req.Name = strings.TrimSpace(req.Name)
	if !slugPattern.MatchString(req.Slug) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "slug must match [a-z0-9-], length 3-64")
		return
	}
	if req.Name == "" || len(req.Name) > 128 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "name must be 1-128 chars")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	workspaceID := uuid.New()
	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into workspaces (id, slug, name, owner_user_id, created_at, updated_at)
		 values ($1, $2, $3, $4, $5, $5)`,
		workspaceID, req.Slug, req.Name, userID, now,
	)
	if err != nil {
		if strings.Contains(err.Error(), "SQLSTATE 23505") {
			sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "slug already taken")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create workspace")
		return
	}

	_, err = tx.Exec(r.Context(),
		`insert into workspace_members (workspace_id, user_id, role_code, joined_at)
		 values ($1, $2, $3, $4)`,
		workspaceID, userID, RoleOwner, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not add owner membership")
		return
	}

	defaultChannelID := uuid.New()
	_, err = tx.Exec(r.Context(),
		`insert into channels (id, workspace_id, kind, name, is_private, position, created_at, updated_at)
		 values ($1, $2, 'text', 'general', false, 0, $3, $3)`,
		defaultChannelID, workspaceID, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create default channel")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionWorkspaceCreated,
		TargetType:  "workspace",
		TargetID:    workspaceID.String(),
	})

	sharedhttp.WriteJSON(w, http.StatusCreated, workspaceView{
		ID:        workspaceID.String(),
		Slug:      req.Slug,
		Name:      req.Name,
		OwnerID:   userID.String(),
		Role:      RoleOwner,
		CreatedAt: now,
	})
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}

	var v workspaceView
	var id, ownerID uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select w.id, w.slug, w.name, w.owner_user_id, w.created_at, m.role_code
		 from workspaces w
		 join workspace_members m on m.workspace_id = w.id and m.user_id = $2
		 where w.id = $1`,
		workspaceID, userID,
	).Scan(&id, &v.Slug, &v.Name, &ownerID, &v.CreatedAt, &v.Role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	v.ID = id.String()
	v.OwnerID = ownerID.String()
	sharedhttp.WriteJSON(w, http.StatusOK, v)
}

type memberView struct {
	UserID      string    `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName,omitempty"`
	Role        string    `json:"role"`
	JoinedAt    time.Time `json:"joinedAt"`
}

func (m *Module) handleListMembers(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	if !IsMember(r.Context(), m.db, workspaceID, userID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select u.id, u.username, u.display_name, wm.role_code, wm.joined_at
		 from workspace_members wm
		 join users u on u.id = wm.user_id
		 where wm.workspace_id = $1
		 order by wm.joined_at`,
		workspaceID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]memberView, 0)
	for rows.Next() {
		var (
			id          uuid.UUID
			username    string
			displayName *string
			role        string
			joinedAt    time.Time
		)
		if err := rows.Scan(&id, &username, &displayName, &role, &joinedAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		view := memberView{UserID: id.String(), Username: username, Role: role, JoinedAt: joinedAt}
		if displayName != nil {
			view.DisplayName = *displayName
		}
		items = append(items, view)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// IsMember reports whether the user is a member of the workspace.
func IsMember(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID) bool {
	_, ok := RoleOf(ctx, db, workspaceID, userID)
	return ok
}

// RoleOf returns the membership role for a user in a workspace, if any.
func RoleOf(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID) (string, bool) {
	var role string
	err := db.QueryRow(ctx,
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	).Scan(&role)
	if err != nil {
		return "", false
	}
	return role, true
}

// CanModerate reports whether the role can manage workspace resources.
func CanModerate(role string) bool {
	return role == RoleOwner || role == RoleAdmin || role == RoleModerator
}

func parseUUIDParam(r *http.Request, name string) (uuid.UUID, bool) {
	raw := r.PathValue(name)
	if raw == "" {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
