package transport

import (
	"io"
	"log/slog"
	"testing"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/services/sfu/internal/rtc"
)

type accessSignaler struct {
	closed bool
	status websocket.StatusCode
}

func (*accessSignaler) Send(string, any) error { return nil }
func (*accessSignaler) Close(string)           {}

type accessSocket struct{ signal *accessSignaler }

func (s accessSocket) Close(status websocket.StatusCode, reason string) error {
	s.signal.closed = true
	s.signal.status = status
	return nil
}

func TestRevokedAccessClosesEstablishedMediaAndSignaling(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine, err := rtc.NewEngine(logger, rtc.EngineConfig{UDPPort: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	manager := rtc.NewManager(logger, engine)
	signal := &accessSignaler{}
	peer, err := manager.Join(uuid.New(), uuid.New(), uuid.New(), signal)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close("test cleanup")
	connection := activeConnection{conn: accessSocket{signal}}
	if enforceAccess(peer, connection, true) || signal.closed {
		t.Fatal("allowed media connection closed")
	}
	if !enforceAccess(peer, connection, false) || !signal.closed || signal.status != websocket.StatusPolicyViolation {
		t.Fatal("revoked connection kept signaling open")
	}
	enforceAccess(peer, connection, false)
}
