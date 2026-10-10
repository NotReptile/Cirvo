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
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
)

// manageableRoles — роли воркспейса, на которые можно навешивать
// override'ы (Wave 5: включая кастомные). Owner преднамеренно исключён:
// AuthorizeChannel короткозамыкается на owner = allowed=true, поэтому
// override никак не повлиял бы. Лучше явно блокировать создание таких
// записей в API, чтобы UI не показывал бессмысленную колонку.
func manageableRoles(ctx context.Context, db *postgres.Pool, workspaceID uuid.UUID) []string {
	rows, err := db.Query(ctx,
		`select code from workspace_roles
		 where workspace_id = $1 and code <> 'owner'
		 order by position desc, name`,
		workspaceID,
	)
	if err != nil {
		return []string{"admin", "moderator", "member"} // fallback на seeded
	}
	defer rows.Close()
	out := make([]string, 0, 8)
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			continue
		}
		out = append(out, code)
	}
	if len(out) == 0 {
		return []string{"admin", "moderator", "member"}
	}
	return out
}

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
		Roles:     manageableRoles(r.Context(), m.db, scope.WorkspaceID),
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
	for _, code := range manageableRoles(r.Context(), m.db, scope.WorkspaceID) {
		validRoles[code] = struct{}{}
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
	permission.PublishChanged(r.Context(), m.publisher, scope.WorkspaceID)
	m.handleGetPermissions(w, r)
}

// ---- per-user overrides (Wave 5) --------------------------------------------

type userOverrideView struct {
	UserID  string   `json:"userId"`
	Granted []string `json:"granted"`
	Denied  []string `json:"denied"`
}

type userPermissionsView struct {
	ChannelID string             `json:"channelId"`
	Actions   []string           `json:"actions"`
	Overrides []userOverrideView `json:"overrides"`
}

type updateUserPermissionsRequest struct {
	Overrides []userOverrideView `json:"overrides"`
}

func (m *Module) handleGetUserPermissions(w http.ResponseWriter, r *http.Request) {
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
	if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.ChannelUpdate); !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage permissions")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select user_id, coalesce(granted_actions, '{}'), coalesce(denied_actions, '{}')
		 from channel_user_overrides where channel_id = $1`,
		channelID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	overrides := []userOverrideView{}
	for rows.Next() {
		var uid uuid.UUID
		var row userOverrideView
		if err := rows.Scan(&uid, &row.Granted, &row.Denied); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "scan failed")
			return
		}
		row.UserID = uid.String()
		overrides = append(overrides, row)
	}

	actions := make([]string, 0, len(permission.ChannelActions))
	for _, a := range permission.ChannelActions {
		actions = append(actions, string(a))
	}
	sharedhttp.WriteJSON(w, http.StatusOK, userPermissionsView{
		ChannelID: channelID.String(),
		Actions:   actions,
		Overrides: overrides,
	})
}

func (m *Module) handleUpdateUserPermissions(w http.ResponseWriter, r *http.Request) {
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
	if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.ChannelUpdate); !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage permissions")
		return
	}

	var req updateUserPermissionsRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}

	validActions := map[string]struct{}{}
	for _, a := range permission.ChannelActions {
		validActions[string(a)] = struct{}{}
	}
	type parsedOverride struct {
		userID  uuid.UUID
		granted []string
		denied  []string
	}
	parsed := make([]parsedOverride, 0, len(req.Overrides))
	for _, o := range req.Overrides {
		uid, err := uuid.Parse(o.UserID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id: "+o.UserID)
			return
		}
		for _, a := range append(append([]string{}, o.Granted...), o.Denied...) {
			if _, ok := validActions[a]; !ok {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown action: "+a)
				return
			}
		}
		// Цель должна быть участником воркспейса — override на чужака
		// бессмыслен и засоряет таблицу.
		var one int
		if err := m.db.QueryRow(r.Context(),
			`select 1 from workspace_members where workspace_id = $1 and user_id = $2`,
			scope.WorkspaceID, uid,
		).Scan(&one); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "user is not a workspace member: "+o.UserID)
			return
		}
		g := o.Granted
		if g == nil {
			g = []string{}
		}
		d := o.Denied
		if d == nil {
			d = []string{}
		}
		parsed = append(parsed, parsedOverride{userID: uid, granted: g, denied: d})
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Полная замена, как у role-overrides: всё стираем, пишем non-empty.
	if _, err := tx.Exec(r.Context(),
		`delete from channel_user_overrides where channel_id = $1`, channelID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reset overrides")
		return
	}
	now := time.Now().UTC()
	for _, o := range parsed {
		if len(o.granted) == 0 && len(o.denied) == 0 {
			continue
		}
		if _, err := tx.Exec(r.Context(),
			`insert into channel_user_overrides
			   (channel_id, user_id, granted_actions, denied_actions, updated_at, updated_by_user_id)
			 values ($1, $2, $3, $4, $5, $6)`,
			channelID, o.userID, o.granted, o.denied, now, userID,
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

	permission.PublishChanged(r.Context(), m.publisher, scope.WorkspaceID)
	m.handleGetUserPermissions(w, r)
}
