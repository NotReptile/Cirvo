// WS-сигналинг SFU. Авторизация: одноразовый тикет и живая сессия в
// user_sessions. Дополнительно — членство в voice-канале: клиент обязан
// сначала сделать POST /voice/join в core-api (строка в
// channel_participants), иначе 403. Core-api проверяет лимит участников;
// SFU дополнительно проверяет общую ACL-видимость и архив, затем пакетно
// перепроверяет активные соединения, чтобы отзыв прав закрывал медиапоток.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/channelacl"
	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	sharedticket "github.com/NotReptile/RuCord/libs/shared-go/wsticket"

	"github.com/NotReptile/RuCord/services/sfu/internal/rtc"
)

const (
	readDeadline  = 60 * time.Second
	writeDeadline = 10 * time.Second
	pingInterval  = 25 * time.Second
	maxReadBytes  = 1 << 17 // SDP с десятком m-line легко уходит за 32K
)

type Module struct {
	logger     *slog.Logger
	db         *postgres.Pool
	jwt        *jwtauth.Issuer
	manager    *rtc.Manager
	tickets    *sharedticket.Store
	accessMu   sync.Mutex
	active     map[*rtc.Peer]activeConnection
	monitoring bool
}

func NewModule(logger *slog.Logger, db *postgres.Pool, jwt *jwtauth.Issuer, manager *rtc.Manager, tickets *sharedticket.Store) *Module {
	return &Module{logger: logger, db: db, jwt: jwt, manager: manager, tickets: tickets}
}

func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /sfu/ws", m.handleConnect)
}

type envelope struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func (m *Module) handleConnect(w http.ResponseWriter, r *http.Request) {
	if ticket := r.URL.Query().Get("ticket"); ticket != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		claims, err := m.tickets.Consume(ctx, ticket, sharedticket.PurposeSFU)
		cancel()
		if err != nil || claims.ChannelID == uuid.Nil {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid websocket ticket")
			return
		}
		m.connectAuthenticated(w, r, claims.UserID, claims.SessionID, claims.ChannelID)
		return
	}
	sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "websocket ticket required")
}

func (m *Module) connectAuthenticated(w http.ResponseWriter, r *http.Request, userID, sessionID, channelID uuid.UUID) {

	checkCtx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	alive, passwordPending := sessionStatus(checkCtx, m.db, sessionID, userID)
	if !alive {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeSessionRevoked, "session not active")
		return
	}
	if passwordPending {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodePasswordChangeRequired, "password change required")
		return
	}
	if !isVoiceParticipant(checkCtx, m.db, channelID, sessionID) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "join the voice channel first")
		return
	}
	visible, accessErr := channelacl.VisibleChannel(checkCtx, m.db, channelID, userID)
	if accessErr != nil || !visible {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "channel access unavailable")
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		m.logger.Error("websocket accept failed", "error", err)
		return
	}
	wsConn.SetReadLimit(maxReadBytes)

	sig := &wsSignaler{conn: wsConn}
	peer, err := m.manager.Join(channelID, userID, sessionID, sig)
	if err != nil {
		m.logger.Error("sfu join failed", "error", err)
		_ = wsConn.Close(websocket.StatusInternalError, "join failed")
		return
	}
	defer peer.Close("ws closed")
	m.trackConnection(peer, activeConnection{userID: userID, sessionID: sessionID, channelID: channelID, conn: wsConn})
	defer m.untrackConnection(peer)

	go pingLoop(r.Context(), wsConn)
	m.readLoop(r.Context(), wsConn, peer)
}

func (m *Module) readLoop(ctx context.Context, wsConn *websocket.Conn, peer *rtc.Peer) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, readDeadline)
		msgType, data, err := wsConn.Read(readCtx)
		cancel()
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				m.logger.Debug("sfu read loop ended", "error", err)
			}
			return
		}
		if msgType != websocket.MessageText || len(data) == 0 {
			continue
		}
		var env envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		switch env.Event {
		case "pub.offer":
			var p rtc.SDPPayload
			if json.Unmarshal(env.Payload, &p) == nil {
				peer.HandlePubOffer(p)
			}
		case "sub.answer":
			var p rtc.SDPPayload
			if json.Unmarshal(env.Payload, &p) == nil {
				peer.HandleSubAnswer(p)
			}
		case "pub.ice":
			var p rtc.ICEPayload
			if json.Unmarshal(env.Payload, &p) == nil {
				peer.HandlePubICE(p)
			}
		case "sub.ice":
			var p rtc.ICEPayload
			if json.Unmarshal(env.Payload, &p) == nil {
				peer.HandleSubICE(p)
			}
		}
	}
}

func pingLoop(ctx context.Context, wsConn *websocket.Conn) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
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

// wsSignaler — потокобезопасная запись в WS (Send зовётся и из
// read-loop, и из горутин других peer'ов при renegotiation).
type wsSignaler struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (s *wsSignaler) Send(event string, payload any) error {
	body, err := json.Marshal(struct {
		Event   string `json:"event"`
		Payload any    `json:"payload"`
	}{Event: event, Payload: payload})
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeDeadline)
	defer cancel()
	return s.conn.Write(ctx, websocket.MessageText, body)
}

func (s *wsSignaler) Close(reason string) {
	_ = s.conn.Close(websocket.StatusNormalClosure, reason)
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

func isVoiceParticipant(ctx context.Context, db *postgres.Pool, channelID, sessionID uuid.UUID) bool {
	var exists bool
	err := db.QueryRow(ctx,
		`select exists(select 1 from channel_participants cp join channels c on c.id = cp.channel_id
		 where cp.channel_id = $1 and cp.session_id = $2 and c.archived_at is null)`,
		channelID, sessionID,
	).Scan(&exists)
	return err == nil && exists
}
