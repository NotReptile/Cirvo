package profile

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const maxDisplayName = 64

type Module struct {
	db     *postgres.Pool
	logger *slog.Logger
}

func NewModule(db *postgres.Pool, logger *slog.Logger) *Module {
	return &Module{db: db, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("PUT /api/v1/users/me", m.handleUpdateMe)
	router.Protected("PUT /api/v1/users/me/avatar", m.handleUpdateAvatar)
	router.Protected("DELETE /api/v1/users/me/avatar", m.handleRemoveAvatar)
	router.Protected("GET /api/v1/users/{userId}", m.handleGetUser)
}

type updateRequest struct {
	DisplayName *string `json:"displayName"`
}

type avatarRequest struct {
	MediaID string `json:"mediaId"`
}

type profileView struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	DisplayName   string `json:"displayName,omitempty"`
	AvatarMediaID string `json:"avatarMediaId,omitempty"`
}

type meView struct {
	profileView
	Email     string    `json:"email"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (m *Module) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req updateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.DisplayName == nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "displayName is required")
		return
	}
	trimmed := strings.TrimSpace(*req.DisplayName)
	if len(trimmed) > maxDisplayName {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "displayName too long")
		return
	}

	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`update users set display_name = nullif($1, ''), updated_at = $2 where id = $3`,
		trimmed, now, userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update profile")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    userID,
		Action:     auditlog.ActionProfileUpdated,
		TargetType: "user",
		TargetID:   userID.String(),
	})

	view, err := m.loadMeView(r.Context(), userID, now)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload profile")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// handleUpdateAvatar привязывает уже загруженный media-объект как аватар
// текущего юзера. Требования: media существует, content-type начинается
// с image/, uploaded_by_user_id == текущий юзер (защита от привязки
// чужого upload'а как своего аватара). Media-объект остаётся «свежим
// upload'ом» в терминах retention.Sweep — orphan-чистка пропускает его,
// потому что есть FK-ссылка users.avatar_media_id (cascade set null).
func (m *Module) handleUpdateAvatar(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req avatarRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	mediaID, err := uuid.Parse(strings.TrimSpace(req.MediaID))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid mediaId")
		return
	}

	var (
		contentType string
		ownerID     *uuid.UUID
	)
	err = m.db.QueryRow(r.Context(),
		`select content_type, uploaded_by_user_id from media_objects where id = $1`,
		mediaID,
	).Scan(&contentType, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if ownerID == nil || *ownerID != userID {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "media does not belong to you")
		return
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "avatar must be an image")
		return
	}

	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update users set avatar_media_id = $1, updated_at = $2 where id = $3`,
		mediaID, now, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update avatar")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    userID,
		Action:     auditlog.ActionProfileUpdated,
		TargetType: "user",
		TargetID:   userID.String(),
	})

	view, err := m.loadMeView(r.Context(), userID, now)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload profile")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) handleRemoveAvatar(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update users set avatar_media_id = null, updated_at = $1 where id = $2`,
		now, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove avatar")
		return
	}
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    userID,
		Action:     auditlog.ActionProfileUpdated,
		TargetType: "user",
		TargetID:   userID.String(),
	})
	view, err := m.loadMeView(r.Context(), userID, now)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload profile")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) loadMeView(ctx context.Context, userID uuid.UUID, updatedAt time.Time) (meView, error) {
	var (
		email    string
		username string
		display  *string
		avatarID *uuid.UUID
	)
	if err := m.db.QueryRow(ctx,
		`select email, username, display_name, avatar_media_id from users where id = $1`,
		userID,
	).Scan(&email, &username, &display, &avatarID); err != nil {
		return meView{}, err
	}
	view := meView{
		profileView: profileView{ID: userID.String(), Username: username},
		Email:       email,
		UpdatedAt:   updatedAt,
	}
	if display != nil {
		view.DisplayName = *display
	}
	if avatarID != nil {
		view.AvatarMediaID = avatarID.String()
	}
	return view, nil
}

func (m *Module) handleGetUser(w http.ResponseWriter, r *http.Request) {
	_ = authctx.MustUserID(r.Context())
	targetID, ok := parseUUID(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	var (
		username string
		display  *string
		avatarID *uuid.UUID
	)
	err := m.db.QueryRow(r.Context(),
		`select username, display_name, avatar_media_id from users where id = $1`,
		targetID,
	).Scan(&username, &display, &avatarID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	view := profileView{ID: targetID.String(), Username: username}
	if display != nil {
		view.DisplayName = *display
	}
	if avatarID != nil {
		view.AvatarMediaID = avatarID.String()
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
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
