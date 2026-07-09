package rtc

import "testing"

type fakeSignaler struct {
	closed string
}

func (f *fakeSignaler) Send(string, any) error { return nil }
func (f *fakeSignaler) Close(reason string)    { f.closed = reason }

func TestFailNegotiationResetsStateAndClosesSignaling(t *testing.T) {
	signal := &fakeSignaler{}
	p := &Peer{signal: signal, negotiating: true, negPending: true}
	p.failNegotiation("timeout")

	if p.negotiating || p.negPending {
		t.Fatalf("negotiation state not reset: negotiating=%v pending=%v", p.negotiating, p.negPending)
	}
	if signal.closed != "timeout" {
		t.Fatalf("close reason = %q", signal.closed)
	}
}

func TestFailNegotiationIsIdempotent(t *testing.T) {
	signal := &fakeSignaler{}
	p := &Peer{signal: signal}
	p.failNegotiation("ignored")
	if signal.closed != "" {
		t.Fatalf("inactive negotiation closed signaling: %q", signal.closed)
	}
}
