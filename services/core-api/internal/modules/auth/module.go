package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/passwords"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/ratelimit"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

// Лимиты anti brute-force на auth-эндпоинтах. Считаются per-IP (за Caddy —
// X-Forwarded-For). Цифры подобраны как «явно щадящие для людей, но
// мешающие перебору словарём».
var (
	authLoginRule    = ratelimit.Rule{Capacity: 10, Window: 5 * time.Minute}
	authRegisterRule = ratelimit.Rule{Capacity: 5, Window: time.Hour}
	authRefreshRule  = ratelimit.Rule{Capacity: 30, Window: 5 * time.Minute}
)

const (
	refreshTokenBytes = 32
	refreshTTL        = 30 * 24 * time.Hour
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

type Module struct {
	db       *postgres.Pool
	jwt      *jwtauth.Issuer
	limiter  *ratelimit.Limiter
	settings *serversettings.Provider
	logger   *slog.Logger
}

func NewModule(db *postgres.Pool, jwt *jwtauth.Issuer, limiter *ratelimit.Limiter, settings *serversettings.Provider, logger *slog.Logger) *Module {
	return &Module{db: db, jwt: jwt, limiter: limiter, settings: settings, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	rl := func(scope string, rule ratelimit.Rule, h http.HandlerFunc) http.HandlerFunc {
		return ratelimit.Middleware(m.limiter, m.logger, scope, rule, ratelimit.IPKey)(h)
	}
	router.Public("POST /api/v1/auth/register", rl("auth_register", authRegisterRule, m.handleRegister))
	router.Public("POST /api/v1/auth/login", rl("auth_login", authLoginRule, m.handleLogin))
	router.Public("POST /api/v1/auth/refresh", rl("auth_refresh", authRefreshRule, m.handleRefresh))
	router.Protected("POST /api/v1/auth/logout", m.handleLogout)
	router.Protected("POST /api/v1/auth/logout-all", m.handleLogoutAll)
	router.Protected("GET /api/v1/users/me", m.handleMe)
	// I.10: privacy/sessions — список активных сессий + точечный revoke.
	router.Protected("GET /api/v1/users/me/sessions", m.handleListSessions)
	router.Protected("DELETE /api/v1/users/me/sessions/{sessionId}", m.handleRevokeSession)
}

type registerRequest struct {
	Email       string `json:"email"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
	DeviceLabel string `json:"deviceLabel"`
}

type loginRequest struct {
	Login       string `json:"login"`
	Password    string `json:"password"`
	DeviceLabel string `json:"deviceLabel"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

type authResponse struct {
	User            userView  `json:"user"`
	AccessToken     string    `json:"accessToken"`
	AccessExpiresAt time.Time `json:"accessExpiresAt"`
	RefreshToken    string    `json:"refreshToken"`
	SessionID       string    `json:"sessionId"`
}

type userView struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	Username      string `json:"username"`
	DisplayName   string `json:"displayName,omitempty"`
	IsRoot        bool   `json:"isRoot,omitempty"`
	AvatarMediaID string `json:"avatarMediaId,omitempty"`
	PresenceMode  string `json:"presenceMode,omitempty"`
	CustomStatus  string `json:"customStatus,omitempty"`
	// I.6: расширенный профиль. Опциональные.
	Bio           string `json:"bio,omitempty"`
	BannerColor   string `json:"bannerColor,omitempty"`
	BannerMediaID string `json:"bannerMediaId,omitempty"`
}

func (m *Module) handleRegister(w http.ResponseWriter, r *http.Request) {
	// D.1: server-wide лимиты. registration_open=false — закрытый инстанс
	// (но bootstrap'у env всё ещё разрешит создать первого пользователя,
	// до миграции это поле умолчанием true). max_users=0 — без лимита.
	if m.settings != nil {
		snap := m.settings.Get(r.Context())
		if !snap.RegistrationOpen {
			// 403, не 404 — admin-аудитория должна понимать причину.
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "registration is closed on this server")
			return
		}
		if snap.MaxUsers > 0 {
			var n int
			if err := m.db.QueryRow(r.Context(), `select count(*) from users`).Scan(&n); err == nil && n >= snap.MaxUsers {
				sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "user limit reached on this server")
				return
			}
		}
	}

	var req registerRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	req.DisplayName = strings.TrimSpace(req.DisplayName)

	if !strings.Contains(req.Email, "@") {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid email")
		return
	}
	if !usernamePattern.MatchString(req.Username) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "username must be 3-32 chars of [a-z0-9_]")
		return
	}
	if len(req.Password) < 8 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "password must be at least 8 characters")
		return
	}

	passwordHash, err := passwords.Hash(req.Password)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "password hashing failed")
		return
	}

	userID := uuid.New()
	now := time.Now().UTC()

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Первый зарегистрированный = root-owner инстанса (если bootstrap
	// через env не запускали). Проверяем под транзакцией, чтобы не было
	// race с одновременным insert.
	var registeredIsRoot bool
	err = tx.QueryRow(r.Context(),
		`insert into users (id, email, username, display_name, password_hash, is_root, created_at, updated_at)
		 values ($1, $2, $3, nullif($4, ''), $5,
		         not exists (select 1 from users where is_root = true),
		         $6, $6)
		 returning is_root`,
		userID, req.Email, req.Username, req.DisplayName, passwordHash, now,
	).Scan(&registeredIsRoot)
	if err != nil {
		if isUniqueViolation(err) {
			sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "email or username already taken")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create user")
		return
	}

	resp, err := m.createSession(r.Context(), tx, userID, req.DeviceLabel, r.UserAgent())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create session")
		return
	}
	resp.User = userView{
		ID:          userID.String(),
		Email:       req.Email,
		Username:    req.Username,
		DisplayName: req.DisplayName,
		IsRoot:      registeredIsRoot,
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	sharedhttp.WriteJSON(w, http.StatusCreated, resp)
}

func (m *Module) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Login = strings.ToLower(strings.TrimSpace(req.Login))
	if req.Login == "" || req.Password == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "login and password are required")
		return
	}

	var (
		userID       uuid.UUID
		passwordHash string
		email        string
		username     string
		displayName  *string
		bannedAt     *time.Time
		isRoot       bool
		avatarID     *uuid.UUID
		presenceMode string
		customStatus *string
		bio          *string
		bannerColor  *string
		bannerID     *uuid.UUID
	)
	err := m.db.QueryRow(r.Context(),
		`select id, email, username, display_name, password_hash, banned_at, is_root,
		        avatar_media_id, presence_mode, custom_status,
		        bio, banner_color, banner_media_id
		 from users where email = $1 or username = $1`,
		req.Login,
	).Scan(&userID, &email, &username, &displayName, &passwordHash, &bannedAt, &isRoot,
		&avatarID, &presenceMode, &customStatus,
		&bio, &bannerColor, &bannerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid credentials")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	if err := passwords.Verify(passwordHash, req.Password); err != nil {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid credentials")
		return
	}

	if bannedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "account banned")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	resp, err := m.createSession(r.Context(), tx, userID, req.DeviceLabel, r.UserAgent())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create session")
		return
	}
	resp.User = userView{
		ID:           userID.String(),
		Email:        email,
		Username:     username,
		IsRoot:       isRoot,
		PresenceMode: presenceMode,
	}
	if displayName != nil {
		resp.User.DisplayName = *displayName
	}
	if avatarID != nil {
		resp.User.AvatarMediaID = avatarID.String()
	}
	if customStatus != nil {
		resp.User.CustomStatus = *customStatus
	}
	if bio != nil {
		resp.User.Bio = *bio
	}
	if bannerColor != nil {
		resp.User.BannerColor = *bannerColor
	}
	if bannerID != nil {
		resp.User.BannerMediaID = bannerID.String()
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	sharedhttp.WriteJSON(w, http.StatusOK, resp)
}

func (m *Module) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.RefreshToken == "" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "refreshToken is required")
		return
	}

	hash := hashRefreshToken(req.RefreshToken)

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		sessionID uuid.UUID
		userID    uuid.UUID
		revoked   *time.Time
		expires   time.Time
		bannedAt  *time.Time
	)
	err = tx.QueryRow(r.Context(),
		`select s.id, s.user_id, s.revoked_at, s.refresh_expires_at, u.banned_at
		 from user_sessions s join users u on u.id = s.user_id
		 where s.refresh_token_hash = $1
		 for update of s`,
		hash,
	).Scan(&sessionID, &userID, &revoked, &expires, &bannedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid refresh token")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	if revoked != nil {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeSessionRevoked, "session revoked")
		return
	}
	if bannedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "account banned")
		return
	}
	if time.Now().After(expires) {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "refresh token expired")
		return
	}

	newRaw, newHash, err := generateRefreshToken()
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "token generation failed")
		return
	}
	newExpires := time.Now().UTC().Add(refreshTTL)

	_, err = tx.Exec(r.Context(),
		`update user_sessions set refresh_token_hash = $1, refresh_expires_at = $2, last_seen_at = now() where id = $3`,
		newHash, newExpires, sessionID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "session update failed")
		return
	}

	access, accessExp, err := m.jwt.IssueAccess(userID, sessionID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "token signing failed")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	sharedhttp.WriteJSON(w, http.StatusOK, authResponse{
		AccessToken:     access,
		AccessExpiresAt: accessExp,
		RefreshToken:    newRaw,
		SessionID:       sessionID.String(),
	})
}

// I.10: list активных (не revoked) сессий юзера. Возвращаем самые свежие
// сверху. `current=true` для своего session_id — клиент рисует «текущая».
type sessionView struct {
	ID           string  `json:"id"`
	DeviceLabel  string  `json:"deviceLabel"`
	UserAgent    *string `json:"userAgent,omitempty"`
	CreatedAt    string  `json:"createdAt"`
	LastSeenAt   string  `json:"lastSeenAt"`
	Current      bool    `json:"current"`
}

func (m *Module) handleListSessions(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	currentSessionID, _ := authctx.SessionID(r.Context())
	rows, err := m.db.Query(r.Context(),
		`select id, device_label, user_agent, created_at, last_seen_at
		 from user_sessions
		 where user_id = $1 and revoked_at is null and refresh_expires_at > now()
		 order by last_seen_at desc`,
		userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]sessionView, 0)
	for rows.Next() {
		var (
			id         uuid.UUID
			label      string
			ua         *string
			created    time.Time
			lastSeen   time.Time
		)
		if err := rows.Scan(&id, &label, &ua, &created, &lastSeen); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		items = append(items, sessionView{
			ID:          id.String(),
			DeviceLabel: label,
			UserAgent:   ua,
			CreatedAt:   created.UTC().Format(time.RFC3339),
			LastSeenAt:  lastSeen.UTC().Format(time.RFC3339),
			Current:     id == currentSessionID,
		})
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// I.10: точечный revoke. Запретить ревокать СВОЮ текущую сессию через этот
// endpoint — для этого есть /auth/logout. Иначе клиент бы остался с access-
// токеном, а refresh уже revoked — следующий refresh бы упал.
func (m *Module) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	currentSessionID, _ := authctx.SessionID(r.Context())
	rawID := r.PathValue("sessionId")
	targetID, err := uuid.Parse(rawID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid session id")
		return
	}
	if targetID == currentSessionID {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "use /auth/logout to end current session")
		return
	}
	tag, err := m.db.Exec(r.Context(),
		`update user_sessions set revoked_at = now()
		 where id = $1 and user_id = $2 and revoked_at is null`,
		targetID, userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not revoke session")
		return
	}
	if tag.RowsAffected() == 0 {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "session not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// I.10: revoke ВСЕХ сессий юзера кроме текущей. Возвращает количество
// отозванных. Текущая остаётся живой — иначе клиент окажется без refresh'а.
func (m *Module) handleLogoutAll(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	currentSessionID, _ := authctx.SessionID(r.Context())
	tag, err := m.db.Exec(r.Context(),
		`update user_sessions set revoked_at = now()
		 where user_id = $1 and revoked_at is null and id <> $2`,
		userID, currentSessionID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not revoke sessions")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"revoked": tag.RowsAffected()})
}

func (m *Module) handleLogout(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := authctx.SessionID(r.Context())
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "no session in context")
		return
	}
	_, err := m.db.Exec(r.Context(),
		`update user_sessions set revoked_at = now() where id = $1 and revoked_at is null`,
		sessionID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not revoke session")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) handleMe(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var (
		email        string
		username     string
		displayName  *string
		isRoot       bool
		avatarID     *uuid.UUID
		presenceMode string
		customStatus *string
		bio          *string
		bannerColor  *string
		bannerID     *uuid.UUID
	)
	err := m.db.QueryRow(r.Context(),
		`select email, username, display_name, is_root, avatar_media_id, presence_mode, custom_status,
		        bio, banner_color, banner_media_id
		 from users where id = $1`,
		userID,
	).Scan(&email, &username, &displayName, &isRoot, &avatarID, &presenceMode, &customStatus,
		&bio, &bannerColor, &bannerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	view := userView{ID: userID.String(), Email: email, Username: username, IsRoot: isRoot, PresenceMode: presenceMode}
	if displayName != nil {
		view.DisplayName = *displayName
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

func (m *Module) createSession(ctx context.Context, tx pgx.Tx, userID uuid.UUID, deviceLabel string, userAgent string) (authResponse, error) {
	rawRefresh, hashRefresh, err := generateRefreshToken()
	if err != nil {
		return authResponse{}, err
	}
	sessionID := uuid.New()
	now := time.Now().UTC()
	expires := now.Add(refreshTTL)

	if deviceLabel == "" {
		deviceLabel = "unknown"
	}

	_, err = tx.Exec(ctx,
		`insert into user_sessions (id, user_id, refresh_token_hash, device_label, user_agent, created_at, last_seen_at, refresh_expires_at)
		 values ($1, $2, $3, $4, $5, $6, $6, $7)`,
		sessionID, userID, hashRefresh, deviceLabel, nullableString(userAgent), now, expires,
	)
	if err != nil {
		return authResponse{}, err
	}

	access, accessExp, err := m.jwt.IssueAccess(userID, sessionID)
	if err != nil {
		return authResponse{}, err
	}

	return authResponse{
		AccessToken:     access,
		AccessExpiresAt: accessExp,
		RefreshToken:    rawRefresh,
		SessionID:       sessionID.String(),
	}, nil
}

func generateRefreshToken() (raw, hash string, err error) {
	buf := make([]byte, refreshTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	raw = hex.EncodeToString(buf)
	hash = hashRefreshToken(raw)
	return raw, hash, nil
}

func hashRefreshToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "SQLSTATE 23505")
}
