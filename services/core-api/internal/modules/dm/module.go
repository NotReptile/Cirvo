// Package dm реализует личные сообщения (Direct Messages, G.8).
//
// DM — это channels c kind='dm' и workspace_id IS NULL. Унификация с обычными
// каналами позволяет переиспользовать messages/reactions/attachments/read_receipts
// без дублей. Доступ контролируется через channel_members (оба участника
// прописываются при создании); channel.Resolve понимает DM-scope.
//
// Один DM на пару юзеров — нормализованная запись в dm_channels (user_a < user_b)
// с unique-индексом. Find-or-create идемпотентен.
package dm

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
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
	router.Protected("GET  /api/v1/dm", m.handleList)
	router.Protected("POST /api/v1/dm", m.handleOpen)
	router.Protected("GET  /api/v1/dm/unread", m.handleUnread)
}

type peerView struct {
	UserID        string `json:"userId"`
	Username      string `json:"username"`
	DisplayName   string `json:"displayName,omitempty"`
	Online        bool   `json:"online"`
	AvatarMediaID string `json:"avatarMediaId,omitempty"`
	PresenceMode  string `json:"presenceMode,omitempty"`
	CustomStatus  string `json:"customStatus,omitempty"`
}

type dmView struct {
	ChannelID     string     `json:"channelId"`
	Peer          peerView   `json:"peer"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastMessageAt *time.Time `json:"lastMessageAt,omitempty"`
	UnreadCount   int        `json:"unreadCount"`
}

type openRequest struct {
	UserID   string `json:"userId,omitempty"`
	Username string `json:"username,omitempty"`
}

// handleList — список DM текущего юзера, отсортирован по последнему сообщению
// (свежие сверху, как в Discord). last_message_at и unread_count считаются
// одним запросом, чтобы UI не дёргал каналы по одному.
func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	rows, err := m.db.Query(r.Context(),
		`select
		   c.id, c.created_at,
		   case when d.user_a = $1 then d.user_b else d.user_a end as peer_id,
		   u.username,
		   coalesce(u.display_name, ''),
		   case
		     when u.presence_mode = 'invisible' then 'offline'
		     when not exists (
		       select 1 from user_sessions s
		       where s.user_id = u.id
		         and s.revoked_at is null
		         and s.last_seen_at > now() - interval '5 minutes'
		     ) then 'offline'
		     else u.presence_mode
		   end as effective_mode,
		   case when u.presence_mode = 'invisible' then null else u.custom_status end as effective_status,
		   (select max(m.created_at) from messages m
		     where m.channel_id = c.id and m.deleted_at is null) as last_message_at,
		   (select count(*) from messages mm
		     where mm.channel_id = c.id
		       and mm.deleted_at is null
		       and mm.author_user_id <> $1
		       and mm.created_at > coalesce(
		         (select last_read_at from read_receipts r
		           where r.channel_id = c.id and r.user_id = $1),
		         'epoch'::timestamptz)) as unread_count,
		   u.avatar_media_id
		 from dm_channels d
		 join channels c on c.id = d.channel_id
		 join users u on u.id = case when d.user_a = $1 then d.user_b else d.user_a end
		 where d.user_a = $1 or d.user_b = $1
		 order by last_message_at desc nulls last, c.created_at desc`,
		userID,
	)
	if err != nil {
		m.logger.Error("dm list failed", "error", err, "userId", userID)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]dmView, 0)
	for rows.Next() {
		var (
			chID        uuid.UUID
			created     time.Time
			peerID      uuid.UUID
			username    string
			displayName string
			effMode     string
			effStatus   *string
			lastMsg     *time.Time
			unread      int
			avatarID    *uuid.UUID
		)
		if err := rows.Scan(&chID, &created, &peerID, &username, &displayName, &effMode, &effStatus, &lastMsg, &unread, &avatarID); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		pv := peerView{
			UserID:       peerID.String(),
			Username:     username,
			DisplayName:  displayName,
			Online:       effMode != "offline",
			PresenceMode: effMode,
		}
		if avatarID != nil {
			pv.AvatarMediaID = avatarID.String()
		}
		if effStatus != nil {
			pv.CustomStatus = *effStatus
		}
		items = append(items, dmView{
			ChannelID:     chID.String(),
			Peer:          pv,
			CreatedAt:     created,
			LastMessageAt: lastMsg,
			UnreadCount:   unread,
		})
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// handleOpen — find-or-create DM-канал с указанным пиром (по userId или
// username). Идемпотентно: повторный вызов возвращает существующий канал.
// Нормализация: (user_a, user_b) = (min, max) — unique-индекс гарантирует
// единственность пары. INSERT с ON CONFLICT DO NOTHING + SELECT после —
// атомарный путь без race'ов с параллельным открытием с обеих сторон.
func (m *Module) handleOpen(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())

	var req openRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	peerID, ok := m.resolvePeer(r.Context(), w, r, req)
	if !ok {
		return
	}
	if peerID == userID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot open DM with yourself")
		return
	}

	// Нормализация пары: user_a < user_b.
	a, b := userID, peerID
	if a.String() > b.String() {
		a, b = b, a
	}

	// Сначала пробуем найти существующий DM.
	var (
		channelID uuid.UUID
	)
	err := m.db.QueryRow(r.Context(),
		`select channel_id from dm_channels where user_a = $1 and user_b = $2`,
		a, b,
	).Scan(&channelID)
	if err == nil {
		m.respondOpened(w, r, channelID, peerID, userID, false)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	// Не нашлось — создаём в транзакции (channel + dm_channels + channel_members×2).
	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	now := time.Now().UTC()
	channelID = uuid.New()
	// name — для логов/админ-панели; UI берёт имя из peer.
	dmName := "dm-" + a.String()[:8] + "-" + b.String()[:8]
	if _, err := tx.Exec(r.Context(),
		`insert into channels (id, workspace_id, kind, name, is_private, position, created_at, updated_at)
		 values ($1, null, 'dm', $2, true, 0, $3, $3)`,
		channelID, dmName, now,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create dm channel")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`insert into dm_channels (channel_id, user_a, user_b, created_at) values ($1, $2, $3, $4)
		 on conflict (user_a, user_b) do nothing`,
		channelID, a, b, now,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not register dm pair")
		return
	}
	// Race: если параллельный запрос с другой стороны успел вставить
	// dm_channels первым, наш channels-insert сирота — отменим транзакцию
	// и пере-выберем существующий канал. ON CONFLICT DO NOTHING выше не
	// вернёт ошибку, но row будет старая, не наша. Проверим:
	var dbChannelID uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`select channel_id from dm_channels where user_a = $1 and user_b = $2`,
		a, b,
	).Scan(&dbChannelID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "dm lookup failed")
		return
	}
	if dbChannelID != channelID {
		// Конкурент опередил. Откатываем транзакцию и возвращаем его канал.
		_ = tx.Rollback(r.Context())
		m.respondOpened(w, r, dbChannelID, peerID, userID, false)
		return
	}
	if _, err := tx.Exec(r.Context(),
		`insert into channel_members (channel_id, user_id, joined_at) values ($1, $2, $4), ($1, $3, $4)`,
		channelID, a, b, now,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not seed dm members")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	// Realtime: оба пира узнают о новом DM (для refresh DM-листа в UI).
	m.publishDMOpened(channelID, []uuid.UUID{a, b}, now)

	m.respondOpened(w, r, channelID, peerID, userID, true)
}

// handleUnread — суммарный unread по DM (для badge на DM-rail-иконке).
func (m *Module) handleUnread(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var total int
	err := m.db.QueryRow(r.Context(),
		`select coalesce(sum(unread), 0) from (
		   select (select count(*) from messages mm
		            where mm.channel_id = d.channel_id
		              and mm.deleted_at is null
		              and mm.author_user_id <> $1
		              and mm.created_at > coalesce(
		                (select last_read_at from read_receipts r
		                  where r.channel_id = d.channel_id and r.user_id = $1),
		                'epoch'::timestamptz)) as unread
		   from dm_channels d
		   where d.user_a = $1 or d.user_b = $1
		 ) t`,
		userID,
	).Scan(&total)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"total": total})
}

// ---- helpers ----------------------------------------------------------------

func (m *Module) resolvePeer(ctx context.Context, w http.ResponseWriter, r *http.Request, req openRequest) (uuid.UUID, bool) {
	raw := strings.TrimSpace(req.UserID)
	if raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
			return uuid.Nil, false
		}
		var exists bool
		if err := m.db.QueryRow(ctx,
			`select exists(select 1 from users where id = $1 and banned_at is null)`, id,
		).Scan(&exists); err != nil || !exists {
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
	if err := m.db.QueryRow(ctx,
		`select id from users where username = $1 and banned_at is null`, username,
	).Scan(&id); err != nil {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
		return uuid.Nil, false
	}
	return id, true
}

func (m *Module) respondOpened(w http.ResponseWriter, r *http.Request, channelID, peerID, viewerID uuid.UUID, created bool) {
	var (
		username    string
		displayName string
		effMode     string
		effStatus   *string
		createdAt   time.Time
		lastMsg     *time.Time
		unread      int
		avatarID    *uuid.UUID
	)
	err := m.db.QueryRow(r.Context(),
		`select u.username, coalesce(u.display_name, ''),
		        case
		          when u.presence_mode = 'invisible' then 'offline'
		          when not exists (select 1 from user_sessions s
		                            where s.user_id = u.id
		                              and s.revoked_at is null
		                              and s.last_seen_at > now() - interval '5 minutes') then 'offline'
		          else u.presence_mode
		        end as effective_mode,
		        case when u.presence_mode = 'invisible' then null else u.custom_status end as effective_status,
		        c.created_at,
		        (select max(m.created_at) from messages m
		           where m.channel_id = c.id and m.deleted_at is null),
		        (select count(*) from messages mm
		           where mm.channel_id = c.id
		             and mm.deleted_at is null
		             and mm.author_user_id <> $2
		             and mm.created_at > coalesce(
		               (select last_read_at from read_receipts r
		                 where r.channel_id = c.id and r.user_id = $2),
		               'epoch'::timestamptz)),
		        u.avatar_media_id
		 from users u, channels c
		 where u.id = $1 and c.id = $3`,
		peerID, viewerID, channelID,
	).Scan(&username, &displayName, &effMode, &effStatus, &createdAt, &lastMsg, &unread, &avatarID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not load dm view")
		return
	}
	pv := peerView{
		UserID:       peerID.String(),
		Username:     username,
		DisplayName:  displayName,
		Online:       effMode != "offline",
		PresenceMode: effMode,
	}
	if avatarID != nil {
		pv.AvatarMediaID = avatarID.String()
	}
	if effStatus != nil {
		pv.CustomStatus = *effStatus
	}
	view := dmView{
		ChannelID:     channelID.String(),
		Peer:          pv,
		CreatedAt:     createdAt,
		LastMessageAt: lastMsg,
		UnreadCount:   unread,
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	sharedhttp.WriteJSON(w, status, view)
}

func (m *Module) publishDMOpened(channelID uuid.UUID, recipients []uuid.UUID, createdAt time.Time) {
	if m.publisher == nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"channelId": channelID.String(),
		"createdAt": createdAt,
	})
	if err != nil {
		return
	}
	for _, uid := range recipients {
		_ = m.publisher.Publish(context.Background(), realtimebus.Event{
			Event:     "dm.opened",
			UserID:    uid.String(),
			ChannelID: channelID.String(),
			Payload:   payload,
		})
	}
}
