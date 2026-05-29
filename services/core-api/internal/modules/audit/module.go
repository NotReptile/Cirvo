package audit

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
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
	router.Protected("GET /api/v1/workspaces/{workspaceId}/audit/export", m.handleExport)
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
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.AuditRead)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
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

// I.12(a): server-side CSV-экспорт. Зачем отдельный endpoint, если есть
// /audit с limit=200: при большом workspace история не помещается в один
// фронтовый запрос, а пагинировать в браузере через несколько /audit-вызовов
// неудобно (cursor edge-cases, гонки). Здесь стримим одним SELECT'ом без
// LIMIT'а, бounded по from/to (фильтр обязателен для широких выгрузок).
// Action-код пишем сырой — стабильнее переводов на UI.
func (m *Module) handleExport(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.AuditRead)
	if !isMember {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	q := r.URL.Query()
	where := "where al.workspace_id = $1"
	args := []any{workspaceID}

	if v := strings.TrimSpace(q.Get("from")); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid from date")
			return
		}
		args = append(args, t)
		where += fmt.Sprintf(" and al.created_at >= $%d", len(args))
	}
	if v := strings.TrimSpace(q.Get("to")); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid to date")
			return
		}
		end := t.Add(24*time.Hour - time.Nanosecond)
		args = append(args, end)
		where += fmt.Sprintf(" and al.created_at <= $%d", len(args))
	}
	if v := strings.TrimSpace(q.Get("action")); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" and al.action_code = $%d", len(args))
	}
	if v := strings.TrimSpace(q.Get("targetType")); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" and al.target_type = $%d", len(args))
	}

	query := `select al.created_at, al.actor_user_id, al.action_code, al.target_type, al.target_id,
	                 coalesce(u.display_name, u.username, '')
	          from audit_log al
	          left join users u on u.id = al.actor_user_id
	          ` + where + `
	          order by al.created_at desc`

	rows, err := m.db.Query(r.Context(), query, args...)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	var slug string
	_ = m.db.QueryRow(r.Context(), "select coalesce(slug, '') from workspaces where id = $1", workspaceID).Scan(&slug)
	if slug == "" {
		slug = workspaceID.String()
	}
	filename := fmt.Sprintf("audit-%s-%s.csv", slug, time.Now().UTC().Format("2006-01-02"))

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	if _, err := w.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return
	}

	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"Дата (ISO)", "Автор", "Код действия", "Тип объекта", "ID объекта"}); err != nil {
		return
	}

	for rows.Next() {
		var (
			createdAt  time.Time
			actorID    *uuid.UUID
			actionCode string
			targetType string
			targetID   string
			actorName  string
		)
		if err := rows.Scan(&createdAt, &actorID, &actionCode, &targetType, &targetID, &actorName); err != nil {
			return
		}
		actor := "система"
		if actorID != nil {
			if actorName != "" {
				actor = actorName
			} else {
				actor = actorID.String()
			}
		}
		if err := cw.Write([]string{
			createdAt.UTC().Format(time.RFC3339Nano),
			actor,
			actionCode,
			targetType,
			targetID,
		}); err != nil {
			return
		}
	}
	cw.Flush()
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
