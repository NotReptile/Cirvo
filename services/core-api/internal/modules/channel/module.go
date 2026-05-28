package channel

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

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

// SystemMessagePoster — узкий интерфейс для постинга system-плашек
// (channel created/renamed/deleted и т.п.). Объявлен здесь, чтобы избежать
// import-цикла channel ↔ message — реализация в message.Module.
type SystemMessagePoster interface {
	PostSystemMessage(ctx context.Context, channelID, workspaceID, authorUserID uuid.UUID, kind, body string) error
}

type Module struct {
	db        *postgres.Pool
	settings  *serversettings.Provider
	publisher *realtimebus.Publisher
	messages  SystemMessagePoster
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, settings *serversettings.Provider, messages SystemMessagePoster, logger *slog.Logger) *Module {
	return &Module{db: db, settings: settings, publisher: publisher, messages: messages, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/workspaces/{workspaceId}/channels", m.handleList)
	router.Protected("POST /api/v1/workspaces/{workspaceId}/channels", m.handleCreate)
	router.Protected("GET /api/v1/channels/{channelId}", m.handleGet)
	router.Protected("PATCH /api/v1/channels/{channelId}", m.handleUpdate)
	router.Protected("DELETE /api/v1/channels/{channelId}", m.handleDelete)
	router.Protected("GET /api/v1/channels/{channelId}/members", m.handleListMembers)
	router.Protected("POST /api/v1/channels/{channelId}/members", m.handleAddMember)
	router.Protected("DELETE /api/v1/channels/{channelId}/members/{userId}", m.handleRemoveMember)
	router.Protected("GET /api/v1/channels/{channelId}/permissions", m.handleGetPermissions)
	router.Protected("PUT /api/v1/channels/{channelId}/permissions", m.handleUpdatePermissions)
}

// publish — фан-аут в workspace, channelID опционально (для delete/update
// шлём, чтобы клиенты могли сразу заматчить локальный state по id).
func (m *Module) publish(eventName string, workspaceID uuid.UUID, channelID string, payload any) {
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
		ChannelID:   channelID,
		Payload:     raw,
	})
}

type channelView struct {
	ID              string    `json:"id"`
	WorkspaceID     string    `json:"workspaceId"`
	Kind            string    `json:"kind"`
	Name            string    `json:"name"`
	Topic           string    `json:"topic,omitempty"`
	IsPrivate       bool      `json:"isPrivate"`
	Position        int       `json:"position"`
	CreatedAt       time.Time `json:"createdAt"`
	SlowModeSeconds int       `json:"slowModeSeconds"`
	IsNsfw          bool      `json:"isNsfw"`
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
	UserID        string    `json:"userId"`
	Username      string    `json:"username"`
	DisplayName   string    `json:"displayName,omitempty"`
	JoinedAt      time.Time `json:"joinedAt"`
	AvatarMediaID string    `json:"avatarMediaId,omitempty"`
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

	// Видимость каналов:
	//   • public — все участники воркспейса;
	//   • private — owner короткозамыкается, либо явное членство в
	//     channel_members, либо роль юзера имеет 'channel.view' в granted_actions
	//     соответствующего channel_role_overrides. base_action_mask на приватные
	//     каналы НЕ распространяется (H.6).
	rows, err := m.db.Query(r.Context(),
		`select c.id, c.workspace_id, c.kind, c.name, coalesce(c.topic, ''), c.is_private, c.position, c.created_at, c.slow_mode_seconds, c.is_nsfw
		 from channels c
		 where c.workspace_id = $1
		   and (
		     c.is_private = false
		     or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = $2)
		     or exists (
		       select 1 from workspace_members wm
		       where wm.workspace_id = $1 and wm.user_id = $2 and wm.role_code = 'owner'
		     )
		     or exists (
		       select 1 from workspace_role_members wrm
		       join channel_role_overrides cro
		         on cro.role_id = wrm.role_id and cro.channel_id = c.id
		       where wrm.workspace_id = $1 and wrm.user_id = $2
		         and 'channel.view' = any(cro.granted_actions)
		     )
		   )
		 order by c.position, c.created_at`,
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
		if err := rows.Scan(&id, &wsID, &v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt, &v.SlowModeSeconds, &v.IsNsfw); err != nil {
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
	_, isMember, allowed := permission.Authorize(r.Context(), m.db, workspaceID, userID, permission.ChannelCreate)
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

	// D.1: лимит каналов на воркспейс.
	if m.settings != nil {
		snap := m.settings.Get(r.Context())
		if snap.MaxChannelsPerWorkspace > 0 {
			var n int
			if err := m.db.QueryRow(r.Context(),
				`select count(*) from channels where workspace_id = $1`, workspaceID).Scan(&n); err == nil && n >= snap.MaxChannelsPerWorkspace {
				sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "channel limit reached for this workspace")
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

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: workspaceID,
		Action:      auditlog.ActionChannelCreated,
		TargetType:  "channel",
		TargetID:    channelID.String(),
	})

	view := channelView{
		ID:          channelID.String(),
		WorkspaceID: workspaceID.String(),
		Kind:        req.Kind,
		Name:        req.Name,
		Topic:       req.Topic,
		IsPrivate:   req.IsPrivate,
		Position:    0,
		CreatedAt:   now,
	}
	m.publish("channel.created", workspaceID, channelID.String(), view)
	// H.9.iii: системная плашка «Канал создан» — только в text-канал.
	// В voice-канал такие плашки не вписаны (там нет message-стрима).
	if req.Kind == "text" && m.messages != nil {
		if err := m.messages.PostSystemMessage(r.Context(), channelID, workspaceID, userID, "system_channel_event", "Канал создан"); err != nil {
			m.logger.Warn("channel.create: PostSystemMessage failed", slog.String("err", err.Error()))
		}
	}
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}

type updateRequest struct {
	Name            *string `json:"name"`
	Topic           *string `json:"topic"`
	IsPrivate       *bool   `json:"isPrivate"`
	SlowModeSeconds *int    `json:"slowModeSeconds"`
	IsNsfw          *bool   `json:"isNsfw"`
}

// handleUpdate — PATCH /api/v1/channels/{id}. Изменяем name/topic/isPrivate.
// kind менять нельзя: это поменяло бы UX-контракт (voice vs text), а
// связанные с типом записи (channel_participants для voice) остались бы
// неконсистентны.
func (m *Module) handleUpdate(w http.ResponseWriter, r *http.Request) {
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
	if req.Topic != nil {
		trimmed := strings.TrimSpace(*req.Topic)
		if len(trimmed) > 256 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "topic must be ≤256 chars")
			return
		}
		req.Topic = &trimmed
	}
	// J.3: sanity guard — CHECK constraint в БД тоже ловит, но 400 удобнее
	// чем 500 от транзакции. 6 часов сверху — больше нет смысла (всё равно
	// аудитория уйдёт), меньше нуля бессмысленно.
	if req.SlowModeSeconds != nil {
		if *req.SlowModeSeconds < 0 || *req.SlowModeSeconds > 21600 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "slowModeSeconds must be 0..21600")
			return
		}
	}

	// Запоминаем old name до апдейта, чтобы post-система могла оформить
	// «Канал переименован: #old → #new». Если запрос не меняет имя — поле
	// будет пустым и плашку не пишем.
	var oldName, oldKind string
	if err := m.db.QueryRow(r.Context(),
		`select name, kind from channels where id = $1`, channelID).Scan(&oldName, &oldKind); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`update channels set
		   name              = coalesce($2, name),
		   topic             = case when $3::bool then nullif($4, '') else topic end,
		   is_private        = coalesce($5, is_private),
		   slow_mode_seconds = coalesce($7, slow_mode_seconds),
		   is_nsfw           = coalesce($8, is_nsfw),
		   updated_at        = $6
		 where id = $1`,
		channelID, req.Name, req.Topic != nil, derefString(req.Topic), req.IsPrivate, now, req.SlowModeSeconds, req.IsNsfw,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	// Тянем актуальный state обратно, чтобы и в response, и в realtime
	// уехала одна и та же канонизированная версия (для clients без race'а
	// между двумя одновременными PATCH'ами).
	var v channelView
	err = m.db.QueryRow(r.Context(),
		`select id, workspace_id, kind, name, coalesce(topic, ''), is_private, position, created_at, slow_mode_seconds, is_nsfw
		 from channels where id = $1`,
		channelID,
	).Scan(&v.ID, &v.WorkspaceID, &v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt, &v.SlowModeSeconds, &v.IsNsfw)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload channel")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: scope.WorkspaceID,
		Action:      auditlog.ActionChannelUpdated,
		TargetType:  "channel",
		TargetID:    channelID.String(),
	})
	m.publish("channel.updated", scope.WorkspaceID, channelID.String(), v)
	// H.9.iii: system-плашка при переименовании text-канала.
	if oldKind == "text" && m.messages != nil && req.Name != nil && *req.Name != oldName {
		body := "Канал переименован: #" + oldName + " → #" + v.Name
		if err := m.messages.PostSystemMessage(r.Context(), channelID, scope.WorkspaceID, userID, "system_channel_event", body); err != nil {
			m.logger.Warn("channel.update: PostSystemMessage failed", slog.String("err", err.Error()))
		}
	}
	sharedhttp.WriteJSON(w, http.StatusOK, v)
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// handleDelete — каскад на messages/reactions/attachments-links/members
// через существующие FK on delete cascade. media_objects остаются (orphan),
// retention.Sweep заберёт их через час grace-периодом.
func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
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
	_, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.ChannelDelete)
	if !allowed {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	// Audit ДО delete, чтобы actor+target ссылки ещё были валидны на момент
	// записи (consistent с server/admin.go delete user pattern).
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: scope.WorkspaceID,
		Action:      auditlog.ActionChannelDeleted,
		TargetType:  "channel",
		TargetID:    channelID.String(),
	})

	tag, err := m.db.Exec(r.Context(), `delete from channels where id = $1`, channelID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not delete channel")
		return
	}
	if tag.RowsAffected() == 0 {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not found")
		return
	}

	m.publish("channel.deleted", scope.WorkspaceID, channelID.String(), map[string]string{
		"channelId":   channelID.String(),
		"workspaceId": scope.WorkspaceID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
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
		`select kind, name, coalesce(topic, ''), is_private, position, created_at, slow_mode_seconds, is_nsfw
		 from channels where id = $1`,
		channelID,
	).Scan(&v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt, &v.SlowModeSeconds, &v.IsNsfw)
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
		`select u.id, u.username, u.display_name, cm.joined_at, u.avatar_media_id
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
			avatarID    *uuid.UUID
		)
		if err := rows.Scan(&id, &username, &displayName, &joinedAt, &avatarID); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		mv := memberView{UserID: id.String(), Username: username, JoinedAt: joinedAt}
		if displayName != nil {
			mv.DisplayName = *displayName
		}
		if avatarID != nil {
			mv.AvatarMediaID = avatarID.String()
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
	if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, actorID, permission.ChannelManageMembers); !allowed {
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
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: scope.WorkspaceID,
		Action:      auditlog.ActionChannelMemberAdded,
		TargetType:  "channel_member",
		TargetID:    channelID.String() + ":" + targetID.String(),
	})
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
		if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, actorID, permission.ChannelManageMembers); !allowed {
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
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     actorID,
		WorkspaceID: scope.WorkspaceID,
		Action:      auditlog.ActionChannelMemberRemoved,
		TargetType:  "channel_member",
		TargetID:    channelID.String() + ":" + targetID.String(),
	})
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
