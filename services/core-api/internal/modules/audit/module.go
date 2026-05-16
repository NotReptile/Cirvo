package audit

import (
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const (
	defaultListLimit = 50
	maxListLimit     = 200
)

type Module struct {
	db *postgres.Pool
}

func NewModule(db *postgres.Pool) *Module {
	return &Module{db: db}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces/{workspaceId}/audit", m.handleList)
}

type entryView struct {
	ID          string    `json:"id"`
	ActorID     string    `json:"actorId,omitempty"`
	Action      string    `json:"action"`
	TargetType  string    `json:"targetType"`
	TargetID    string    `json:"targetId"`
	WorkspaceID string    `json:"workspaceId,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
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

	limit := defaultListLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid limit")
			return
		}
		if parsed > maxListLimit {
			parsed = maxListLimit
		}
		limit = parsed
	}

	var before time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid before cursor")
			return
		}
		before = parsed
	} else {
		before = time.Now().UTC().Add(time.Hour)
	}

	rows, err := m.db.Query(r.Context(),
		`select id, actor_user_id, workspace_id, action_code, target_type, target_id, created_at
		 from audit_log
		 where workspace_id = $1 and created_at < $2
		 order by created_at desc
		 limit $3`,
		workspaceID, before, limit,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]entryView, 0)
	for rows.Next() {
		var (
			id         uuid.UUID
			actorID    *uuid.UUID
			wsID       *uuid.UUID
			action     string
			targetType string
			targetID   string
			createdAt  time.Time
		)
		if err := rows.Scan(&id, &actorID, &wsID, &action, &targetType, &targetID, &createdAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		view := entryView{
			ID:         id.String(),
			Action:     action,
			TargetType: targetType,
			TargetID:   targetID,
			CreatedAt:  createdAt,
		}
		if actorID != nil {
			view.ActorID = actorID.String()
		}
		if wsID != nil {
			view.WorkspaceID = wsID.String()
		}
		items = append(items, view)
	}

	var nextCursor string
	if len(items) == limit {
		nextCursor = items[len(items)-1].CreatedAt.Format(time.RFC3339Nano)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"nextCursor": nextCursor,
	})
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
