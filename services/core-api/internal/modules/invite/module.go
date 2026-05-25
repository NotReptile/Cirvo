package invite

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/ratelimit"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/message"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/role"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

// Лимит на accept — per user. Защищает от перебора кодов приглашения и от
// абуза одной учёткой (массовое присоединение к воркспейсам).
var inviteAcceptRule = ratelimit.Rule{Capacity: 20, Window: time.Hour}

const (
	codeBytes      = 8 // 8 raw bytes -> 13-char base32 code
	defaultMaxUses = 0 // unlimited
	maxMaxUses     = 10000
)

var codeEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

type Module struct {
	db       *postgres.Pool
	limiter  *ratelimit.Limiter
	messages *message.Module
	logger   *slog.Logger
}

func NewModule(db *postgres.Pool, limiter *ratelimit.Limiter, messages *message.Module, logger *slog.Logger) *Module {
	return &Module{db: db, limiter: limiter, messages: messages, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	acceptLimited := ratelimit.Middleware(m.limiter, m.logger, "invite_accept", inviteAcceptRule, userIDKey)(m.handleAccept)
	router.Protected("POST /api/v1/workspaces/{workspaceId}/invites", m.handleCreate)
	router.Protected("GET /api/v1/workspaces/{workspaceId}/invites", m.handleList)
	router.Protected("DELETE /api/v1/invites/{inviteId}", m.handleRevoke)
	router.Protected("POST /api/v1/invites/{code}/accept", acceptLimited)
	router.Public("GET /api/v1/invites/{code}", m.handlePreview)
}

func userIDKey(r *http.Request) string {
	uid, ok := authctx.UserID(r.Context())
	if !ok {
		return ""
	}
	return uid.String()
}

type createRequest struct {
	MaxUses   int    `json:"maxUses"`
	ExpiresAt string `json:"expiresAt"`
}

type inviteView struct {
	ID          string     `json:"id"`
	WorkspaceID string     `json:"workspaceId"`
	Code        string     `json:"code"`
	MaxUses     int        `json:"maxUses"`
	UsedCount   int        `json:"usedCount"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	RevokedAt   *time.Time `json:"revokedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	CreatedBy   string     `json:"createdBy,omitempty"`
}

type previewView struct {
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName"`
	WorkspaceSlug string `json:"workspaceSlug"`
}

type acceptResponse struct {
	WorkspaceID string `json:"workspaceId"`
	Role        string `json:"role"`
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.InviteManage)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	var req createRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.MaxUses < 0 || req.MaxUses > maxMaxUses {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid maxUses")
		return
	}
	if req.MaxUses == 0 {
		req.MaxUses = defaultMaxUses
	}

	var expiresAt *time.Time
	if strings.TrimSpace(req.ExpiresAt) != "" {
		parsed, err := time.Parse(time.RFC3339, req.ExpiresAt)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid expiresAt")
			return
		}
		if parsed.Before(time.Now()) {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "expiresAt must be in the future")
			return
		}
		expiresAt = &parsed
	}

	code, err := generateCode()
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "code generation failed")
		return
	}

	id := uuid.New()
	now := time.Now().UTC()
	_, err = m.db.Exec(r.Context(),
		`insert into workspace_invites (id, workspace_id, code, max_uses, used_count, expires_at, created_by_user_id, created_at)
		 values ($1, $2, $3, $4, 0, $5, $6, $7)`,
		id, workspaceID, code, req.MaxUses, expiresAt, userID, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create invite")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionInviteCreated,
		TargetType:  "invite",
		TargetID:    id.String(),
	})

	sharedhttp.WriteJSON(w, http.StatusCreated, inviteView{
		ID:          id.String(),
		WorkspaceID: workspaceID.String(),
		Code:        code,
		MaxUses:     req.MaxUses,
		UsedCount:   0,
		ExpiresAt:   expiresAt,
		CreatedAt:   now,
		CreatedBy:   userID.String(),
	})
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.InviteManage)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select id, workspace_id, code, max_uses, used_count, expires_at, revoked_at, created_at, created_by_user_id
		 from workspace_invites
		 where workspace_id = $1
		 order by created_at desc`,
		workspaceID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]inviteView, 0)
	for rows.Next() {
		var (
			id, wsID  uuid.UUID
			code      string
			maxUses   int
			usedCount int
			expires   *time.Time
			revoked   *time.Time
			created   time.Time
			createdBy *uuid.UUID
		)
		if err := rows.Scan(&id, &wsID, &code, &maxUses, &usedCount, &expires, &revoked, &created, &createdBy); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		view := inviteView{
			ID:          id.String(),
			WorkspaceID: wsID.String(),
			Code:        code,
			MaxUses:     maxUses,
			UsedCount:   usedCount,
			ExpiresAt:   expires,
			RevokedAt:   revoked,
			CreatedAt:   created,
		}
		if createdBy != nil {
			view.CreatedBy = createdBy.String()
		}
		items = append(items, view)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (m *Module) handleRevoke(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	inviteID, ok := parseUUID(r, "inviteId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid invite id")
		return
	}

	var (
		workspaceID uuid.UUID
		revoked     *time.Time
	)
	err := m.db.QueryRow(r.Context(),
		`select workspace_id, revoked_at from workspace_invites where id = $1`,
		inviteID,
	).Scan(&workspaceID, &revoked)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "invite not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if _, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.InviteManage); !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}
	if revoked != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	_, err = m.db.Exec(r.Context(),
		`update workspace_invites set revoked_at = now() where id = $1`,
		inviteID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not revoke invite")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionInviteRevoked,
		TargetType:  "invite",
		TargetID:    inviteID.String(),
	})

	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handlePreview(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.PathValue("code"))
	if code == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid code")
		return
	}

	var (
		wsID uuid.UUID
		name string
		slug string
	)
	err := m.db.QueryRow(r.Context(),
		`select w.id, w.name, w.slug
		 from workspace_invites i
		 join workspaces w on w.id = i.workspace_id
		 where i.code = $1 and i.revoked_at is null`,
		code,
	).Scan(&wsID, &name, &slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "invite not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, previewView{
		WorkspaceID:   wsID.String(),
		WorkspaceName: name,
		WorkspaceSlug: slug,
	})
}

func (m *Module) handleAccept(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	code := strings.TrimSpace(r.PathValue("code"))
	if code == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid code")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		inviteID  uuid.UUID
		wsID      uuid.UUID
		maxUses   int
		usedCount int
		expires   *time.Time
		revoked   *time.Time
	)
	err = tx.QueryRow(r.Context(),
		`select id, workspace_id, max_uses, used_count, expires_at, revoked_at
		 from workspace_invites where code = $1 for update`,
		code,
	).Scan(&inviteID, &wsID, &maxUses, &usedCount, &expires, &revoked)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "invite not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if revoked != nil {
		sharedhttp.WriteError(w, r, http.StatusGone, sharedhttp.CodeConflict, "invite revoked")
		return
	}
	if expires != nil && time.Now().After(*expires) {
		sharedhttp.WriteError(w, r, http.StatusGone, sharedhttp.CodeConflict, "invite expired")
		return
	}
	if maxUses > 0 && usedCount >= maxUses {
		sharedhttp.WriteError(w, r, http.StatusGone, sharedhttp.CodeConflict, "invite exhausted")
		return
	}

	var existingRole string
	err = tx.QueryRow(r.Context(),
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		wsID, userID,
	).Scan(&existingRole)
	alreadyMember := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	now := time.Now().UTC()
	if !alreadyMember {
		_, err = tx.Exec(r.Context(),
			`insert into workspace_members (workspace_id, user_id, role_code, joined_at)
			 values ($1, $2, $3, $4)`,
			wsID, userID, workspace.RoleMember, now,
		)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not add member")
			return
		}
		if err := role.AssignSystemRole(r.Context(), tx, wsID, userID, role.CodeMember); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not assign member role")
			return
		}
		existingRole = workspace.RoleMember
	}

	_, err = tx.Exec(r.Context(),
		`update workspace_invites set used_count = used_count + 1 where id = $1`,
		inviteID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update invite")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	bgCtx := context.Background()
	auditlog.Record(bgCtx, m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: wsID,
		Action:      auditlog.ActionInviteUsed,
		TargetType:  "invite",
		TargetID:    inviteID.String(),
	})
	if !alreadyMember {
		auditlog.Record(bgCtx, m.db, m.logger, auditlog.Entry{
			ActorID:     userID,
			WorkspaceID: wsID,
			Action:      auditlog.ActionWorkspaceMemberAdded,
			TargetType:  "user",
			TargetID:    userID.String(),
		})
		// H.9: если у воркспейса задан welcome-канал — постим плашку
		// system_join. Только для НОВОГО члена (alreadyMember=false), чтобы
		// повторное использование инвайта тем же юзером не флудило канал.
		m.postWelcomeJoin(bgCtx, wsID, userID)
	}

	sharedhttp.WriteJSON(w, http.StatusOK, acceptResponse{
		WorkspaceID: wsID.String(),
		Role:        existingRole,
	})
}

// postWelcomeJoin читает workspaces.welcome_channel_id и, если он задан,
// постит system_join плашку через message.PostSystemMessage. Body — это
// fallback-текст для старых клиентов, не знающих про kind: «<displayName>
// присоединился к серверу».
//
// Ошибки на best-effort'е: лог + продолжаем, чтобы баги в чате не валили
// invite.accept (юзер уже в воркспейсе после commit).
func (m *Module) postWelcomeJoin(ctx context.Context, workspaceID, userID uuid.UUID) {
	if m.messages == nil {
		return
	}
	var welcomeID *uuid.UUID
	if err := m.db.QueryRow(ctx,
		`select welcome_channel_id from workspaces where id = $1`, workspaceID,
	).Scan(&welcomeID); err != nil || welcomeID == nil {
		return
	}
	// Канал мог стать voice или удалиться между настройкой и accept'ом —
	// проверяем kind в момент публикации. На delete cascade set null
	// welcome_channel_id уже обнулится; здесь страхуемся от ручной правки.
	var chKind string
	if err := m.db.QueryRow(ctx,
		`select kind from channels where id = $1`, *welcomeID,
	).Scan(&chKind); err != nil || chKind != "text" {
		return
	}
	var (
		displayName *string
		username    string
	)
	if err := m.db.QueryRow(ctx,
		`select display_name, username from users where id = $1`, userID,
	).Scan(&displayName, &username); err != nil {
		return
	}
	name := username
	if displayName != nil && strings.TrimSpace(*displayName) != "" {
		name = *displayName
	}
	body := name + " присоединился к серверу"
	if err := m.messages.PostSystemMessage(ctx, *welcomeID, workspaceID, userID, "system_join", body); err != nil {
		m.logger.Warn("welcome join post failed", "error", err, "workspaceId", workspaceID, "channelId", welcomeID)
	}
}

func generateCode() (string, error) {
	buf := make([]byte, codeBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToLower(codeEncoding.EncodeToString(buf)), nil
}

func parseUUID(r *http.Request, name string) (uuid.UUID, bool) {
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
