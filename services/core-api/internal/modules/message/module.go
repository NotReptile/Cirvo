package message

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const (
	defaultLimit       = 50
	maxLimit           = 200
	maxBodyChars       = 8000
	maxEmojiLen        = 64
	replySnippetMaxLen = 120
)

// messageSelectColumns — общий список колонок для list/loadOne, чтобы
// scanMessageWithReactions работал одинаково. $N плейсхолдеры:
// $1 — viewer userID (для bool_or в reactions). Каждый вызов добавит
// свои дополнительные параметры в where после этой константы.
const messageSelectColumns = `m.id, m.channel_id, m.author_user_id, m.body,
        coalesce(m.client_message_id, ''), m.created_at, m.edited_at,
        coalesce(
          (select jsonb_object_agg(emoji, jsonb_build_object('count', cnt, 'mine', mine))
           from (
             select emoji, count(*) as cnt, bool_or(user_id = $1) as mine
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
        end as reply_to`

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, logger *slog.Logger) *Module {
	return &Module{db: db, publisher: publisher, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/channels/{channelId}/messages", m.handleList)
	router.Protected("POST /api/v1/channels/{channelId}/messages", m.handleCreate)
	router.Protected("PATCH /api/v1/messages/{messageId}", m.handleEdit)
	router.Protected("DELETE /api/v1/messages/{messageId}", m.handleDelete)
	router.Protected("PUT /api/v1/messages/{messageId}/reactions/{emoji}", m.handleAddReaction)
	router.Protected("DELETE /api/v1/messages/{messageId}/reactions/{emoji}", m.handleRemoveReaction)
	router.Protected("POST /api/v1/channels/{channelId}/read", m.handleMarkRead)
	router.Protected("GET /api/v1/channels/{channelId}/read", m.handleGetRead)
}

type reactionAgg struct {
	Count int  `json:"count"`
	Mine  bool `json:"mine"`
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
	ClientMessageID string                 `json:"clientMessageId,omitempty"`
	CreatedAt       time.Time              `json:"createdAt"`
	EditedAt        *time.Time             `json:"editedAt,omitempty"`
	DeletedAt       *time.Time             `json:"deletedAt,omitempty"`
	Reactions       map[string]reactionAgg `json:"reactions"`
	Attachments     []attachmentView       `json:"attachments"`
	ReplyTo         *replySnippetView      `json:"replyTo,omitempty"`
}

type createRequest struct {
	Body              string   `json:"body"`
	ClientMessageID   string   `json:"clientMessageId"`
	AttachmentIDs     []string `json:"attachmentIds"`
	ReplyToMessageID  string   `json:"replyToMessageId,omitempty"`
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
	if scope.Kind != "text" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "channel does not accept messages")
		return
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
	if len(req.Body) > maxBodyChars {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body too long")
		return
	}

	// reply_to: parent должен жить в том же канале и не быть удалён.
	// Иначе reply теряет смысл (или это попытка процитировать сообщение
	// из приватного канала, к которому юзер не имеет доступа).
	var replyToID *uuid.UUID
	if req.ReplyToMessageID != "" {
		pid, err := uuid.Parse(req.ReplyToMessageID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid replyToMessageId")
			return
		}
		var parentChannel uuid.UUID
		var parentDeleted *time.Time
		err = m.db.QueryRow(r.Context(),
			`select channel_id, deleted_at from messages where id = $1`,
			pid,
		).Scan(&parentChannel, &parentDeleted)
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

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	messageID := uuid.New()
	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into messages (id, channel_id, author_user_id, body, client_message_id, created_at, reply_to_message_id)
		 values ($1, $2, $3, $4, nullif($5, ''), $6, $7)`,
		messageID, channelID, userID, req.Body, req.ClientMessageID, now, replyToID,
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

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	view, err := m.loadMessageView(r.Context(), messageID, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload message")
		return
	}
	m.publish("message.created", scope.WorkspaceID, channelID, view)
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
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
	if len(req.Body) > maxBodyChars {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body too long")
		return
	}

	var (
		channelID uuid.UUID
		authorID  uuid.UUID
		deletedAt *time.Time
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id, author_user_id, deleted_at from messages where id = $1`,
		messageID,
	).Scan(&channelID, &authorID, &deletedAt)
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
	_, err = m.db.Exec(r.Context(),
		`update messages set body = $1, edited_at = $2 where id = $3`,
		req.Body, now, messageID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update message")
		return
	}

	view, err := m.loadMessage(r.Context(), messageID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload message")
		return
	}
	m.publish("message.updated", scope.WorkspaceID, channelID, view)
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
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id, author_user_id, deleted_at from messages where id = $1`,
		messageID,
	).Scan(&channelID, &authorID, &deletedAt)
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
	if authorID != userID {
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
	m.publish("message.deleted", scope.WorkspaceID, channelID, map[string]any{
		"id":        messageID.String(),
		"channelId": channelID.String(),
		"deletedAt": now,
	})
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:     userID,
		WorkspaceID: scope.WorkspaceID,
		Action:      auditlog.ActionMessageDeleted,
		TargetType:  "message",
		TargetID:    messageID.String(),
	})
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
	m.publish("message.reaction.added", scope.WorkspaceID, channelID, map[string]any{
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
	m.publish("message.reaction.removed", scope.WorkspaceID, channelID, map[string]any{
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
	m.publish("channel.read", scope.WorkspaceID, channelID, view)
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
		body, cmid        string
		created           time.Time
		edited            *time.Time
		reactionsJSON     []byte
		attachmentsJSON   []byte
		replyJSON         []byte
	)
	if err := row.Scan(&mid, &chID, &authID, &body, &cmid, &created, &edited, &reactionsJSON, &attachmentsJSON, &replyJSON); err != nil {
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
	return messageView{
		ID:              mid.String(),
		ChannelID:       chID.String(),
		AuthorID:        authID.String(),
		Body:            body,
		ClientMessageID: cmid,
		CreatedAt:       created,
		EditedAt:        edited,
		Reactions:       reactions,
		Attachments:     attachments,
		ReplyTo:         reply,
	}, nil
}

func (m *Module) loadMessage(ctx context.Context, id uuid.UUID) (messageView, error) {
	var (
		chID, authID uuid.UUID
		body, cmid   string
		created      time.Time
		edited       *time.Time
		deleted      *time.Time
	)
	err := m.db.QueryRow(ctx,
		`select channel_id, author_user_id, body, coalesce(client_message_id, ''), created_at, edited_at, deleted_at
		 from messages where id = $1`,
		id,
	).Scan(&chID, &authID, &body, &cmid, &created, &edited, &deleted)
	if err != nil {
		return messageView{}, err
	}
	return messageView{
		ID:              id.String(),
		ChannelID:       chID.String(),
		AuthorID:        authID.String(),
		Body:            body,
		ClientMessageID: cmid,
		CreatedAt:       created,
		EditedAt:        edited,
		DeletedAt:       deleted,
	}, nil
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

func scanMessageWithReactions(rows pgx.Rows) (messageView, error) {
	var (
		id, chID, authID uuid.UUID
		body, cmid       string
		created          time.Time
		edited           *time.Time
		reactionsJSON    []byte
		attachmentsJSON  []byte
		replyJSON        []byte
	)
	if err := rows.Scan(&id, &chID, &authID, &body, &cmid, &created, &edited, &reactionsJSON, &attachmentsJSON, &replyJSON); err != nil {
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
	return messageView{
		ID:              id.String(),
		ChannelID:       chID.String(),
		AuthorID:        authID.String(),
		Body:            body,
		ClientMessageID: cmid,
		CreatedAt:       created,
		EditedAt:        edited,
		Reactions:       reactions,
		Attachments:     attachments,
		ReplyTo:         reply,
	}, nil
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
