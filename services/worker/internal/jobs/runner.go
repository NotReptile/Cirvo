package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/NotReptile/Cirvo/libs/shared-go/objectstore"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
)

const (
	pollIdle     = 5 * time.Second
	pollActive   = 200 * time.Millisecond
	jobTimeout   = 60 * time.Second
	maxAttempts  = 3
	heartbeatMin = 30 * time.Second
)

// Handler runs a single job and returns nil on success.
type Handler interface {
	Kind() string
	Handle(ctx context.Context, job Job) error
}

type Job struct {
	ID       uuid.UUID
	MediaID  uuid.UUID
	Kind     string
	Attempts int
}

type Runner struct {
	logger   *slog.Logger
	db       *postgres.Pool
	handlers map[string]Handler
}

func NewRunner(logger *slog.Logger, db *postgres.Pool, store *objectstore.Client) *Runner {
	r := &Runner{
		logger:   logger,
		db:       db,
		handlers: map[string]Handler{},
	}
	if store != nil {
		r.register(NewThumbnailHandler(logger, db, store))
	}
	return r
}

func (r *Runner) register(h Handler) {
	r.handlers[h.Kind()] = h
}

func (r *Runner) Run(ctx context.Context) {
	kinds := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		kinds = append(kinds, k)
	}
	r.logger.Info("worker loop ready", "jobs", kinds)

	lastHeartbeat := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			r.logger.Info("worker stopped")
			return
		}
		job, ok, err := r.claim(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				r.logger.Error("claim failed", "error", err)
			}
			if !sleep(ctx, pollIdle) {
				return
			}
			continue
		}
		if !ok {
			if time.Since(lastHeartbeat) >= heartbeatMin {
				r.logger.Info("worker heartbeat")
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

// claim atomically picks one pending job, marks it running and returns it.
// Uses SKIP LOCKED so multiple worker replicas don't double-process.
func (r *Runner) claim(ctx context.Context) (Job, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var job Job
	err := r.db.QueryRow(ctx, `
		update media_jobs
		set status = 'running',
		    started_at = now(),
		    attempts = attempts + 1
		where id = (
		  select id from media_jobs
		  where status = 'pending' and scheduled_at <= now()
		  order by scheduled_at
		  for update skip locked
		  limit 1
		)
		returning id, media_id, kind, attempts
	`).Scan(&job.ID, &job.MediaID, &job.Kind, &job.Attempts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Job{}, false, nil
		}
		return Job{}, false, err
	}
	return job, true, nil
}

func (r *Runner) process(parent context.Context, job Job) {
	handler, ok := r.handlers[job.Kind]
	if !ok {
		r.fail(parent, job, fmt.Errorf("unknown kind: %s", job.Kind), true)
		return
	}
	ctx, cancel := context.WithTimeout(parent, jobTimeout)
	defer cancel()

	if err := handler.Handle(ctx, job); err != nil {
		r.logger.Warn("job failed", "kind", job.Kind, "media_id", job.MediaID, "attempt", job.Attempts, "error", err)
		terminal := job.Attempts >= maxAttempts
		r.fail(parent, job, err, terminal)
		return
	}
	r.markDone(parent, job)
}

func (r *Runner) markDone(ctx context.Context, job Job) {
	ctx, cancel := context.WithTimeout(detach(ctx), 5*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`update media_jobs set status = 'done', finished_at = now(), last_error = null where id = $1`,
		job.ID,
	)
	if err != nil {
		r.logger.Error("could not mark job done", "id", job.ID, "error", err)
		return
	}
	r.logger.Info("job done", "kind", job.Kind, "media_id", job.MediaID)
}

func (r *Runner) fail(ctx context.Context, job Job, jobErr error, terminal bool) {
	ctx, cancel := context.WithTimeout(detach(ctx), 5*time.Second)
	defer cancel()
	status := "pending"
	scheduledAt := time.Now().Add(backoff(job.Attempts))
	if terminal {
		status = "failed"
	}
	_, err := r.db.Exec(ctx,
		`update media_jobs
		 set status = $1, last_error = $2, scheduled_at = $3, finished_at = case when $1 = 'failed' then now() else null end
		 where id = $4`,
		status, jobErr.Error(), scheduledAt, job.ID,
	)
	if err != nil {
		r.logger.Error("could not mark job failed", "id", job.ID, "error", err)
	}
}

func backoff(attempts int) time.Duration {
	if attempts <= 1 {
		return 5 * time.Second
	}
	d := time.Duration(1<<attempts) * time.Second
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// detach returns a fresh context preserving cancellation only via the parent's
// done signal, so update queries can run even when a per-job timeout context
// has expired.
func detach(parent context.Context) context.Context {
	if parent.Err() == nil {
		return parent
	}
	return context.Background()
}
