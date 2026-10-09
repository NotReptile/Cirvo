package transport

import (
	"net/http/httptest"
	"testing"
)

func TestLegacyCredentialsRejectedBeforeUpgrade(t *testing.T) {
	for _, target := range []string{"/sfu/ws", "/sfu/ws?access_token=legacy&channel_id=invalid"} {
		r := httptest.NewRequest("GET", target, nil)
		r.Header.Set("Authorization", "Bearer legacy")
		w := httptest.NewRecorder()
		(&Module{}).handleConnect(w, r)
		if w.Code != 401 {
			t.Fatalf("legacy credentials: got %d, want 401", w.Code)
		}
	}
}
