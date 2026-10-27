// Package notification — in-app уведомления (C.8).
//
// Архитектура:
//   - core-api в местах создания события (POST message с mentions/reply,
//     POST /calls для 1-к-1) вызывает Enqueue, который пишет задачу в
//     notification_jobs.
//   - worker'ный NotificationRunner подхватывает задачу и раскладывает
//     записи в user_notifications + публикует realtime-эвент
//     notification.created в UserID-канал.
//   - этот модуль обслуживает чтение: GET /notifications,
//     GET /notifications/count, POST /notifications/read (mark-all-read),
//     POST /notifications/{id}/read (single).
package notification

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"
	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/routing"
)

const (
	defaultLimit = 30
	maxLimit     = 100

	KindMention      = "mention"
	KindReply        = "reply"
	KindCallIncoming = "call_incoming"
	// KindMentionEveryone — массовый пинг @everyone/@here (Wave 4).
	// Recipients в payload пуст: worker сам разворачивает список по
	// участникам канала на момент доставки (актуальнее и не раздувает jsonb).
	KindMentionEveryone = "mention_everyone"
)

// JobPayload — структура, которую core-api enqueue'ит и которую парсит
// worker (services/worker/internal/jobs/notifications.go).
// Recipients — список user_id строк, кому раскладывать.
type JobPayload struct {
	Recipients  []string `json:"recipients"`
	ActorID     string   `json:"actorId,omitempty"`
	WorkspaceID string   `json:"workspaceId,omitempty"`
	ChannelID   string   `json:"channelId,omitempty"`
	MessageID   string   `json:"messageId,omitempty"`
	CallID      string   `json:"callId,omitempty"`
	Snippet     string   `json:"snippet,omitempty"`
	// mention_everyone: 'everyone' | 'here' — что именно сработало.
	MentionKind string `json:"mentionKind,omitempty"`
	// mention_everyone: кого worker исключает из развёрнутого списка
	// (автор + персонально упомянутые + автор parent'а reply — они уже
	// получили свои нотификации, дубль не нужен).
	Exclude []string `json:"exclude,omitempty"`
}

// Querier — pgx.Pool либо pgx.Tx. Enqueue работает и снаружи, и
// внутри транзакции, чтобы атомарно с insert сообщения положить задачу.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Enqueue кладёт задачу в notification_jobs. recipients фильтруются от
// пустых/невалидных uuid; если после фильтра список пуст — no-op.
// Исключение — KindMentionEveryone: там список разворачивает worker.
func Enqueue(ctx context.Context, q Querier, kind string, payload JobPayload) error {
	if len(payload.Recipients) == 0 && kind != KindMentionEveryone {
		return nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx,
		`insert into notification_jobs (kind, payload) values ($1, $2)`,
		kind, raw,
	)
	return err
}

type Module struct {
	db     *postgres.Pool
	logger *slog.Logger
}

func NewModule(db *postgres.Pool, logger *slog.Logger) *Module {
	return &Module{db: db, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/notifications", m.handleList)
	router.Protected("GET /api/v1/notifications/count", m.handleCount)
	router.Protected("POST /api/v1/notifications/read", m.handleMarkAllRead)
	router.Protected("POST /api/v1/notifications/{notificationId}/read", m.handleMarkOneRead)
	// Wave 4 — персистентные уровни уведомлений (см. prefs.go).
	router.Protected("GET /api/v1/users/me/notification-prefs", m.handleGetPrefs)
	router.Protected("PUT /api/v1/channels/{channelId}/notification-pref", m.handlePutChannelPref)
	router.Protected("PUT /api/v1/workspaces/{workspaceId}/notification-pref", m.handlePutWorkspacePref)
}

type notificationView struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
	ReadAt    *time.Time      `json:"readAt,omitempty"`
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
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

	visibleIDs, err := m.visibleChannelIDs(r.Context(), userID, before)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "notification access unavailable")
		return
	}
	rows, err := m.db.Query(r.Context(),
		`select id, kind, payload, created_at, read_at
		 from user_notifications
		 where user_id = $1 and created_at < $2
		 and jsonb_typeof(payload) = 'object'
		 and ((payload->>'channelId') = any($4::text[])
		      or (coalesce(payload->>'channelId', '') = '' and kind not in ('mention','reply','mention_everyone')))
		 order by created_at desc
		 limit $3`,
		userID, before, limit, visibleIDs,
	)
	if err != nil {
		m.logger.Error("notifications list failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]notificationView, 0)
	for rows.Next() {
		var (
			id        uuid.UUID
			kind      string
			payload   []byte
			createdAt time.Time
			readAt    *time.Time
		)
		if err := rows.Scan(&id, &kind, &payload, &createdAt, &readAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, notificationView{
			ID:        id.String(),
			Kind:      kind,
			Payload:   payload,
			CreatedAt: createdAt,
			ReadAt:    readAt,
		})
	}
	var nextCursor string
	if len(items) == limit {
		nextCursor = items[len(items)-1].CreatedAt.Format(time.RFC3339Nano)
	}
	if err := rows.Err(); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	rows.Close()
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"nextCursor": nextCursor,
	})
}

func (m *Module) handleCount(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	rows, err := m.db.Query(r.Context(),
		`select kind, coalesce(payload->>'channelId', ''), count(*) from user_notifications
		 where user_id = $1 and read_at is null and jsonb_typeof(payload) = 'object'
		 group by kind, payload->>'channelId'`, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	type group struct {
		id            uuid.UUID
		scoped, valid bool
		count         int
	}
	groups := []group{}
	ids := []uuid.UUID{}
	seen := map[uuid.UUID]bool{}
	for rows.Next() {
		var kind, channel string
		var count int
		if err := rows.Scan(&kind, &channel, &count); err != nil {
			rows.Close()
			sharedhttp.WriteError(w, r, 500, sharedhttp.CodeInternal, "database error")
			return
		}
		payload, _ := json.Marshal(map[string]string{"channelId": channel})
		id, scoped, valid := notificationChannel(kind, payload)
		groups = append(groups, group{id, scoped, valid, count})
		if scoped && valid && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		sharedhttp.WriteError(w, r, 500, sharedhttp.CodeInternal, "database error")
		return
	}
	access, err := channelacl.VisibleChannels(r.Context(), m.db, ids, []uuid.UUID{userID})
	if err != nil {
		sharedhttp.WriteError(w, r, 500, sharedhttp.CodeInternal, "notification access unavailable")
		return
	}
	count := 0
	for _, g := range groups {
		if g.valid && (!g.scoped || access[userID][g.id]) {
			count += g.count
		}
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"unread": count})
}

func (m *Module) handleMarkAllRead(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`update user_notifications set read_at = $1 where user_id = $2 and read_at is null`,
		now, userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleMarkOneRead(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	raw := r.PathValue("notificationId")
	id, err := uuid.Parse(raw)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid id")
		return
	}
	now := time.Now().UTC()
	tag, err := m.db.Exec(r.Context(),
		`update user_notifications set read_at = $1 where id = $2 and user_id = $3 and read_at is null`,
		now, id, userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		// либо уже read, либо чужое — 404 не палит факт существования
		var exists bool
		_ = m.db.QueryRow(r.Context(),
			`select exists(select 1 from user_notifications where id = $1 and user_id = $2)`,
			id, userID,
		).Scan(&exists)
		if !exists {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "notification not found")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
