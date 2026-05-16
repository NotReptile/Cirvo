package transport

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

const (
	readDeadline    = 60 * time.Second
	pingInterval    = 25 * time.Second
	writeDeadline   = 10 * time.Second
	maxReadBytes    = 1 << 16
	closeReasonAuth = "unauthorized"
)

type Module struct {
	logger *slog.Logger
	db     *postgres.Pool
	jwt    *jwtauth.Issuer
	hub    *hub.Hub
}

func NewModule(logger *slog.Logger, db *postgres.Pool, jwt *jwtauth.Issuer, h *hub.Hub) *Module {
	return &Module{logger: logger, db: db, jwt: jwt, hub: h}
}

func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", m.handleConnect)
}

type envelope struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func (m *Module) handleConnect(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("access_token")
	if token == "" {
		token = bearerToken(r)
	}
	if token == "" {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "missing access token")
		return
	}
	claims, err := m.jwt.Parse(token)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid token")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	if !sessionAlive(ctx, m.db, claims.SessionID, claims.UserID) {
		cancel()
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeSessionRevoked, "session not active")
		return
	}
	workspaces, err := loadUserWorkspaces(ctx, m.db, claims.UserID)
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

	connection := hub.NewConnection(claims.SessionID, claims.UserID, workspaces)
	m.hub.Add(connection)
	defer func() {
		m.hub.Remove(connection)
		_ = wsConn.Close(websocket.StatusNormalClosure, "bye")
	}()

	snapshot := buildPresenceSnapshot(workspaces)
	if encoded, err := json.Marshal(snapshot); err == nil {
		select {
		case connection.Send <- encoded:
		default:
		}
	}

	connectionCtx, cancelConn := context.WithCancel(context.Background())
	defer cancelConn()

	go m.readLoop(connectionCtx, cancelConn, wsConn, connection)
	m.writeLoop(connectionCtx, wsConn, connection)
}

func (m *Module) readLoop(ctx context.Context, cancel context.CancelFunc, wsConn *websocket.Conn, conn *hub.Connection) {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Close:
			return
		default:
		}
		readCtx, readCancel := context.WithTimeout(ctx, readDeadline)
		_, _, err := wsConn.Read(readCtx)
		readCancel()
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				m.logger.Debug("read loop ended", "error", err)
			}
			return
		}
	}
}

func (m *Module) writeLoop(ctx context.Context, wsConn *websocket.Conn, conn *hub.Connection) {
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
		}
	}
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return ""
	}
	return header[len(prefix):]
}

func sessionAlive(ctx context.Context, db *postgres.Pool, sessionID, userID uuid.UUID) bool {
	var revoked *time.Time
	err := db.QueryRow(ctx,
		`select revoked_at from user_sessions where id = $1 and user_id = $2`,
		sessionID, userID,
	).Scan(&revoked)
	if err != nil {
		return false
	}
	return revoked == nil
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
	Event   string             `json:"event"`
	Payload presenceSnapshotPL `json:"payload"`
}

type presenceSnapshotPL struct {
	Workspaces []string `json:"workspaces"`
	Timestamp  string   `json:"timestamp"`
}

func buildPresenceSnapshot(workspaces []uuid.UUID) presenceSnapshot {
	ws := make([]string, 0, len(workspaces))
	for _, id := range workspaces {
		ws = append(ws, id.String())
	}
	return presenceSnapshot{
		Event: "presence.snapshot",
		Payload: presenceSnapshotPL{
			Workspaces: ws,
			Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
		},
	}
}
