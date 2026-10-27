// Wave 2: typing-индикатор «X печатает…». Чисто transient — никакой БД-записи,
// событие живёт только в WS. Клиент шлёт `typing.start {channel_id}` с
// throttle ~3с; получатели рисуют строку с TTL и сами её гасят — отдельного
// `typing.stop` не нужно (отправка сообщения убивает строку через
// message.created, а молчание — через TTL).
//
// Получатели и отправитель проверяются через общий channel ACL на каждую
// ретрансляцию. Смена прав применяется и к уже открытым соединениям.
package typing

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"

	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/services/realtime/internal/hub"
)

const (
	// Per-user+channel минимальный интервал ретрансляции — клиент и так
	// троттлит, но серверная защита от спама обязательна.
	relayThrottle = 2 * time.Second
)

type Module struct {
	logger   *slog.Logger
	db       *postgres.Pool
	hub      *hub.Hub
	mu       sync.Mutex
	lastSent map[[2]uuid.UUID]time.Time // [user, channel] → последняя ретрансляция
}

type channelEntry struct {
	workspaceID uuid.UUID // uuid.Nil = DM
	members     []uuid.UUID
	memberSet   map[uuid.UUID]struct{}
}

func NewModule(logger *slog.Logger, db *postgres.Pool, h *hub.Hub) *Module {
	return &Module{
		logger:   logger,
		db:       db,
		hub:      h,
		lastSent: make(map[[2]uuid.UUID]time.Time),
	}
}

func (m *Module) RegisterRoutes(_ *http.ServeMux) {}

func (m *Module) Handles(event string) bool {
	return event == "typing.start"
}

type typingPayload struct {
	ChannelID string `json:"channel_id"`
}

func (m *Module) Relay(ctx context.Context, event string, fromUser, _ uuid.UUID, rawPayload []byte) {
	if !m.Handles(event) || len(rawPayload) == 0 || len(rawPayload) > 1024 {
		return
	}
	var p typingPayload
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		return
	}

	key := [2]uuid.UUID{fromUser, channelID}
	m.mu.Lock()
	if last, ok := m.lastSent[key]; ok && time.Since(last) < relayThrottle {
		m.mu.Unlock()
		return
	}
	m.lastSent[key] = time.Now()
	// Карта не должна расти бесконечно — лениво чистим протухшие записи.
	if len(m.lastSent) > 4096 {
		cutoff := time.Now().Add(-time.Minute)
		for k, v := range m.lastSent {
			if v.Before(cutoff) {
				delete(m.lastSent, k)
			}
		}
	}
	m.mu.Unlock()

	entry, err := m.resolveChannel(ctx, channelID)
	if err != nil {
		m.logger.Debug("typing channel lookup failed", "error", err)
		return
	}
	if entry == nil {
		return // канала нет
	}

	// ACL: отправитель должен быть участником. Для workspace-канала —
	// workspace-membership уже гарантирован hub-bucket'ами на приёме,
	// но проверяем членство отправителя, чтобы нельзя было слать typing
	// в чужой канал по подобранному UUID.
	if _, ok := entry.memberSet[fromUser]; !ok {
		return
	}

	envelope, err := json.Marshal(map[string]any{
		"event":     "typing.start",
		"channelId": channelID.String(),
		"payload": map[string]any{
			"channelId": channelID.String(),
			"userId":    fromUser.String(),
		},
	})
	if err != nil {
		return
	}

	for _, member := range entry.members {
		m.hub.BroadcastUser(member, envelope)
	}
}

// Членство не кешируется: отозванное право не должно переживать TTL.
func (m *Module) resolveChannel(ctx context.Context, channelID uuid.UUID) (*channelEntry, error) {
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var workspaceID *uuid.UUID
	err := m.db.QueryRow(qctx, `select workspace_id from channels where id = $1`, channelID).Scan(&workspaceID)
	if err != nil {
		return nil, nil // канал не найден — молча игнорим
	}

	var rows interface {
		Next() bool
		Scan(dest ...any) error
		Close()
		Err() error
	}
	if workspaceID != nil {
		r, err := m.db.Query(qctx, `select user_id from workspace_members where workspace_id = $1`, *workspaceID)
		if err != nil {
			return nil, err
		}
		rows = r
	} else {
		r, err := m.db.Query(qctx, `select user_id from channel_members where channel_id = $1`, channelID)
		if err != nil {
			return nil, err
		}
		rows = r
	}
	defer rows.Close()

	entry := &channelEntry{
		memberSet: make(map[uuid.UUID]struct{}),
	}
	if workspaceID != nil {
		entry.workspaceID = *workspaceID
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		entry.members = append(entry.members, id)
		entry.memberSet[id] = struct{}{}
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	visible, err := channelacl.VisibleMembers(qctx, m.db, channelID, entry.members)
	if err != nil {
		return nil, err
	}
	filtered := entry.members[:0]
	for _, member := range entry.members {
		if visible[member] {
			filtered = append(filtered, member)
		} else {
			delete(entry.memberSet, member)
		}
	}
	entry.members = filtered
	return entry, nil
}
