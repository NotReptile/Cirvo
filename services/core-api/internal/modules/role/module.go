// Package role — CRUD кастомных ролей воркспейса и их назначение
// участникам (workspace_roles + workspace_role_members).
//
// system-роли (owner/admin/moderator/member) защищены: code и system нельзя
// поменять, удалить нельзя; name/color/position/hoisted/base_action_mask
// редактируемы — это даёт админу подстроить семантику seeded ролей без
// миграции схемы.
package role

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

var codePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,30}[a-z0-9]$`)

type Module struct {
	db     *postgres.Pool
	logger *slog.Logger
}

func NewModule(db *postgres.Pool, logger *slog.Logger) *Module {
	return &Module{db: db, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces/{workspaceId}/roles", m.handleList)
	router.Protected("POST /api/v1/workspaces/{workspaceId}/roles", m.handleCreate)
	router.Protected("PATCH /api/v1/workspaces/{workspaceId}/roles/{roleId}", m.handleUpdate)
	router.Protected("DELETE /api/v1/workspaces/{workspaceId}/roles/{roleId}", m.handleDelete)
	router.Protected("POST /api/v1/workspaces/{workspaceId}/roles/{roleId}/members/{userId}", m.handleAssign)
	router.Protected("DELETE /api/v1/workspaces/{workspaceId}/roles/{roleId}/members/{userId}", m.handleUnassign)
}

type roleView struct {
	ID              string   `json:"id"`
	WorkspaceID     string   `json:"workspaceId"`
	Code            string   `json:"code"`
	Name            string   `json:"name"`
	Color           string   `json:"color,omitempty"`
	Position        int      `json:"position"`
	Hoisted         bool     `json:"hoisted"`
	BaseActionMask  []string `json:"baseActionMask"`
	System          bool     `json:"system"`
	MemberUserIDs   []string `json:"memberUserIds"`
}

type createRequest struct {
	Code           string   `json:"code"`
	Name           string   `json:"name"`
	Color          *string  `json:"color"`
	Position       *int     `json:"position"`
	Hoisted        *bool    `json:"hoisted"`
	BaseActionMask []string `json:"baseActionMask"`
}

type updateRequest struct {
	Name           *string  `json:"name"`
	Color          *string  `json:"color"`
	Position       *int     `json:"position"`
	Hoisted        *bool    `json:"hoisted"`
	BaseActionMask []string `json:"baseActionMask"`
	BaseActionMaskSet bool   `json:"-"`
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	if !isMember(r.Context(), m.db, workspaceID, userID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select wr.id, wr.code, wr.name, wr.color, wr.position, wr.hoisted, wr.base_action_mask, wr.system,
		        coalesce(array_agg(wrm.user_id) filter (where wrm.user_id is not null), '{}')
		 from workspace_roles wr
		 left join workspace_role_members wrm on wrm.role_id = wr.id
		 where wr.workspace_id = $1
		 group by wr.id
		 order by wr.position desc, wr.name`,
		workspaceID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]roleView, 0)
	for rows.Next() {
		v, err := scanRole(rows, workspaceID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, v)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	if _, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.WorkspaceUpdate); !allowed {
		if !isMember(r.Context(), m.db, workspaceID, actorID) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage roles")
		return
	}

	var req createRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Code = strings.ToLower(strings.TrimSpace(req.Code))
	req.Name = strings.TrimSpace(req.Name)
	if !codePattern.MatchString(req.Code) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "code must match [a-z0-9_-], length 3-32")
		return
	}
	if isReservedCode(req.Code) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "code is reserved for system role")
		return
	}
	if req.Name == "" || len(req.Name) > 64 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "name must be 1-64 chars")
		return
	}
	mask, ok := sanitizeActions(req.BaseActionMask)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown action in baseActionMask")
		return
	}
	color := normalizeColor(req.Color)
	pos := 0
	if req.Position != nil {
		pos = *req.Position
	}
	hoisted := false
	if req.Hoisted != nil {
		hoisted = *req.Hoisted
	}

	roleID := uuid.New()
	_, err := m.db.Exec(r.Context(),
		`insert into workspace_roles (id, workspace_id, code, name, color, position, hoisted, base_action_mask, system)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
		roleID, workspaceID, req.Code, req.Name, color, pos, hoisted, mask,
	)
	if err != nil {
		if strings.Contains(err.Error(), "SQLSTATE 23505") {
			sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "role code already exists in this workspace")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create role")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionRoleCreated,
		TargetType:  "role",
		TargetID:    roleID.String(),
	})

	view, err := m.loadOne(r.Context(), workspaceID, roleID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload role")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}

func (m *Module) handleUpdate(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	roleID, ok := parseUUID(r, "roleId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid role id")
		return
	}
	if _, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.WorkspaceUpdate); !allowed {
		if !isMember(r.Context(), m.db, workspaceID, actorID) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage roles")
		return
	}

	// Парсим в map[string]json.RawMessage чтобы отличить "не задано" от
	// null (например baseActionMask: null → очистить, baseActionMask
	// отсутствует → не трогать).
	body, ok := decodePatchBody(w, r)
	if !ok {
		return
	}
	var req updateRequest
	if raw, ok := body["name"]; ok {
		var s string
		if err := jsonUnmarshal(raw, &s); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid name")
			return
		}
		s = strings.TrimSpace(s)
		req.Name = &s
	}
	if raw, ok := body["color"]; ok {
		var s *string
		if err := jsonUnmarshal(raw, &s); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid color")
			return
		}
		req.Color = s
	}
	if raw, ok := body["position"]; ok {
		var i int
		if err := jsonUnmarshal(raw, &i); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid position")
			return
		}
		req.Position = &i
	}
	if raw, ok := body["hoisted"]; ok {
		var b bool
		if err := jsonUnmarshal(raw, &b); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid hoisted")
			return
		}
		req.Hoisted = &b
	}
	if raw, ok := body["baseActionMask"]; ok {
		var arr []string
		if err := jsonUnmarshal(raw, &arr); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid baseActionMask")
			return
		}
		mask, ok := sanitizeActions(arr)
		if !ok {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown action in baseActionMask")
			return
		}
		req.BaseActionMask = mask
		req.BaseActionMaskSet = true
	}

	// Coalesce-update: nil → не менять. Для system-роли code и system
	// фиксированы (мы их и не пишем), остальное редактируется.
	if req.Name != nil && (*req.Name == "" || len(*req.Name) > 64) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "name must be 1-64 chars")
		return
	}
	var colorArg any
	colorSet := false
	if req.Color != nil {
		colorArg = normalizeColor(req.Color)
		colorSet = true
	} else if _, present := body["color"]; present {
		// явный null → стереть
		colorArg = nil
		colorSet = true
	}

	tag, err := m.db.Exec(r.Context(),
		`update workspace_roles set
		    name = coalesce($3, name),
		    color = case when $4::bool then $5 else color end,
		    position = coalesce($6, position),
		    hoisted = coalesce($7, hoisted),
		    base_action_mask = case when $8::bool then $9 else base_action_mask end
		 where workspace_id = $1 and id = $2`,
		workspaceID, roleID, req.Name, colorSet, colorArg, req.Position, req.Hoisted, req.BaseActionMaskSet, req.BaseActionMask,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update role")
		return
	}
	if tag.RowsAffected() == 0 {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "role not found")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionRoleUpdated,
		TargetType:  "role",
		TargetID:    roleID.String(),
	})

	view, err := m.loadOne(r.Context(), workspaceID, roleID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload role")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	roleID, ok := parseUUID(r, "roleId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid role id")
		return
	}
	if _, _, allowed := permission.Authorize(r.Context(), m.db, workspaceID, actorID, permission.WorkspaceUpdate); !allowed {
		if !isMember(r.Context(), m.db, workspaceID, actorID) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage roles")
		return
	}

	var isSystem bool
	err := m.db.QueryRow(r.Context(),
		`select system from workspace_roles where workspace_id = $1 and id = $2`,
		workspaceID, roleID,
	).Scan(&isSystem)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "role not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if isSystem {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "system role cannot be deleted")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionRoleDeleted,
		TargetType:  "role",
		TargetID:    roleID.String(),
	})

	if _, err := m.db.Exec(r.Context(),
		`delete from workspace_roles where workspace_id = $1 and id = $2`,
		workspaceID, roleID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not delete role")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleAssign(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, roleID, targetID, ok := parseAssignParams(w, r)
	if !ok {
		return
	}
	if !m.canManageMember(r.Context(), w, r, workspaceID, actorID, targetID) {
		return
	}

	// Проверяем что роль принадлежит этому воркспейсу — иначе можно
	// прокинуть chuжую role_id в обход проверки.
	var roleSystem bool
	var roleCode string
	if err := m.db.QueryRow(r.Context(),
		`select system, code from workspace_roles where workspace_id = $1 and id = $2`,
		workspaceID, roleID,
	).Scan(&roleSystem, &roleCode); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "role not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	// Owner-роль не назначается напрямую — она наследуется при создании
	// воркспейса. Иначе двое owner'ов рассинхронизировали бы semantic короткого
	// замыкания в AuthorizeChannel.
	if roleSystem && roleCode == "owner" {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "owner role cannot be reassigned")
		return
	}

	if _, err := m.db.Exec(r.Context(),
		`insert into workspace_role_members (workspace_id, role_id, user_id)
		 values ($1, $2, $3) on conflict (role_id, user_id) do nothing`,
		workspaceID, roleID, targetID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not assign role")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionRoleAssigned,
		TargetType:  "role",
		TargetID:    roleID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleUnassign(w http.ResponseWriter, r *http.Request) {
	actorID := authctx.MustUserID(r.Context())
	workspaceID, roleID, targetID, ok := parseAssignParams(w, r)
	if !ok {
		return
	}
	if !m.canManageMember(r.Context(), w, r, workspaceID, actorID, targetID) {
		return
	}

	// Защита primary-role: workspace_members.role_code должно остаться
	// валидным, иначе legacy admin-PATCH через permission.Authorize вернёт
	// fallback. Запрещаем убирать роль, соответствующую primary role_code.
	var primaryCode string
	if err := m.db.QueryRow(r.Context(),
		`select wm.role_code from workspace_members wm where wm.workspace_id = $1 and wm.user_id = $2`,
		workspaceID, targetID,
	).Scan(&primaryCode); err == nil {
		var roleCode string
		_ = m.db.QueryRow(r.Context(),
			`select code from workspace_roles where workspace_id = $1 and id = $2`,
			workspaceID, roleID,
		).Scan(&roleCode)
		if roleCode == primaryCode {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "primary role cannot be unassigned; change it via PATCH /members/{userId} first")
			return
		}
	}

	if _, err := m.db.Exec(r.Context(),
		`delete from workspace_role_members where workspace_id = $1 and role_id = $2 and user_id = $3`,
		workspaceID, roleID, targetID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not unassign role")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionRoleUnassigned,
		TargetType:  "role",
		TargetID:    roleID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) loadOne(ctx context.Context, workspaceID, roleID uuid.UUID) (roleView, error) {
	rows, err := m.db.Query(ctx,
		`select wr.id, wr.code, wr.name, wr.color, wr.position, wr.hoisted, wr.base_action_mask, wr.system,
		        coalesce(array_agg(wrm.user_id) filter (where wrm.user_id is not null), '{}')
		 from workspace_roles wr
		 left join workspace_role_members wrm on wrm.role_id = wr.id
		 where wr.workspace_id = $1 and wr.id = $2
		 group by wr.id`,
		workspaceID, roleID,
	)
	if err != nil {
		return roleView{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return roleView{}, pgx.ErrNoRows
	}
	return scanRole(rows, workspaceID)
}

func scanRole(rows pgx.Rows, workspaceID uuid.UUID) (roleView, error) {
	var (
		id       uuid.UUID
		code     string
		name     string
		color    *string
		pos      int
		hoisted  bool
		mask     []string
		system   bool
		members  []uuid.UUID
	)
	if err := rows.Scan(&id, &code, &name, &color, &pos, &hoisted, &mask, &system, &members); err != nil {
		return roleView{}, err
	}
	v := roleView{
		ID:             id.String(),
		WorkspaceID:    workspaceID.String(),
		Code:           code,
		Name:           name,
		Position:       pos,
		Hoisted:        hoisted,
		BaseActionMask: mask,
		System:         system,
		MemberUserIDs:  []string{},
	}
	if color != nil {
		v.Color = *color
	}
	if v.BaseActionMask == nil {
		v.BaseActionMask = []string{}
	}
	for _, mid := range members {
		v.MemberUserIDs = append(v.MemberUserIDs, mid.String())
	}
	sort.Strings(v.MemberUserIDs)
	return v, nil
}

func parseAssignParams(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, uuid.UUID, bool) {
	workspaceID, ok := parseUUID(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return uuid.Nil, uuid.Nil, uuid.Nil, false
	}
	roleID, ok := parseUUID(r, "roleId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid role id")
		return uuid.Nil, uuid.Nil, uuid.Nil, false
	}
	userID, ok := parseUUID(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return uuid.Nil, uuid.Nil, uuid.Nil, false
	}
	return workspaceID, roleID, userID, true
}

func (m *Module) canManageMember(ctx context.Context, w http.ResponseWriter, r *http.Request, workspaceID, actorID, targetID uuid.UUID) bool {
	if _, _, allowed := permission.Authorize(ctx, m.db, workspaceID, actorID, permission.MemberManageRole); !allowed {
		if !isMember(ctx, m.db, workspaceID, actorID) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
			return false
		}
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "cannot manage member roles")
		return false
	}
	if !isMember(ctx, m.db, workspaceID, targetID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "target user not in workspace")
		return false
	}
	_ = time.Now // keep import
	return true
}

func isMember(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID) bool {
	var one int
	err := db.QueryRow(ctx,
		`select 1 from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	).Scan(&one)
	return err == nil
}

func isReservedCode(code string) bool {
	switch code {
	case CodeOwner, CodeAdmin, CodeModerator, CodeMember:
		return true
	}
	return false
}

func sanitizeActions(in []string) ([]string, bool) {
	known := map[string]struct{}{}
	for _, a := range permission.AllActions {
		known[string(a)] = struct{}{}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, a := range in {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if _, ok := known[a]; !ok {
			return nil, false
		}
		if _, dup := seen[a]; dup {
			continue
		}
		seen[a] = struct{}{}
		out = append(out, a)
	}
	return out, true
}

var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func normalizeColor(in *string) *string {
	if in == nil {
		return nil
	}
	s := strings.TrimSpace(*in)
	if s == "" {
		return nil
	}
	if !colorPattern.MatchString(s) {
		// невалидный цвет → сбрасываем в nil; UI всё равно потом отрисует
		// дефолт. Жёсткий 400 на цвете кажется излишним для self-host.
		return nil
	}
	low := strings.ToLower(s)
	return &low
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
