// Package serversettings — кешируемый доступ к таблице server_settings (D.1).
//
// Settings читаются модулями на каждом хэндлере (max_message_bytes,
// max_attachment_bytes, max_users и т.п.), поэтому Provider держит
// in-memory снапшот с TTL. PUT через /api/v1/server/settings зовёт
// Invalidate() — следующее Get() обновит кеш из БД.
//
// Zero-значения (0) означают «без лимита» — это удобно для self-host,
// где админ может явно отключить ограничение.
package serversettings

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

// Snapshot — копия server_settings на момент чтения.
type Snapshot struct {
	MaxUsers                int
	MaxWorkspaces           int
	MaxChannelsPerWorkspace int
	MaxMessageBytes         int
	MaxAttachmentBytes      int64
	StorageQuotaBytes       int64
	MessageRetentionDays    int
	RegistrationOpen        bool
	UpdatedAt               time.Time
	UpdatedByUserID         *uuid.UUID
}

const cacheTTL = 30 * time.Second

// Provider загружает и кеширует snapshot.
type Provider struct {
	db *postgres.Pool

	mu       sync.RWMutex
	cached   Snapshot
	cachedAt time.Time
	hasCache bool
}

func NewProvider(db *postgres.Pool) *Provider {
	return &Provider{db: db}
}

// Get возвращает актуальный snapshot. При ошибке БД возвращает последний
// успешный (если был) или zero-value — лимиты-нули = «без ограничений»,
// что fail-open, как и rate limiter при недоступности Redis.
func (p *Provider) Get(ctx context.Context) Snapshot {
	p.mu.RLock()
	if p.hasCache && time.Since(p.cachedAt) < cacheTTL {
		s := p.cached
		p.mu.RUnlock()
		return s
	}
	p.mu.RUnlock()

	p.mu.Lock()
	defer p.mu.Unlock()
	// double-check
	if p.hasCache && time.Since(p.cachedAt) < cacheTTL {
		return p.cached
	}
	snap, err := loadFromDB(ctx, p.db)
	if err != nil {
		if p.hasCache {
			return p.cached
		}
		return Snapshot{}
	}
	p.cached = snap
	p.cachedAt = time.Now()
	p.hasCache = true
	return snap
}

// Invalidate сбрасывает кеш — следующее Get() сходит в БД.
func (p *Provider) Invalidate() {
	p.mu.Lock()
	p.hasCache = false
	p.mu.Unlock()
}

func loadFromDB(ctx context.Context, db *postgres.Pool) (Snapshot, error) {
	var s Snapshot
	err := db.QueryRow(ctx,
		`select max_users, max_workspaces, max_channels_per_workspace,
		        max_message_bytes, max_attachment_bytes, storage_quota_bytes,
		        message_retention_days, registration_open,
		        updated_at, updated_by_user_id
		 from server_settings where id = true`,
	).Scan(
		&s.MaxUsers, &s.MaxWorkspaces, &s.MaxChannelsPerWorkspace,
		&s.MaxMessageBytes, &s.MaxAttachmentBytes, &s.StorageQuotaBytes,
		&s.MessageRetentionDays, &s.RegistrationOpen,
		&s.UpdatedAt, &s.UpdatedByUserID,
	)
	if err != nil {
		return Snapshot{}, err
	}
	return s, nil
}

// IsRoot проверяет users.is_root для userID. Используется в admin-only ручках.
func IsRoot(ctx context.Context, db *postgres.Pool, userID uuid.UUID) bool {
	var isRoot bool
	err := db.QueryRow(ctx, `select is_root from users where id = $1`, userID).Scan(&isRoot)
	if err != nil {
		return false
	}
	return isRoot
}
