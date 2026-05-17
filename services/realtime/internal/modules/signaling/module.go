package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

const (
	membershipTTL  = 30 * time.Second
	maxPayloadSize = 32 * 1024
)

var relayEvents = map[string]struct{}{
	"call.invite": {},
	"call.offer":  {},
	"call.answer": {},
	"call.ice":    {},
	"call.hangup": {},
}

type Module struct {
	logger     *slog.Logger
	db         *postgres.Pool
	hub        *hub.Hub
	membership *membershipCache
}

func NewModule(logger *slog.Logger, db *postgres.Pool, h *hub.Hub) *Module {
	return &Module{
		logger:     logger,
		db:         db,
		hub:        h,
		membership: newMembershipCache(membershipTTL),
	}
}

func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/signaling/health", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{
			"module": "signaling",
			"status": "ok",
		})
	})
}

// Handles returns true if this module relays the given event name.
func (m *Module) Handles(event string) bool {
	_, ok := relayEvents[event]
	return ok
}

type relayPayload struct {
	CallID          string          `json:"call_id"`
	TargetUserID    string          `json:"target_user_id,omitempty"`
	TargetSessionID string          `json:"target_session_id,omitempty"`
	SDP             json.RawMessage `json:"sdp,omitempty"`
	Candidate       json.RawMessage `json:"candidate,omitempty"`
	Reason          string          `json:"reason,omitempty"`
	ChannelID       string          `json:"channel_id,omitempty"`
}

// Relay validates and forwards a signaling envelope from a connected user.
// rawPayload is the original JSON payload received from the client.
func (m *Module) Relay(ctx context.Context, event string, fromUser, fromSession uuid.UUID, rawPayload []byte) {
	if !m.Handles(event) {
		return
	}
	if len(rawPayload) == 0 || len(rawPayload) > maxPayloadSize {
		m.logger.Debug("signaling payload rejected", "reason", "size", "event", event, "size", len(rawPayload))
		return
	}
	var p relayPayload
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		m.logger.Debug("signaling payload rejected", "reason", "invalid_json", "event", event)
		return
	}
	if p.CallID == "" {
		m.logger.Debug("signaling payload rejected", "reason", "missing_call_id", "event", event)
		return
	}

	var targetSession uuid.UUID
	if p.TargetSessionID != "" {
		id, err := uuid.Parse(p.TargetSessionID)
		if err != nil {
			return
		}
		targetSession = id
	}
	var targetUser uuid.UUID
	if p.TargetUserID != "" {
		id, err := uuid.Parse(p.TargetUserID)
		if err != nil {
			return
		}
		targetUser = id
	}
	if targetSession == uuid.Nil && targetUser == uuid.Nil {
		m.logger.Debug("signaling payload rejected", "reason", "missing_target", "event", event)
		return
	}

	// ACL: source and (resolved) target user must share a workspace.
	resolvedUser := targetUser
	if resolvedUser == uuid.Nil {
		// session-only target — derive user from session, ACL still applies
		uid, ok := m.lookupSessionUser(ctx, targetSession)
		if !ok {
			return
		}
		resolvedUser = uid
	}
	if resolvedUser != fromUser {
		shared, err := m.membership.sharedWorkspace(ctx, m.db, fromUser, resolvedUser)
		if err != nil {
			m.logger.Warn("signaling acl lookup failed", "error", err)
			return
		}
		if !shared {
			m.logger.Debug("signaling acl denied", "from", fromUser, "to", resolvedUser, "event", event)
			return
		}
	}

	// Rebuild envelope with from_* fields injected.
	envelope := map[string]any{
		"event": event,
		"payload": map[string]any{
			"call_id":           p.CallID,
			"from_user_id":      fromUser.String(),
			"from_session_id":   fromSession.String(),
			"target_user_id":    p.TargetUserID,
			"target_session_id": p.TargetSessionID,
			"channel_id":        p.ChannelID,
		},
	}
	pl := envelope["payload"].(map[string]any)
	if len(p.SDP) > 0 {
		pl["sdp"] = json.RawMessage(p.SDP)
	}
	if len(p.Candidate) > 0 {
		pl["candidate"] = json.RawMessage(p.Candidate)
	}
	if p.Reason != "" {
		pl["reason"] = p.Reason
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return
	}

	if targetSession != uuid.Nil {
		m.hub.BroadcastSession(targetSession, encoded)
		return
	}
	m.hub.BroadcastUser(targetUser, encoded)
}

func (m *Module) lookupSessionUser(ctx context.Context, sessionID uuid.UUID) (uuid.UUID, bool) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var userID uuid.UUID
	err := m.db.QueryRow(ctx,
		`select user_id from user_sessions where id = $1 and revoked_at is null`,
		sessionID,
	).Scan(&userID)
	if err != nil {
		return uuid.Nil, false
	}
	return userID, true
}

// membershipCache caches "does user belong to workspace W" answers.
type membershipCache struct {
	ttl   time.Duration
	mu    sync.Mutex
	users map[uuid.UUID]*membershipEntry
}

type membershipEntry struct {
	workspaces map[uuid.UUID]struct{}
	expires    time.Time
}

func newMembershipCache(ttl time.Duration) *membershipCache {
	return &membershipCache{ttl: ttl, users: make(map[uuid.UUID]*membershipEntry)}
}

func (c *membershipCache) sharedWorkspace(ctx context.Context, db *postgres.Pool, a, b uuid.UUID) (bool, error) {
	wa, err := c.workspacesFor(ctx, db, a)
	if err != nil {
		return false, err
	}
	wb, err := c.workspacesFor(ctx, db, b)
	if err != nil {
		return false, err
	}
	if len(wa) > len(wb) {
		wa, wb = wb, wa
	}
	for ws := range wa {
		if _, ok := wb[ws]; ok {
			return true, nil
		}
	}
	return false, nil
}

func (c *membershipCache) workspacesFor(ctx context.Context, db *postgres.Pool, user uuid.UUID) (map[uuid.UUID]struct{}, error) {
	c.mu.Lock()
	entry, ok := c.users[user]
	c.mu.Unlock()
	if ok && time.Now().Before(entry.expires) {
		return entry.workspaces, nil
	}
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	rows, err := db.Query(qctx, `select workspace_id from workspace_members where user_id = $1`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var ws uuid.UUID
		if err := rows.Scan(&ws); err != nil {
			return nil, err
		}
		set[ws] = struct{}{}
	}
	c.mu.Lock()
	c.users[user] = &membershipEntry{workspaces: set, expires: time.Now().Add(c.ttl)}
	c.mu.Unlock()
	return set, nil
}
