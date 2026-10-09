package message

import (
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestMessageCursorRoundTripAndLegacy(t *testing.T) {
	stamp := time.Date(2026, 10, 9, 12, 0, 0, 123456000, time.UTC)
	id := uuid.New()
	parsed, parsedID, err := parseMessageCursor(formatMessageCursor(stamp, id.String()))
	if err != nil || !parsed.Equal(stamp) || parsedID != id {
		t.Fatalf("round trip failed: %v", err)
	}
	parsed, parsedID, err = parseMessageCursor(stamp.Format(time.RFC3339Nano))
	if err != nil || !parsed.Equal(stamp) || parsedID != uuid.Nil {
		t.Fatalf("legacy timestamp failed: %v", err)
	}
	for _, raw := range []string{"bad", stamp.Format(time.RFC3339Nano) + "|bad", "|" + id.String()} {
		if _, _, err := parseMessageCursor(raw); err == nil {
			t.Fatalf("accepted invalid cursor %q", raw)
		}
	}
}
