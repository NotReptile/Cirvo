package message

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestParseReactionAcceptsEmojiAndText(t *testing.T) {
	cases := map[string]string{
		"👍":                     "👍",
		"  ок так  ":            "ок так",
		"100%":                  "100%",
		"a%20b":                 "a%20b",
		"👨‍👩‍👧‍👦":               "👨‍👩‍👧‍👦",
		strings.Repeat("я", 24): strings.Repeat("я", 24),
		strings.Repeat("🎉", 24): strings.Repeat("🎉", 24),
	}
	for raw, want := range cases {
		got, ok := parseReaction(raw)
		if !ok || got != want {
			t.Fatalf("parseReaction(%q) = %q, %v; want %q, true", raw, got, ok, want)
		}
	}
}

func TestParseReactionRejectsInvalid(t *testing.T) {
	cases := []string{
		"",
		"   ",
		"\t\n",
		strings.Repeat("я", 25),
		strings.Repeat("🎉", 25),
		"строка\nс переводом",
		"tab\there",
		"\x00",
		string([]byte{0xff, 0xfe}),
	}
	for _, raw := range cases {
		if got, ok := parseReaction(raw); ok {
			t.Fatalf("parseReaction(%q) accepted as %q", raw, got)
		}
	}
}

// Клиент кодирует значение через encodeURIComponent; сервер должен получить
// исходный текст ровно один раз. Проверяем через настоящий ServeMux, как в
// роутинге core-api (Go 1.22+ уже распаковывает path-параметры).
func TestReactionPathRoundTripThroughMux(t *testing.T) {
	values := []string{"👍", "100%", "a%20b", "ок/да", "👨‍👩‍👧‍👦 семья"}
	for _, value := range values {
		mux := http.NewServeMux()
		var got string
		mux.HandleFunc("PUT /api/v1/messages/{messageId}/reactions/{emoji}", func(w http.ResponseWriter, r *http.Request) {
			parsed, ok := parseReaction(r.PathValue("emoji"))
			if !ok {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			got = parsed
			w.WriteHeader(http.StatusNoContent)
		})
		target := "/api/v1/messages/1/reactions/" + url.PathEscape(value)
		req := httptest.NewRequest(http.MethodPut, target, nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("value %q: status %d", value, rec.Code)
		}
		if got != value {
			t.Fatalf("value %q: server got %q", value, got)
		}
	}
}
