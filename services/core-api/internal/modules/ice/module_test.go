package ice

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
)

func TestMediaConfigIssuesTemporaryTurnCredentials(t *testing.T) {
	m := &Module{config: Config{
		STUNURLs:   []string{"stun:example.test:3478"},
		TURNURLs:   []string{"turn:example.test:3478?transport=udp", "turn:example.test:3478?transport=tcp"},
		TURNSecret: "test-secret",
		SFUURL:     "wss://example.test/sfu/ws",
	}}
	userID := uuid.New()
	r := httptest.NewRequest("GET", "/api/v1/media/config", nil)
	r = r.WithContext(authctx.With(r.Context(), userID, uuid.New()))
	w := httptest.NewRecorder()

	m.handle(w, r)
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}
	var got response
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Mode != "sfu" || got.SFUURL == "" || got.TURNExpiresAt == "" {
		t.Fatalf("unexpected config: %+v", got)
	}
	if len(got.IceServers) != 2 || len(got.IceServers[1].URLs) != 2 {
		t.Fatalf("unexpected ICE servers: %+v", got.IceServers)
	}
	if !strings.HasSuffix(got.IceServers[1].Username, ":"+userID.String()) || got.IceServers[1].Credential == "" {
		t.Fatalf("temporary credentials not bound to user: %+v", got.IceServers[1])
	}
}

func TestSplitList(t *testing.T) {
	got := splitList(" turn:a , ,turn:b ")
	if len(got) != 2 || got[0] != "turn:a" || got[1] != "turn:b" {
		t.Fatalf("splitList = %#v", got)
	}
}
