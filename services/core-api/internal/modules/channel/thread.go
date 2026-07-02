// Wave 10: треды на сообщениях. Тред = дочерний канал kind='thread' с
// parent_channel_id → text-канал и root_message_id → корневое сообщение
// (посты форума из forum.go — та же модель, но без якоря на сообщение).
// Message-инфраструктура (вложения/reactions/mentions/realtime/typing)
// работает в треде бесплатно, клиент открывает его как обычный канал.
//
// Один тред на сообщение: unique-индекс channels_root_message_uidx
// (миграция 39); повторный POST возвращает существующий тред (200) —
// endpoint идемпотентен, «Открыть тред» и «Создать тред» — одна кнопка.
package channel

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
)

type threadCreateRequest struct {
	// Title опционален: пустой = первые 64 руны корневого сообщения.
	Title string `json:"title"`
}

// threadTitleFromBody — заголовок из тела корневого сообщения: схлопываем
// пробелы/переводы строк, режем до 64 рун. Пустое тело (attachment-only
// сообщение) — фолбэк «Тред» (серверные плашки уже по-русски, см. H.9).
func threadTitleFromBody(body string) string {
	title := strings.Join(strings.Fields(body), " ")
	if runes := []rune(title); len(runes) > 64 {
		title = strings.TrimSpace(string(runes[:64])) + "…"
	}
	if title == "" {
		title = "Тред"
	}
	return title
}

func (m *Module) handleThreadCreate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	messageID, ok := parseUUID(r, "messageId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid message id")
		return
	}
	scope, ok := Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	// Только text-каналы: в DM нет workspace-контекста для channel.created
	// fan-out'а, во voice/forum треды на сообщениях не имеют смысла
	// (у форума свои посты). Вложенные треды (thread-в-thread) — запрет.
	if scope.Kind != "text" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "threads can be started only in text channels")
		return
	}
	var archivedAt *time.Time
	if err := m.db.QueryRow(r.Context(),
		`select archived_at from channels where id = $1`, channelID).Scan(&archivedAt); err == nil && archivedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "channel is archived")
		return
	}
	// Право открыть тред = право писать сообщения (та же семантика, что у
	// форум-постов): deny message.write закрывает и треды.
	if !permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, channelID, userID, permission.MessageWrite) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	// Корневое сообщение: живое user-сообщение этого же канала. Системные
	// плашки тредов не заводят.
	var rootBody, rootKind string
	var rootDeleted *time.Time
	err := m.db.QueryRow(r.Context(),
		`select body, kind, deleted_at from messages where id = $1 and channel_id = $2`,
		messageID, channelID,
	).Scan(&rootBody, &rootKind, &rootDeleted)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "message not found in this channel")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if rootDeleted != nil || rootKind != "user" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot start a thread on this message")
		return
	}

	var req threadCreateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if len([]rune(req.Title)) > 96 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "title must be ≤96 chars")
		return
	}
	if req.Title == "" {
		req.Title = threadTitleFromBody(rootBody)
	}

	threadID := uuid.New()
	now := time.Now().UTC()
	tag, err := m.db.Exec(r.Context(),
		`insert into channels (id, workspace_id, kind, name, is_private, position, created_at, updated_at, parent_channel_id, root_message_id)
		 values ($1, $2, 'thread', $3, false, 0, $4, $4, $5, $6)
		 on conflict (root_message_id) where root_message_id is not null do nothing`,
		threadID, scope.WorkspaceID, req.Title, now, channelID, messageID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create thread")
		return
	}
	if tag.RowsAffected() == 0 {
		// Тред уже есть (вторая кнопка/другой клиент) — отдаём существующий.
		var v channelView
		var existingID uuid.UUID
		var createdAt time.Time
		if err := m.db.QueryRow(r.Context(),
			`select id, name, created_at from channels where root_message_id = $1`, messageID,
		).Scan(&existingID, &v.Name, &createdAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
			return
		}
		parent := channelID.String()
		root := messageID.String()
		v.ID = existingID.String()
		v.WorkspaceID = scope.WorkspaceID.String()
		v.Kind = "thread"
		v.CreatedAt = createdAt
		v.ParentChannelID = &parent
		v.RootMessageID = &root
		sharedhttp.WriteJSON(w, http.StatusOK, v)
		return
	}

	parent := channelID.String()
	root := messageID.String()
	view := channelView{
		ID:              threadID.String(),
		WorkspaceID:     scope.WorkspaceID.String(),
		Kind:            "thread",
		Name:            req.Title,
		IsPrivate:       false,
		Position:        0,
		CreatedAt:       now,
		ParentChannelID: &parent,
		RootMessageID:   &root,
	}
	// channel.created — клиенты добавят тред в state.channels и повесят чип
	// «0 ответов» на корневое сообщение (по rootMessageId из payload'а).
	m.publish("channel.created", scope.WorkspaceID, threadID.String(), view)
	// Первая плашка внутри треда — контекст, из какого сообщения он вырос
	// (лента треда не показывает корневое сообщение, оно живёт в родителе).
	if m.messages != nil {
		body := "Тред начат из сообщения: «" + threadTitleFromBody(rootBody) + "»"
		if err := m.messages.PostSystemMessage(r.Context(), threadID, scope.WorkspaceID, userID, "system_channel_event", body); err != nil {
			m.logger.Warn("thread.create: PostSystemMessage failed", slog.String("err", err.Error()))
		}
	}
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}
