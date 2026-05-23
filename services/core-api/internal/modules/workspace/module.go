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
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/role"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

const (
	RoleOwner     = "owner"
	RoleAdmin     = "admin"
	RoleMember    = "member"
	RoleModerator = "moderator"
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)

type Module struct {
	db       *postgres.Pool
	settings *serversettings.Provider
	logger   *slog.Logger
}

func NewModule(db *postgres.Pool, settings *serversettings.Provider, logger *slog.Logger) *Module {
	return &Module{db: db, settings: settings, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces", m.handleList)
	router.Protected("POST /api/v1/workspaces", m.handleCreate)
	router.Protected("GET /api/v1/workspaces/{workspaceId}", m.handleGet)
	router.Protected("PUT /api/v1/workspaces/{workspaceId}/avatar", m.handleUpdateAvatar)
	router.Protected("DELETE /api/v1/workspaces/{workspaceId}/avatar", m.handleRemoveAvatar)
	router.Protected("GET /api/v1/workspaces/{workspaceId}/members", m.handleListMembers)
	router.Protected("PATCH /api/v1/workspaces/{workspaceId}/members/{userId}", m.handleUpdateMember)
	router.Protected("DELETE /api/v1/workspaces/{workspaceId}/members/{userId}", m.handleRemoveMember)
}

type workspaceView struct {
	ID            string    `json:"id"`
	Slug          string    `json:"slug"`
	Name          string    `json:"name"`
	OwnerID       string    `json:"ownerId"`
	Role          string    `json:"role,omitempty"`
	AvatarMediaID string    `json:"avatarMediaId,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

type avatarRequest struct {
	MediaID string `json:"mediaId"`
}

type createRequest struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	rows, err := m.db.Query(r.Context(),
		`select w.id, w.slug, w.name, w.owner_user_id, w.created_at, m.role_code, w.avatar_media_id
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
		var avatarID *uuid.UUID
		if err := rows.Scan(&id, &v.Slug, &v.Name, &ownerID, &v.CreatedAt, &v.Role, &avatarID); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		v.ID = id.String()
		v.OwnerID = ownerID.String()
		if avatarID != nil {
			v.AvatarMediaID = avatarID.String()
		}
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

	// D.1: server-wide лимит на общее число воркспейсов.
	if m.settings != nil {
		snap := m.settings.Get(r.Context())
		if snap.MaxWorkspaces > 0 {
			var n int
			if err := m.db.QueryRow(r.Context(), `select count(*) from workspaces`).Scan(&n); err == nil && n >= snap.MaxWorkspaces {
				sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "workspace limit reached on this server")
				return
			}
		}
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

	if err := role.SeedDefaults(r.Context(), tx, workspaceID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not seed roles")
		return
	}
	if err := role.AssignSystemRole(r.Context(), tx, workspaceID, userID, role.CodeOwner); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not assign owner role")
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
	var avatarID *uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select w.id, w.slug, w.name, w.owner_user_id, w.created_at, m.role_code, w.avatar_media_id
		 from workspaces w
		 join workspace_members m on m.workspace_id = w.id and m.user_id = $2
		 where w.id = $1`,
		workspaceID, userID,
	).Scan(&id, &v.Slug, &v.Name, &ownerID, &v.CreatedAt, &v.Role, &avatarID)
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
	if avatarID != nil {
		v.AvatarMediaID = avatarID.String()
	}
	sharedhttp.WriteJSON(w, http.StatusOK, v)
}

// handleUpdateAvatar — H.2. Привязывает media-объект как иконку воркспейса.
// Семантика по аналогии с profile.handleUpdateAvatar: media должна
// принадлежать вызывающему (защита от привязки чужого upload'а), content-type
// — image/*. Через FK on delete set null retention.Sweep пропустит media
// как «прикреплённое».
func (m *Module) handleUpdateAvatar(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.WorkspaceUpdate)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "only owner or admin can change workspace icon")
		return
	}

	var req avatarRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	mediaID, err := uuid.Parse(strings.TrimSpace(req.MediaID))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid mediaId")
		return
	}

	var (
		contentType string
		ownerID     *uuid.UUID
	)
	err = m.db.QueryRow(r.Context(),
		`select content_type, uploaded_by_user_id from media_objects where id = $1`,
		mediaID,
	).Scan(&contentType, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if ownerID == nil || *ownerID != actorID {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "media does not belong to you")
		return
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "icon must be an image")
		return
	}

	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update workspaces set avatar_media_id = $1, updated_at = $2 where id = $3`,
		mediaID, now, workspaceID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update icon")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionWorkspaceUpdated,
		TargetType:  "workspace",
		TargetID:    workspaceID.String(),
	})

	m.writeWorkspaceView(w, r, workspaceID, actorID)
}

func (m *Module) handleRemoveAvatar(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.WorkspaceUpdate)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "only owner or admin can change workspace icon")
		return
	}

	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update workspaces set avatar_media_id = null, updated_at = $1 where id = $2`,
		now, workspaceID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove icon")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionWorkspaceUpdated,
		TargetType:  "workspace",
		TargetID:    workspaceID.String(),
	})

	m.writeWorkspaceView(w, r, workspaceID, actorID)
}

func (m *Module) writeWorkspaceView(w http.ResponseWriter, r *http.Request, workspaceID, userID uuid.UUID) {
	var v workspaceView
	var id, ownerID uuid.UUID
	var avatarID *uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select w.id, w.slug, w.name, w.owner_user_id, w.created_at, m.role_code, w.avatar_media_id
		 from workspaces w
		 join workspace_members m on m.workspace_id = w.id and m.user_id = $2
		 where w.id = $1`,
		workspaceID, userID,
	).Scan(&id, &v.Slug, &v.Name, &ownerID, &v.CreatedAt, &v.Role, &avatarID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload workspace")
		return
	}
	v.ID = id.String()
	v.OwnerID = ownerID.String()
	if avatarID != nil {
		v.AvatarMediaID = avatarID.String()
	}
	sharedhttp.WriteJSON(w, http.StatusOK, v)
}

type memberView struct {
	UserID        string    `json:"userId"`
	Username      string    `json:"username"`
	DisplayName   string    `json:"displayName,omitempty"`
	Role          string    `json:"role"`
	JoinedAt      time.Time `json:"joinedAt"`
	Online        bool      `json:"online"`
	AvatarMediaID string    `json:"avatarMediaId,omitempty"`
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

	// online — есть активная (не ревокированная) сессия с last_seen за
	// последние 5 минут. Порог 5 минут совпадает с realtime presence-TTL.
	rows, err := m.db.Query(r.Context(),
		`select u.id, u.username, u.display_name, wm.role_code, wm.joined_at,
		        exists (
		          select 1 from user_sessions s
		          where s.user_id = u.id
		            and s.revoked_at is null
		            and s.last_seen_at > now() - interval '5 minutes'
		        ) as online,
		        u.avatar_media_id
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
			online      bool
			avatarID    *uuid.UUID
		)
		if err := rows.Scan(&id, &username, &displayName, &role, &joinedAt, &online, &avatarID); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		view := memberView{UserID: id.String(), Username: username, Role: role, JoinedAt: joinedAt, Online: online}
		if displayName != nil {
			view.DisplayName = *displayName
		}
		if avatarID != nil {
			view.AvatarMediaID = avatarID.String()
		}
		items = append(items, view)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

type updateMemberRequest struct {
	Role string `json:"role"`
}

var assignableRoles = map[string]struct{}{
	RoleAdmin:     {},
	RoleModerator: {},
	RoleMember:    {},
}

func (m *Module) handleUpdateMember(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	targetID, ok := parseUUIDParam(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}

	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.MemberManageRole)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "only owner or admin can change roles")
		return
	}

	var req updateMemberRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Role = strings.ToLower(strings.TrimSpace(req.Role))
	if _, allowed := assignableRoles[req.Role]; !allowed {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "role must be admin, moderator or member")
		return
	}

	var targetRole string
	err := m.db.QueryRow(r.Context(),
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, targetID,
	).Scan(&targetRole)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "member not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if targetRole == RoleOwner {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "owner role cannot be changed")
		return
	}
	if targetID == actorID {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot change your own role")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`update workspace_members set role_code = $1 where workspace_id = $2 and user_id = $3`,
		req.Role, workspaceID, targetID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update role")
		return
	}
	if err := role.SyncPrimaryRole(r.Context(), tx, workspaceID, targetID, req.Role); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not sync role membership")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	targetID, ok := parseUUIDParam(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}

	if actorID == targetID {
		// self-leave is always allowed; just need membership to exist
		if !IsMember(r.Context(), m.db, workspaceID, actorID) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return
		}
	} else {
		_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.MemberKick)
		if !isMember {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return
		}
		if !allowed {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
			return
		}
	}

	var targetRole string
	err := m.db.QueryRow(r.Context(),
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, targetID,
	).Scan(&targetRole)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if targetRole == RoleOwner {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "owner cannot be removed")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := role.RemoveAllAssignments(r.Context(), tx, workspaceID, targetID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not strip roles")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`delete from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, targetID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove member")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
