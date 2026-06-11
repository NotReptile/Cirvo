package message

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/friend"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/notification"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

const (
	defaultLimit       = 50
	maxLimit           = 200
	maxBodyChars       = 8000
	maxEmojiLen        = 64
	replySnippetMaxLen = 120
	maxMentionsPerMsg  = 20
)

// mentionRe — `@<slug>`, slug по правилу users.username:
// `[a-z0-9_]{3,32}`. Не матчит email'ы (перед @ есть word-char) — `\B`
// гарантирует, что `@` это начало токена. Совпадает с case-sensitive,
// usernames в БД хранятся lowercase.
var mentionRe = regexp.MustCompile(`(?:^|[^A-Za-z0-9_])@([a-z0-9_]{3,32})`)

// everyoneRe — массовый пинг @everyone/@here (Wave 4). Та же граница
// слева, что у mentionRe; \b справа отсекает "@everyones".
var everyoneRe = regexp.MustCompile(`(?:^|[^A-Za-z0-9_])@(everyone|here)\b`)

// detectEveryoneMention — 'everyone' | 'here' | "". При обоих токенах
// в теле побеждает everyone (более широкий пинг).
func detectEveryoneMention(body string) string {
	kind := ""
	for _, m := range everyoneRe.FindAllStringSubmatch(body, -1) {
		if m[1] == "everyone" {
			return "everyone"
		}
		kind = "here"
	}
	return kind
}

// messageSelectColumns — общий список колонок для list/loadOne, чтобы
// scanMessageWithReactions работал одинаково. $N плейсхолдеры:
// $1 — viewer userID (для bool_or в reactions). Каждый вызов добавит
// свои дополнительные параметры в where после этой константы.
const messageSelectColumns = `m.id, m.channel_id, m.author_user_id, m.body, m.kind,
        coalesce(m.client_message_id, ''), m.created_at, m.edited_at,
        m.is_pinned, m.pinned_at, m.link_previews, coalesce(m.mention_everyone, ''),
        coalesce(
          (select jsonb_object_agg(emoji, jsonb_build_object('count', cnt, 'mine', mine, 'userIds', user_ids))
           from (
             select emoji, count(*) as cnt, bool_or(user_id = $1) as mine,
                    jsonb_agg(user_id::text order by created_at) as user_ids
             from message_reactions where message_id = m.id
             group by emoji
           ) r),
          '{}'::jsonb
        ) as reactions,
        coalesce(
          (select jsonb_agg(jsonb_build_object(
             'id', mo.id,
             'contentType', mo.content_type,
             'sizeBytes', mo.size_bytes,
             'filename', coalesce(mo.original_filename, ''),
             'url', '/api/v1/media/' || mo.id::text
           ) order by ma.position, mo.created_at)
           from message_attachments ma
           join media_objects mo on mo.id = ma.media_id
           where ma.message_id = m.id),
          '[]'::jsonb
        ) as attachments,
        case
          when m.reply_to_message_id is null then null::jsonb
          else (
            select jsonb_build_object(
              'messageId', p.id,
              'authorId', p.author_user_id,
              'body', substring(p.body for 120),
              'deleted', p.deleted_at is not null
            )
            from messages p where p.id = m.reply_to_message_id
          )
        end as reply_to,
        coalesce(
          (select jsonb_agg(user_id::text order by user_id)
           from message_mentions where message_id = m.id),
          '[]'::jsonb
        ) as mentions`

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	settings  *serversettings.Provider
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, settings *serversettings.Provider, logger *slog.Logger) *Module {
	return &Module{db: db, publisher: publisher, settings: settings, logger: logger}
}

// bodyLimit возвращает текущий лимит тела сообщения в байтах. 0 = безлимит.
// При отсутствии Provider (старые тесты) — fallback на исторический maxBodyChars.
func (m *Module) bodyLimit(r *http.Request) int {
	if m.settings == nil {
		return maxBodyChars
	}
	return m.settings.Get(r.Context()).MaxMessageBytes
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/channels/{channelId}/messages", m.handleList)
	router.Protected("POST /api/v1/channels/{channelId}/messages", m.handleCreate)
	router.Protected("PATCH /api/v1/messages/{messageId}", m.handleEdit)
	router.Protected("DELETE /api/v1/messages/{messageId}", m.handleDelete)
	router.Protected("PUT /api/v1/messages/{messageId}/reactions/{emoji}", m.handleAddReaction)
	router.Protected("DELETE /api/v1/messages/{messageId}/reactions/{emoji}", m.handleRemoveReaction)
	router.Protected("PUT /api/v1/messages/{messageId}/pin", m.handlePin)
	router.Protected("DELETE /api/v1/messages/{messageId}/pin", m.handleUnpin)
	router.Protected("GET /api/v1/channels/{channelId}/pins", m.handleListPins)
	router.Protected("POST /api/v1/channels/{channelId}/read", m.handleMarkRead)
	router.Protected("GET /api/v1/channels/{channelId}/read", m.handleGetRead)
	router.Protected("GET /api/v1/workspaces/{workspaceId}/unread", m.handleListUnread)
	router.Protected("GET /api/v1/workspaces/{workspaceId}/search", m.handleSearch)
}

type reactionAgg struct {
	Count   int      `json:"count"`
	Mine    bool     `json:"mine"`
	UserIDs []string `json:"userIds,omitempty"`
}

type attachmentView struct {
	ID          string `json:"id"`
	ContentType string `json:"contentType"`
	SizeBytes   int64  `json:"sizeBytes"`
	Filename    string `json:"filename,omitempty"`
	URL         string `json:"url"`
}

// replySnippetView — компактная цитата для рендера в message-card.
// body обрезается на сервере (120 символов), чтобы клиент не подгружал
// весь parent message только ради превью. deleted=true когда parent
// удалён (на FK on delete set null reply_to_message_id обнуляется, но
// если в момент чтения parent уже soft-deleted — показываем плашку).
type replySnippetView struct {
	MessageID string `json:"messageId"`
	AuthorID  string `json:"authorId"`
	Body      string `json:"body"`
	Deleted   bool   `json:"deleted,omitempty"`
}

type messageView struct {
	ID              string                 `json:"id"`
	ChannelID       string                 `json:"channelId"`
	AuthorID        string                 `json:"authorId"`
	Body            string                 `json:"body"`
	Kind            string                 `json:"kind,omitempty"`
	ClientMessageID string                 `json:"clientMessageId,omitempty"`
	CreatedAt       time.Time              `json:"createdAt"`
	EditedAt        *time.Time             `json:"editedAt,omitempty"`
	DeletedAt       *time.Time             `json:"deletedAt,omitempty"`
	Reactions       map[string]reactionAgg `json:"reactions"`
	Attachments     []attachmentView       `json:"attachments"`
	ReplyTo         *replySnippetView      `json:"replyTo,omitempty"`
	Mentions        []string               `json:"mentions"`
	IsPinned        bool                   `json:"isPinned,omitempty"`
	PinnedAt        *time.Time             `json:"pinnedAt,omitempty"`
	// Wave 2: OG-карточки, заполняет worker (link_preview_jobs). Сырой
	// jsonb-passthrough — структуру знает worker и клиент.
	LinkPreviews json.RawMessage `json:"linkPreviews,omitempty"`
	// Wave 4: 'everyone' | 'here', если автор имел право на массовый пинг.
	// Клиент подсвечивает токен и считает сообщение mention'ом для всех.
	MentionEveryone string `json:"mentionEveryone,omitempty"`
}

type createRequest struct {
	Body             string   `json:"body"`
	ClientMessageID  string   `json:"clientMessageId"`
	AttachmentIDs    []string `json:"attachmentIds"`
	ReplyToMessageID string   `json:"replyToMessageId,omitempty"`
}

type editRequest struct {
	Body string `json:"body"`
}

type readRequest struct {
	MessageID string `json:"messageId"`
}

type readView struct {
	ChannelID     string    `json:"channelId"`
	UserID        string    `json:"userId"`
	LastMessageID string    `json:"lastMessageId,omitempty"`
	LastReadAt    time.Time `json:"lastReadAt"`
}

// ---- list / create ----------------------------------------------------------

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	if _, ok := channel.Resolve(r.Context(), m.db, channelID, userID); !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}

	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid limit")
			return
		}
		if parsed > maxLimit {
			parsed = maxLimit
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
		`select `+messageSelectColumns+`
		 from messages m
		 where m.channel_id = $2 and m.deleted_at is null and m.created_at < $3
		 order by m.created_at desc
		 limit $4`,
		userID, channelID, before, limit,
	)
	if err != nil {
		m.logger.Error("list messages query failed", "error", err, "channelId", channelID)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]messageView, 0)
	for rows.Next() {
		v, err := scanMessageWithReactions(rows)
		if err != nil {
			m.logger.Error("list messages scan failed", "error", err, "channelId", channelID)
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, v)
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

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	if scope.Kind != "text" && scope.Kind != "dm" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "channel does not accept messages")
		return
	}
	// D.4 — per-channel overrides: deny message.write блокирует отправку
	// даже для участника, у которого есть базовое право от роли.
	// DM-каналы (workspace_id IS NULL) пропускают workspace-permission
	// проверки — членство в DM = право писать/прикреплять/реагировать.
	if scope.Kind != "dm" &&
		!permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageWrite) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "writing is disabled in this channel")
		return
	}
	// Wave 3: блокировка закрывает DM в обе стороны. Текст ошибки нарочно
	// не говорит, кто кого заблокировал.
	if scope.Kind == "dm" {
		var ua, ub uuid.UUID
		if err := m.db.QueryRow(r.Context(),
			`select user_a, user_b from dm_channels where channel_id = $1`, channelID,
		).Scan(&ua, &ub); err == nil {
			peer := ua
			if ua == userID {
				peer = ub
			}
			if friend.IsBlocked(r.Context(), m.db, userID, peer) {
				sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "direct messages are not available with this user")
				return
			}
		}
	}

	var req createRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	attachmentUUIDs, err := parseAttachmentIDs(req.AttachmentIDs)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, err.Error())
		return
	}
	if req.Body == "" && len(attachmentUUIDs) == 0 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body or attachments are required")
		return
	}
	// D.4 — deny message.attach запрещает прикреплять файлы (сообщения
	// без вложений всё ещё проходят).
	if scope.Kind != "dm" && len(attachmentUUIDs) > 0 &&
		!permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageAttach) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "attachments are disabled in this channel")
		return
	}
	if limit := m.bodyLimit(r); limit > 0 && len(req.Body) > limit {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body too long")
		return
	}

	// J.3: slow-mode. Тянем только для text-каналов (DM не имеют slow-mode).
	// Модераторы (MessageModerate) обходят — иначе они не смогут оперативно
	// модерировать флуд в режиме slow-mode. Race между двумя сессиями
	// одного юзера допустима (race-окно мс на ту же пуш-стрим).
	if scope.Kind == "text" {
		var slowSec int
		var archivedAt *time.Time
		err := m.db.QueryRow(r.Context(),
			`select slow_mode_seconds, archived_at from channels where id = $1`, channelID).Scan(&slowSec, &archivedAt)
		// Wave 8: архивный канал read-only для всех (включая модераторов) —
		// чтобы написать, канал возвращают из архива через PATCH. System-плашки
		// идут через PostSystemMessage и этот guard не проходят.
		if err == nil && archivedAt != nil {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "channel is archived")
			return
		}
		if err == nil && slowSec > 0 {
			isModerator := permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageModerate)
			if !isModerator {
				var lastTS *time.Time
				_ = m.db.QueryRow(r.Context(),
					`select max(created_at) from messages
					 where channel_id = $1 and author_user_id = $2 and deleted_at is null and kind = 'user'`,
					channelID, userID).Scan(&lastTS)
				if lastTS != nil {
					elapsed := time.Since(*lastTS)
					if elapsed < time.Duration(slowSec)*time.Second {
						retry := int((time.Duration(slowSec)*time.Second - elapsed).Seconds())
						if retry < 1 {
							retry = 1
						}
						w.Header().Set("Retry-After", strconv.Itoa(retry))
						sharedhttp.WriteError(w, r, http.StatusTooManyRequests, sharedhttp.CodeRateLimited, "slow mode is on; wait before sending the next message")
						return
					}
				}
			}
		}
	}

	// reply_to: parent должен жить в том же канале и не быть удалён.
	// Иначе reply теряет смысл (или это попытка процитировать сообщение
	// из приватного канала, к которому юзер не имеет доступа).
	var (
		replyToID     *uuid.UUID
		replyAuthorID *uuid.UUID
	)
	if req.ReplyToMessageID != "" {
		pid, err := uuid.Parse(req.ReplyToMessageID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid replyToMessageId")
			return
		}
		var parentChannel uuid.UUID
		var parentAuthor uuid.UUID
		var parentDeleted *time.Time
		err = m.db.QueryRow(r.Context(),
			`select channel_id, author_user_id, deleted_at from messages where id = $1`,
			pid,
		).Scan(&parentChannel, &parentAuthor, &parentDeleted)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "reply target not found")
				return
			}
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "reply lookup failed")
			return
		}
		if parentChannel != channelID {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "reply target is in another channel")
			return
		}
		if parentDeleted != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "reply target is deleted")
			return
		}
		replyToID = &pid
		replyAuthorID = &parentAuthor
	}

	if req.ClientMessageID != "" {
		var existingID uuid.UUID
		err := m.db.QueryRow(r.Context(),
			`select id from messages
			 where channel_id = $1 and author_user_id = $2 and client_message_id = $3`,
			channelID, userID, req.ClientMessageID,
		).Scan(&existingID)
		if err == nil {
			existing, loadErr := m.loadMessageView(r.Context(), existingID, userID)
			if loadErr == nil {
				sharedhttp.WriteJSON(w, http.StatusOK, existing)
				return
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
			return
		}
	}

	// Wave 4: @everyone/@here. Срабатывает только при наличии права —
	// без него токен остаётся обычным текстом (молча, как deny mention'ов).
	// В DM массовый пинг бессмыслен (двое участников).
	mentionEveryone := ""
	if scope.Kind != "dm" {
		if kind := detectEveryoneMention(req.Body); kind != "" &&
			permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageMentionEveryone) {
			mentionEveryone = kind
		}
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	messageID := uuid.New()
	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into messages (id, channel_id, author_user_id, body, client_message_id, created_at, reply_to_message_id, mention_everyone)
		 values ($1, $2, $3, $4, nullif($5, ''), $6, $7, nullif($8, ''))`,
		messageID, channelID, userID, req.Body, req.ClientMessageID, now, replyToID, mentionEveryone,
	)
	if err != nil {
		if strings.Contains(err.Error(), "SQLSTATE 23505") {
			sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeMessageAlreadyExists, "client message id already used")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create message")
		return
	}

	for i, mediaID := range attachmentUUIDs {
		var ownerID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`select coalesce(uploaded_by_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
			 from media_objects where id = $1`,
			mediaID,
		).Scan(&ownerID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown attachment")
				return
			}
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "attachment lookup failed")
			return
		}
		if ownerID != userID {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "attachment does not belong to user")
			return
		}
		if _, err := tx.Exec(r.Context(),
			`insert into message_attachments (message_id, media_id, position) values ($1, $2, $3)`,
			messageID, mediaID, i,
		); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not link attachment")
			return
		}
	}

	var mentionIDs []uuid.UUID
	// D.4 — если message.mention deny'нут в канале, mentions молча
	// игнорируются: парсинг пропускается, ничего не пишется в
	// message_mentions, notifications не enqueue'ятся. UI клиент
	// тоже не подсветит — без записи в mentions[].
	// В DM-каналах mentions нет смысла (только 2 участника) — пропускаем.
	mentionsAllowed := scope.Kind != "dm" &&
		permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageMention)
	if mentionsAllowed {
		if slugs := parseMentionSlugs(req.Body); len(slugs) > 0 {
			ids, err := resolveMentionTargets(r.Context(), tx, scope.WorkspaceID, slugs)
			if err != nil {
				sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "mentions lookup failed")
				return
			}
			mentionIDs = ids
			for _, uid := range ids {
				if _, err := tx.Exec(r.Context(),
					`insert into message_mentions (message_id, user_id) values ($1, $2) on conflict do nothing`,
					messageID, uid,
				); err != nil {
					sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not save mention")
					return
				}
			}
		}
	}

	// Notification jobs. Enqueue внутри tx — атомарно с insert сообщения.
	// Дедуп: если автор parent'а (reply) есть среди упомянутых, он
	// получит только reply-нотификацию (без дубля mention).
	snippet := req.Body
	if len(snippet) > replySnippetMaxLen {
		snippet = snippet[:replySnippetMaxLen]
	}
	mentionRecipients := make([]string, 0, len(mentionIDs))
	for _, uid := range mentionIDs {
		if uid == userID {
			continue // сам себя
		}
		if replyAuthorID != nil && uid == *replyAuthorID {
			continue // получит reply
		}
		mentionRecipients = append(mentionRecipients, uid.String())
	}
	if len(mentionRecipients) > 0 {
		if err := notification.Enqueue(r.Context(), tx, notification.KindMention, notification.JobPayload{
			Recipients:  mentionRecipients,
			ActorID:     userID.String(),
			WorkspaceID: scope.WorkspaceID.String(),
			ChannelID:   channelID.String(),
			MessageID:   messageID.String(),
			Snippet:     snippet,
		}); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not enqueue mention notification")
			return
		}
	}
	if replyAuthorID != nil && *replyAuthorID != userID {
		if err := notification.Enqueue(r.Context(), tx, notification.KindReply, notification.JobPayload{
			Recipients:  []string{replyAuthorID.String()},
			ActorID:     userID.String(),
			WorkspaceID: scope.WorkspaceID.String(),
			ChannelID:   channelID.String(),
			MessageID:   messageID.String(),
			Snippet:     snippet,
		}); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not enqueue reply notification")
			return
		}
	}

	// Wave 4: @everyone/@here — recipients развернёт worker по участникам
	// канала; exclude — те, кто уже получил персональную нотификацию выше.
	if mentionEveryone != "" {
		exclude := make([]string, 0, len(mentionRecipients)+2)
		exclude = append(exclude, userID.String())
		exclude = append(exclude, mentionRecipients...)
		if replyAuthorID != nil {
			exclude = append(exclude, replyAuthorID.String())
		}
		if err := notification.Enqueue(r.Context(), tx, notification.KindMentionEveryone, notification.JobPayload{
			ActorID:     userID.String(),
			WorkspaceID: scope.WorkspaceID.String(),
			ChannelID:   channelID.String(),
			MessageID:   messageID.String(),
			Snippet:     snippet,
			MentionKind: mentionEveryone,
			Exclude:     exclude,
		}); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not enqueue everyone notification")
			return
		}
	}

	// Wave 2: link-preview job — если в теле есть http(s)-URL, worker
	// асинхронно подтянет OG-мету и допишет messages.link_previews.
	// Атомарно с insert (та же tx); сбой enqueue не валит отправку.
	if hasPreviewableURL(req.Body) {
		if _, err := tx.Exec(r.Context(),
			`insert into link_preview_jobs (message_id) values ($1)`, messageID,
		); err != nil {
			m.logger.Warn("link-preview enqueue failed", "messageId", messageID, "error", err)
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	view, err := m.loadMessageView(r.Context(), messageID, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload message")
		return
	}
	m.publishScope("message.created", scope, channelID, view)
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}

// hasPreviewableURL — лёгкая проверка «есть ли в теле http(s)-ссылка».
// Точную экстракцию (до 3 уникальных, обрезка пунктуации) делает worker.
var previewURLRe = regexp.MustCompile(`https?://\S+`)

func hasPreviewableURL(body string) bool {
	return previewURLRe.MatchString(body)
}

// parseMentionSlugs тянет из body уникальные `@<username>` (lowercased
// usernames по правилу `[a-z0-9_]{3,32}`), сохраняя порядок появления.
// Лимит maxMentionsPerMsg обрезает спам — лишние просто игнорим.
func parseMentionSlugs(body string) []string {
	if body == "" {
		return nil
	}
	matches := mentionRe.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		slug := m[1]
		if _, dup := seen[slug]; dup {
			continue
		}
		seen[slug] = struct{}{}
		out = append(out, slug)
		if len(out) >= maxMentionsPerMsg {
			break
		}
	}
	return out
}

// resolveMentionTargets резолвит slug'и в user_id'ы, ограничиваясь
// участниками воркспейса канала. Чужие slug'и/опечатки молча отсекаются —
// пользователь увидит, что подсветки нет, но сообщение всё равно уйдёт.
type mentionQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func resolveMentionTargets(ctx context.Context, q mentionQuerier, workspaceID uuid.UUID, slugs []string) ([]uuid.UUID, error) {
	if len(slugs) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx,
		`select u.id from users u
		 join workspace_members wm on wm.user_id = u.id
		 where wm.workspace_id = $1 and u.username = any($2)`,
		workspaceID, slugs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]uuid.UUID, 0, len(slugs))
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func parseAttachmentIDs(raw []string) ([]uuid.UUID, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > 10 {
		return nil, errors.New("too many attachments (max 10)")
	}
	out := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		id, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil {
			return nil, errors.New("invalid attachment id")
		}
		out = append(out, id)
	}
	return out, nil
}

// ---- edit / delete ----------------------------------------------------------

func (m *Module) handleEdit(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}

	var req editRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body must not be empty")
		return
	}
	if limit := m.bodyLimit(r); limit > 0 && len(req.Body) > limit {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body too long")
		return
	}

	var (
		channelID uuid.UUID
		authorID  uuid.UUID
		deletedAt *time.Time
		kind      string
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id, author_user_id, deleted_at, kind from messages where id = $1`,
		messageID,
	).Scan(&channelID, &authorID, &deletedAt, &kind)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "message not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if deletedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "message already deleted")
		return
	}
	if kind != "user" {
		// H.9: system_join/system_call/system_channel_event — служебные плашки.
		// Тело сформировано бэком, юзер не может редактировать.
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "system messages are not editable")
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	if authorID != userID {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "only author can edit")
		return
	}

	now := time.Now().UTC()
	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := tx.Exec(r.Context(),
		`update messages set body = $1, edited_at = $2 where id = $3`,
		req.Body, now, messageID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update message")
		return
	}

	// Mentions перестраиваются с нуля — это проще и устойчивее к правкам
	// (юзер мог удалить или дописать @username).
	if _, err := tx.Exec(r.Context(),
		`delete from message_mentions where message_id = $1`, messageID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not refresh mentions")
		return
	}
	if permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageMention) {
		if slugs := parseMentionSlugs(req.Body); len(slugs) > 0 {
			ids, err := resolveMentionTargets(r.Context(), tx, scope.WorkspaceID, slugs)
			if err != nil {
				sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "mentions lookup failed")
				return
			}
			for _, uid := range ids {
				if _, err := tx.Exec(r.Context(),
					`insert into message_mentions (message_id, user_id) values ($1, $2) on conflict do nothing`,
					messageID, uid,
				); err != nil {
					sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not save mention")
					return
				}
			}
		}
	}

	// Wave 4: пересчёт @everyone/@here. Новые нотификации при edit'е не
	// шлём (как и для обычных mentions) — только подсветка актуализируется.
	mentionEveryone := ""
	if kind := detectEveryoneMention(req.Body); kind != "" &&
		permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageMentionEveryone) {
		mentionEveryone = kind
	}
	if _, err := tx.Exec(r.Context(),
		`update messages set mention_everyone = nullif($1, '') where id = $2`,
		mentionEveryone, messageID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not refresh everyone mention")
		return
	}

	// Wave 2: пересборка link-preview после правки. Есть URL — worker
	// пересчитает (и перезатрёт старые); нет — чистим колонку сразу,
	// чтобы карточка от вырезанной ссылки не зависала.
	if hasPreviewableURL(req.Body) {
		if _, err := tx.Exec(r.Context(),
			`insert into link_preview_jobs (message_id) values ($1)`, messageID,
		); err != nil {
			m.logger.Warn("link-preview enqueue failed", "messageId", messageID, "error", err)
		}
	} else {
		if _, err := tx.Exec(r.Context(),
			`update messages set link_previews = null where id = $1`, messageID,
		); err != nil {
			m.logger.Warn("link-preview clear failed", "messageId", messageID, "error", err)
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	view, err := m.loadMessageView(r.Context(), messageID, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload message")
		return
	}
	m.publishScope("message.updated", scope, channelID, view)
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}

	var (
		channelID uuid.UUID
		authorID  uuid.UUID
		deletedAt *time.Time
		kind      string
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id, author_user_id, deleted_at, kind from messages where id = $1`,
		messageID,
	).Scan(&channelID, &authorID, &deletedAt, &kind)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "message not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if deletedAt != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	// H.9: system-сообщения может убирать только moderator+ (author —
	// формальный участник события, не должен мочь стирать историю плашек).
	if kind != "user" {
		if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.MessageModerate); !allowed {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "only moderator can delete system messages")
			return
		}
	} else if authorID != userID {
		if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.MessageModerate); !allowed {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "only author or moderator can delete")
			return
		}
	}

	now := time.Now().UTC()
	_, err = m.db.Exec(r.Context(),
		`update messages set deleted_at = $1 where id = $2`,
		now, messageID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not delete message")
		return
	}
	m.publishScope("message.deleted", scope, channelID, map[string]any{
		"id":        messageID.String(),
		"channelId": channelID.String(),
		"deletedAt": now,
	})
	// Audit пишем только для workspace-каналов — журнал событий per-workspace,
	// DM-удаления (приватный диалог двух людей) туда не относятся.
	if scope.Kind != "dm" {
		auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
			ActorID:     userID,
			WorkspaceID: scope.WorkspaceID,
			Action:      auditlog.ActionMessageDeleted,
			TargetType:  "message",
			TargetID:    messageID.String(),
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- reactions --------------------------------------------------------------

func (m *Module) handleAddReaction(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}
	emoji, ok := decodeEmoji(r.PathValue("emoji"))
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid emoji")
		return
	}

	channelID, scope, ok := m.resolveMessageScope(r.Context(), w, r, messageID, userID)
	if !ok {
		return
	}
	if scope.Kind != "dm" &&
		!permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageReact) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "reactions are disabled in this channel")
		return
	}
	// H.9: реакции на system-сообщения запрещены.
	var msgKind string
	if err := m.db.QueryRow(r.Context(),
		`select kind from messages where id = $1`, messageID,
	).Scan(&msgKind); err == nil && msgKind != "user" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "reactions on system messages are not allowed")
		return
	}

	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`insert into message_reactions (message_id, user_id, emoji, created_at)
		 values ($1, $2, $3, $4) on conflict do nothing`,
		messageID, userID, emoji, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not add reaction")
		return
	}
	m.publishScope("message.reaction.added", scope, channelID, map[string]any{
		"messageId": messageID.String(),
		"channelId": channelID.String(),
		"userId":    userID.String(),
		"emoji":     emoji,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleRemoveReaction(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}
	emoji, ok := decodeEmoji(r.PathValue("emoji"))
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid emoji")
		return
	}

	channelID, scope, ok := m.resolveMessageScope(r.Context(), w, r, messageID, userID)
	if !ok {
		return
	}

	_, err := m.db.Exec(r.Context(),
		`delete from message_reactions where message_id = $1 and user_id = $2 and emoji = $3`,
		messageID, userID, emoji,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove reaction")
		return
	}
	m.publishScope("message.reaction.removed", scope, channelID, map[string]any{
		"messageId": messageID.String(),
		"channelId": channelID.String(),
		"userId":    userID.String(),
		"emoji":     emoji,
	})
	w.WriteHeader(http.StatusNoContent)
}

// ---- read receipts ----------------------------------------------------------

func (m *Module) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}

	var req readRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	var lastMessageID *uuid.UUID
	if strings.TrimSpace(req.MessageID) != "" {
		parsed, err := uuid.Parse(req.MessageID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
			return
		}
		var owningChannel uuid.UUID
		if err := m.db.QueryRow(r.Context(),
			`select channel_id from messages where id = $1`, parsed,
		).Scan(&owningChannel); err != nil || owningChannel != channelID {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "message does not belong to channel")
			return
		}
		lastMessageID = &parsed
	}

	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`insert into read_receipts (channel_id, user_id, last_read_message_id, last_read_at)
		 values ($1, $2, $3, $4)
		 on conflict (channel_id, user_id) do update
		   set last_read_message_id = excluded.last_read_message_id,
		       last_read_at = excluded.last_read_at`,
		channelID, userID, lastMessageID, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not record read receipt")
		return
	}

	view := readView{ChannelID: channelID.String(), UserID: userID.String(), LastReadAt: now}
	if lastMessageID != nil {
		view.LastMessageID = lastMessageID.String()
	}
	m.publishScope("channel.read", scope, channelID, view)
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) handleGetRead(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	if _, ok := channel.Resolve(r.Context(), m.db, channelID, userID); !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}

	var (
		lastMessageID *uuid.UUID
		lastReadAt    time.Time
	)
	err := m.db.QueryRow(r.Context(),
		`select last_read_message_id, last_read_at from read_receipts where channel_id = $1 and user_id = $2`,
		channelID, userID,
	).Scan(&lastMessageID, &lastReadAt)
	if errors.Is(err, pgx.ErrNoRows) {
		sharedhttp.WriteJSON(w, http.StatusOK, readView{ChannelID: channelID.String(), UserID: userID.String()})
		return
	}
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	view := readView{ChannelID: channelID.String(), UserID: userID.String(), LastReadAt: lastReadAt}
	if lastMessageID != nil {
		view.LastMessageID = lastMessageID.String()
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// ---- unread aggregation -----------------------------------------------------

type unreadView struct {
	ChannelID   string     `json:"channelId"`
	LastReadAt  *time.Time `json:"lastReadAt,omitempty"`
	UnreadCount int        `json:"unreadCount"`
}

// handleListUnread — агрегированный счётчик непрочитанных по всем
// видимым каналам воркспейса. Считаются только сообщения чужих
// авторов и не soft-deleted, чтобы своя писанина не висела как
// "новое" у тебя же. Приватные каналы фильтруются через
// channel_members ровно как в channel.handleList.
func (m *Module) handleListUnread(w http.ResponseWriter, r *http.Request) {
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
		`select c.id,
		        r.last_read_at,
		        (select count(*) from messages mm
		          where mm.channel_id = c.id
		            and mm.deleted_at is null
		            and mm.author_user_id <> $2
		            and mm.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz)) as unread_count
		 from channels c
		 left join read_receipts r on r.channel_id = c.id and r.user_id = $2
		 where c.workspace_id = $1
		   and (c.is_private = false
		        or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = $2))`,
		workspaceID, userID,
	)
	if err != nil {
		m.logger.Error("unread query failed", "error", err, "workspaceId", workspaceID)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]unreadView, 0)
	for rows.Next() {
		var (
			channelID  uuid.UUID
			lastReadAt *time.Time
			count      int
		)
		if err := rows.Scan(&channelID, &lastReadAt, &count); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, unreadView{
			ChannelID:   channelID.String(),
			LastReadAt:  lastReadAt,
			UnreadCount: count,
		})
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// ---- search -----------------------------------------------------------------

const (
	searchMinQueryLen   = 2
	searchDefaultLimit  = 25
	searchMaxLimit      = 50
	searchHeadlineStart = "⟨MARK⟩"  // ⟨MARK⟩
	searchHeadlineStop  = "⟨/MARK⟩" // ⟨/MARK⟩
)

// searchResultView — расширение messageView полями channelName (резолвится
// на сервере одним JOIN, чтобы клиент не дёргал каналы повторно) и
// highlight: ts_headline c sentinel-делимитерами вместо HTML тегов.
// Клиент эскейпит highlight, потом заменяет sentinel'ы на <mark>.
type searchResultView struct {
	messageView
	ChannelName string `json:"channelName"`
	Highlight   string `json:"highlight"`
}

// buildPrefixTSQuery превращает пользовательский ввод в tsquery-строку с
// prefix-семантикой: «Hel world» → «Hel:* & world:*». Это нужно, чтобы
// search-as-you-type находил «Hello world» по запросу «Hel» — стандартный
// websearch_to_tsquery превращает «Hel» в лексему «hel» и требует
// точного совпадения с уже-проиндексированными лексемами («hello»).
//
// Очистка: оставляем только буквы и цифры (любая письменность), всё
// остальное (кавычки, операторы, пунктуация) выбрасываем. Это намеренно:
// в чате почти никто не пишет `"phrase" OR foo`, зато инъекция в
// to_tsquery через спецсимволы (`!`, `&`, `|`, `(`, `)`, `:`) сломает
// запрос. После очистки остаются безопасные токены, склеиваем через ` & `.
// Пустая строка на выходе → вызывающий должен вернуть 400.
func buildPrefixTSQuery(q string) string {
	tokens := strings.FieldsFunc(q, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	if len(tokens) == 0 {
		return ""
	}
	parts := make([]string, 0, len(tokens))
	for _, t := range tokens {
		// FieldsFunc уже дал нам только буквы+цифры, доп.очистка не нужна.
		parts = append(parts, t+":*")
	}
	return strings.Join(parts, " & ")
}

// handleSearch — полнотекстовый поиск по messages.body в рамках одного
// воркспейса. Фильтрация по видимым каналам (приватные через
// channel_members), исключаются soft-deleted. Сортировка — по
// created_at desc (Discord-style «свежее сверху»), пагинация — cursor
// `before` (RFC3339Nano), как в list.
//
// q парсится через websearch_to_tsquery — терпит пользовательский ввод
// со словами, фразами в кавычках, OR. На пустой запрос/слишком короткий
// — 400.
func (m *Module) handleSearch(w http.ResponseWriter, r *http.Request) {
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

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) < searchMinQueryLen {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "query too short")
		return
	}
	tsq := buildPrefixTSQuery(q)
	if tsq == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "query has no searchable tokens")
		return
	}

	limit := searchDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid limit")
			return
		}
		if parsed > searchMaxLimit {
			parsed = searchMaxLimit
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

	headlineOpts := "StartSel=" + searchHeadlineStart +
		", StopSel=" + searchHeadlineStop +
		", MaxFragments=2, MaxWords=15, MinWords=5, ShortWord=2, HighlightAll=FALSE"

	// $1 viewer (для reactions.mine в messageSelectColumns), $2 workspace,
	// $3 tsquery c prefix-семантикой (`hel:* & world:*`), $4 before,
	// $5 limit, $6 headline options.
	rows, err := m.db.Query(r.Context(),
		`select `+messageSelectColumns+`,
		        c.name,
		        ts_headline('russian', m.body, to_tsquery('russian', $3), $6)
		 from messages m
		 join channels c on c.id = m.channel_id
		 where c.workspace_id = $2
		   and m.deleted_at is null
		   and m.search_vector @@ to_tsquery('russian', $3)
		   and (c.is_private = false
		        or exists (select 1 from channel_members cm
		                    where cm.channel_id = c.id and cm.user_id = $1))
		   and m.created_at < $4
		 order by m.created_at desc
		 limit $5`,
		userID, workspaceID, tsq, before, limit, headlineOpts,
	)
	if err != nil {
		m.logger.Error("search query failed", "error", err, "workspaceId", workspaceID)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]searchResultView, 0)
	for rows.Next() {
		v, channelName, highlight, err := scanSearchResult(rows)
		if err != nil {
			m.logger.Error("search scan failed", "error", err, "workspaceId", workspaceID)
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, searchResultView{messageView: v, ChannelName: channelName, Highlight: highlight})
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

func scanSearchResult(rows pgx.Rows) (messageView, string, string, error) {
	var (
		id, chID, authID uuid.UUID
		body, cmid, kind string
		created          time.Time
		edited           *time.Time
		isPinned         bool
		pinnedAt         *time.Time
		linkPreviewsJSON []byte
		mentionEveryone  string
		reactionsJSON    []byte
		attachmentsJSON  []byte
		replyJSON        []byte
		mentionsJSON     []byte
		channelName      string
		highlight        string
	)
	if err := rows.Scan(&id, &chID, &authID, &body, &kind, &cmid, &created, &edited, &isPinned, &pinnedAt, &linkPreviewsJSON, &mentionEveryone, &reactionsJSON, &attachmentsJSON, &replyJSON, &mentionsJSON, &channelName, &highlight); err != nil {
		return messageView{}, "", "", err
	}
	reactions := map[string]reactionAgg{}
	if len(reactionsJSON) > 0 {
		_ = json.Unmarshal(reactionsJSON, &reactions)
	}
	attachments := []attachmentView{}
	if len(attachmentsJSON) > 0 {
		_ = json.Unmarshal(attachmentsJSON, &attachments)
	}
	var reply *replySnippetView
	if len(replyJSON) > 0 && string(replyJSON) != "null" {
		var snippet replySnippetView
		if json.Unmarshal(replyJSON, &snippet) == nil {
			reply = &snippet
		}
	}
	mentions := []string{}
	if len(mentionsJSON) > 0 {
		_ = json.Unmarshal(mentionsJSON, &mentions)
	}
	return messageView{
		ID:              id.String(),
		ChannelID:       chID.String(),
		AuthorID:        authID.String(),
		Body:            body,
		Kind:            kind,
		ClientMessageID: cmid,
		CreatedAt:       created,
		EditedAt:        edited,
		Reactions:       reactions,
		Attachments:     attachments,
		ReplyTo:         reply,
		Mentions:        mentions,
		IsPinned:        isPinned,
		PinnedAt:        pinnedAt,
		LinkPreviews:    normalizeJSONB(linkPreviewsJSON),
		MentionEveryone: mentionEveryone,
	}, channelName, highlight, nil
}

// PostSystemMessage — H.9: вставляет system-сообщение в канал и публикует
// `message.created` через realtimebus. Используется invite.handleAccept
// (system_join), будущим B.5-финалом (system_call), реоргом каналов
// (system_channel_event).
//
// authorUserID — кто стал причиной события (для join это новый юзер,
// для call — инициатор). body — fallback-текст, который покажется на
// старых клиентах не знающих про kind. Не пишет в audit/mentions/reactions/
// notification_jobs — это служебные плашки, не юзерский контент.
//
// channelID должен указывать на существующий text-канал; вызывающая
// сторона валидирует kind заранее (см. PUT welcome-channel в workspace/).
func (m *Module) PostSystemMessage(ctx context.Context, channelID, workspaceID, authorUserID uuid.UUID, kind, body string) error {
	if kind == "user" {
		return errors.New("PostSystemMessage: kind must be system_*")
	}
	id := uuid.New()
	now := time.Now().UTC()
	_, err := m.db.Exec(ctx,
		`insert into messages (id, channel_id, author_user_id, body, kind, created_at)
		 values ($1, $2, $3, $4, $5, $6)`,
		id, channelID, authorUserID, body, kind, now,
	)
	if err != nil {
		return err
	}
	view, err := m.loadMessageView(ctx, id, authorUserID)
	if err != nil {
		return err
	}
	// G.5.e: для DM-каналов (workspaceID == uuid.Nil — caller сигнализирует
	// этим что канал не workspace-scoped) фан-аут идёт по UserID каждого
	// channel_members, а не через WorkspaceID — публикация в WorkspaceID=""
	// не доехала бы ни до кого. Логика синхронна с publishScope для DM выше.
	if m.publisher != nil {
		raw, mErr := json.Marshal(view)
		if mErr != nil {
			return nil
		}
		if workspaceID == uuid.Nil {
			rows, qerr := m.db.Query(context.Background(),
				`select user_id from channel_members where channel_id = $1`, channelID)
			if qerr != nil {
				return nil
			}
			defer rows.Close()
			for rows.Next() {
				var uid uuid.UUID
				if err := rows.Scan(&uid); err != nil {
					continue
				}
				_ = m.publisher.Publish(context.Background(), realtimebus.Event{
					Event:     "message.created",
					UserID:    uid.String(),
					ChannelID: channelID.String(),
					Payload:   raw,
				})
			}
			return nil
		}
		_ = m.publisher.Publish(context.Background(), realtimebus.Event{
			Event:       "message.created",
			WorkspaceID: workspaceID.String(),
			ChannelID:   channelID.String(),
			Payload:     raw,
		})
	}
	return nil
}

// ---- helpers ----------------------------------------------------------------

func (m *Module) resolveMessageScope(ctx context.Context, w http.ResponseWriter, r *http.Request, messageID, userID uuid.UUID) (uuid.UUID, channel.Scope, bool) {
	var (
		channelID uuid.UUID
		deletedAt *time.Time
	)
	err := m.db.QueryRow(ctx,
		`select channel_id, deleted_at from messages where id = $1`,
		messageID,
	).Scan(&channelID, &deletedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "message not found")
			return uuid.Nil, channel.Scope{}, false
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return uuid.Nil, channel.Scope{}, false
	}
	if deletedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "message already deleted")
		return uuid.Nil, channel.Scope{}, false
	}
	scope, ok := channel.Resolve(ctx, m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return uuid.Nil, channel.Scope{}, false
	}
	return channelID, scope, true
}

func (m *Module) loadMessageView(ctx context.Context, id, viewerID uuid.UUID) (messageView, error) {
	row := m.db.QueryRow(ctx,
		`select `+messageSelectColumns+`
		 from messages m where m.id = $2`,
		viewerID, id,
	)
	var (
		mid, chID, authID uuid.UUID
		body, cmid, kind  string
		created           time.Time
		edited            *time.Time
		isPinned          bool
		pinnedAt          *time.Time
		linkPreviewsJSON  []byte
		mentionEveryone   string
		reactionsJSON     []byte
		attachmentsJSON   []byte
		replyJSON         []byte
		mentionsJSON      []byte
	)
	if err := row.Scan(&mid, &chID, &authID, &body, &kind, &cmid, &created, &edited, &isPinned, &pinnedAt, &linkPreviewsJSON, &mentionEveryone, &reactionsJSON, &attachmentsJSON, &replyJSON, &mentionsJSON); err != nil {
		return messageView{}, err
	}
	reactions := map[string]reactionAgg{}
	if len(reactionsJSON) > 0 {
		_ = json.Unmarshal(reactionsJSON, &reactions)
	}
	attachments := []attachmentView{}
	if len(attachmentsJSON) > 0 {
		_ = json.Unmarshal(attachmentsJSON, &attachments)
	}
	var reply *replySnippetView
	if len(replyJSON) > 0 && string(replyJSON) != "null" {
		var snippet replySnippetView
		if json.Unmarshal(replyJSON, &snippet) == nil {
			reply = &snippet
		}
	}
	mentions := []string{}
	if len(mentionsJSON) > 0 {
		_ = json.Unmarshal(mentionsJSON, &mentions)
	}
	return messageView{
		ID:              mid.String(),
		ChannelID:       chID.String(),
		AuthorID:        authID.String(),
		Body:            body,
		Kind:            kind,
		ClientMessageID: cmid,
		CreatedAt:       created,
		EditedAt:        edited,
		Reactions:       reactions,
		Attachments:     attachments,
		ReplyTo:         reply,
		Mentions:        mentions,
		IsPinned:        isPinned,
		PinnedAt:        pinnedAt,
		LinkPreviews:    normalizeJSONB(linkPreviewsJSON),
		MentionEveryone: mentionEveryone,
	}, nil
}

// normalizeJSONB — NULL-jsonb приходит как nil или "null"; для omitempty
// в view нужен честный nil.
func normalizeJSONB(raw []byte) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}

func (m *Module) publish(eventName string, workspaceID, channelID uuid.UUID, payload any) {
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
		ChannelID:   channelID.String(),
		Payload:     raw,
	})
}

// publishScope — публикует событие с учётом DM-семантики. Для workspace-каналов
// fan-out идёт через WorkspaceID. Для DM (workspace_id отсутствует) — по
// UserID каждого участника channel_members; так событие доезжает до обеих
// сторон (включая другие сессии автора) без подписки на воркспейс.
func (m *Module) publishScope(eventName string, scope channel.Scope, channelID uuid.UUID, payload any) {
	if m.publisher == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if scope.Kind != "dm" {
		_ = m.publisher.Publish(context.Background(), realtimebus.Event{
			Event:       eventName,
			WorkspaceID: scope.WorkspaceID.String(),
			ChannelID:   channelID.String(),
			Payload:     raw,
		})
		return
	}
	rows, err := m.db.Query(context.Background(),
		`select user_id from channel_members where channel_id = $1`, channelID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err != nil {
			continue
		}
		_ = m.publisher.Publish(context.Background(), realtimebus.Event{
			Event:     eventName,
			UserID:    uid.String(),
			ChannelID: channelID.String(),
			Payload:   raw,
		})
	}
}

func scanMessageWithReactions(rows pgx.Rows) (messageView, error) {
	var (
		id, chID, authID uuid.UUID
		body, cmid, kind string
		created          time.Time
		edited           *time.Time
		isPinned         bool
		pinnedAt         *time.Time
		linkPreviewsJSON []byte
		mentionEveryone  string
		reactionsJSON    []byte
		attachmentsJSON  []byte
		replyJSON        []byte
		mentionsJSON     []byte
	)
	if err := rows.Scan(&id, &chID, &authID, &body, &kind, &cmid, &created, &edited, &isPinned, &pinnedAt, &linkPreviewsJSON, &mentionEveryone, &reactionsJSON, &attachmentsJSON, &replyJSON, &mentionsJSON); err != nil {
		return messageView{}, err
	}
	reactions := map[string]reactionAgg{}
	if len(reactionsJSON) > 0 {
		_ = json.Unmarshal(reactionsJSON, &reactions)
	}
	attachments := []attachmentView{}
	if len(attachmentsJSON) > 0 {
		_ = json.Unmarshal(attachmentsJSON, &attachments)
	}
	var reply *replySnippetView
	if len(replyJSON) > 0 && string(replyJSON) != "null" {
		var snippet replySnippetView
		if json.Unmarshal(replyJSON, &snippet) == nil {
			reply = &snippet
		}
	}
	mentions := []string{}
	if len(mentionsJSON) > 0 {
		_ = json.Unmarshal(mentionsJSON, &mentions)
	}
	return messageView{
		ID:              id.String(),
		ChannelID:       chID.String(),
		AuthorID:        authID.String(),
		Body:            body,
		Kind:            kind,
		ClientMessageID: cmid,
		CreatedAt:       created,
		EditedAt:        edited,
		Reactions:       reactions,
		Attachments:     attachments,
		ReplyTo:         reply,
		Mentions:        mentions,
		IsPinned:        isPinned,
		PinnedAt:        pinnedAt,
		LinkPreviews:    normalizeJSONB(linkPreviewsJSON),
		MentionEveryone: mentionEveryone,
	}, nil
}

// ---- pins -------------------------------------------------------------------

// Discord-cap: не более 50 pinned в одном канале. В БД hard-cap не ставим
// (миграция проще + админам иногда нужно временно превысить), проверяем здесь.
const maxPinsPerChannel = 50

func (m *Module) handlePin(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}
	var (
		channelID uuid.UUID
		deletedAt *time.Time
		isPinned  bool
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id, deleted_at, is_pinned from messages where id = $1`,
		messageID,
	).Scan(&channelID, &deletedAt, &isPinned)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "message not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if deletedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot pin deleted message")
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	// DM: оба участника могут пинить, нет moderate-роли. Для workspace —
	// MessageModerate (та же роль, что для delete и reaction.removeAll).
	if scope.Kind != "dm" {
		if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.MessageModerate); !allowed {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role to pin")
			return
		}
	}
	if isPinned {
		// Idempotent — клиент мог продолбать predicate. Возвращаем актуальный view.
		view, err := m.loadMessageView(r.Context(), messageID, userID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload message")
			return
		}
		sharedhttp.WriteJSON(w, http.StatusOK, view)
		return
	}
	var count int
	if err := m.db.QueryRow(r.Context(),
		`select count(*) from messages where channel_id = $1 and is_pinned = true and deleted_at is null`,
		channelID,
	).Scan(&count); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if count >= maxPinsPerChannel {
		sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeValidationFailed,
			"channel pin limit reached (50)")
		return
	}
	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update messages set is_pinned = true, pinned_at = $1, pinned_by = $2 where id = $3`,
		now, userID, messageID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not pin message")
		return
	}
	view, err := m.loadMessageView(r.Context(), messageID, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload message")
		return
	}
	m.publishScope("message.pinned", scope, channelID, view)
	if scope.Kind != "dm" {
		auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
			ActorID:     userID,
			WorkspaceID: scope.WorkspaceID,
			Action:      auditlog.ActionMessagePinned,
			TargetType:  "message",
			TargetID:    messageID.String(),
		})
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) handleUnpin(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}
	var (
		channelID uuid.UUID
		isPinned  bool
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id, is_pinned from messages where id = $1`,
		messageID,
	).Scan(&channelID, &isPinned)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "message not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	if scope.Kind != "dm" {
		if _, _, allowed := permission.Authorize(r.Context(), m.db, scope.WorkspaceID, userID, permission.MessageModerate); !allowed {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role to unpin")
			return
		}
	}
	if !isPinned {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if _, err := m.db.Exec(r.Context(),
		`update messages set is_pinned = false, pinned_at = null, pinned_by = null where id = $1`,
		messageID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not unpin message")
		return
	}
	m.publishScope("message.unpinned", scope, channelID, map[string]any{
		"id":        messageID.String(),
		"channelId": channelID.String(),
	})
	if scope.Kind != "dm" {
		auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
			ActorID:     userID,
			WorkspaceID: scope.WorkspaceID,
			Action:      auditlog.ActionMessageUnpinned,
			TargetType:  "message",
			TargetID:    messageID.String(),
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleListPins(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	if _, ok := channel.Resolve(r.Context(), m.db, channelID, userID); !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	rows, err := m.db.Query(r.Context(),
		`select `+messageSelectColumns+`
		 from messages m
		 where m.channel_id = $2 and m.is_pinned = true and m.deleted_at is null
		 order by m.pinned_at desc nulls last
		 limit 50`,
		userID, channelID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]messageView, 0)
	for rows.Next() {
		v, err := scanMessageWithReactions(rows)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, v)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
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

func decodeEmoji(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", false
	}
	decoded = strings.TrimSpace(decoded)
	if decoded == "" || len(decoded) > maxEmojiLen {
		return "", false
	}
	return decoded, true
}
