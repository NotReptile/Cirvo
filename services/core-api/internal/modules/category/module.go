// J.5: пользовательские категории каналов. CRUD по workspace-scope;
// permission — `permission.ChannelUpdate` (Discord-pattern: «Manage Channels»
// рулит и каналами и категориями). Привязка `channels.category_id` редактится
// через тот же PATCH /api/v1/channels/{id} (см. channel.handleUpdate).
package category

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
	"github.com/NotReptile/Cirvo/services/core-api/internal/auditlog"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/modules/permission"
	"github.com/NotReptile/Cirvo/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/Cirvo/services/core-api/internal/routing"
)

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, logger *slog.Logger) *Module {
	return &Module{db: db, publisher: publisher, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces/{workspaceId}/categories", m.handleList)
	router.Protected("POST /api/v1/workspaces/{workspaceId}/categories", m.handleCreate)
	router.Protected("PATCH /api/v1/categories/{categoryId}", m.handleUpdate)
	router.Protected("DELETE /api/v1/categories/{categoryId}", m.handleDelete)
	// Wave 5 (J.5b): role-override'ы категории, наследуются её каналами.
	router.Protected("GET /api/v1/categories/{categoryId}/permissions", m.handleGetPermissions)
	router.Protected("PUT /api/v1/categories/{categoryId}/permissions", m.handleUpdatePermissions)
}

type categoryView struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Position    int       `json:"position"`
	CreatedAt   time.Time `json:"createdAt"`
}

type createRequest struct {
	Name     string `json:"name"`
	Position *int   `json:"position"`
}

type updateRequest struct {
	Name     *string `json:"name"`
	Position *int    `json:"position"`
}

func (m *Module) publish(eventName string, workspaceID uuid.UUID, payload any) {
	if m.publisher == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = m.publisher.Publish(context.Background(), realtimebus.Event{
		Event:       eventName,
		WorkspaceID: workspaceID.String(),
		Payload:     raw,
	})
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
		`select id, workspace_id, name, position, created_at
		 from channel_categories
		 where workspace_id = $1
		 order by position, created_at`,
		workspaceID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]categoryView, 0)
	for rows.Next() {
		var v categoryView
		var id, wsID uuid.UUID
		if err := rows.Scan(&id, &wsID, &v.Name, &v.Position, &v.CreatedAt); err != nil {
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
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.ChannelUpdate)
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
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 64 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "name must be 1-64 chars")
		return
	}

	// Если position не задан — кладём в конец списка (max+1).
	var pos int
	if req.Position != nil {
		pos = *req.Position
	} else {
		_ = m.db.QueryRow(r.Context(),
			`select coalesce(max(position), -1) + 1 from channel_categories where workspace_id = $1`,
			workspaceID).Scan(&pos)
	}

	id := uuid.New()
	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`insert into channel_categories (id, workspace_id, name, position, created_at)
		 values ($1, $2, $3, $4, $5)`,
		id, workspaceID, req.Name, pos, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create category")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionCategoryCreated,
		TargetType:  "category",
		TargetID:    id.String(),
	})
	view := categoryView{
		ID:          id.String(),
		WorkspaceID: workspaceID.String(),
		Name:        req.Name,
		Position:    pos,
		CreatedAt:   now,
	}
	m.publish("category.created", workspaceID, view)
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}

func (m *Module) handleUpdate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	categoryID, ok := parseUUID(r, "categoryId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid category id")
		return
	}
	workspaceID, ok := m.resolveWorkspace(r.Context(), categoryID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "category not found")
		return
	}
	_, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.ChannelUpdate)
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}
	var req updateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" || len(trimmed) > 64 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "name must be 1-64 chars")
			return
		}
		req.Name = &trimmed
	}
	_, err := m.db.Exec(r.Context(),
		`update channel_categories set
		   name     = coalesce($2, name),
		   position = coalesce($3, position)
		 where id = $1`,
		categoryID, req.Name, req.Position,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update category")
		return
	}
	var v categoryView
	err = m.db.QueryRow(r.Context(),
		`select id, workspace_id, name, position, created_at
		 from channel_categories where id = $1`,
		categoryID,
	).Scan(&v.ID, &v.WorkspaceID, &v.Name, &v.Position, &v.CreatedAt)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload category")
		return
	}
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionCategoryUpdated,
		TargetType:  "category",
		TargetID:    categoryID.String(),
	})
	m.publish("category.updated", workspaceID, v)
	sharedhttp.WriteJSON(w, http.StatusOK, v)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	categoryID, ok := parseUUID(r, "categoryId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid category id")
		return
	}
	workspaceID, ok := m.resolveWorkspace(r.Context(), categoryID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "category not found")
		return
	}
	_, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.ChannelUpdate)
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}
	// `on delete set null` на channels.category_id — каналы остаются,
	// просто становятся беспривязочными.
	tag, err := m.db.Exec(r.Context(), `delete from channel_categories where id = $1`, categoryID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not delete category")
		return
	}
	if tag.RowsAffected() == 0 {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "category not found")
		return
	}
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionCategoryDeleted,
		TargetType:  "category",
		TargetID:    categoryID.String(),
	})
	m.publish("category.deleted", workspaceID, map[string]string{
		"categoryId":  categoryID.String(),
		"workspaceId": workspaceID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) resolveWorkspace(ctx context.Context, categoryID uuid.UUID) (uuid.UUID, bool) {
	var wsID uuid.UUID
	err := m.db.QueryRow(ctx,
		`select workspace_id from channel_categories where id = $1`, categoryID).Scan(&wsID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, false
		}
		return uuid.Nil, false
	}
	return wsID, true
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
