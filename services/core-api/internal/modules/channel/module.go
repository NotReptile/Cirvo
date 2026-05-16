package channel

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

type Module struct {
	db *postgres.Pool
}

func NewModule(db *postgres.Pool) *Module {
	return &Module{db: db}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces/{workspaceId}/channels", m.handleList)
	router.Protected("POST /api/v1/workspaces/{workspaceId}/channels", m.handleCreate)
	router.Protected("GET /api/v1/channels/{channelId}", m.handleGet)
	router.Protected("GET /api/v1/channels/{channelId}/members", m.handleListMembers)
	router.Protected("POST /api/v1/channels/{channelId}/members", m.handleAddMember)
	router.Protected("DELETE /api/v1/channels/{channelId}/members/{userId}", m.handleRemoveMember)
}

type channelView struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Kind        string    `json:"kind"`
	Name        string    `json:"name"`
	Topic       string    `json:"topic,omitempty"`
	IsPrivate   bool      `json:"isPrivate"`
	Position    int       `json:"position"`
	CreatedAt   time.Time `json:"createdAt"`
}

type createRequest struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Topic     string `json:"topic"`
	IsPrivate bool   `json:"isPrivate"`
}

type memberRequest struct {
	UserID string `json:"userId"`
}

type memberView struct {
	UserID      string    `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName,omitempty"`
	JoinedAt    time.Time `json:"joinedAt"`
}

var allowedKinds = map[string]struct{}{
	"text":   {},
	"voice":  {},
	"media":  {},
	"system": {},
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	if !workspace.IsMember(r.Context(), m.db, workspaceID, userID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select id, workspace_id, kind, name, coalesce(topic, ''), is_private, position, created_at
		 from channels
		 where workspace_id = $1
		   and (is_private = false
		        or exists (select 1 from channel_members cm where cm.channel_id = id and cm.user_id = $2))
		 order by position, created_at`,
		workspaceID, userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]channelView, 0)
	for rows.Next() {
		var v channelView
		var id, wsID uuid.UUID
		if err := rows.Scan(&id, &wsID, &v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		v.ID = id.String()
		v.WorkspaceID = wsID.String()
		items = append(items, v)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	role, ok := workspace.RoleOf(r.Context(), m.db, workspaceID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !workspace.CanModerate(role) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	var req createRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Kind = strings.ToLower(strings.TrimSpace(req.Kind))
	req.Name = strings.TrimSpace(req.Name)
	if req.Kind == "" {
		req.Kind = "text"
	}
	if _, ok := allowedKinds[req.Kind]; !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unsupported channel kind")
		return
	}
	if req.Name == "" || len(req.Name) > 64 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "name must be 1-64 chars")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	channelID := uuid.New()
	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into channels (id, workspace_id, kind, name, topic, is_private, position, created_at, updated_at)
		 values ($1, $2, $3, $4, nullif($5, ''), $6, 0, $7, $7)`,
		channelID, workspaceID, req.Kind, req.Name, req.Topic, req.IsPrivate, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create channel")
		return
	}

	if req.IsPrivate {
		_, err = tx.Exec(r.Context(),
			`insert into channel_members (channel_id, user_id, joined_at) values ($1, $2, $3)`,
			channelID, userID, now,
		)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not seed channel members")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	sharedhttp.WriteJSON(w, http.StatusCreated, channelView{
		ID:          channelID.String(),
		WorkspaceID: workspaceID.String(),
		Kind:        req.Kind,
		Name:        req.Name,
		Topic:       req.Topic,
		IsPrivate:   req.IsPrivate,
		Position:    0,
		CreatedAt:   now,
	})
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	scope, ok := Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	var v channelView
	err := m.db.QueryRow(r.Context(),
		`select kind, name, coalesce(topic, ''), is_private, position, created_at
		 from channels where id = $1`,
		channelID,
	).Scan(&v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	v.ID = channelID.String()
	v.WorkspaceID = scope.WorkspaceID.String()
	sharedhttp.WriteJSON(w, http.StatusOK, v)
}

func (m *Module) handleListMembers(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	if _, ok := Resolve(r.Context(), m.db, channelID, userID); !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	rows, err := m.db.Query(r.Context(),
		`select u.id, u.username, u.display_name, cm.joined_at
		 from channel_members cm
		 join users u on u.id = cm.user_id
		 where cm.channel_id = $1
		 order by cm.joined_at`,
		channelID,
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
			joinedAt    time.Time
		)
		if err := rows.Scan(&id, &username, &displayName, &joinedAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		mv := memberView{UserID: id.String(), Username: username, JoinedAt: joinedAt}
		if displayName != nil {
			mv.DisplayName = *displayName
		}
		items = append(items, mv)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (m *Module) handleAddMember(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	scope, ok := Resolve(r.Context(), m.db, channelID, actorID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	role, ok := workspace.RoleOf(r.Context(), m.db, scope.WorkspaceID, actorID)
	if !ok || !workspace.CanModerate(role) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	var req memberRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	targetID, err := uuid.Parse(strings.TrimSpace(req.UserID))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	if !workspace.IsMember(r.Context(), m.db, scope.WorkspaceID, targetID) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "user is not a workspace member")
		return
	}

	now := time.Now().UTC()
	_, err = m.db.Exec(r.Context(),
		`insert into channel_members (channel_id, user_id, joined_at) values ($1, $2, $3)
		 on conflict do nothing`,
		channelID, targetID, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not add member")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	targetID, ok := parseUUID(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	scope, ok := Resolve(r.Context(), m.db, channelID, actorID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	if actorID != targetID {
		role, ok := workspace.RoleOf(r.Context(), m.db, scope.WorkspaceID, actorID)
		if !ok || !workspace.CanModerate(role) {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
			return
		}
	}
	_, err := m.db.Exec(r.Context(),
		`delete from channel_members where channel_id = $1 and user_id = $2`,
		channelID, targetID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove member")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
