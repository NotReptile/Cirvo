package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/channelacl"
	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

const (
	membershipTTL  = 30 * time.Second
	maxPayloadSize = 32 * 1024
)

var relayEvents = map[string]struct{}{
	// 1-к-1 звонки (CallManager на клиенте).
	"call.invite": {},
	"call.offer":  {},
	"call.answer": {},
	"call.ice":    {},
	"call.hangup": {},
	// Voice-каналы mesh (VoiceChannelManager). Отдельный namespace,
	// чтобы CallManager не подхватывал mesh-offer как входящий звонок.
	"voice.offer":  {},
	"voice.answer": {},
	"voice.ice":    {},
	"voice.hangup": {},
	// Track-kind / mute-state синхронизация. Принимающий не может
	// определить по MediaStreamTrack, делится ли peer экраном или
	// камерой — отдельный канал signalling'а несёт `state` JSON.
	"voice.state": {},
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
	State           json.RawMessage `json:"state,omitempty"`
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
	if targetSession != uuid.Nil {
		// A session target must belong to the claimed target user.
		uid, ok := m.lookupSessionUser(ctx, targetSession)
		if !ok || (resolvedUser != uuid.Nil && resolvedUser != uid) {
			return
		}
		resolvedUser = uid
	}
	var voiceSessions []uuid.UUID
	if strings.HasPrefix(event, "voice.") {
		channelID, err := uuid.Parse(p.ChannelID)
		if err != nil {
			return
		}
		voiceSessions, err = m.voiceRecipients(ctx, channelID, fromUser, fromSession, resolvedUser, targetSession)
		if err != nil || len(voiceSessions) == 0 {
			return
		}
	} else if resolvedUser != fromUser {
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
	if len(p.State) > 0 {
		pl["state"] = json.RawMessage(p.State)
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return
	}

	if strings.HasPrefix(event, "voice.") {
		for _, sessionID := range voiceSessions {
			m.hub.BroadcastSession(sessionID, encoded)
		}
		return
	}
	if targetSession != uuid.Nil {
		m.hub.BroadcastSession(targetSession, encoded)
		return
	}
	m.hub.BroadcastUser(targetUser, encoded)
}

// voiceRecipients checks current ACL and actual voice endpoints without caching
// grants. User-only targets receive signaling only on participating sessions.
func (m *Module) voiceRecipients(ctx context.Context, channelID, fromUser, fromSession, targetUser, targetSession uuid.UUID) ([]uuid.UUID, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	access, err := channelacl.VisibleMembers(ctx, m.db, channelID, []uuid.UUID{fromUser, targetUser})
	if err != nil || !access[fromUser] || !access[targetUser] {
		return nil, err
	}
	rows, err := m.db.Query(ctx, `select target.session_id
	 from channels c
	 join channel_participants source on source.channel_id=c.id and source.user_id=$2 and source.session_id=$3
	 join user_sessions source_session on source_session.id=source.session_id and source_session.user_id=source.user_id
	 join channel_participants target on target.channel_id=c.id and target.user_id=$4
	 join user_sessions target_session on target_session.id=target.session_id and target_session.user_id=target.user_id
	 where c.id=$1 and c.kind='voice' and c.archived_at is null
	 and source_session.revoked_at is null and source_session.refresh_expires_at>now()
	 and target_session.revoked_at is null and target_session.refresh_expires_at>now()
	 and ($5='00000000-0000-0000-0000-000000000000'::uuid or target.session_id=$5)`, channelID, fromUser, fromSession, targetUser, targetSession)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
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
