// Package friend — друзья, заявки, блокировки и приватные заметки (Wave 3).
//
// Модель: одна строка friendships на нормализованную пару (user_a < user_b,
// как dm_channels). status=pending/accepted/blocked; requested_by — кто
// отправил заявку (для pending) либо кто заблокировал (для blocked).
//
// Блокировка односторонняя и «невидимая»: заблокированный не получает
// никакого сигнала, его заявки в друзья отклоняются generic-ошибкой,
// DM/звонки отказывают (см. IsBlocked-вызовы в dm/message/call). В списке
// /friends блок виден только блокировщику.
package friend

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"encoding/json"
	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/notification"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
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
	router.Protected("GET  /api/v1/friends", m.handleList)
	router.Protected("POST /api/v1/friends/requests", m.handleRequest)
	router.Protected("POST /api/v1/friends/{userId}/accept", m.handleAccept)
	router.Protected("DELETE /api/v1/friends/{userId}", m.handleRemove)
	router.Protected("PUT  /api/v1/friends/{userId}/block", m.handleBlock)
	router.Protected("DELETE /api/v1/friends/{userId}/block", m.handleUnblock)
	router.Protected("GET  /api/v1/users/{userId}/note", m.handleGetNote)
	router.Protected("PUT  /api/v1/users/{userId}/note", m.handlePutNote)
}

// RowQuerier — pgx.Pool либо pgx.Tx, для IsBlocked из чужих модулей.
type RowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// IsBlocked — заблокирована ли пара (в любую сторону). Используется в
// dm.handleOpen, message.handleCreate (DM) и call.handleStart. Fail-open
// при ошибке БД: блокировка — UX-фича, не бастион; не ломать отправку
// сообщений из-за моргнувшей БД важнее.
func IsBlocked(ctx context.Context, q RowQuerier, x, y uuid.UUID) bool {
	a, b := normalizePair(x, y)
	var one int
	err := q.QueryRow(ctx,
		`select 1 from friendships where user_a = $1 and user_b = $2 and status = 'blocked'`,
		a, b,
	).Scan(&one)
	return err == nil
}

func normalizePair(x, y uuid.UUID) (uuid.UUID, uuid.UUID) {
	if x.String() > y.String() {
		return y, x
	}
	return x, y
}

type friendView struct {
	UserID        string `json:"userId"`
	Username      string `json:"username"`
	DisplayName   string `json:"displayName,omitempty"`
	AvatarMediaID string `json:"avatarMediaId,omitempty"`
	PresenceMode  string `json:"presenceMode,omitempty"`
	CustomStatus  string `json:"customStatus,omitempty"`
	Online        bool   `json:"online"`
	// accepted | pending_in (ждёт моего ответа) | pending_out (я отправил) | blocked (я заблокировал)
	Status string    `json:"status"`
	Since  time.Time `json:"since"`
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	rows, err := m.db.Query(r.Context(), `
		select
		  case when f.user_a = $1 then f.user_b else f.user_a end as peer_id,
		  u.username,
		  coalesce(u.display_name, ''),
		  u.avatar_media_id,
		  case
		    when u.presence_mode = 'invisible' then 'offline'
		    when not exists (
		      select 1 from user_sessions s
		      where s.user_id = u.id and s.revoked_at is null
		        and s.last_seen_at > now() - interval '5 minutes'
		    ) then 'offline'
		    else u.presence_mode
		  end as effective_mode,
		  case when u.presence_mode = 'invisible' then null else u.custom_status end,
		  f.status, f.requested_by, f.updated_at
		from friendships f
		join users u on u.id = case when f.user_a = $1 then f.user_b else f.user_a end
		where (f.user_a = $1 or f.user_b = $1)
		  -- чужой блок против меня невидим
		  and not (f.status = 'blocked' and f.requested_by <> $1)
		order by u.username
	`, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]friendView, 0)
	for rows.Next() {
		var (
			peerID      uuid.UUID
			username    string
			displayName string
			avatarID    *uuid.UUID
			effMode     string
			effStatus   *string
			status      string
			requestedBy uuid.UUID
			updatedAt   time.Time
		)
		if err := rows.Scan(&peerID, &username, &displayName, &avatarID, &effMode, &effStatus, &status, &requestedBy, &updatedAt); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		view := friendView{
			UserID:       peerID.String(),
			Username:     username,
			DisplayName:  displayName,
			PresenceMode: effMode,
			Online:       effMode != "offline",
			Since:        updatedAt,
		}
		if avatarID != nil {
			view.AvatarMediaID = avatarID.String()
		}
		if effStatus != nil {
			view.CustomStatus = *effStatus
		}
		switch status {
		case "accepted":
			view.Status = "accepted"
		case "blocked":
			view.Status = "blocked"
			// Блокированному не показываем presence — он «оффлайн».
			view.PresenceMode = "offline"
			view.Online = false
			view.CustomStatus = ""
		case "pending":
			if requestedBy == userID {
				view.Status = "pending_out"
			} else {
				view.Status = "pending_in"
			}
		}
		items = append(items, view)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

type requestBody struct {
	UserID   string `json:"userId,omitempty"`
	Username string `json:"username,omitempty"`
}

func (m *Module) handleRequest(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req requestBody
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	peerID, ok := m.resolveTarget(w, r, req)
	if !ok {
		return
	}
	if peerID == userID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot friend yourself")
		return
	}
	a, b := normalizePair(userID, peerID)

	var status string
	var requestedBy uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select status, requested_by from friendships where user_a = $1 and user_b = $2`, a, b,
	).Scan(&status, &requestedBy)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := m.db.Exec(r.Context(),
			`insert into friendships (user_a, user_b, status, requested_by) values ($1, $2, 'pending', $3)
			 on conflict (user_a, user_b) do nothing`,
			a, b, userID,
		); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create request")
			return
		}
		m.notify(r.Context(), notificationKindRequest, userID, peerID)
		m.publishToUser(peerID, "friend.request", map[string]string{"userId": userID.String()})
		sharedhttp.WriteJSON(w, http.StatusCreated, map[string]string{"status": "pending_out"})
	case err != nil:
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
	case status == "blocked":
		// Не палим, кто кого блокировал — generic-отказ.
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "could not send friend request")
	case status == "accepted":
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
	case requestedBy == userID:
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"status": "pending_out"})
	default:
		// Встречная заявка — авто-accept (Discord-pattern).
		m.acceptPair(w, r, userID, peerID)
	}
}

func (m *Module) handleAccept(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	peerID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	a, b := normalizePair(userID, peerID)
	var requestedBy uuid.UUID
	err := m.db.QueryRow(r.Context(),
		`select requested_by from friendships where user_a = $1 and user_b = $2 and status = 'pending'`,
		a, b,
	).Scan(&requestedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "no pending request")
		return
	}
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if requestedBy == userID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot accept own request")
		return
	}
	m.acceptPair(w, r, userID, peerID)
}

// acceptPair — переводит pending → accepted, уведомляет инициатора.
func (m *Module) acceptPair(w http.ResponseWriter, r *http.Request, userID, peerID uuid.UUID) {
	a, b := normalizePair(userID, peerID)
	if _, err := m.db.Exec(r.Context(),
		`update friendships set status = 'accepted', updated_at = now()
		 where user_a = $1 and user_b = $2 and status = 'pending'`,
		a, b,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not accept")
		return
	}
	m.notify(r.Context(), notificationKindAccept, userID, peerID)
	m.publishToUser(peerID, "friend.accepted", map[string]string{"userId": userID.String()})
	m.publishToUser(userID, "friend.accepted", map[string]string{"userId": peerID.String()})
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
}

// handleRemove — отклонить входящую, отменить исходящую или удалить из
// друзей. Блок этим НЕ снимается (отдельный DELETE /block). Идемпотентно.
func (m *Module) handleRemove(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	peerID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	a, b := normalizePair(userID, peerID)
	if _, err := m.db.Exec(r.Context(),
		`delete from friendships where user_a = $1 and user_b = $2 and status <> 'blocked'`,
		a, b,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove")
		return
	}
	m.publishToUser(peerID, "friend.removed", map[string]string{"userId": userID.String()})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleBlock(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	peerID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	if peerID == userID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot block yourself")
		return
	}
	a, b := normalizePair(userID, peerID)
	if _, err := m.db.Exec(r.Context(),
		`insert into friendships (user_a, user_b, status, requested_by)
		 values ($1, $2, 'blocked', $3)
		 on conflict (user_a, user_b)
		 do update set status = 'blocked', requested_by = $3, updated_at = now()`,
		a, b, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not block")
		return
	}
	// Блокируемому намеренно не шлём событие — блок невидим.
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleUnblock(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	peerID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	a, b := normalizePair(userID, peerID)
	if _, err := m.db.Exec(r.Context(),
		`delete from friendships
		 where user_a = $1 and user_b = $2 and status = 'blocked' and requested_by = $3`,
		a, b, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not unblock")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- приватные заметки ------------------------------------------------------

func (m *Module) handleGetNote(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	targetID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	var note string
	err := m.db.QueryRow(r.Context(),
		`select note from user_notes where owner_user_id = $1 and target_user_id = $2`,
		userID, targetID,
	).Scan(&note)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"note": note})
}

type noteBody struct {
	Note string `json:"note"`
}

func (m *Module) handlePutNote(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	targetID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	var req noteBody
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	note := strings.TrimSpace(req.Note)
	if len(note) > 2000 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "note too long")
		return
	}
	var err error
	if note == "" {
		_, err = m.db.Exec(r.Context(),
			`delete from user_notes where owner_user_id = $1 and target_user_id = $2`,
			userID, targetID)
	} else {
		_, err = m.db.Exec(r.Context(),
			`insert into user_notes (owner_user_id, target_user_id, note)
			 values ($1, $2, $3)
			 on conflict (owner_user_id, target_user_id)
			 do update set note = $3, updated_at = now()`,
			userID, targetID, note)
	}
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not save note")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"note": note})
}

// ---- helpers -----------------------------------------------------------------

const (
	notificationKindRequest = "friend_request"
	notificationKindAccept  = "friend_accept"
)

func (m *Module) notify(ctx context.Context, kind string, actorID, recipientID uuid.UUID) {
	if err := notification.Enqueue(ctx, m.db, kind, notification.JobPayload{
		Recipients: []string{recipientID.String()},
		ActorID:    actorID.String(),
	}); err != nil {
		m.logger.Warn("friend notification enqueue failed", "kind", kind, "error", err)
	}
}

func (m *Module) publishToUser(userID uuid.UUID, event string, payload map[string]string) {
	if m.publisher == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = m.publisher.Publish(context.Background(), realtimebus.Event{
		Event:   event,
		UserID:  userID.String(),
		Payload: raw,
	})
}

func (m *Module) resolveTarget(w http.ResponseWriter, r *http.Request, req requestBody) (uuid.UUID, bool) {
	if req.UserID != "" {
		id, err := uuid.Parse(req.UserID)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
			return uuid.Nil, false
		}
		var one int
		if err := m.db.QueryRow(r.Context(), `select 1 from users where id = $1`, id).Scan(&one); err != nil {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return uuid.Nil, false
		}
		return id, true
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if username == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "userId or username required")
		return uuid.Nil, false
	}
	var id uuid.UUID
	err := m.db.QueryRow(r.Context(), `select id from users where username = $1`, username).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
		return uuid.Nil, false
	}
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return uuid.Nil, false
	}
	return id, true
}

func parseUserID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := r.PathValue("userId")
	id, err := uuid.Parse(raw)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return uuid.Nil, false
	}
	return id, true
}
