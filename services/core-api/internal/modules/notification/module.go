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

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const (
	defaultLimit = 30
	maxLimit     = 100

	KindMention      = "mention"
	KindReply        = "reply"
	KindCallIncoming = "call_incoming"
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
}

// Querier — pgx.Pool либо pgx.Tx. Enqueue работает и снаружи, и
// внутри транзакции, чтобы атомарно с insert сообщения положить задачу.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Enqueue кладёт задачу в notification_jobs. recipients фильтруются от
// пустых/невалидных uuid; если после фильтра список пуст — no-op.
func Enqueue(ctx context.Context, q Querier, kind string, payload JobPayload) error {
	if len(payload.Recipients) == 0 {
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

	rows, err := m.db.Query(r.Context(),
		`select id, kind, payload, created_at, read_at
		 from user_notifications
		 where user_id = $1 and created_at < $2
		 order by created_at desc
		 limit $3`,
		userID, before, limit,
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
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"nextCursor": nextCursor,
	})
}

func (m *Module) handleCount(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var count int
	err := m.db.QueryRow(r.Context(),
		`select count(*) from user_notifications where user_id = $1 and read_at is null`,
		userID,
	).Scan(&count)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
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

