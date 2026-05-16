package httpx

import (
	"net/http"
	"strings"
)

// CORS returns a middleware that allows credentialed requests from any of
// the given allowed origins. An origin entry of "*" permits any browser
// origin while still echoing the request's Origin header back (required
// for credential mode). Methods/headers are broad enough for the dev API
// surface: GET/POST/PUT/PATCH/DELETE plus Authorization + custom headers.
func CORS(allowed []string) func(http.Handler) http.Handler {
	allowAny := false
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		if o == "*" {
			allowAny = true
			continue
		}
		set[o] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				if _, ok := set[origin]; ok || allowAny {
					h := w.Header()
					h.Set("Access-Control-Allow-Origin", origin)
					h.Set("Vary", "Origin")
					h.Set("Access-Control-Allow-Credentials", "true")
					h.Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
					h.Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-Id")
					h.Set("Access-Control-Max-Age", "600")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
