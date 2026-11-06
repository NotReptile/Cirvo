package objectstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestLazyRecovers(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	fail := true
	l := NewLazyWithConnect(quiet(), func(context.Context) (*Client, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if fail {
			return nil, errors.New("down")
		}
		return &Client{bucket: "b"}, nil
	})
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }

	if _, err := l.Get(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("want ErrUnavailable, got %v", err)
	}
	// в окне паузы новая попытка не делается
	if _, err := l.Get(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("want ErrUnavailable, got %v", err)
	}
	mu.Lock()
	if calls != 1 {
		t.Fatalf("calls=%d, want 1", calls)
	}
	fail = false
	mu.Unlock()
	now = now.Add(2 * time.Second)
	c, err := l.Get(context.Background())
	if err != nil || c.Bucket() != "b" {
		t.Fatalf("want ready client, got %v %v", c, err)
	}
	if l.Status() != "ready" {
		t.Fatalf("status=%s", l.Status())
	}
}

func TestLazyNotConfigured(t *testing.T) {
	l := NewLazyWithConnect(quiet(), func(context.Context) (*Client, error) {
		return nil, fmt.Errorf("%w: no creds", ErrNotConfigured)
	})
	if _, err := l.Get(context.Background()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("got %v", err)
	}
	if l.Status() != "not_configured" {
		t.Fatalf("status=%s", l.Status())
	}
	var nilLazy *Lazy
	if _, err := nilLazy.Get(context.Background()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("nil: %v", err)
	}
}

func TestLazyBackoffCaps(t *testing.T) {
	l := NewLazyWithConnect(quiet(), func(context.Context) (*Client, error) { return nil, errors.New("x") })
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 20; i++ {
		_, _ = l.Get(context.Background())
		if d := l.nextTry.Sub(now); d > lazyMaxBackoff {
			t.Fatalf("backoff %v exceeds cap", d)
		}
		now = l.nextTry
	}
}
