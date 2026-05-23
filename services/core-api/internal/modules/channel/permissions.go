// permissions.go — D.4. CRUD per-channel override'ов прав ролей.
//
// GET /api/v1/channels/{id}/permissions — видимый канал + право
// ChannelManageMembers (workspace-уровень; per-channel override на эту
// проверку не накладываем — иначе owner потеряет доступ к настройке
// собственного канала).
//
// PUT принимает массив override'ов per role_code; пустые grants+denies =
// удалить запись (роль наследует базовые workspace-permissions).
package channel

import (
	"net/http"
	"time"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
)

// manageableRoles — на эти роли можно навешивать override'ы. Owner
// преднамеренно исключён: AuthorizeChannel короткозамыкается на owner =
// allowed=true, поэтому override никак не повлиял бы. Лучше явно
// блокировать создание таких записей в API, чтобы UI не показывал
// бессмысленную колонку.
var manageableRoles = []string{"admin", "moderator", "member"}

type roleOverrideView struct {
	RoleCode string   `json:"roleCode"`
	Granted  []string `json:"granted"`
	Denied   []string `json:"denied"`
}

type permissionsView struct {
	ChannelID string             `json:"channelId"`
	Actions   []string           `json:"actions"`   // список action-кодов для UI
	Roles     []string           `json:"roles"`     // manageable roles
	Overrides []roleOverrideView `json:"overrides"` // только те, где есть записи
}

type updatePermissionsRequest struct {
	Overrides []roleOverrideView `json:"overrides"`
}

func (m *Module) handleGetPermissions(w http.ResponseWriter, r *http.Request) {
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
	_, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.ChannelUpdate)
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage permissions")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select role_code, coalesce(granted_actions, '{}'), coalesce(denied_actions, '{}')
		 from channel_role_overrides where channel_id = $1`,
		channelID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	overrides := []roleOverrideView{}
	for rows.Next() {
		var row roleOverrideView
		if err := rows.Scan(&row.RoleCode, &row.Granted, &row.Denied); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "scan failed")
			return
		}
		if row.Granted == nil {
			row.Granted = []string{}
		}
		if row.Denied == nil {
			row.Denied = []string{}
		}
		overrides = append(overrides, row)
	}

	actions := make([]string, 0, len(permission.ChannelActions))
	for _, a := range permission.ChannelActions {
		actions = append(actions, string(a))
	}
	sharedhttp.WriteJSON(w, http.StatusOK, permissionsView{
		ChannelID: channelID.String(),
		Actions:   actions,
		Roles:     manageableRoles,
		Overrides: overrides,
	})
}

func (m *Module) handleUpdatePermissions(w http.ResponseWriter, r *http.Request) {
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
	_, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.ChannelUpdate)
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage permissions")
		return
	}

	var req updatePermissionsRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}

	// Валидация: action-коды должны быть из ChannelActions, role_code из manageableRoles.
	validActions := map[string]struct{}{}
	for _, a := range permission.ChannelActions {
		validActions[string(a)] = struct{}{}
	}
	validRoles := map[string]struct{}{}
	for _, r := range manageableRoles {
		validRoles[r] = struct{}{}
	}
	for _, o := range req.Overrides {
		if _, ok := validRoles[o.RoleCode]; !ok {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown role: "+o.RoleCode)
			return
		}
		for _, a := range o.Granted {
			if _, ok := validActions[a]; !ok {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown granted action: "+a)
				return
			}
		}
		for _, a := range o.Denied {
			if _, ok := validActions[a]; !ok {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown denied action: "+a)
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

	// Полная замена: всё стираем, потом upsert'им non-empty записи.
	if _, err := tx.Exec(r.Context(),
		`delete from channel_role_overrides where channel_id = $1`, channelID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reset overrides")
		return
	}
	now := time.Now().UTC()
	for _, o := range req.Overrides {
		if len(o.Granted) == 0 && len(o.Denied) == 0 {
			continue // нечего записывать — оставляем чистую запись отсутствующей
		}
		if o.Granted == nil {
			o.Granted = []string{}
		}
		if o.Denied == nil {
			o.Denied = []string{}
		}
		if _, err := tx.Exec(r.Context(),
			`insert into channel_role_overrides
			   (channel_id, role_code, role_id, granted_actions, denied_actions, updated_at, updated_by_user_id)
			 select $1, $2, wr.id, $3, $4, $5, $6
			 from workspace_roles wr
			 where wr.workspace_id = $7 and wr.code = $2`,
			channelID, o.RoleCode, o.Granted, o.Denied, now, userID, scope.WorkspaceID,
		); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not write override")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: scope.WorkspaceID,
		Action:      auditlog.ActionChannelPermissionsUpdated,
		TargetType:  "channel",
		TargetID:    channelID.String(),
	})

	// Перечитываем для ответа — пользователь видит результат сохранения.
	m.handleGetPermissions(w, r)
}
