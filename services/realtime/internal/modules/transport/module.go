package transport

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/jwtauth"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	sharedticket "github.com/NotReptile/Cirvo/libs/shared-go/wsticket"
	"github.com/NotReptile/Cirvo/services/realtime/internal/eventjournal"
	"github.com/NotReptile/Cirvo/services/realtime/internal/hub"
)

const (
	pingInterval    = 25 * time.Second
	writeDeadline   = 10 * time.Second
	maxReadBytes    = 1 << 16
	closeReasonAuth = "unauthorized"
	// G.6.b: минимальный интервал между subscription.refresh per-connection —
	// каждый refresh ходит в БД, спам с клиента не должен её дёргать.
	refreshThrottle = 2 * time.Second
)

// Dispatcher routes a single inbound client→server frame. Implementations must
// not block (offload to goroutine if needed).
type Dispatcher interface {
	Handles(event string) bool
	Relay(ctx context.Context, event string, fromUser, fromSession uuid.UUID, rawPayload []byte)
}

type Module struct {
	logger         *slog.Logger
	db             *postgres.Pool
	jwt            *jwtauth.Issuer
	hub            *hub.Hub
	journal        *eventjournal.Journal
	tickets        *sharedticket.Store
	dispatchers    []Dispatcher
	presenceLockMu sync.Mutex
	presenceLocks  map[uuid.UUID]*presenceLock
}

func NewModule(logger *slog.Logger, db *postgres.Pool, jwt *jwtauth.Issuer, h *hub.Hub, journal *eventjournal.Journal, tickets *sharedticket.Store, dispatchers ...Dispatcher) *Module {
	return &Module{logger: logger, db: db, jwt: jwt, hub: h, journal: journal, tickets: tickets, dispatchers: dispatchers}
}

func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", m.handleConnect)
}

type envelope struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func (m *Module) handleConnect(w http.ResponseWriter, r *http.Request) {
	if ticket := r.URL.Query().Get("ticket"); ticket != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		claims, err := m.tickets.Consume(ctx, ticket, sharedticket.PurposeRealtime)
		cancel()
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid websocket ticket")
			return
		}
		m.connectAuthenticated(w, r, claims.UserID, claims.SessionID)
		return
	}
	sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "websocket ticket required")
}

func (m *Module) connectAuthenticated(w http.ResponseWriter, r *http.Request, userID, sessionID uuid.UUID) {

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	alive, passwordPending := sessionStatus(ctx, m.db, sessionID, userID)
	if !alive {
		cancel()
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeSessionRevoked, "session not active")
		return
	}
	// Временный пароль не заменён: события воркспейсов недоступны, как и API.
	if passwordPending {
		cancel()
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodePasswordChangeRequired, "password change required")
		return
	}
	workspaces, err := loadUserWorkspaces(ctx, m.db, userID)
	cancel()
	if err != nil {
		m.logger.Error("workspace lookup failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "workspace lookup failed")
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		m.logger.Error("websocket accept failed", "error", err)
		return
	}
	wsConn.SetReadLimit(maxReadBytes)

	connection := hub.NewConnection(sessionID, userID, workspaces)
	m.connectPresence(connection)
	defer func() {
		m.disconnectPresence(connection)
		_ = wsConn.Close(websocket.StatusNormalClosure, "bye")
	}()

	m.initializeSync(r.Context(), connection, workspaces, parseCursor(r))
	connection.Activate()

	connectionCtx, cancelConn := context.WithCancel(context.Background())
	defer cancelConn()

	go m.readLoop(connectionCtx, cancelConn, wsConn, connection)
	m.writeLoop(connectionCtx, wsConn, connection, sessionID)
}

func parseCursor(r *http.Request) int64 {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func (m *Module) initializeSync(ctx context.Context, conn *hub.Connection, workspaces []uuid.UUID, cursor int64) {
	syncCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	highWater, err := m.journal.HighWater(syncCtx)
	if err != nil {
		m.logger.Warn("realtime high-water lookup failed", "error", err)
		m.sendControl(conn, "sync.required", map[string]any{"reason": "journal_unavailable", "cursor": 0})
		m.sendPresence(conn, workspaces)
		return
	}

	requiresSnapshot := cursor == 0
	reason := "missing_cursor"
	if cursor > 0 {
		minimum, minErr := m.journal.MinimumCursor(syncCtx)
		if minErr != nil {
			requiresSnapshot = true
			reason = "journal_unavailable"
		} else if minimum > 0 && cursor < minimum-1 {
			requiresSnapshot = true
			reason = "cursor_expired"
		}
	}

	if !requiresSnapshot && cursor < highWater {
		items, replayErr := m.journal.Replay(syncCtx, conn.UserID, workspaces, cursor, highWater)
		if replayErr != nil || len(items) >= eventjournal.MaxReplayItems {
			requiresSnapshot = true
			if errors.Is(replayErr, eventjournal.ErrReplayLimit) {
				reason = "replay_limit"
			} else if replayErr != nil {
				reason = "replay_failed"
			} else {
				reason = "replay_limit"
			}
		} else {
			for _, item := range items {
				encoded, marshalErr := json.Marshal(item)
				if marshalErr != nil || !conn.SendReplay(encoded) {
					return
				}
			}
		}
	}

	if requiresSnapshot {
		m.sendControl(conn, "sync.required", map[string]any{"reason": reason, "cursor": highWater})
	} else {
		m.sendControl(conn, "sync.ready", map[string]any{"cursor": highWater, "workspaces": uuidStrings(workspaces)})
	}
	m.sendPresence(conn, workspaces)
}

func (m *Module) sendControl(conn *hub.Connection, event string, payload any) {
	encoded, err := json.Marshal(map[string]any{
		"version": 2,
		"event":   event,
		"payload": payload,
	})
	if err == nil {
		conn.SendReplay(encoded)
	}
}

func (m *Module) sendPresence(conn *hub.Connection, workspaces []uuid.UUID) {
	snapshot := buildPresenceSnapshot(workspaces)
	snapshot.Payload.Users = m.visiblePresenceSnapshot(conn.UserID, workspaces)
	if encoded, err := json.Marshal(snapshot); err == nil {
		conn.SendReplay(encoded)
	}
}

func uuidStrings(ids []uuid.UUID) []string {
	values := make([]string, 0, len(ids))
	for _, id := range ids {
		values = append(values, id.String())
	}
	return values
}

func (m *Module) readLoop(ctx context.Context, cancel context.CancelFunc, wsConn *websocket.Conn, conn *hub.Connection) {
	defer cancel()
	var lastRefresh time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Close:
			return
		default:
		}
		// Таймаута на Read нет намеренно: Read обрабатывает pong внутри себя и
		// не возвращается, пока нет data-кадра, поэтому дедлайн закрывал бы
		// простаивающее соединение каждые 60 с, хотя pong приходит исправно.
		// Мёртвый пир обнаруживается по неудачному Ping в writeLoop.
		msgType, data, err := wsConn.Read(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				m.logger.Debug("read loop ended", "error", err)
			}
			return
		}
		if msgType != websocket.MessageText || len(data) == 0 {
			continue
		}
		var env envelope
		if err := json.Unmarshal(data, &env); err != nil {
			m.logger.Debug("inbound envelope rejected", "error", err)
			continue
		}
		if env.Event == "" {
			continue
		}
		// G.6.b: клиент просит перечитать workspace-membership без разрыва WS
		// (вступил в воркспейс / создал новый). Список берём из БД — клиенту
		// нельзя доверять перечень workspace-id напрямую.
		if env.Event == "subscription.refresh" {
			if time.Since(lastRefresh) < refreshThrottle {
				continue
			}
			lastRefresh = time.Now()
			m.refreshSubscriptions(ctx, conn)
			continue
		}
		for _, d := range m.dispatchers {
			if d.Handles(env.Event) {
				d.Relay(ctx, env.Event, conn.UserID, conn.SessionID, env.Payload)
				break
			}
		}
	}
}

func (m *Module) writeLoop(ctx context.Context, wsConn *websocket.Conn, conn *hub.Connection, sessionID uuid.UUID) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Close:
			return
		case payload, ok := <-conn.Send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeDeadline)
			err := wsConn.Write(writeCtx, websocket.MessageText, payload)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeDeadline)
			err := wsConn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
			m.touchSession(ctx, sessionID)
		}
	}
}

// refreshSubscriptions перечитывает membership юзера и перекладывает
// соединение по hub-bucket'ам. Подтверждение клиенту — свежий
// presence.snapshot (тот же event, что и при коннекте).
func (m *Module) refreshSubscriptions(ctx context.Context, conn *hub.Connection) {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	workspaces, err := loadUserWorkspaces(queryCtx, m.db, conn.UserID)
	cancel()
	if err != nil {
		m.logger.Warn("subscription refresh failed", "userId", conn.UserID.String(), "error", err)
		return
	}
	m.hub.UpdateWorkspaces(conn, workspaces)
	m.sendPresence(conn, workspaces)
}

func (m *Module) touchSession(ctx context.Context, sessionID uuid.UUID) {
	touchCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, _ = m.db.Exec(touchCtx,
		`update user_sessions set last_seen_at = now() where id = $1 and revoked_at is null`,
		sessionID,
	)
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return ""
	}
	return header[len(prefix):]
}

// sessionStatus сообщает, жива ли сессия и ждёт ли пользователь смены
// временного пароля (users.must_change_password).
func sessionStatus(ctx context.Context, db *postgres.Pool, sessionID, userID uuid.UUID) (alive, passwordPending bool) {
	var revoked *time.Time
	err := db.QueryRow(ctx,
		`select s.revoked_at, u.must_change_password
		 from user_sessions s join users u on u.id = s.user_id
		 where s.id = $1 and s.user_id = $2`,
		sessionID, userID,
	).Scan(&revoked, &passwordPending)
	if err != nil || revoked != nil {
		return false, false
	}
	return true, passwordPending
}

func loadUserWorkspaces(ctx context.Context, db *postgres.Pool, userID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := db.Query(ctx, `select workspace_id from workspace_members where user_id = $1`, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

type presenceSnapshot struct {
	Version int                `json:"version"`
	Event   string             `json:"event"`
	Payload presenceSnapshotPL `json:"payload"`
}

type presenceSnapshotPL struct {
	Users      []presenceView `json:"users,omitempty"`
	Workspaces []string       `json:"workspaces"`
	Timestamp  string         `json:"timestamp"`
}

func buildPresenceSnapshot(workspaces []uuid.UUID) presenceSnapshot {
	ws := make([]string, 0, len(workspaces))
	for _, id := range workspaces {
		ws = append(ws, id.String())
	}
	return presenceSnapshot{
		Version: 2,
		Event:   "presence.snapshot",
		Payload: presenceSnapshotPL{
			Workspaces: ws,
			Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
		},
	}
}
