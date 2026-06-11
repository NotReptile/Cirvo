// Package voice реализует voice-каналы (mesh). REST-ручки управляют
// таблицей `channel_participants` (кто сейчас в канале), события
// `voice.joined` / `voice.left` уходят в realtimebus и фанятся realtime'ом
// на всех в воркспейсе. Сам WebRTC-сигналинг (offer/answer/ice) идёт
// через существующий `signaling`-модуль realtime-сервиса — voice-канал
// не дублирует его, только заявляет «я тут».
package voice

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

// meshLimit — потолок одновременных участников в одном voice-канале.
// Каждый клиент держит N-1 peer connection'ов; выше ~5 это становится
// неприемлемой нагрузкой на upstream. Когда появится SFU (F.2) — лимит
// уйдёт в server_settings (D.1).
const meshLimit = 5

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, logger *slog.Logger) *Module {
	return &Module{db: db, publisher: publisher, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("POST /api/v1/channels/{channelId}/voice/join", m.handleJoin)
	router.Protected("POST /api/v1/channels/{channelId}/voice/leave", m.handleLeave)
	router.Protected("GET /api/v1/channels/{channelId}/voice/participants", m.handleList)
}

type participantView struct {
	UserID      string    `json:"userId"`
	SessionID   string    `json:"sessionId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName,omitempty"`
	JoinedAt    time.Time `json:"joinedAt"`
}

type joinResponse struct {
	ChannelID string            `json:"channelId"`
	Self      participantView   `json:"self"`
	Others    []participantView `json:"others"`
}

type listResponse struct {
	Items []participantView `json:"items"`
}

func (m *Module) handleJoin(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	sessionID, ok := authctx.SessionID(r.Context())
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "no session")
		return
	}
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	scope, ok := channel.Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	if scope.Kind != "voice" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "channel is not voice")
		return
	}
	// Wave 8: в архивный voice-канал не подключаемся — сначала вернуть из архива.
	var archivedAt *time.Time
	if err := m.db.QueryRow(r.Context(),
		`select archived_at from channels where id = $1`, channelID).Scan(&archivedAt); err == nil && archivedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "channel is archived")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Считаем участников ДРУГИХ сессий — переподключение собственного
	// клиента не должно упираться в лимит.
	var others int
	err = tx.QueryRow(r.Context(),
		`select count(*) from channel_participants where channel_id = $1 and session_id <> $2`,
		channelID, sessionID,
	).Scan(&others)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if others >= meshLimit {
		sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "voice channel is full")
		return
	}

	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into channel_participants (channel_id, user_id, session_id, joined_at)
		 values ($1, $2, $3, $4)
		 on conflict (channel_id, session_id) do update set joined_at = excluded.joined_at, user_id = excluded.user_id`,
		channelID, userID, sessionID, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not join voice channel")
		return
	}

	self, err := readSelf(r.Context(), tx, userID, sessionID, now)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not read self")
		return
	}
	rest, err := readOthers(r.Context(), tx, channelID, sessionID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not read participants")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	m.broadcast("voice.joined", scope.WorkspaceID, channelID, participantEnvelope{
		ChannelID:   channelID.String(),
		UserID:      self.UserID,
		SessionID:   self.SessionID,
		Username:    self.Username,
		DisplayName: self.DisplayName,
		JoinedAt:    self.JoinedAt,
	})

	sharedhttp.WriteJSON(w, http.StatusOK, joinResponse{
		ChannelID: channelID.String(),
		Self:      self,
		Others:    rest,
	})
}

func (m *Module) handleLeave(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	sessionID, ok := authctx.SessionID(r.Context())
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "no session")
		return
	}
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	// Не зовём channel.Resolve: если канал уже удалён / юзер из него
	// вышел, leave всё равно идемпотентен. Workspace для broadcast'а
	// тянем напрямую.
	var workspaceID uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select workspace_id from channels where id = $1`,
		channelID,
	).Scan(&workspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	tag, err := m.db.Exec(r.Context(),
		`delete from channel_participants where channel_id = $1 and session_id = $2`,
		channelID, sessionID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not leave")
		return
	}
	if tag.RowsAffected() > 0 {
		m.broadcast("voice.left", workspaceID, channelID, participantEnvelope{
			ChannelID: channelID.String(),
			UserID:    userID.String(),
			SessionID: sessionID.String(),
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	if _, ok := channel.Resolve(r.Context(), m.db, channelID, userID); !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select cp.user_id, cp.session_id, u.username, u.display_name, cp.joined_at
		 from channel_participants cp
		 join users u on u.id = cp.user_id
		 where cp.channel_id = $1
		 order by cp.joined_at`,
		channelID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]participantView, 0)
	for rows.Next() {
		v, err := scanParticipant(rows)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, v)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, listResponse{Items: items})
}

// ---- helpers ---------------------------------------------------------------

type participantEnvelope struct {
	ChannelID   string    `json:"channelId"`
	UserID      string    `json:"userId"`
	SessionID   string    `json:"sessionId"`
	Username    string    `json:"username,omitempty"`
	DisplayName string    `json:"displayName,omitempty"`
	JoinedAt    time.Time `json:"joinedAt,omitempty"`
}

func (m *Module) broadcast(event string, workspaceID, channelID uuid.UUID, payload participantEnvelope) {
	raw, err := json.Marshal(payload)
	if err != nil {
		m.logger.Warn("voice broadcast marshal failed", slog.String("error", err.Error()))
		return
	}
	if err := m.publisher.Publish(context.Background(), realtimebus.Event{
		Event:       event,
		WorkspaceID: workspaceID.String(),
		ChannelID:   channelID.String(),
		Payload:     raw,
	}); err != nil {
		m.logger.Warn("voice broadcast publish failed", slog.String("error", err.Error()))
	}
}

func readSelf(ctx context.Context, tx pgx.Tx, userID, sessionID uuid.UUID, joinedAt time.Time) (participantView, error) {
	var (
		username    string
		displayName *string
	)
	err := tx.QueryRow(ctx,
		`select username, display_name from users where id = $1`,
		userID,
	).Scan(&username, &displayName)
	if err != nil {
		return participantView{}, err
	}
	v := participantView{
		UserID:    userID.String(),
		SessionID: sessionID.String(),
		Username:  username,
		JoinedAt:  joinedAt,
	}
	if displayName != nil {
		v.DisplayName = *displayName
	}
	return v, nil
}

func readOthers(ctx context.Context, tx pgx.Tx, channelID, sessionID uuid.UUID) ([]participantView, error) {
	rows, err := tx.Query(ctx,
		`select cp.user_id, cp.session_id, u.username, u.display_name, cp.joined_at
		 from channel_participants cp
		 join users u on u.id = cp.user_id
		 where cp.channel_id = $1 and cp.session_id <> $2
		 order by cp.joined_at`,
		channelID, sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]participantView, 0)
	for rows.Next() {
		v, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func scanParticipant(rows pgx.Rows) (participantView, error) {
	var (
		uid, sid    uuid.UUID
		username    string
		displayName *string
		joinedAt    time.Time
	)
	if err := rows.Scan(&uid, &sid, &username, &displayName, &joinedAt); err != nil {
		return participantView{}, err
	}
	v := participantView{
		UserID:    uid.String(),
		SessionID: sid.String(),
		Username:  username,
		JoinedAt:  joinedAt,
	}
	if displayName != nil {
		v.DisplayName = *displayName
	}
	return v, nil
}

func parseUUID(r *http.Request, name string) (uuid.UUID, bool) {
	raw := r.PathValue(name)
	if raw == "" {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
