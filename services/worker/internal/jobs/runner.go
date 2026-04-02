package jobs

import (
	"context"
	"log/slog"
	"time"
)

type Runner struct {
	logger *slog.Logger
}

func NewRunner(logger *slog.Logger) *Runner {
	return &Runner{logger: logger}
}

func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	r.logger.Info("worker loop ready", "jobs", []string{"media-processing", "notifications", "audit-fanout"})

	for {
		select {
		case <-ctx.Done():
			r.logger.Info("worker stopped")
			return
		case <-ticker.C:
			r.logger.Info("worker heartbeat")
		}
	}
}
