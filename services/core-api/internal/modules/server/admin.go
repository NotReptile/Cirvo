package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/retention"
	"github.com/NotReptile/Cirvo/services/core-api/internal/auditlog"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/serversettings"
)

// adminUserView — строка в списке пользователей админ-панели.
type adminUserView struct {
	ID            string     `json:"id"`
	Email         string     `json:"email"`
	Username      string     `json:"username"`
	DisplayName   string     `json:"displayName,omitempty"`
	IsRoot        bool       `json:"isRoot"`
	BannedAt      *time.Time `json:"bannedAt,omitempty"`
	BannedReason  string     `json:"bannedReason,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastSeenAt    *time.Time `json:"lastSeenAt,omitempty"`
	ActiveSession bool       `json:"activeSession"`
}

type adminUsersResponse struct {
	Items []adminUserView `json:"items"`
	Total int             `json:"total"`
}

type banRequest struct {
	Reason string `json:"reason,omitempty"`
}

type metricsView struct {
	UserCount              int   `json:"userCount"`
	BannedUserCount        int   `json:"bannedUserCount"`
	WorkspaceCount         int   `json:"workspaceCount"`
	ChannelCount           int   `json:"channelCount"`
	MessageCount           int64 `json:"messageCount"`
	ActiveSessions24h      int   `json:"activeSessions24h"`
	StorageBytes           int64 `json:"storageBytes"`
	MediaObjectCount       int64 `json:"mediaObjectCount"`
	DatabaseSizeBytes      int64 `json:"databaseSizeBytes"`
	StorageQuotaBytes      int64 `json:"storageQuotaBytes"`
	StorageQuotaUsedRatio  float64 `json:"storageQuotaUsedRatio,omitempty"`
}

func (m *Module) requireRoot(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	userID := authctx.MustUserID(r.Context())
	if !serversettings.IsRoot(r.Context(), m.db, userID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "not found")
		return uuid.Nil, false
	}
	return userID, true
}

func parseUserID(r *http.Request) (uuid.UUID, bool) {
	raw := r.PathValue("userId")
	if raw == "" {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

func (m *Module) handleListUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := m.requireRoot(w, r); !ok {
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 200 {
			limit = v
		}
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 0 {
			offset = v
		}
	}

	// like-параметр: пустой → не фильтруем (через `where ($1 = '' or ...)`).
	pattern := ""
	if q != "" {
		pattern = "%" + strings.ToLower(q) + "%"
	}

	var total int
	err := m.db.QueryRow(r.Context(),
		`select count(*) from users
		 where $1 = '' or lower(email) like $1 or lower(username) like $1
		   or coalesce(lower(display_name), '') like $1`,
		pattern,
	).Scan(&total)
	if err != nil {
		m.logger.Error("admin users count failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	rows, err := m.db.Query(r.Context(),
		`select u.id, u.email, u.username, u.display_name, u.is_root,
		        u.banned_at, u.banned_reason, u.created_at,
		        (select max(last_seen_at) from user_sessions s where s.user_id = u.id) as last_seen_at,
		        exists(
		          select 1 from user_sessions s
		          where s.user_id = u.id and s.revoked_at is null
		            and s.last_seen_at > now() - interval '24 hours'
		        ) as active_session
		 from users u
		 where $1 = '' or lower(u.email) like $1 or lower(u.username) like $1
		   or coalesce(lower(u.display_name), '') like $1
		 order by u.created_at asc
		 limit $2 offset $3`,
		pattern, limit, offset,
	)
	if err != nil {
		m.logger.Error("admin users list failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]adminUserView, 0, limit)
	for rows.Next() {
		var (
			id            uuid.UUID
			email         string
			username      string
			display       *string
			isRoot        bool
			bannedAt      *time.Time
			bannedReason  *string
			createdAt     time.Time
			lastSeenAt    *time.Time
			activeSession bool
		)
		if err := rows.Scan(&id, &email, &username, &display, &isRoot, &bannedAt, &bannedReason, &createdAt, &lastSeenAt, &activeSession); err != nil {
			m.logger.Error("admin users scan failed", "error", err)
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
			return
		}
		view := adminUserView{
			ID:            id.String(),
			Email:         email,
			Username:      username,
			IsRoot:        isRoot,
			BannedAt:      bannedAt,
			CreatedAt:     createdAt,
			LastSeenAt:    lastSeenAt,
			ActiveSession: activeSession,
		}
		if display != nil {
			view.DisplayName = *display
		}
		if bannedReason != nil {
			view.BannedReason = *bannedReason
		}
		items = append(items, view)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, adminUsersResponse{Items: items, Total: total})
}

func (m *Module) handleBanUser(w http.ResponseWriter, r *http.Request) {
	actorID, ok := m.requireRoot(w, r)
	if !ok {
		return
	}
	targetID, ok := parseUserID(r)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	if targetID == actorID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot ban yourself")
		return
	}

	var req banRequest
	// тело необязательное — пустой POST допускаем
	if r.ContentLength > 0 {
		if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
			return
		}
	}
	reason := strings.TrimSpace(req.Reason)
	if len(reason) > 500 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "reason too long")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		isRootTarget bool
		alreadyBan   *time.Time
	)
	err = tx.QueryRow(r.Context(),
		`select is_root, banned_at from users where id = $1 for update`,
		targetID,
	).Scan(&isRootTarget, &alreadyBan)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if isRootTarget {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot ban root user")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`update users set banned_at = now(), banned_reason = nullif($2, '') where id = $1`,
		targetID, reason,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "ban failed")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
		targetID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "session revoke failed")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    actorID,
		Action:     auditlog.ActionUserBanned,
		TargetType: "user",
		TargetID:   targetID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleUnbanUser(w http.ResponseWriter, r *http.Request) {
	actorID, ok := m.requireRoot(w, r)
	if !ok {
		return
	}
	targetID, ok := parseUserID(r)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	tag, err := m.db.Exec(r.Context(),
		`update users set banned_at = null, banned_reason = null where id = $1`,
		targetID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "unban failed")
		return
	}
	if tag.RowsAffected() == 0 {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
		return
	}
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    actorID,
		Action:     auditlog.ActionUserUnbanned,
		TargetType: "user",
		TargetID:   targetID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	actorID, ok := m.requireRoot(w, r)
	if !ok {
		return
	}
	targetID, ok := parseUserID(r)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	if targetID == actorID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot delete yourself")
		return
	}
	var isRootTarget bool
	if err := m.db.QueryRow(r.Context(),
		`select is_root from users where id = $1`, targetID,
	).Scan(&isRootTarget); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if isRootTarget {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "cannot delete root user")
		return
	}

	// Аудит ДО удаления — иначе FK actor_user_id может попасть в target
	// (мы фильтруем actor, не target, но всё же фиксируем факт пока юзер есть).
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    actorID,
		Action:     auditlog.ActionUserDeleted,
		TargetType: "user",
		TargetID:   targetID.String(),
	})

	if _, err := m.db.Exec(r.Context(), `delete from users where id = $1`, targetID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if _, ok := m.requireRoot(w, r); !ok {
		return
	}

	var view metricsView
	if err := m.db.QueryRow(r.Context(),
		`select
		   (select count(*) from users),
		   (select count(*) from users where banned_at is not null),
		   (select count(*) from workspaces),
		   (select count(*) from channels),
		   (select count(*) from messages where deleted_at is null),
		   (select count(distinct user_id) from user_sessions
		      where revoked_at is null and last_seen_at > now() - interval '24 hours'),
		   (select coalesce(sum(size_bytes), 0) from media_objects),
		   (select count(*) from media_objects),
		   pg_database_size(current_database())`,
	).Scan(
		&view.UserCount, &view.BannedUserCount, &view.WorkspaceCount,
		&view.ChannelCount, &view.MessageCount, &view.ActiveSessions24h,
		&view.StorageBytes, &view.MediaObjectCount, &view.DatabaseSizeBytes,
	); err != nil {
		m.logger.Error("admin metrics failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	snap := m.settings.Get(r.Context())
	view.StorageQuotaBytes = snap.StorageQuotaBytes
	if snap.StorageQuotaBytes > 0 {
		view.StorageQuotaUsedRatio = float64(view.StorageBytes) / float64(snap.StorageQuotaBytes)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// handleRetentionRun — D.3. Синхронно прогоняет retention.Sweep по текущим
// server_settings. Тот же код, что воркер крутит по таймеру; здесь —
// ручной триггер из админ-панели. Возвращает Stats клиенту, чтобы UI
// показал «удалено N сообщений / M файлов / K байт». Аудит пишется до
// sweep'а, чтобы actor существовал в момент записи (если root удалит
// сам себя через массовую чистку — маловероятно, но).
func (m *Module) handleRetentionRun(w http.ResponseWriter, r *http.Request) {
	actorID, ok := m.requireRoot(w, r)
	if !ok {
		return
	}
	settings, err := retention.LoadSettings(r.Context(), m.db)
	if err != nil {
		m.logger.Error("retention: load settings failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not load settings")
		return
	}
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    actorID,
		Action:     auditlog.ActionRetentionSweep,
		TargetType: "server",
		TargetID:   "retention",
	})
	// Без хранилища sweep всё равно работает (blob'ы останутся orphan'ами).
	store, storeErr := m.store.Get(r.Context())
	if storeErr != nil {
		store = nil
	}
	stats, err := retention.Sweep(r.Context(), m.logger, m.db, store, settings)
	if err != nil {
		m.logger.Error("retention sweep failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "sweep failed")
		return
	}
	m.logger.Info("retention sweep (manual)",
		"actor", actorID,
		"messages_deleted", stats.MessagesDeleted,
		"media_deleted", stats.MediaDeleted,
		"bytes_freed", stats.BytesFreed,
	)
	sharedhttp.WriteJSON(w, http.StatusOK, stats)
}
