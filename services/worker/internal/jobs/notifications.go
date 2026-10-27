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

	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
	"github.com/NotReptile/Cirvo/libs/shared-go/redisstore"
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
	// mention_everyone (Wave 4): kind пинга ('everyone'|'here') и кого
	// исключить из развёрнутого списка (уже получили персональные нотификации).
	MentionKind string   `json:"mentionKind,omitempty"`
	Exclude     []string `json:"exclude,omitempty"`
}

type NotificationRunner struct {
	logger    *slog.Logger
	db        *postgres.Pool
	publisher *realtimebus.Publisher
}

func NewNotificationRunner(logger *slog.Logger, db *postgres.Pool, redis *redisstore.Client) *NotificationRunner {
	var pub *realtimebus.Publisher
	if redis != nil {
		pub = realtimebus.NewPublisher(redis, db)
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
	recipients := p.Recipients
	// Wave 4: mention_everyone приходит без recipients — разворачиваем по
	// участникам канала на момент доставки.
	if job.Kind == "mention_everyone" {
		expanded, err := r.expandChannelRecipients(ctx, p.ChannelID, p.Exclude)
		if err != nil {
			return fmt.Errorf("expand everyone recipients: %w", err)
		}
		recipients = expanded
	}
	if len(recipients) == 0 {
		// Пустой список — задача невалидна, но раскладывать нечего;
		// помечаем done чтобы не ретраить.
		return nil
	}
	var channelID uuid.UUID
	visible := map[uuid.UUID]bool{}
	if p.ChannelID != "" {
		var err error
		channelID, err = uuid.Parse(p.ChannelID)
		if err != nil {
			return fmt.Errorf("invalid notification channel: %w", err)
		}
		if channelID == uuid.Nil {
			return errors.New("empty notification channel UUID")
		}
		users := make([]uuid.UUID, 0, len(recipients))
		for _, raw := range recipients {
			if user, err := uuid.Parse(raw); err == nil {
				users = append(users, user)
			}
		}
		visible, err = channelacl.VisibleMembers(ctx, r.db, channelID, users)
		if err != nil {
			return fmt.Errorf("notification channel access: %w", err)
		}
	} else if job.Kind == "mention" || job.Kind == "reply" || job.Kind == "mention_everyone" {
		return errors.New("channel notification has no channel")
	}

	for _, raw := range recipients {
		uid, err := uuid.Parse(raw)
		if err != nil {
			r.logger.Warn("notification: invalid recipient uuid", "value", raw)
			continue
		}
		if channelID != uuid.Nil && !visible[uid] {
			continue
		}
		// Wave 4: эффективный уровень получателя (канал ← воркспейс ← 'all').
		// 'none' глушит mention/reply/mention_everyone; call_incoming и
		// friend_* не канало-привязаны (ChannelID пуст) и проходят всегда.
		if (job.Kind == "mention" || job.Kind == "reply" || job.Kind == "mention_everyone") && p.ChannelID != "" {
			if r.effectiveLevel(ctx, uid, p.ChannelID, p.WorkspaceID) == "none" {
				continue
			}
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
		if p.MentionKind != "" {
			row["mentionKind"] = p.MentionKind
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
				Event:     "notification.created",
				UserID:    uid.String(),
				ChannelID: p.ChannelID,
				Payload:   evtPayload,
			})
		}
	}
	return nil
}

// expandChannelRecipients — список user_id для @everyone/@here: участники
// воркспейса канала; handle затем применяет общую пакетную ACL, включая
// private/category/role/user overrides.
// exclude — автор и уже-уведомлённые персонально. @here пока доставляется
// как @everyone: presence живёт в памяти realtime-хаба и worker'у недоступен.
func (r *NotificationRunner) expandChannelRecipients(ctx context.Context, channelID string, exclude []string) ([]string, error) {
	chID, err := uuid.Parse(channelID)
	if err != nil {
		return nil, fmt.Errorf("invalid channel id %q", channelID)
	}
	rows, err := r.db.Query(ctx, `
		select wm.user_id
		from channels c
		join workspace_members wm on wm.workspace_id = c.workspace_id
		where c.id = $1`,
		chID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	skip := make(map[string]struct{}, len(exclude))
	for _, e := range exclude {
		skip[e] = struct{}{}
	}
	out := make([]string, 0, 32)
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		if _, ok := skip[uid.String()]; ok {
			continue
		}
		out = append(out, uid.String())
	}
	return out, rows.Err()
}

// effectiveLevel — явный канальный уровень, иначе workspace-уровень, иначе
// 'all'. При ошибке БД — 'all' (fail-open: лучше лишнее уведомление, чем
// молча потерянное).
func (r *NotificationRunner) effectiveLevel(ctx context.Context, userID uuid.UUID, channelID, workspaceID string) string {
	chID, err := uuid.Parse(channelID)
	if err != nil {
		return "all"
	}
	var level string
	if wsID, werr := uuid.Parse(workspaceID); werr == nil {
		if r.db.QueryRow(ctx, `
			select coalesce(
			  (select level from user_channel_preferences where user_id = $1 and channel_id = $2),
			  (select level from user_workspace_preferences where user_id = $1 and workspace_id = $3),
			  'all')`,
			userID, chID, wsID,
		).Scan(&level) == nil {
			return level
		}
		return "all"
	}
	if r.db.QueryRow(ctx, `
		select coalesce(
		  (select level from user_channel_preferences where user_id = $1 and channel_id = $2),
		  'all')`,
		userID, chID,
	).Scan(&level) == nil {
		return level
	}
	return "all"
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
