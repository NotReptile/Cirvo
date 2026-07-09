package hub

import (
	"io"
	"log/slog"
	"testing"

	"github.com/google/uuid"
)

func TestReplayPrecedesBufferedLiveFrames(t *testing.T) {
	h := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	workspaceID := uuid.New()
	conn := NewConnection(uuid.New(), uuid.New(), []uuid.UUID{workspaceID})
	h.Add(conn)

	h.BroadcastWorkspace(workspaceID, []byte("live"))
	if !conn.SendReplay([]byte("replay")) {
		t.Fatal("replay frame rejected")
	}
	conn.Activate()

	if got := string(<-conn.Send); got != "replay" {
		t.Fatalf("first frame = %q, want replay", got)
	}
	if got := string(<-conn.Send); got != "live" {
		t.Fatalf("second frame = %q, want live", got)
	}
}

func TestPausedSlowConsumerIsClosed(t *testing.T) {
	h := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	workspaceID := uuid.New()
	conn := NewConnection(uuid.New(), uuid.New(), []uuid.UUID{workspaceID})
	h.Add(conn)

	for i := 0; i <= sendBufferSize; i++ {
		h.BroadcastWorkspace(workspaceID, []byte("event"))
	}
	select {
	case <-conn.Close:
	default:
		t.Fatal("slow paused consumer was not closed")
	}
}
