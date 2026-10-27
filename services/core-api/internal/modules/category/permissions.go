// permissions.go — Wave 5 (J.5b). CRUD role-override'ов на уровне категории.
//
// Категорийные override'ы наследуются всеми каналами категории: слой между
// base_action_mask и channel_role_overrides (канальный перекрывает
// категорийный, см. permission.AuthorizeChannel). API зеркалит
// channel/permissions.go: PUT — полная замена, пустые grants+denies =
// удалить запись.
package category

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/auditlog"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/modules/permission"
)

type roleOverrideView struct {
	RoleCode string   `json:"roleCode"`
	Granted  []string `json:"granted"`
	Denied   []string `json:"denied"`
}

type permissionsView struct {
	CategoryID string             `json:"categoryId"`
	Actions    []string           `json:"actions"`
	Roles      []string           `json:"roles"`
	Overrides  []roleOverrideView `json:"overrides"`
}

type updatePermissionsRequest struct {
	Overrides []roleOverrideView `json:"overrides"`
}

// manageableRoles — все роли воркспейса кроме owner (он короткозамыкается
// в AuthorizeChannel, override бессмыслен). Включая кастомные.
func (m *Module) manageableRoles(r *http.Request, workspaceID uuid.UUID) []string {
	rows, err := m.db.Query(r.Context(),
		`select code from workspace_roles
		 where workspace_id = $1 and code <> 'owner'
		 order by position desc, name`,
		workspaceID,
	)
	if err != nil {
		return []string{"admin", "moderator", "member"}
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

func (m *Module) handleGetPermissions(w http.ResponseWriter, r *http.Request) {
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
	if _, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.ChannelUpdate); !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage permissions")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select wr.code, coalesce(caro.granted_actions, '{}'), coalesce(caro.denied_actions, '{}')
		 from category_role_overrides caro
		 join workspace_roles wr on wr.id = caro.role_id
		 where caro.category_id = $1`,
		categoryID,
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
		overrides = append(overrides, row)
	}

	actions := make([]string, 0, len(permission.ChannelActions))
	for _, a := range permission.ChannelActions {
		actions = append(actions, string(a))
	}
	sharedhttp.WriteJSON(w, http.StatusOK, permissionsView{
		CategoryID: categoryID.String(),
		Actions:    actions,
		Roles:      m.manageableRoles(r, workspaceID),
		Overrides:  overrides,
	})
}

func (m *Module) handleUpdatePermissions(w http.ResponseWriter, r *http.Request) {
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
	if _, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.ChannelUpdate); !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage permissions")
		return
	}

	var req updatePermissionsRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}

	validActions := map[string]struct{}{}
	for _, a := range permission.ChannelActions {
		validActions[string(a)] = struct{}{}
	}
	validRoles := map[string]struct{}{}
	for _, code := range m.manageableRoles(r, workspaceID) {
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

	if _, err := tx.Exec(r.Context(),
		`delete from category_role_overrides where category_id = $1`, categoryID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reset overrides")
		return
	}
	now := time.Now().UTC()
	for _, o := range req.Overrides {
		if len(o.Granted) == 0 && len(o.Denied) == 0 {
			continue
		}
		if o.Granted == nil {
			o.Granted = []string{}
		}
		if o.Denied == nil {
			o.Denied = []string{}
		}
		if _, err := tx.Exec(r.Context(),
			`insert into category_role_overrides
			   (category_id, role_id, granted_actions, denied_actions, updated_at, updated_by_user_id)
			 select $1, wr.id, $2, $3, $4, $5
			 from workspace_roles wr
			 where wr.workspace_id = $6 and wr.code = $7`,
			categoryID, o.Granted, o.Denied, now, userID, workspaceID, o.RoleCode,
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
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionCategoryUpdated,
		TargetType:  "category",
		TargetID:    categoryID.String(),
	})

	permission.PublishChanged(r.Context(), m.publisher, workspaceID)
	m.handleGetPermissions(w, r)
}
