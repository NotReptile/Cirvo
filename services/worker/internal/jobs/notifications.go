// Package jobs — обработчик очереди notification_jobs (C.8).
//
// Архитектура повторяет media_jobs runner: один claim через FOR UPDATE
// SKIP LOCKED, ретраи через exponential backoff. Отдельный runner (а не
// reuse Runner) — потому что Job там завязан на media_id; обобщать ради
// двух очередей оверкилл.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
)

// NotificationJob — claim'ленная задача из notification_jobs.
type NotificationJob struct {
	ID       uuid.UUID
	Kind     string          // mention | reply | call_incoming
	Payload  json.RawMessage // см. payloadShape ниже
	Attempts int
}

// payloadShape — структура payload, которую core-api enqueue'ит в БД.
// recipients — кому раскладываем user_notifications.
//   - actorId       — кто инициировал (автор сообщения / звонящий)
//   - workspaceId   — для роутинга realtime-эвентов на клиенте
//   - channelId     — где произошло (для mention/reply)
//   - messageId     — для mention/reply
//   - callId        — для call_incoming
//   - snippet       — обрезанный body для предпросмотра (mention/reply)
type notificationPayload struct {
	Recipients  []string `json:"recipients"`
	ActorID     string   `json:"actorId,omitempty"`
	WorkspaceID string   `json:"workspaceId,omitempty"`
	ChannelID   string   `json:"channelId,omitempty"`
	MessageID   string   `json:"messageId,omitempty"`
	CallID      string   `json:"callId,omitempty"`
	Snippet     string   `json:"snippet,omitempty"`
}

type NotificationRunner struct {
	logger    *slog.Logger
	db        *postgres.Pool
	publisher *realtimebus.Publisher
}

func NewNotificationRunner(logger *slog.Logger, db *postgres.Pool, redis *redisstore.Client) *NotificationRunner {
	var pub *realtimebus.Publisher
	if redis != nil {
		pub = realtimebus.NewPublisher(redis)
	}
	return &NotificationRunner{logger: logger, db: db, publisher: pub}
}

func (r *NotificationRunner) Run(ctx context.Context) {
	r.logger.Info("notification loop ready")
	lastHeartbeat := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			r.logger.Info("notification worker stopped")
			return
		}
		job, ok, err := r.claim(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				r.logger.Error("notification claim failed", "error", err)
			}
			if !sleep(ctx, pollIdle) {
				return
			}
			continue
		}
		if !ok {
			if time.Since(lastHeartbeat) >= heartbeatMin {
				r.logger.Info("notification worker heartbeat")
				lastHeartbeat = time.Now()
			}
			if !sleep(ctx, pollIdle) {
				return
			}
			continue
		}
		r.process(ctx, job)
		if !sleep(ctx, pollActive) {
			return
		}
	}
}

func (r *NotificationRunner) claim(ctx context.Context) (NotificationJob, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var job NotificationJob
	err := r.db.QueryRow(ctx, `
		update notification_jobs
		set status = 'running',
		    started_at = now(),
		    attempts = attempts + 1
		where id = (
		  select id from notification_jobs
		  where status = 'pending' and scheduled_at <= now()
		  order by scheduled_at
		  for update skip locked
		  limit 1
		)
		returning id, kind, payload, attempts
	`).Scan(&job.ID, &job.Kind, &job.Payload, &job.Attempts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NotificationJob{}, false, nil
		}
		return NotificationJob{}, false, err
	}
	return job, true, nil
}

func (r *NotificationRunner) process(parent context.Context, job NotificationJob) {
	ctx, cancel := context.WithTimeout(parent, jobTimeout)
	defer cancel()

	if err := r.handle(ctx, job); err != nil {
		r.logger.Warn("notification job failed", "kind", job.Kind, "id", job.ID, "attempt", job.Attempts, "error", err)
		terminal := job.Attempts >= maxAttempts
		r.fail(parent, job, err, terminal)
		return
	}
	r.markDone(parent, job)
}

func (r *NotificationRunner) handle(ctx context.Context, job NotificationJob) error {
	var p notificationPayload
	if err := json.Unmarshal(job.Payload, &p); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if len(p.Recipients) == 0 {
		// Пустой список — задача невалидна, но раскладывать нечего;
		// помечаем done чтобы не ретраить.
		return nil
	}

	for _, raw := range p.Recipients {
		uid, err := uuid.Parse(raw)
		if err != nil {
			r.logger.Warn("notification: invalid recipient uuid", "value", raw)
			continue
		}
		notifID := uuid.New()
		// payload в user_notifications не дублируем recipients (они уже
		// разложены по user_id-строкам).
		row := map[string]any{
			"actorId":     p.ActorID,
			"workspaceId": p.WorkspaceID,
			"channelId":   p.ChannelID,
			"messageId":   p.MessageID,
			"callId":      p.CallID,
			"snippet":     p.Snippet,
		}
		rowJSON, _ := json.Marshal(row)
		now := time.Now().UTC()
		_, err = r.db.Exec(ctx,
			`insert into user_notifications (id, user_id, kind, payload, created_at)
			 values ($1, $2, $3, $4, $5)`,
			notifID, uid, job.Kind, rowJSON, now,
		)
		if err != nil {
			return fmt.Errorf("insert notification for %s: %w", uid, err)
		}
		if r.publisher != nil {
			evtPayload, _ := json.Marshal(map[string]any{
				"id":        notifID.String(),
				"userId":    uid.String(),
				"kind":      job.Kind,
				"createdAt": now,
				"payload":   row,
			})
			_ = r.publisher.Publish(context.Background(), realtimebus.Event{
				Event:   "notification.created",
				UserID:  uid.String(),
				Payload: evtPayload,
			})
		}
	}
	return nil
}

func (r *NotificationRunner) markDone(ctx context.Context, job NotificationJob) {
	ctx, cancel := context.WithTimeout(detach(ctx), 5*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`update notification_jobs set status = 'done', finished_at = now(), last_error = null where id = $1`,
		job.ID,
	)
	if err != nil {
		r.logger.Error("could not mark notification job done", "id", job.ID, "error", err)
		return
	}
	r.logger.Info("notification job done", "kind", job.Kind, "id", job.ID)
}

func (r *NotificationRunner) fail(ctx context.Context, job NotificationJob, jobErr error, terminal bool) {
	ctx, cancel := context.WithTimeout(detach(ctx), 5*time.Second)
	defer cancel()
	status := "pending"
	scheduledAt := time.Now().Add(backoff(job.Attempts))
	if terminal {
		status = "failed"
	}
	_, err := r.db.Exec(ctx,
		`update notification_jobs
		 set status = $1, last_error = $2, scheduled_at = $3,
		     finished_at = case when $1 = 'failed' then now() else null end
		 where id = $4`,
		status, jobErr.Error(), scheduledAt, job.ID,
	)
	if err != nil {
		r.logger.Error("could not mark notification job failed", "id", job.ID, "error", err)
	}
}
