package ratelimit

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"log/slog"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
)

// KeyFunc вычисляет идентификатор бакета по запросу. Например, IP или
// userID. Если возвращает пустую строку — лимит не применяется (open
// endpoint без выраженного субъекта).
type KeyFunc func(r *http.Request) string

// Middleware оборачивает handler token-bucket'ом. До вызова handler делает
// Allow(); при отказе пишет 429 с заголовком Retry-After.
//
// scope — идентификатор лимита для метрик/отладки и неймспейса в Redis.
func Middleware(limiter *Limiter, logger *slog.Logger, scope string, rule Rule, keyFn KeyFunc) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if limiter == nil {
				next(w, r)
				return
			}
			id := keyFn(r)
			if id == "" {
				next(w, r)
				return
			}
			decision, err := limiter.Allow(r.Context(), Key(scope, id), rule)
			if err != nil {
				// Fail-open: брать на себя падение Redis нельзя — иначе один
				// сбой кэша валит весь auth. Логируем и пропускаем.
				if logger != nil {
					logger.Warn("ratelimit allow failed, falling open",
						slog.String("scope", scope),
						slog.String("key", id),
						slog.String("error", err.Error()),
					)
				}
				next(w, r)
				return
			}
			if !decision.Allowed {
				WriteTooMany(w, r, decision.RetryAfter)
				return
			}
			next(w, r)
		}
	}
}

// IPKey достаёт client IP из X-Forwarded-For (первый элемент списка) или
// RemoteAddr. Caddy в наших deploy-конфигах ставит X-Forwarded-For — на
// inbound-сервере мы доверяем этому заголовку. Если сервис светит наружу
// без проксей — RemoteAddr остаётся актуальным.
func IPKey(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma >= 0 {
			xff = xff[:comma]
		}
		if v := strings.TrimSpace(xff); v != "" {
			return v
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-Ip")); xri != "" {
		return xri
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// WriteTooMany пишет 429 с Retry-After. Используется как middleware'ом,
// так и хэндлерами, которые делают Charge/Allow внутри (например, upload).
func WriteTooMany(w http.ResponseWriter, r *http.Request, retryAfter time.Duration) {
	if retryAfter > 0 {
		sec := int(retryAfter.Seconds())
		if sec < 1 {
			sec = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(sec))
	}
	sharedhttp.WriteError(w, r, http.StatusTooManyRequests, sharedhttp.CodeRateLimited, "rate limit exceeded")
}
