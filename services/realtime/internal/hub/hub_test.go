package hub

import (
	"io"
	"log/slog"
	"testing"

	"github.com/google/uuid"
)

func TestOldSocketCleanupKeepsReplacementAndOtherUserSession(t *testing.T) {
	h := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	user, session := uuid.New(), uuid.New()
	old := NewConnection(session, user, nil)
	replacement := NewConnection(session, user, nil)
	other := NewConnection(uuid.New(), user, nil)
	h.Add(old)
	h.Add(replacement)
	h.Add(other)
	h.Remove(old)
	if !h.SessionConnected(session) || h.Count() != 2 {
		t.Fatal("old cleanup removed replacement")
	}
	h.Remove(replacement)
	if !h.UserConnected(user) {
		t.Fatal("another live session reported offline")
	}
	h.Remove(other)
	if h.UserConnected(user) {
		t.Fatal("last disconnect still reported online")
	}
}

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

func TestWorkspaceUsersDeduplicatesSessionsAndReflectsRemoval(t *testing.T) {
	h := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ws, user := uuid.New(), uuid.New()
	first := NewConnection(uuid.New(), user, []uuid.UUID{ws})
	second := NewConnection(uuid.New(), user, []uuid.UUID{ws})
	h.Add(first)
	h.Add(second)
	if users := h.WorkspaceUsers(ws); len(users) != 1 || users[0] != user {
		t.Fatalf("recipients = %v", users)
	}
	h.UpdateWorkspaces(first, nil)
	if len(h.WorkspaceUsers(ws)) != 1 {
		t.Fatal("second session lost")
	}
	h.Remove(second)
	if len(h.WorkspaceUsers(ws)) != 0 {
		t.Fatal("removed member retained")
	}
}
