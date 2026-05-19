// Package retention — sweep устаревших данных по политике server_settings (D.3).
//
// Используется и worker'ом (по расписанию), и core-api (ручной запуск из
// админ-панели через POST /server/retention/run). Один и тот же код, чтобы
// не разъезжалось поведение.
//
// Что чистится:
//
//  1. Сообщения старше message_retention_days (если > 0). Cascade удаляет
//     message_attachments, reactions, mentions, read_receipts и т.п.
//  2. Orphan media_objects — те, что не привязаны ни к одному
//     message_attachment'у и созданы дольше getOrphanGrace назад. Параллельно
//     решает техдолг про auto-cleanup orphaned media (см. TASKS.md).
//  3. Storage quota: если storage_quota_bytes > 0 и текущий sum(size_bytes)
//     превышает квоту — удаляет самые старые media_objects (с cascade на
//     attachment'ы) пока не уложимся. Сами сообщения остаются без файлов.
//
// Sweep idempotent — безопасно гонять чаще раз в сутки. Файлы из MinIO
// удаляются best-effort: если store == nil или Remove упал, лог warn и идём
// дальше; row из media_objects всё равно удаляется, иначе orphan blob будет
// вечно мешать квоте.
package retention

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

// orphanGrace — media без attachment'а считается orphan'ом только спустя
// этот интервал. Защищает свежие аплоады (юзер только что POST'нул
// /uploads и сейчас прикрепляет к сообщению — не убивать).
const orphanGrace = 1 * time.Hour

// Settings — поля server_settings, влияющие на sweep. Передаются явно,
// чтобы пакет не зависел от serversettings.Provider (core-api-specific).
type Settings struct {
	MessageRetentionDays int
	StorageQuotaBytes    int64
}

// Stats — итоги одного sweep'а; возвращаются вызывающему (worker логирует,
// API отдаёт админу).
type Stats struct {
	MessagesDeleted int64 `json:"messagesDeleted"`
	MediaDeleted    int64 `json:"mediaDeleted"`
	BytesFreed      int64 `json:"bytesFreed"`
}

// Sweep — основная точка входа. db обязателен, store опционален (без него
// blob'ы в MinIO не удалятся, останутся orphan'ами — лог warn).
func Sweep(ctx context.Context, logger *slog.Logger, db *postgres.Pool, store *objectstore.Client, s Settings) (Stats, error) {
	var stats Stats

	if s.MessageRetentionDays > 0 {
		n, err := deleteOldMessages(ctx, db, s.MessageRetentionDays)
		if err != nil {
			return stats, fmt.Errorf("retention messages: %w", err)
		}
		stats.MessagesDeleted = n
	}

	// Orphan-cleanup всегда (даже если retention отключён) — раз уж sweep
	// крутится, орфаны от любых причин (отвалившийся upload, удалённое
	// сообщение) лучше подобрать.
	mediaN, bytesN, err := deleteOrphanMedia(ctx, logger, db, store)
	if err != nil {
		return stats, fmt.Errorf("retention orphans: %w", err)
	}
	stats.MediaDeleted += mediaN
	stats.BytesFreed += bytesN

	if s.StorageQuotaBytes > 0 {
		mediaN, bytesN, err := enforceQuota(ctx, logger, db, store, s.StorageQuotaBytes)
		if err != nil {
			return stats, fmt.Errorf("retention quota: %w", err)
		}
		stats.MediaDeleted += mediaN
		stats.BytesFreed += bytesN
	}

	return stats, nil
}

func deleteOldMessages(ctx context.Context, db *postgres.Pool, days int) (int64, error) {
	cutoff := time.Now().UTC().AddDate(0, 0, -days)
	tag, err := db.Exec(ctx,
		`delete from messages where created_at < $1`,
		cutoff,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// deleteOrphanMedia — медиа без attachment'а и старше orphanGrace удаляются
// из MinIO + media_objects.
func deleteOrphanMedia(ctx context.Context, logger *slog.Logger, db *postgres.Pool, store *objectstore.Client) (int64, int64, error) {
	rows, err := db.Query(ctx, `
		select mo.id, mo.object_key, mo.size_bytes
		from media_objects mo
		where not exists (select 1 from message_attachments ma where ma.media_id = mo.id)
		  and mo.created_at < now() - make_interval(secs => $1)
		order by mo.created_at
		limit 10000`,
		int(orphanGrace.Seconds()),
	)
	if err != nil {
		return 0, 0, err
	}
	type row struct {
		id        uuid.UUID
		objectKey string
		size      int64
	}
	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.objectKey, &r.size); err != nil {
			rows.Close()
			return 0, 0, err
		}
		batch = append(batch, r)
	}
	rows.Close()

	var count, bytes int64
	for _, r := range batch {
		if err := removeBlobAndRow(ctx, logger, db, store, r.id, r.objectKey); err != nil {
			logger.Warn("retention: orphan delete failed", "media_id", r.id, "error", err)
			continue
		}
		count++
		bytes += r.size
	}
	return count, bytes, nil
}

// enforceQuota — самые старые media_objects удаляются пока sum(size_bytes)
// не уложится в quota. С cascade'м на message_attachments — сообщения
// останутся без файлов (UI просто не покажет attachment-чипы).
func enforceQuota(ctx context.Context, logger *slog.Logger, db *postgres.Pool, store *objectstore.Client, quota int64) (int64, int64, error) {
	var total int64
	if err := db.QueryRow(ctx, `select coalesce(sum(size_bytes), 0) from media_objects`).Scan(&total); err != nil {
		return 0, 0, err
	}
	if total <= quota {
		return 0, 0, nil
	}
	over := total - quota

	rows, err := db.Query(ctx, `
		select id, object_key, size_bytes
		from media_objects
		order by created_at asc
		limit 10000`)
	if err != nil {
		return 0, 0, err
	}
	type row struct {
		id        uuid.UUID
		objectKey string
		size      int64
	}
	var batch []row
	var freed int64
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.objectKey, &r.size); err != nil {
			rows.Close()
			return 0, 0, err
		}
		batch = append(batch, r)
		freed += r.size
		if freed >= over {
			break
		}
	}
	rows.Close()

	var count, bytes int64
	for _, r := range batch {
		if err := removeBlobAndRow(ctx, logger, db, store, r.id, r.objectKey); err != nil {
			logger.Warn("retention: quota delete failed", "media_id", r.id, "error", err)
			continue
		}
		count++
		bytes += r.size
	}
	return count, bytes, nil
}

func removeBlobAndRow(ctx context.Context, logger *slog.Logger, db *postgres.Pool, store *objectstore.Client, mediaID uuid.UUID, objectKey string) error {
	if store != nil {
		// best-effort: если blob уже удалён или MinIO недоступен — лог и продолжаем.
		// Иначе ряд в media_objects остался бы вечно и блокировал квоту.
		if err := store.Remove(ctx, objectKey); err != nil {
			logger.Warn("retention: minio remove failed", "object_key", objectKey, "error", err)
		}
	}
	if _, err := db.Exec(ctx, `delete from media_objects where id = $1`, mediaID); err != nil {
		return err
	}
	return nil
}

// LoadSettings — хелпер для воркера и admin-эндпоинта: одна выборка
// из server_settings.
func LoadSettings(ctx context.Context, db *postgres.Pool) (Settings, error) {
	var s Settings
	err := db.QueryRow(ctx,
		`select message_retention_days, storage_quota_bytes
		 from server_settings where id = true`,
	).Scan(&s.MessageRetentionDays, &s.StorageQuotaBytes)
	if err != nil {
		return Settings{}, err
	}
	return s, nil
}
