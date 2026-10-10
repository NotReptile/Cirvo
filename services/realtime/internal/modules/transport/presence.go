package transport

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

type presenceLock struct {
	mu   sync.Mutex
	refs int
}

func (m *Module) lockPresence(userID uuid.UUID) func() {
	m.presenceLockMu.Lock()
	if m.presenceLocks == nil {
		m.presenceLocks = map[uuid.UUID]*presenceLock{}
	}
	entry := m.presenceLocks[userID]
	if entry == nil {
		entry = &presenceLock{}
		m.presenceLocks[userID] = entry
	}
	entry.refs++
	m.presenceLockMu.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		m.presenceLockMu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(m.presenceLocks, userID)
		}
		m.presenceLockMu.Unlock()
	}
}

func (m *Module) connectPresence(connection *hub.Connection) {
	unlock := m.lockPresence(connection.UserID)
	defer unlock()
	m.hub.Add(connection)
	m.touchSession(context.Background(), connection.SessionID)
	m.publishPresence(context.Background(), connection.UserID)
}

func (m *Module) disconnectPresence(connection *hub.Connection) {
	unlock := m.lockPresence(connection.UserID)
	defer unlock()
	m.hub.Remove(connection)
	m.expireDisconnectedSession(connection.SessionID)
	m.publishPresence(context.Background(), connection.UserID)
}

func visiblePresence(mode, custom string, connected bool) (string, string) {
	if mode == "invisible" {
		return "offline", ""
	}
	if !connected {
		return "offline", custom
	}
	return mode, custom
}

type presenceView struct {
	UserID       string    `json:"userId"`
	Mode         string    `json:"mode"`
	CustomStatus string    `json:"customStatus"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (m *Module) visiblePresenceSnapshot(userID uuid.UUID, workspaces []uuid.UUID) []presenceView {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rows, err := m.db.Query(ctx, `select u.id, u.presence_mode, coalesce(u.custom_status, ''), u.updated_at,
	 exists(select 1 from user_sessions s where s.user_id = u.id and s.revoked_at is null and s.last_seen_at > now() - interval '5 minutes')
	 from users u where u.id in (select user_id from workspace_members where workspace_id = any($1::uuid[]))
	 or u.id in (select case when user_a = $2 then user_b else user_a end from dm_channels where user_a = $2 or user_b = $2
	 union select case when user_a = $2 then user_b else user_a end from friendships where (user_a = $2 or user_b = $2) and status = 'accepted')`, workspaces, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	items := []presenceView{}
	for rows.Next() {
		var id uuid.UUID
		var mode, custom string
		var connected bool
		var updatedAt time.Time
		if rows.Scan(&id, &mode, &custom, &updatedAt, &connected) != nil {
			return nil
		}
		mode, custom = visiblePresence(mode, custom, connected)
		items = append(items, presenceView{UserID: id.String(), Mode: mode, CustomStatus: custom, UpdatedAt: updatedAt})
	}
	if rows.Err() != nil {
		return nil
	}
	return items
}

func (m *Module) expireDisconnectedSession(sessionID uuid.UUID) {
	if m.hub.SessionConnected(sessionID) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = m.db.Exec(ctx, `update user_sessions set last_seen_at = least(last_seen_at, now() - interval '5 minutes') where id = $1`, sessionID)
}

// Connectivity transitions are transient. HTTP snapshots derive the same result
// from session freshness; manual modes always take precedence over connectivity.
func (m *Module) publishPresence(parent context.Context, userID uuid.UUID) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	var mode, custom string
	var updatedAt time.Time
	if err := m.db.QueryRow(ctx, `select presence_mode, coalesce(custom_status, ''), updated_at from users where id = $1`, userID).Scan(&mode, &custom, &updatedAt); err != nil {
		return
	}
	mode, custom = visiblePresence(mode, custom, m.hub.UserConnected(userID))
	payload := map[string]any{"userId": userID.String(), "mode": mode, "customStatus": custom, "updatedAt": updatedAt}
	encoded, err := json.Marshal(map[string]any{"version": 2, "event": "presence.updated", "payload": payload})
	if err != nil {
		return
	}
	rows, err := m.db.Query(ctx, `select workspace_id from workspace_members where user_id = $1`, userID)
	if err != nil {
		return
	}
	workspaces := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return
		}
		workspaces = append(workspaces, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return
	}
	peers := []uuid.UUID{}
	rows, err = m.db.Query(ctx, `select case when user_a = $1 then user_b else user_a end
  from dm_channels where user_a = $1 or user_b = $1
  union select case when user_a = $1 then user_b else user_a end
  from friendships where (user_a = $1 or user_b = $1) and status = 'accepted'`, userID)
	if err != nil {
		return
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return
		}
		peers = append(peers, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return
	}
	for _, ws := range workspaces {
		m.hub.BroadcastWorkspace(ws, encoded)
	}
	for _, peer := range peers {
		m.hub.BroadcastUser(peer, encoded)
	}
}
