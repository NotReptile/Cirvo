package transport

import (
	"context"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/libs/shared-go/channelacl"
	"github.com/NotReptile/RuCord/services/sfu/internal/rtc"
)

const accessCheckInterval = 5 * time.Second

type activeConnection struct {
	userID, sessionID, channelID uuid.UUID
	conn                         interface {
		Close(websocket.StatusCode, string) error
	}
}

func enforceAccess(peer *rtc.Peer, connection activeConnection, allowed bool) bool {
	if allowed {
		return false
	}
	peer.Close("access revoked")
	_ = connection.conn.Close(websocket.StatusPolicyViolation, "channel access revoked")
	return true
}

func (m *Module) trackConnection(peer *rtc.Peer, connection activeConnection) {
	m.accessMu.Lock()
	defer m.accessMu.Unlock()
	if m.active == nil {
		m.active = map[*rtc.Peer]activeConnection{}
	}
	m.active[peer] = connection
	if !m.monitoring {
		m.monitoring = true
		go m.monitorAccess()
	}
}

func (m *Module) untrackConnection(peer *rtc.Peer) {
	m.accessMu.Lock()
	defer m.accessMu.Unlock()
	delete(m.active, peer)
}

func (m *Module) monitorAccess() {
	ticker := time.NewTicker(accessCheckInterval)
	defer ticker.Stop()
	for range ticker.C {
		m.accessMu.Lock()
		if len(m.active) == 0 {
			m.monitoring = false
			m.accessMu.Unlock()
			return
		}
		connections := make(map[*rtc.Peer]activeConnection, len(m.active))
		for peer, connection := range m.active {
			connections[peer] = connection
		}
		m.accessMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		m.revalidateConnections(ctx, connections)
		cancel()
	}
}

func (m *Module) revalidateConnections(ctx context.Context, connections map[*rtc.Peer]activeConnection) {
	channels, users, sessions := []uuid.UUID{}, []uuid.UUID{}, []uuid.UUID{}
	seenChannels, seenUsers, seenSessions := map[uuid.UUID]bool{}, map[uuid.UUID]bool{}, map[uuid.UUID]bool{}
	for _, connection := range connections {
		if !seenChannels[connection.channelID] {
			channels = append(channels, connection.channelID)
			seenChannels[connection.channelID] = true
		}
		if !seenUsers[connection.userID] {
			users = append(users, connection.userID)
			seenUsers[connection.userID] = true
		}
		if !seenSessions[connection.sessionID] {
			sessions = append(sessions, connection.sessionID)
			seenSessions[connection.sessionID] = true
		}
	}
	visible, accessErr := channelacl.VisibleChannels(ctx, m.db, channels, users)
	// A session is valid only while its original channel participation remains live.
	type pair struct{ session, channel uuid.UUID }
	live := map[pair]bool{}
	rows, err := m.db.Query(ctx, `select cp.session_id, cp.channel_id from channel_participants cp
  join user_sessions s on s.id = cp.session_id and s.user_id = cp.user_id
  join users u on u.id = cp.user_id join channels c on c.id = cp.channel_id
  where cp.session_id = any($1::uuid[]) and s.revoked_at is null
  and not u.must_change_password and c.archived_at is null`, sessions)
	if err == nil {
		for rows.Next() {
			var sessionID, channelID uuid.UUID
			if scanErr := rows.Scan(&sessionID, &channelID); scanErr != nil {
				err = scanErr
				break
			}
			live[pair{sessionID, channelID}] = true
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
	}
	for peer, connection := range connections {
		allowed := accessErr == nil && err == nil && visible[connection.userID][connection.channelID] && live[pair{connection.sessionID, connection.channelID}]
		if !enforceAccess(peer, connection, allowed) {
			continue
		}
		// Database failures close media conservatively but do not delete membership state.
		m.untrackConnection(peer)
		if accessErr == nil && err == nil {
			_, _ = m.db.Exec(ctx, `delete from channel_participants where channel_id = $1 and session_id = $2`, connection.channelID, connection.sessionID)
		}
	}
}
