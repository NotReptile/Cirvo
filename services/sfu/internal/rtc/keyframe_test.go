package rtc

import (
	"testing"
	"time"
)

func TestKeyframeRequesterThrottles(t *testing.T) {
	sent := 0
	now := time.Unix(1000, 0)
	k := newKeyframeRequester(500*time.Millisecond, func() error { sent++; return nil })
	k.now = func() time.Time { return now }

	if !k.Request() {
		t.Fatal("первый запрос должен уйти")
	}
	now = now.Add(100 * time.Millisecond)
	if k.Request() {
		t.Fatal("запрос внутри интервала должен быть отброшен")
	}
	now = now.Add(450 * time.Millisecond)
	if !k.Request() {
		t.Fatal("после интервала запрос должен уйти")
	}
	if sent != 2 {
		t.Fatalf("отправлено %d PLI, ожидалось 2", sent)
	}
}

func TestKeyframeRequesterNilSafe(t *testing.T) {
	var k *keyframeRequester
	if k.Request() {
		t.Fatal("nil requester не должен ничего отправлять")
	}
}
