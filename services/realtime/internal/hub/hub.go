package hub

import (
	"log/slog"
	"sync"

	"github.com/google/uuid"
)

const sendBufferSize = 64

type Connection struct {
	SessionID    uuid.UUID
	UserID       uuid.UUID
	WorkspaceIDs []uuid.UUID
	Send         chan []byte
	Close        chan struct{}

	closeOnce sync.Once
}

func NewConnection(sessionID, userID uuid.UUID, workspaces []uuid.UUID) *Connection {
	return &Connection{
		SessionID:    sessionID,
		UserID:       userID,
		WorkspaceIDs: workspaces,
		Send:         make(chan []byte, sendBufferSize),
		Close:        make(chan struct{}),
	}
}

func (c *Connection) Shutdown() {
	c.closeOnce.Do(func() {
		close(c.Close)
	})
}

type Hub struct {
	mu               sync.RWMutex
	logger           *slog.Logger
	bySession        map[uuid.UUID]*Connection
	workspaceMembers map[uuid.UUID]map[uuid.UUID]*Connection
	userMembers      map[uuid.UUID]map[uuid.UUID]*Connection
}

func New(logger *slog.Logger) *Hub {
	return &Hub{
		logger:           logger,
		bySession:        make(map[uuid.UUID]*Connection),
		workspaceMembers: make(map[uuid.UUID]map[uuid.UUID]*Connection),
		userMembers:      make(map[uuid.UUID]map[uuid.UUID]*Connection),
	}
}

func (h *Hub) Add(conn *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if existing, ok := h.bySession[conn.SessionID]; ok {
		h.removeLocked(existing)
		existing.Shutdown()
	}
	h.bySession[conn.SessionID] = conn

	userBucket, ok := h.userMembers[conn.UserID]
	if !ok {
		userBucket = make(map[uuid.UUID]*Connection)
		h.userMembers[conn.UserID] = userBucket
	}
	userBucket[conn.SessionID] = conn

	for _, ws := range conn.WorkspaceIDs {
		bucket, ok := h.workspaceMembers[ws]
		if !ok {
			bucket = make(map[uuid.UUID]*Connection)
			h.workspaceMembers[ws] = bucket
		}
		bucket[conn.SessionID] = conn
	}
}

func (h *Hub) Remove(conn *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(conn)
}

func (h *Hub) removeLocked(conn *Connection) {
	if _, ok := h.bySession[conn.SessionID]; !ok {
		return
	}
	delete(h.bySession, conn.SessionID)

	if bucket, ok := h.userMembers[conn.UserID]; ok {
		delete(bucket, conn.SessionID)
		if len(bucket) == 0 {
			delete(h.userMembers, conn.UserID)
		}
	}

	for _, ws := range conn.WorkspaceIDs {
		if bucket, ok := h.workspaceMembers[ws]; ok {
			delete(bucket, conn.SessionID)
			if len(bucket) == 0 {
				delete(h.workspaceMembers, ws)
			}
		}
	}
}

// UpdateWorkspaces перекладывает живое соединение по workspace-bucket'ам без
// разрыва WS (G.6.b subscription.refresh): юзер вступил в воркспейс / создал
// новый / покинул — membership перечитан из БД, фан-аут должен пойти по
// актуальному списку. conn.WorkspaceIDs читается/пишется только под h.mu.
func (h *Hub) UpdateWorkspaces(conn *Connection, next []uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Соединение могло быть уже снято (или вытеснено повторным логином той же
	// сессии) — не воскрешаем bucket'ы мёртвого conn'а.
	if current, ok := h.bySession[conn.SessionID]; !ok || current != conn {
		return
	}
	for _, ws := range conn.WorkspaceIDs {
		if bucket, ok := h.workspaceMembers[ws]; ok {
			delete(bucket, conn.SessionID)
			if len(bucket) == 0 {
				delete(h.workspaceMembers, ws)
			}
		}
	}
	conn.WorkspaceIDs = next
	for _, ws := range next {
		bucket, ok := h.workspaceMembers[ws]
		if !ok {
			bucket = make(map[uuid.UUID]*Connection)
			h.workspaceMembers[ws] = bucket
		}
		bucket[conn.SessionID] = conn
	}
}

func (h *Hub) BroadcastWorkspace(workspaceID uuid.UUID, payload []byte) {
	h.mu.RLock()
	bucket := h.workspaceMembers[workspaceID]
	conns := make([]*Connection, 0, len(bucket))
	for _, c := range bucket {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	for _, conn := range conns {
		h.deliver(conn, payload)
	}
}

func (h *Hub) BroadcastSession(sessionID uuid.UUID, payload []byte) {
	h.mu.RLock()
	conn := h.bySession[sessionID]
	h.mu.RUnlock()
	if conn == nil {
		return
	}
	h.deliver(conn, payload)
}

func (h *Hub) BroadcastUser(userID uuid.UUID, payload []byte) {
	h.mu.RLock()
	bucket := h.userMembers[userID]
	conns := make([]*Connection, 0, len(bucket))
	for _, c := range bucket {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	for _, conn := range conns {
		h.deliver(conn, payload)
	}
}

func (h *Hub) deliver(conn *Connection, payload []byte) {
	select {
	case conn.Send <- payload:
	default:
		h.logger.Warn("dropping slow consumer", "sessionId", conn.SessionID.String())
		conn.Shutdown()
	}
}

func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.bySession)
}
