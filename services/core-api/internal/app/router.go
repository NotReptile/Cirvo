package app

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
)

type Router struct {
	mux  *http.ServeMux
	auth *Authenticator
}

func NewRouter(mux *http.ServeMux, auth *Authenticator) *Router {
	return &Router{mux: mux, auth: auth}
}

func (r *Router) Public(pattern string, handler http.HandlerFunc) {
	r.mux.HandleFunc(pattern, handler)
}

func (r *Router) Protected(pattern string, handler http.HandlerFunc) {
	r.mux.Handle(pattern, r.auth.Middleware(handler))
}

type Authenticator struct {
	db  *postgres.Pool
	jwt *jwtauth.Issuer
}

func NewAuthenticator(db *postgres.Pool, jwt *jwtauth.Issuer) *Authenticator {
	return &Authenticator{db: db, jwt: jwt}
}

func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := extractBearer(r)
		if raw == "" {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "missing bearer token")
			return
		}
		claims, err := a.jwt.Parse(raw)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "invalid token")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), httpAuthTimeout)
		defer cancel()
		var (
			revoked    *string
			mustChange bool
		)
		err = a.db.QueryRow(ctx,
			`select s.revoked_at::text, u.must_change_password
			 from user_sessions s join users u on u.id = s.user_id
			 where s.id = $1 and s.user_id = $2`,
			claims.SessionID, claims.UserID,
		).Scan(&revoked, &mustChange)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeSessionRevoked, "session not found")
				return
			}
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "session lookup failed")
			return
		}
		if revoked != nil {
			sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeSessionRevoked, "session revoked")
			return
		}
		if mustChange && !allowedWhilePasswordChangePending(r.Pattern) {
			sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodePasswordChangeRequired, "password change required")
			return
		}

		ctx = authctx.With(r.Context(), claims.UserID, claims.SessionID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Пока пользователь не сменил временный пароль, доступны только смена пароля,
// чтение своего профиля (клиенту нужно узнать о флаге) и выход. Маршрут
// определяется по шаблону ServeMux (r.Pattern), а не по сырому пути, чтобы
// его нельзя было подделать лишними слешами или регистром.
var passwordChangePendingAllowed = map[string]struct{}{
	"POST /api/v1/users/me/password": {},
	"GET /api/v1/users/me":           {},
	"POST /api/v1/auth/logout":       {},
}

func allowedWhilePasswordChangePending(pattern string) bool {
	_, ok := passwordChangePendingAllowed[pattern]
	return ok
}

func extractBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
