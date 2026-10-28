package objectstore

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// ErrUnavailable: хранилище настроено, но подключиться пока не удалось
// (MinIO не поднялся, сеть, временный сбой). Следующая попытка будет позже.
var ErrUnavailable = errors.New("object storage is temporarily unavailable")

const (
	lazyMinBackoff     = 1 * time.Second
	lazyMaxBackoff     = 30 * time.Second
	lazyConnectTimeout = 5 * time.Second
)

// Lazy подключается к хранилищу по требованию и в фоне, с экспоненциальной
// паузой между попытками. Безопасен для конкурентного использования.
type Lazy struct {
	connect func(ctx context.Context) (*Client, error)
	logger  *slog.Logger
	now     func() time.Time

	mu         sync.Mutex
	client     *Client
	notConf    bool
	lastErr    error
	failures   int
	nextTry    time.Time
	warnedOnce bool
}

// NewLazy создаёт обёртку над ConnectFromEnv.
func NewLazy(logger *slog.Logger) *Lazy {
	return NewLazyWithConnect(logger, ConnectFromEnv)
}

// NewLazyWithConnect — то же с произвольной функцией подключения (для тестов).
func NewLazyWithConnect(logger *slog.Logger, connect func(ctx context.Context) (*Client, error)) *Lazy {
	if logger == nil {
		logger = slog.Default()
	}
	return &Lazy{connect: connect, logger: logger, now: time.Now}
}

// NewReady оборачивает уже готовый клиент (для смоук-тестов).
func NewReady(c *Client) *Lazy {
	return &Lazy{client: c, logger: slog.Default(), now: time.Now}
}

// Get возвращает готовый клиент, при необходимости пробуя подключиться.
// Ошибка оборачивает ErrNotConfigured или ErrUnavailable.
func (l *Lazy) Get(ctx context.Context) (*Client, error) {
	if l == nil {
		return nil, ErrNotConfigured
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.client != nil {
		return l.client, nil
	}
	if l.notConf {
		return nil, ErrNotConfigured
	}
	if l.now().Before(l.nextTry) {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, l.lastErr)
	}
	l.attemptLocked(ctx)
	if l.client != nil {
		return l.client, nil
	}
	if l.notConf {
		return nil, ErrNotConfigured
	}
	return nil, fmt.Errorf("%w: %v", ErrUnavailable, l.lastErr)
}

// Status: "ready", "unavailable" или "not_configured".
func (l *Lazy) Status() string {
	if l == nil {
		return "not_configured"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	switch {
	case l.client != nil:
		return "ready"
	case l.notConf:
		return "not_configured"
	default:
		return "unavailable"
	}
}

// Run в фоне поддерживает попытки подключения, пока оно не удастся
// или не завершится ctx. Блокирует; запускать в горутине.
func (l *Lazy) Run(ctx context.Context) {
	if l == nil {
		return
	}
	for {
		l.mu.Lock()
		if l.client != nil || l.notConf {
			l.mu.Unlock()
			return
		}
		if !l.now().Before(l.nextTry) {
			l.attemptLocked(ctx)
		}
		done := l.client != nil || l.notConf
		wait := l.nextTry.Sub(l.now())
		l.mu.Unlock()
		if done {
			return
		}
		if wait < 100*time.Millisecond {
			wait = 100 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// attemptLocked вызывается под l.mu.
func (l *Lazy) attemptLocked(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, lazyConnectTimeout)
	defer cancel()
	c, err := l.connect(cctx)
	if err == nil {
		l.client = c
		l.lastErr = nil
		l.logger.Info("object storage connected", "bucket", c.Bucket(), "failed_attempts", l.failures)
		return
	}
	l.lastErr = err
	if errors.Is(err, ErrNotConfigured) {
		l.notConf = true
		l.logger.Warn("object storage not configured, file uploads disabled", "error", err)
		return
	}
	l.failures++
	backoff := lazyMinBackoff << min(l.failures-1, 10)
	if backoff > lazyMaxBackoff {
		backoff = lazyMaxBackoff
	}
	l.nextTry = l.now().Add(backoff)
	if !l.warnedOnce {
		l.warnedOnce = true
		l.logger.Warn("object storage unavailable, will retry in background", "error", err, "retry_in", backoff.String())
	}
}
