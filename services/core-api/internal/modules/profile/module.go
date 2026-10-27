package profile

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/passwords"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
	"github.com/NotReptile/Cirvo/services/core-api/internal/accountrules"
	"github.com/NotReptile/Cirvo/services/core-api/internal/auditlog"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/routing"
)

const (
	maxDisplayName  = 64
	maxCustomStatus = 64
	maxBio          = 600
	maxBannerColor  = 16
	maxBadgeEmoji   = 32
	maxBadgeLabel   = 48
)

// gradientPattern — формат profile_theme / name_gradient: ровно два
// hex-цвета через запятую ("#1e1f22,#5865f2"). Пустая строка = сброс.
var gradientPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6},#[0-9a-fA-F]{6}$`)

// presenceModes — допустимые режимы для users.presence_mode. Семантика:
// online/idle/dnd видны другим как соответствующий цветной dot; invisible
// маскируется на бэке (см. EffectivePresenceSQL) — другие видят как offline,
// сам юзер в /users/me видит реальный режим.
var presenceModes = map[string]struct{}{
	"online": {}, "idle": {}, "dnd": {}, "invisible": {},
}

type Module struct {
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	logger    *slog.Logger
}

func NewModule(db *postgres.Pool, publisher *realtimebus.Publisher, logger *slog.Logger) *Module {
	return &Module{db: db, publisher: publisher, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("PUT /api/v1/users/me", m.handleUpdateMe)
	router.Protected("POST /api/v1/users/me/password", m.handleChangePassword)
	router.Protected("PUT /api/v1/users/me/status", m.handleUpdateStatus)
	router.Protected("PUT /api/v1/users/me/avatar", m.handleUpdateAvatar)
	router.Protected("DELETE /api/v1/users/me/avatar", m.handleRemoveAvatar)
	router.Protected("PUT /api/v1/users/me/banner", m.handleUpdateBanner)
	router.Protected("DELETE /api/v1/users/me/banner", m.handleRemoveBanner)
	router.Protected("GET /api/v1/users/{userId}", m.handleGetUser)
	// Wave 7 (I.13): виджеты профиля (см. widgets.go).
	router.Protected("GET /api/v1/users/{userId}/widgets", m.handleListWidgets)
	router.Protected("PUT /api/v1/users/me/widgets", m.handleUpdateWidgets)
}

// I.6: updateRequest принимает pointer-поля — nil=не трогать, "" в строке=сбросить.
// bannerColor отдельно от banner_media_id: пустой banner_media_id + bannerColor
// = одноцветный баннер; banner_media_id есть = image-баннер (color игнорится UI).
type updateRequest struct {
	DisplayName *string `json:"displayName"`
	Bio         *string `json:"bio"`
	BannerColor *string `json:"bannerColor"`
	// Wave 7 (I.17–I.19): стиль профиля. "" = сброс к дефолту.
	ProfileTheme *string `json:"profileTheme"`
	NameGradient *string `json:"nameGradient"`
	BadgeEmoji   *string `json:"badgeEmoji"`
	BadgeLabel   *string `json:"badgeLabel"`
	// Wave 7 (I.15–I.16): id CSS-пресетов. Набор знает клиент, бэк хранит
	// произвольную строку ≤32 — неизвестный id клиент игнорирует.
	AvatarDecoration *string `json:"avatarDecoration"`
	ProfileEffect    *string `json:"profileEffect"`
}

type avatarRequest struct {
	MediaID string `json:"mediaId"`
}

// bannerRequest — для PUT /users/me/banner. mediaId должен быть image-объектом,
// загруженным самим юзером (та же ACL что и аватар).
type bannerRequest struct {
	MediaID string `json:"mediaId"`
}

type profileView struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	DisplayName   string `json:"displayName,omitempty"`
	AvatarMediaID string `json:"avatarMediaId,omitempty"`
	PresenceMode  string `json:"presenceMode,omitempty"`
	CustomStatus  string `json:"customStatus,omitempty"`
	// I.6: расширенные поля профиля. Все опциональные.
	Bio           string `json:"bio,omitempty"`
	BannerColor   string `json:"bannerColor,omitempty"`
	BannerMediaID string `json:"bannerMediaId,omitempty"`
	// Wave 7: стиль профиля ("#hex,#hex" для theme/gradient).
	ProfileTheme string `json:"profileTheme,omitempty"`
	NameGradient string `json:"nameGradient,omitempty"`
	BadgeEmoji   string `json:"badgeEmoji,omitempty"`
	BadgeLabel   string `json:"badgeLabel,omitempty"`
	// Wave 7 (I.15–I.16): id CSS-пресетов рамки аватара и эффекта баннера.
	AvatarDecoration string `json:"avatarDecoration,omitempty"`
	ProfileEffect    string `json:"profileEffect,omitempty"`
}

type meView struct {
	profileView
	Email     string    `json:"email"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type statusRequest struct {
	Mode              *string    `json:"mode"`
	CustomStatus      *string    `json:"customStatus"`
	ExpectedMode      *string    `json:"expectedMode"`
	ExpectedUpdatedAt *time.Time `json:"expectedUpdatedAt"`
}

// handleUpdateStatus — H.8: смена presence_mode и/или custom_status.
// Pointer-поля: nil = не трогать, "" в customStatus = очистить.
// После апдейта публикуем presence.updated по всем воркспейсам юзера
// и всем DM-собеседникам, чтобы клиенты обновили dot/подпись без F5.
func (m *Module) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())

	var req statusRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.Mode == nil && req.CustomStatus == nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "nothing to update")
		return
	}

	now := time.Now().UTC()
	setParts := []string{}
	args := []any{}
	idx := 1
	if req.Mode != nil {
		mode := strings.TrimSpace(*req.Mode)
		if _, ok := presenceModes[mode]; !ok {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid presence mode")
			return
		}
		setParts = append(setParts, "presence_mode = $"+strconv.Itoa(idx))
		args = append(args, mode)
		idx++
	}
	if req.CustomStatus != nil {
		cs := strings.TrimSpace(*req.CustomStatus)
		if len(cs) > maxCustomStatus {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "customStatus too long")
			return
		}
		setParts = append(setParts, "custom_status = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, cs)
		idx++
	}
	setParts = append(setParts, "updated_at = $"+strconv.Itoa(idx))
	args = append(args, now)
	idx++
	args = append(args, userID)

	q := "update users set " + strings.Join(setParts, ", ") + " where id = $" + strconv.Itoa(idx)
	if req.ExpectedMode != nil || req.ExpectedUpdatedAt != nil {
		if req.ExpectedMode == nil || req.ExpectedUpdatedAt == nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "both status preconditions required")
			return
		}
		q += " and presence_mode = $" + strconv.Itoa(idx+1) + " and updated_at = $" + strconv.Itoa(idx+2)
		args = append(args, *req.ExpectedMode, *req.ExpectedUpdatedAt)
	}
	tag, err := m.db.Exec(r.Context(), q, args...)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update status")
		return
	}
	if tag.RowsAffected() == 0 {
		view, err := m.loadMeView(r.Context(), userID, now)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload profile")
			return
		}
		sharedhttp.WriteJSON(w, http.StatusOK, view)
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

	sessionID, _ := authctx.SessionID(r.Context())
	m.publishPresenceUpdated(r.Context(), userID, view.PresenceMode, view.CustomStatus, sessionID, view.UpdatedAt)

	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// publishPresenceUpdated публикует presence.updated:
//   - для каждого workspace юзера → workspace fan-out;
//   - для каждого DM-собеседника → per-user fan-out.
//
// Если режим invisible — публикуем effective='offline' (другие видят
// как офлайн), customStatus затирается. Сам юзер локально знает свой
// реальный режим из ответа PUT /users/me/status.
func (m *Module) publishPresenceUpdated(ctx context.Context, userID uuid.UUID, mode, customStatus string, sessionID uuid.UUID, updatedAt time.Time) {
	if m.publisher == nil {
		return
	}
	privatePayload, _ := json.Marshal(map[string]any{"userId": userID.String(), "mode": mode, "customStatus": customStatus, "sessionId": sessionID.String(), "updatedAt": updatedAt})
	_ = m.publisher.Publish(ctx, realtimebus.Event{Event: "presence.self.updated", UserID: userID.String(), Payload: privatePayload})
	effectiveMode := mode
	effectiveStatus := customStatus
	var connected bool
	if err := m.db.QueryRow(ctx, `select exists(select 1 from user_sessions where user_id = $1 and revoked_at is null and last_seen_at > now() - interval '5 minutes')`, userID).Scan(&connected); err != nil {
		return
	}
	if mode == "invisible" {
		effectiveMode = "offline"
		effectiveStatus = ""
	} else if !connected {
		effectiveMode = "offline"
	}
	payload, err := json.Marshal(map[string]any{
		"userId":       userID.String(),
		"mode":         effectiveMode,
		"customStatus": effectiveStatus,
		"updatedAt":    updatedAt,
	})
	if err != nil {
		return
	}

	// Workspaces
	wsRows, err := m.db.Query(ctx, `select workspace_id from workspace_members where user_id = $1`, userID)
	if err == nil {
		defer wsRows.Close()
		for wsRows.Next() {
			var wid uuid.UUID
			if err := wsRows.Scan(&wid); err == nil {
				_ = m.publisher.Publish(context.Background(), realtimebus.Event{
					Event:       "presence.updated",
					WorkspaceID: wid.String(),
					Payload:     payload,
				})
			}
		}
	}

	// DM peers
	peerRows, err := m.db.Query(ctx,
		`select case when user_a = $1 then user_b else user_a end as peer_id
		   from dm_channels where user_a = $1 or user_b = $1
		 union select case when user_a = $1 then user_b else user_a end
		   from friendships where (user_a = $1 or user_b = $1) and status = 'accepted'`,
		userID,
	)
	if err == nil {
		defer peerRows.Close()
		for peerRows.Next() {
			var pid uuid.UUID
			if err := peerRows.Scan(&pid); err == nil {
				_ = m.publisher.Publish(context.Background(), realtimebus.Event{
					Event:   "presence.updated",
					UserID:  pid.String(),
					Payload: payload,
				})
			}
		}
	}
}

// publishUserUpdated рассылает user.updated (avatar/displayName change)
// всем кто видит этого юзера: workspace-членам через workspace-fanout,
// DM-собеседникам через per-user. Frontend ставит новое avatarMediaId /
// displayName в state.members[*]/state.dms[*].peer без полной перезагрузки.
func (m *Module) publishUserUpdated(ctx context.Context, userID uuid.UUID, avatarMediaID, displayName string) {
	if m.publisher == nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"userId":        userID.String(),
		"avatarMediaId": avatarMediaID,
		"displayName":   displayName,
	})
	if err != nil {
		return
	}
	wsRows, err := m.db.Query(ctx, `select workspace_id from workspace_members where user_id = $1`, userID)
	if err == nil {
		defer wsRows.Close()
		for wsRows.Next() {
			var wid uuid.UUID
			if err := wsRows.Scan(&wid); err == nil {
				_ = m.publisher.Publish(context.Background(), realtimebus.Event{
					Event:       "user.updated",
					WorkspaceID: wid.String(),
					Payload:     payload,
				})
			}
		}
	}
	peerRows, err := m.db.Query(ctx,
		`select case when user_a = $1 then user_b else user_a end as peer_id
		   from dm_channels where user_a = $1 or user_b = $1`,
		userID,
	)
	if err == nil {
		defer peerRows.Close()
		for peerRows.Next() {
			var pid uuid.UUID
			if err := peerRows.Scan(&pid); err == nil {
				_ = m.publisher.Publish(context.Background(), realtimebus.Event{
					Event:   "user.updated",
					UserID:  pid.String(),
					Payload: payload,
				})
			}
		}
	}
}

func (m *Module) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req updateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.DisplayName == nil && req.Bio == nil && req.BannerColor == nil &&
		req.ProfileTheme == nil && req.NameGradient == nil && req.BadgeEmoji == nil && req.BadgeLabel == nil &&
		req.AvatarDecoration == nil && req.ProfileEffect == nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "nothing to update")
		return
	}

	now := time.Now().UTC()
	setParts := []string{}
	args := []any{}
	idx := 1

	if req.DisplayName != nil {
		trimmed := strings.TrimSpace(*req.DisplayName)
		if len(trimmed) > maxDisplayName {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "displayName too long")
			return
		}
		setParts = append(setParts, "display_name = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	if req.Bio != nil {
		trimmed := strings.TrimSpace(*req.Bio)
		if len(trimmed) > maxBio {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "bio too long")
			return
		}
		setParts = append(setParts, "bio = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	if req.BannerColor != nil {
		trimmed := strings.TrimSpace(*req.BannerColor)
		if len(trimmed) > maxBannerColor {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "bannerColor too long")
			return
		}
		setParts = append(setParts, "banner_color = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	// Wave 7: стиль профиля. theme/gradient — строгий формат "#hex,#hex".
	if req.ProfileTheme != nil {
		trimmed := strings.TrimSpace(*req.ProfileTheme)
		if trimmed != "" && !gradientPattern.MatchString(trimmed) {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "profileTheme must be \"#rrggbb,#rrggbb\"")
			return
		}
		setParts = append(setParts, "profile_theme = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, strings.ToLower(trimmed))
		idx++
	}
	if req.NameGradient != nil {
		trimmed := strings.TrimSpace(*req.NameGradient)
		if trimmed != "" && !gradientPattern.MatchString(trimmed) {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "nameGradient must be \"#rrggbb,#rrggbb\"")
			return
		}
		setParts = append(setParts, "name_gradient = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, strings.ToLower(trimmed))
		idx++
	}
	if req.BadgeEmoji != nil {
		trimmed := strings.TrimSpace(*req.BadgeEmoji)
		if len(trimmed) > maxBadgeEmoji {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "badgeEmoji too long")
			return
		}
		setParts = append(setParts, "badge_emoji = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	if req.BadgeLabel != nil {
		trimmed := strings.TrimSpace(*req.BadgeLabel)
		if len(trimmed) > maxBadgeLabel {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "badgeLabel too long")
			return
		}
		setParts = append(setParts, "badge_label = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	if req.AvatarDecoration != nil {
		trimmed := strings.TrimSpace(*req.AvatarDecoration)
		if len(trimmed) > 32 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "avatarDecoration too long")
			return
		}
		setParts = append(setParts, "avatar_decoration = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	if req.ProfileEffect != nil {
		trimmed := strings.TrimSpace(*req.ProfileEffect)
		if len(trimmed) > 32 {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "profileEffect too long")
			return
		}
		setParts = append(setParts, "profile_effect = nullif($"+strconv.Itoa(idx)+"::text, '')")
		args = append(args, trimmed)
		idx++
	}
	setParts = append(setParts, "updated_at = $"+strconv.Itoa(idx))
	args = append(args, now)
	idx++
	args = append(args, userID)

	q := "update users set " + strings.Join(setParts, ", ") + " where id = $" + strconv.Itoa(idx)
	if _, err := m.db.Exec(r.Context(), q, args...); err != nil {
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
	m.publishUserUpdated(r.Context(), userID, view.AvatarMediaID, view.DisplayName)
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// I.6: PUT /users/me/banner — привязывает уже загруженный media-объект
// как баннер. ACL: media принадлежит юзеру + content-type image/*. По
// семантике эквивалентно handleUpdateAvatar — копипаст не сокращаю
// (общий helper резал бы читабельность для двух ровно одинаковых endpoint'ов).
func (m *Module) handleUpdateBanner(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req bannerRequest
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
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "banner must be an image")
		return
	}

	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update users set banner_media_id = $1, updated_at = $2 where id = $3`,
		mediaID, now, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update banner")
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

func (m *Module) handleRemoveBanner(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	now := time.Now().UTC()
	if _, err := m.db.Exec(r.Context(),
		`update users set banner_media_id = null, updated_at = $1 where id = $2`,
		now, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not remove banner")
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

// handleChangePassword — G.10. Смена своего пароля: требует current-проверки
// (защита от случая угнанной активной сессии — атакующий не знает старого
// пароля и не сменит на свой). Длина нового проверяется общими правилами
// (accountrules), как при регистрации. После обычной смены существующие
// refresh-токены не инвалидируем — это семантически удобно (юзер сменил
// пароль на своём девайсе, не хочет логиниться заново), но можно добавить
// отдельным шагом «выйти со всех устройств» в backlog. Исключение — замена
// временного пароля, выданного админом: он мог побывать в чужих руках, поэтому
// все остальные сессии отзываются.
type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (m *Module) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req changePasswordRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.CurrentPassword == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "currentPassword is required")
		return
	}
	if err := accountrules.ValidatePassword(req.NewPassword); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "newPassword: "+err.Error())
		return
	}
	if req.NewPassword == req.CurrentPassword {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "new password must differ from current")
		return
	}
	var currentHash string
	if err := m.db.QueryRow(r.Context(),
		`select password_hash from users where id = $1`, userID,
	).Scan(&currentHash); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if err := passwords.Verify(currentHash, req.CurrentPassword); err != nil {
		// Не палим, что именно не так — единое сообщение под и mismatch, и
		// внутреннюю bcrypt-ошибку.
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "current password is incorrect")
		return
	}
	newHash, err := passwords.Hash(req.NewPassword)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not hash password")
		return
	}
	now := time.Now().UTC()
	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var wasPending bool
	if err := tx.QueryRow(r.Context(),
		`select must_change_password from users where id = $1 for update`, userID,
	).Scan(&wasPending); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update password")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`update users set password_hash = $1, must_change_password = false, updated_at = $2 where id = $3`,
		newHash, now, userID,
	); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update password")
		return
	}
	if wasPending {
		if sessionID, ok := authctx.SessionID(r.Context()); ok {
			if _, err := tx.Exec(r.Context(),
				`update user_sessions set revoked_at = $1 where user_id = $2 and id <> $3 and revoked_at is null`,
				now, userID, sessionID,
			); err != nil {
				sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update password")
				return
			}
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update password")
		return
	}
	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    userID,
		Action:     auditlog.ActionProfileUpdated,
		TargetType: "user",
		TargetID:   userID.String(),
	})
	w.WriteHeader(http.StatusNoContent)
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
	m.publishUserUpdated(r.Context(), userID, view.AvatarMediaID, view.DisplayName)
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
	m.publishUserUpdated(r.Context(), userID, "", view.DisplayName)
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) loadMeView(ctx context.Context, userID uuid.UUID, _ time.Time) (meView, error) {
	var (
		updatedAt    time.Time
		email        string
		username     string
		display      *string
		avatarID     *uuid.UUID
		presenceMode string
		customStatus *string
		bio          *string
		bannerColor  *string
		bannerID     *uuid.UUID
		profileTheme *string
		nameGradient *string
		badgeEmoji   *string
		badgeLabel   *string
		avatarDeco   *string
		profEffect   *string
	)
	if err := m.db.QueryRow(ctx,
		`select email, username, display_name, avatar_media_id, presence_mode, custom_status,
		        bio, banner_color, banner_media_id,
		        profile_theme, name_gradient, badge_emoji, badge_label,
		        avatar_decoration, profile_effect, updated_at
		 from users where id = $1`,
		userID,
	).Scan(&email, &username, &display, &avatarID, &presenceMode, &customStatus,
		&bio, &bannerColor, &bannerID,
		&profileTheme, &nameGradient, &badgeEmoji, &badgeLabel,
		&avatarDeco, &profEffect, &updatedAt); err != nil {
		return meView{}, err
	}
	view := meView{
		profileView: profileView{ID: userID.String(), Username: username, PresenceMode: presenceMode},
		Email:       email,
		UpdatedAt:   updatedAt,
	}
	applyOptionalStyle(&view.profileView, profileTheme, nameGradient, badgeEmoji, badgeLabel)
	applyOptionalDeco(&view.profileView, avatarDeco, profEffect)
	if display != nil {
		view.DisplayName = *display
	}
	if avatarID != nil {
		view.AvatarMediaID = avatarID.String()
	}
	if customStatus != nil {
		view.CustomStatus = *customStatus
	}
	if bio != nil {
		view.Bio = *bio
	}
	if bannerColor != nil {
		view.BannerColor = *bannerColor
	}
	if bannerID != nil {
		view.BannerMediaID = bannerID.String()
	}
	return view, nil
}

// applyOptionalStyle — общий маппинг nullable стиль-колонок в view
// (loadMeView + handleGetUser).
func applyOptionalStyle(v *profileView, theme, gradient, emoji, label *string) {
	if theme != nil {
		v.ProfileTheme = *theme
	}
	if gradient != nil {
		v.NameGradient = *gradient
	}
	if emoji != nil {
		v.BadgeEmoji = *emoji
	}
	if label != nil {
		v.BadgeLabel = *label
	}
}

func applyOptionalDeco(v *profileView, deco, effect *string) {
	if deco != nil {
		v.AvatarDecoration = *deco
	}
	if effect != nil {
		v.ProfileEffect = *effect
	}
}

func (m *Module) handleGetUser(w http.ResponseWriter, r *http.Request) {
	viewerID := authctx.MustUserID(r.Context())
	targetID, ok := parseUUID(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	var (
		username     string
		display      *string
		avatarID     *uuid.UUID
		presenceMode string
		customStatus *string
		bio          *string
		bannerColor  *string
		bannerID     *uuid.UUID
		profileTheme *string
		nameGradient *string
		badgeEmoji   *string
		badgeLabel   *string
		avatarDeco   *string
		profEffect   *string
	)
	err := m.db.QueryRow(r.Context(),
		`select username, display_name, avatar_media_id,
		        `+effectivePresenceModeExpr("u")+`,
		        `+effectiveCustomStatusExpr("u")+`,
		        u.bio, u.banner_color, u.banner_media_id,
		        u.profile_theme, u.name_gradient, u.badge_emoji, u.badge_label,
		        u.avatar_decoration, u.profile_effect
		 from users u where u.id = $1`,
		targetID,
	).Scan(&username, &display, &avatarID, &presenceMode, &customStatus,
		&bio, &bannerColor, &bannerID,
		&profileTheme, &nameGradient, &badgeEmoji, &badgeLabel,
		&avatarDeco, &profEffect)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	view := profileView{ID: targetID.String(), Username: username, PresenceMode: presenceMode}
	applyOptionalStyle(&view, profileTheme, nameGradient, badgeEmoji, badgeLabel)
	applyOptionalDeco(&view, avatarDeco, profEffect)
	// Если запрашивают самого себя — это редкий путь (фронт обычно зовёт
	// /users/me), но всё равно показываем реальный режим (invisible маска
	// смысла не имеет для самого себя).
	if targetID == viewerID {
		err := m.db.QueryRow(r.Context(),
			`select presence_mode, custom_status from users where id = $1`, viewerID,
		).Scan(&presenceMode, &customStatus)
		if err == nil {
			view.PresenceMode = presenceMode
		}
	}
	if display != nil {
		view.DisplayName = *display
	}
	if avatarID != nil {
		view.AvatarMediaID = avatarID.String()
	}
	if customStatus != nil {
		view.CustomStatus = *customStatus
	}
	if bio != nil {
		view.Bio = *bio
	}
	if bannerColor != nil {
		view.BannerColor = *bannerColor
	}
	if bannerID != nil {
		view.BannerMediaID = bannerID.String()
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

// effectivePresenceModeExpr возвращает SQL-фрагмент, дающий «эффективный»
// presence-mode для других юзеров. Маскирует invisible как offline и
// учитывает свежесть user_sessions.last_seen_at (порог 5 минут).
//
// Параметр alias — алиас таблицы users в запросе (например "u").
func effectivePresenceModeExpr(alias string) string {
	return `case
		when ` + alias + `.presence_mode = 'invisible' then 'offline'
		when not exists (
		  select 1 from user_sessions s
		  where s.user_id = ` + alias + `.id
		    and s.revoked_at is null
		    and s.last_seen_at > now() - interval '5 minutes'
		) then 'offline'
		else ` + alias + `.presence_mode
	end as presence_mode`
}

// effectiveCustomStatusExpr — кастомный статус для других юзеров.
// Скрывается, если режим invisible.
func effectiveCustomStatusExpr(alias string) string {
	return `case when ` + alias + `.presence_mode = 'invisible' then null
	             else ` + alias + `.custom_status end as custom_status`
}

// EffectivePresenceModeExpr / EffectiveCustomStatusExpr — экспорт для
// других модулей (workspace.handleListMembers, dm.handleList/respondOpened),
// чтобы фрагменты SQL не дублировались.
func EffectivePresenceModeExpr(alias string) string { return effectivePresenceModeExpr(alias) }
func EffectiveCustomStatusExpr(alias string) string { return effectiveCustomStatusExpr(alias) }

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
