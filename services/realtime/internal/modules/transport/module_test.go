package transport

import (
	"net/http/httptest"
	"testing"
)

func TestParseCursor(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  int64
	}{
		{"", 0},
		{"?cursor=42", 42},
		{"?cursor=-1", 0},
		{"?cursor=bad", 0},
	} {
		r := httptest.NewRequest("GET", "/ws"+tc.query, nil)
		if got := parseCursor(r); got != tc.want {
			t.Fatalf("parseCursor(%q) = %d, want %d", tc.query, got, tc.want)
		}
	}
}
