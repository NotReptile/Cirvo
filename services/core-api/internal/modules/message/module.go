package message

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const (
	defaultLimit = 50
	maxLimit     = 200
	maxBodyChars = 8000
	maxEmojiLen  = 64
)

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher) *Module {
	return &Module{db: db, publisher: publisher}
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

type messageView struct {
	ID              string     `json:"id"`
	ChannelID       string     `json:"channelId"`
	AuthorID        string     `json:"authorId"`
	Body            string     `json:"body"`
	ClientMessageID string     `json:"clientMessageId,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	EditedAt        *time.Time `json:"editedAt,omitempty"`
	DeletedAt       *time.Time `json:"deletedAt,omitempty"`
}

type createRequest struct {
	Body            string `json:"body"`
	ClientMessageID string `json:"clientMessageId"`
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
		`select id, channel_id, author_user_id, body, coalesce(client_message_id, ''), created_at, edited_at
		 from messages
		 where channel_id = $1 and deleted_at is null and created_at < $2
		 order by created_at desc
		 limit $3`,
		channelID, before, limit,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]messageView, 0)
	for rows.Next() {
		v, err := scanMessage(rows)
		if err != nil {
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
	if req.Body == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body must not be empty")
		return
	}
	if len(req.Body) > maxBodyChars {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "body too long")
		return
	}

	if req.ClientMessageID != "" {
		var (
			existingID uuid.UUID
			body       string
			created    time.Time
			edited     *time.Time
			cmid       string
		)
		err := m.db.QueryRow(r.Context(),
			`select id, body, created_at, edited_at, coalesce(client_message_id, '')
			 from messages
			 where channel_id = $1 and author_user_id = $2 and client_message_id = $3`,
			channelID, userID, req.ClientMessageID,
		).Scan(&existingID, &body, &created, &edited, &cmid)
		if err == nil {
			sharedhttp.WriteJSON(w, http.StatusOK, messageView{
				ID:              existingID.String(),
				ChannelID:       channelID.String(),
				AuthorID:        userID.String(),
				Body:            body,
				ClientMessageID: cmid,
				CreatedAt:       created,
				EditedAt:        edited,
			})
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
			return
		}
	}

	messageID := uuid.New()
	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`insert into messages (id, channel_id, author_user_id, body, client_message_id, created_at)
		 values ($1, $2, $3, $4, nullif($5, ''), $6)`,
		messageID, channelID, userID, req.Body, req.ClientMessageID, now,
	)
	if err != nil {
		if strings.Contains(err.Error(), "SQLSTATE 23505") {
			sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeMessageAlreadyExists, "client message id already used")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create message")
		return
	}

	view := messageView{
		ID:              messageID.String(),
		ChannelID:       channelID.String(),
		AuthorID:        userID.String(),
		Body:            req.Body,
		ClientMessageID: req.ClientMessageID,
		CreatedAt:       now,
	}
	m.publish("message.created", scope.WorkspaceID, channelID, view)
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
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
		role, ok := workspace.RoleOf(r.Context(), m.db, scope.WorkspaceID, userID)
		if !ok || !workspace.CanModerate(role) {
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

func scanMessage(rows pgx.Rows) (messageView, error) {
	var (
		id, chID, authID uuid.UUID
		body, cmid       string
		created          time.Time
		edited           *time.Time
	)
	if err := rows.Scan(&id, &chID, &authID, &body, &cmid, &created, &edited); err != nil {
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
