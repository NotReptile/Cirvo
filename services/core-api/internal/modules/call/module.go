// Package call реализует CRUD истории 1-к-1 звонков. См. миграцию 8 и
// TASKS B.5. Voice-каналы свои сессии участников держат в
// channel_participants (B.1) и сюда не пишут — это в Discord-стиле,
// где в чате видна история DM-звонков, а посещения voice-комнаты — нет.
package call

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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

const (
	KindOneToOne     = "one_to_one"
	KindVoiceChannel = "voice_channel"

	defaultListLimit = 50
	maxListLimit     = 200
)

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, logger *slog.Logger) *Module {
	return &Module{db: db, publisher: publisher, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("POST /api/v1/calls", m.handleStart)
	router.Protected("POST /api/v1/calls/{callId}/end", m.handleEnd)
	router.Protected("GET /api/v1/calls/{callId}", m.handleGet)
	router.Protected("GET /api/v1/channels/{channelId}/calls", m.handleList)
}

type startRequest struct {
	Kind       string `json:"kind"`
	PeerUserID string `json:"peerUserId,omitempty"`
	ChannelID  string `json:"channelId,omitempty"`
}

type endRequest struct {
	Reason string `json:"reason,omitempty"`
}

type callView struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	InitiatorID string     `json:"initiatorId"`
	PeerID      string     `json:"peerId,omitempty"`
	ChannelID   string     `json:"channelId,omitempty"`
	StartedAt   time.Time  `json:"startedAt"`
	EndedAt     *time.Time `json:"endedAt,omitempty"`
	Reason      string     `json:"reason,omitempty"`
	DurationMs  *int64     `json:"durationMs,omitempty"`
}

type listResponse struct {
	Items []callView `json:"items"`
}

// ---- start -----------------------------------------------------------------

func (m *Module) handleStart(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req startRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.Kind != KindOneToOne && req.Kind != KindVoiceChannel {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid kind")
		return
	}

	var (
		peerID    *uuid.UUID
		channelID *uuid.UUID
	)

	if req.Kind == KindOneToOne {
		if req.PeerUserID == "" {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "peerUserId is required for one_to_one")
			return
		}
		pid, err := uuid.Parse(req.PeerUserID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid peerUserId")
			return
		}
		if pid == userID {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot call self")
			return
		}
		if !shareWorkspace(r.Context(), m.db, userID, pid) {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "peer not in shared workspace")
			return
		}
		peerID = &pid
	}

	if req.ChannelID != "" {
		cid, err := uuid.Parse(req.ChannelID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channelId")
			return
		}
		scope, ok := channel.Resolve(r.Context(), m.db, cid, userID)
		if !ok {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
			return
		}
		// voice_channel требует kind=voice; one_to_one привязка к
		// каналу — для контекста (DM нет, но можно ассоциировать).
		if req.Kind == KindVoiceChannel && scope.Kind != "voice" {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "channel is not voice")
			return
		}
		channelID = &cid
	} else if req.Kind == KindVoiceChannel {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "channelId is required for voice_channel")
		return
	}

	id := uuid.New()
	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`insert into calls (id, kind, initiator_user_id, peer_user_id, channel_id, started_at)
		 values ($1, $2, $3, $4, $5, $6)`,
		id, req.Kind, userID, peerID, channelID, now,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not start call")
		return
	}

	view := callView{
		ID:          id.String(),
		Kind:        req.Kind,
		InitiatorID: userID.String(),
		StartedAt:   now,
	}
	if peerID != nil {
		view.PeerID = peerID.String()
	}
	if channelID != nil {
		view.ChannelID = channelID.String()
	}
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}

// ---- end -------------------------------------------------------------------

func (m *Module) handleEnd(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	callID, ok := parseUUID(r, "callId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid call id")
		return
	}
	var req endRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		// тело опционально
		req = endRequest{}
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		kind        string
		initiatorID uuid.UUID
		peerID      *uuid.UUID
		channelID   *uuid.UUID
		startedAt   time.Time
		endedAt     *time.Time
		oldReason   *string
	)
	err = tx.QueryRow(r.Context(),
		`select kind, initiator_user_id, peer_user_id, channel_id, started_at, ended_at, reason
		 from calls where id = $1 for update`,
		callID,
	).Scan(&kind, &initiatorID, &peerID, &channelID, &startedAt, &endedAt, &oldReason)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "call not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	// ACL: завершить может инициатор или peer (для 1-к-1).
	// voice_channel — пока не пишется клиентом, но если когда-нибудь
	// будет — только инициатор.
	if userID != initiatorID && (peerID == nil || userID != *peerID) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "not a participant")
		return
	}

	// Идемпотентно: если уже завершён, возвращаем текущее состояние.
	if endedAt != nil {
		view := buildView(callID, kind, initiatorID, peerID, channelID, startedAt, endedAt, derefStr(oldReason))
		_ = tx.Rollback(r.Context())
		sharedhttp.WriteJSON(w, http.StatusOK, view)
		return
	}

	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`update calls set ended_at = $1, reason = nullif($2, '') where id = $3`,
		now, req.Reason, callID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not end call")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	view := buildView(callID, kind, initiatorID, peerID, channelID, startedAt, &now, req.Reason)

	// realtime: пушим call.ended всем участникам, чтобы UI обоих пиров
	// синхронно увидел финальный durationMs (а не локальный Date.now()).
	// Используем channel_id как routing-ключ если он есть; для
	// «одиноких» 1-к-1 без канала события идут по userID — для этого
	// нужен публичный broadcast UserID, которого у нас нет; пока
	// маршрутизируем по workspace через первый общий workspace.
	if m.publisher != nil {
		payload, _ := json.Marshal(view)
		wsID := firstSharedWorkspace(r.Context(), m.db, initiatorID, peerID)
		evt := realtimebus.Event{Event: "call.ended", Payload: payload}
		if channelID != nil {
			evt.ChannelID = channelID.String()
		}
		if wsID != uuid.Nil {
			evt.WorkspaceID = wsID.String()
		}
		_ = m.publisher.Publish(context.Background(), evt)
	}

	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// ---- get -------------------------------------------------------------------

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	callID, ok := parseUUID(r, "callId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid call id")
		return
	}
	var (
		kind        string
		initiatorID uuid.UUID
		peerID      *uuid.UUID
		channelID   *uuid.UUID
		startedAt   time.Time
		endedAt     *time.Time
		reason      *string
	)
	err := m.db.QueryRow(r.Context(),
		`select kind, initiator_user_id, peer_user_id, channel_id, started_at, ended_at, reason
		 from calls where id = $1`,
		callID,
	).Scan(&kind, &initiatorID, &peerID, &channelID, &startedAt, &endedAt, &reason)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "call not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if userID != initiatorID && (peerID == nil || userID != *peerID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "call not visible")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, buildView(callID, kind, initiatorID, peerID, channelID, startedAt, endedAt, derefStr(reason)))
}

// ---- list ------------------------------------------------------------------

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
	limit := defaultListLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err == nil && parsed > 0 {
			if parsed > maxListLimit {
				parsed = maxListLimit
			}
			limit = parsed
		}
	}
	rows, err := m.db.Query(r.Context(),
		`select id, kind, initiator_user_id, peer_user_id, channel_id, started_at, ended_at, reason
		 from calls
		 where channel_id = $1
		 order by started_at desc
		 limit $2`,
		channelID, limit,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]callView, 0)
	for rows.Next() {
		var (
			id, initiator uuid.UUID
			kind          string
			peerID        *uuid.UUID
			chID          *uuid.UUID
			startedAt     time.Time
			endedAt       *time.Time
			reason        *string
		)
		if err := rows.Scan(&id, &kind, &initiator, &peerID, &chID, &startedAt, &endedAt, &reason); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, buildView(id, kind, initiator, peerID, chID, startedAt, endedAt, derefStr(reason)))
	}
	sharedhttp.WriteJSON(w, http.StatusOK, listResponse{Items: items})
}

// ---- helpers ---------------------------------------------------------------

func buildView(id uuid.UUID, kind string, initiator uuid.UUID, peer *uuid.UUID, channel *uuid.UUID, started time.Time, ended *time.Time, reason string) callView {
	v := callView{
		ID:          id.String(),
		Kind:        kind,
		InitiatorID: initiator.String(),
		StartedAt:   started,
		EndedAt:     ended,
		Reason:      reason,
	}
	if peer != nil {
		v.PeerID = peer.String()
	}
	if channel != nil {
		v.ChannelID = channel.String()
	}
	if ended != nil {
		d := ended.Sub(started).Milliseconds()
		v.DurationMs = &d
	}
	return v
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

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func shareWorkspace(ctx context.Context, db *postgres.Pool, a, b uuid.UUID) bool {
	var exists bool
	err := db.QueryRow(ctx,
		`select exists (
		   select 1 from workspace_members ma
		   join workspace_members mb on mb.workspace_id = ma.workspace_id
		   where ma.user_id = $1 and mb.user_id = $2
		 )`,
		a, b,
	).Scan(&exists)
	return err == nil && exists
}

func firstSharedWorkspace(ctx context.Context, db *postgres.Pool, a uuid.UUID, b *uuid.UUID) uuid.UUID {
	if b == nil {
		return uuid.Nil
	}
	var ws uuid.UUID
	err := db.QueryRow(ctx,
		`select ma.workspace_id
		 from workspace_members ma
		 join workspace_members mb on mb.workspace_id = ma.workspace_id
		 where ma.user_id = $1 and mb.user_id = $2
		 limit 1`,
		a, *b,
	).Scan(&ws)
	if err != nil {
		return uuid.Nil
	}
	return ws
}
