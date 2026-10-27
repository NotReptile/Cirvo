// retention.go — D.3. Раз в сутки гоняет retention.Sweep по политике
// server_settings: удаляет старые сообщения, orphan media и привязки сверх
// квоты хранилища.
//
// Тикер 24 часа + первый прогон через 1 минуту после старта (чтобы при
// рестартах не дублировать большую работу синхронно со стартом всех
// сервисов). Sweep idempotent, повторный запуск ничего не сломает.
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/NotReptile/Cirvo/libs/shared-go/objectstore"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/retention"
)

const (
	retentionInterval  = 24 * time.Hour
	retentionFirstWait = 1 * time.Minute
)

type RetentionRunner struct {
	logger *slog.Logger
	db     *postgres.Pool
	store  *objectstore.Client
}

func NewRetentionRunner(logger *slog.Logger, db *postgres.Pool, store *objectstore.Client) *RetentionRunner {
	return &RetentionRunner{logger: logger, db: db, store: store}
}

func (r *RetentionRunner) Run(ctx context.Context) {
	r.logger.Info("retention loop ready", "interval", retentionInterval)
	if !sleep(ctx, retentionFirstWait) {
		return
	}
	for {
		r.runOnce(ctx)
		if !sleep(ctx, retentionInterval) {
			return
		}
	}
}

func (r *RetentionRunner) runOnce(ctx context.Context) {
	settings, err := retention.LoadSettings(ctx, r.db)
	if err != nil {
		r.logger.Error("retention: load settings failed", "error", err)
		return
	}
	if settings.MessageRetentionDays == 0 && settings.StorageQuotaBytes == 0 {
		r.logger.Info("retention: nothing to enforce", "retention_days", 0, "quota_bytes", 0)
		// orphan-cleanup всё равно прогоняется Sweep'ом — не выходим
	}
	stats, err := retention.Sweep(ctx, r.logger, r.db, r.store, settings)
	if err != nil {
		r.logger.Error("retention sweep failed", "error", err)
		return
	}
	r.logger.Info("retention sweep done",
		"messages_deleted", stats.MessagesDeleted,
		"media_deleted", stats.MediaDeleted,
		"bytes_freed", stats.BytesFreed,
	)
}
