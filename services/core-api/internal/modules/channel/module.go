package channel

import (
	"context"
	"encoding/json"
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
	// Wave 5: точечные права конкретных участников в канале.
	router.Protected("GET /api/v1/channels/{channelId}/user-permissions", m.handleGetUserPermissions)
	router.Protected("PUT /api/v1/channels/{channelId}/user-permissions", m.handleUpdateUserPermissions)
	// Wave 9: форум — посты (треды) внутри kind='forum' канала. См. forum.go.
	router.Protected("GET /api/v1/channels/{channelId}/forum/posts", m.handleForumPostList)
	router.Protected("POST /api/v1/channels/{channelId}/forum/posts", m.handleForumPostCreate)
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
	ID              string     `json:"id"`
	WorkspaceID     string     `json:"workspaceId"`
	Kind            string     `json:"kind"`
	Name            string     `json:"name"`
	Topic           string     `json:"topic,omitempty"`
	IsPrivate       bool       `json:"isPrivate"`
	Position        int        `json:"position"`
	CreatedAt       time.Time  `json:"createdAt"`
	SlowModeSeconds int        `json:"slowModeSeconds"`
	IsNsfw          bool       `json:"isNsfw"`
	CategoryID      *string    `json:"categoryId"`
	// Wave 8: soft-archive. NULL = активный канал.
	ArchivedAt *time.Time `json:"archivedAt,omitempty"`
	// Wave 8: hex-цвет имени канала в sidebar, "" = цвет темы.
	NameColor string `json:"nameColor,omitempty"`
	// Wave 9 (форум): для kind='thread' — id родительского форума.
	// Клиент по нему строит breadcrumb и прячет треды из sidebar.
	ParentChannelID *string `json:"parentChannelId,omitempty"`
}

type createRequest struct {
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Topic      string  `json:"topic"`
	IsPrivate  bool    `json:"isPrivate"`
	CategoryID *string `json:"categoryId"`
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

// Wave 9: 'forum' создаётся явно; 'thread' (пост форума) — ТОЛЬКО через
// POST /channels/{id}/forum/posts (forum.go), напрямую его создать нельзя.
var allowedKinds = map[string]struct{}{
	"text":   {},
	"voice":  {},
	"media":  {},
	"system": {},
	"forum":  {},
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
		`select c.id, c.workspace_id, c.kind, c.name, coalesce(c.topic, ''), c.is_private, c.position, c.created_at, c.slow_mode_seconds, c.is_nsfw, c.category_id, c.archived_at, coalesce(c.name_color, ''), c.parent_channel_id
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
		var catUUID, parentUUID *uuid.UUID
		if err := rows.Scan(&id, &wsID, &v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt, &v.SlowModeSeconds, &v.IsNsfw, &catUUID, &v.ArchivedAt, &v.NameColor, &parentUUID); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		v.ID = id.String()
		v.WorkspaceID = wsID.String()
		if catUUID != nil {
			s := catUUID.String()
			v.CategoryID = &s
		}
		if parentUUID != nil {
			s := parentUUID.String()
			v.ParentChannelID = &s
		}
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
	// Wave 9: приватные форумы отложены — треды создаются is_private=false
	// и наследование членства/ролей на них не реализовано. Пока запрет.
	if req.Kind == "forum" && req.IsPrivate {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "private forums are not supported yet")
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

	// J.5: опциональная привязка к категории при создании.
	var createCategoryID *uuid.UUID
	if req.CategoryID != nil {
		raw := strings.TrimSpace(*req.CategoryID)
		if raw != "" {
			cid, err := uuid.Parse(raw)
			if err != nil {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid categoryId")
				return
			}
			var catWs uuid.UUID
			if err := m.db.QueryRow(r.Context(),
				`select workspace_id from channel_categories where id = $1`, cid).Scan(&catWs); err != nil {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "category not found")
				return
			}
			if catWs != workspaceID {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "category belongs to another workspace")
				return
			}
			createCategoryID = &cid
		}
	}

	channelID := uuid.New()
	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into channels (id, workspace_id, kind, name, topic, is_private, position, created_at, updated_at, category_id)
		 values ($1, $2, $3, $4, nullif($5, ''), $6, 0, $7, $7, $8)`,
		channelID, workspaceID, req.Kind, req.Name, req.Topic, req.IsPrivate, now, createCategoryID,
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
	if createCategoryID != nil {
		s := createCategoryID.String()
		view.CategoryID = &s
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
	// J.5: nil = не трогать; пустая строка "" = снять привязку (NULL).
	// Не-nil валидный UUID = присвоить категорию (проверяем что
	// категория из того же workspace'а).
	CategoryID *string `json:"categoryId"`
	// J.5(a): drag-reorder каналов. Клиент шлёт integer-позицию
	// (мидпоинт между соседями); порядок в sidebar = ORDER BY position.
	Position *int `json:"position"`
	// Wave 8: true = в архив (archived_at = now()), false = вернуть из архива.
	// nil = не трогать. Повторная архивация не двигает archived_at.
	Archived *bool `json:"archived"`
	// Wave 8: '#rrggbb'; пустая строка = сбросить на цвет темы (NULL).
	NameColor *string `json:"nameColor"`
}

// nameColorRe — синхронен с CHECK channels_name_color_chk (миграция 37).
var nameColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

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
	// Wave 8: цвет валидируем до UPDATE — CHECK в БД тоже ловит, но 400
	// дружелюбнее 500. Пустая строка — легальный «сброс».
	if req.NameColor != nil {
		trimmed := strings.TrimSpace(*req.NameColor)
		if trimmed != "" && !nameColorRe.MatchString(trimmed) {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "nameColor must be #rrggbb")
			return
		}
		req.NameColor = &trimmed
	}

	// J.5: categoryId — пустая строка = снять привязку (NULL),
	// валидный UUID = присвоить (но категория должна быть из того же ws'а).
	var newCategoryID *uuid.UUID
	categoryTouch := false
	if req.CategoryID != nil {
		categoryTouch = true
		raw := strings.TrimSpace(*req.CategoryID)
		if raw != "" {
			cid, err := uuid.Parse(raw)
			if err != nil {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid categoryId")
				return
			}
			var catWs uuid.UUID
			if err := m.db.QueryRow(r.Context(),
				`select workspace_id from channel_categories where id = $1`, cid).Scan(&catWs); err != nil {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "category not found")
				return
			}
			if catWs != scope.WorkspaceID {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "category belongs to another workspace")
				return
			}
			newCategoryID = &cid
		}
	}

	// Запоминаем old name до апдейта, чтобы post-система могла оформить
	// «Канал переименован: #old → #new». Если запрос не меняет имя — поле
	// будет пустым и плашку не пишем. old archived_at — для плашки
	// архивации (пишем только при фактической смене состояния).
	var oldName, oldKind string
	var oldArchivedAt *time.Time
	if err := m.db.QueryRow(r.Context(),
		`select name, kind, archived_at from channels where id = $1`, channelID).Scan(&oldName, &oldKind, &oldArchivedAt); err != nil {
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
		   category_id       = case when $9::bool then $10::uuid else category_id end,
		   position          = coalesce($11, position),
		   archived_at       = case when $12::bool then (case when $13::bool then coalesce(archived_at, $6) end) else archived_at end,
		   name_color        = case when $14::bool then nullif($15, '') else name_color end,
		   updated_at        = $6
		 where id = $1`,
		channelID, req.Name, req.Topic != nil, derefString(req.Topic), req.IsPrivate, now, req.SlowModeSeconds, req.IsNsfw, categoryTouch, newCategoryID, req.Position,
		req.Archived != nil, req.Archived != nil && *req.Archived, req.NameColor != nil, derefString(req.NameColor),
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	// Тянем актуальный state обратно, чтобы и в response, и в realtime
	// уехала одна и та же канонизированная версия (для clients без race'а
	// между двумя одновременными PATCH'ами).
	var v channelView
	var reloadCat, reloadParent *uuid.UUID
	err = m.db.QueryRow(r.Context(),
		`select id, workspace_id, kind, name, coalesce(topic, ''), is_private, position, created_at, slow_mode_seconds, is_nsfw, category_id, archived_at, coalesce(name_color, ''), parent_channel_id
		 from channels where id = $1`,
		channelID,
	).Scan(&v.ID, &v.WorkspaceID, &v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt, &v.SlowModeSeconds, &v.IsNsfw, &reloadCat, &v.ArchivedAt, &v.NameColor, &reloadParent)
	if reloadCat != nil {
		s := reloadCat.String()
		v.CategoryID = &s
	}
	if reloadParent != nil {
		s := reloadParent.String()
		v.ParentChannelID = &s
	}
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
	// Wave 8: плашка при фактической смене archive-состояния. Порядок важен:
	// «возвращён» постится после снятия archived_at (постинг в архивный канал
	// message-модуль отклоняет), «перемещён» — тоже после UPDATE, поэтому
	// PostSystemMessage обходит архивный guard (kind != 'user').
	if oldKind == "text" && m.messages != nil && req.Archived != nil && *req.Archived != (oldArchivedAt != nil) {
		body := "Канал возвращён из архива"
		if *req.Archived {
			body = "Канал перемещён в архив"
		}
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
	var getCat, getParent *uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select kind, name, coalesce(topic, ''), is_private, position, created_at, slow_mode_seconds, is_nsfw, category_id, archived_at, coalesce(name_color, ''), parent_channel_id
		 from channels where id = $1`,
		channelID,
	).Scan(&v.Kind, &v.Name, &v.Topic, &v.IsPrivate, &v.Position, &v.CreatedAt, &v.SlowModeSeconds, &v.IsNsfw, &getCat, &v.ArchivedAt, &v.NameColor, &getParent)
	if getCat != nil {
		s := getCat.String()
		v.CategoryID = &s
	}
	if getParent != nil {
		s := getParent.String()
		v.ParentChannelID = &s
	}
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
