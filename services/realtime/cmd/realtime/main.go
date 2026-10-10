package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/libs/shared-go/channelacl"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
	"github.com/NotReptile/RuCord/libs/shared-go/wsticket"

	"github.com/NotReptile/RuCord/services/realtime/internal/app"
	"github.com/NotReptile/RuCord/services/realtime/internal/deps"
	"github.com/NotReptile/RuCord/services/realtime/internal/eventjournal"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

const version = "0.1.0"

func main() {
	cfg := sharedconfig.Load("realtime", ":8090")
	logger := observability.NewLogger(cfg.ServiceName)

	rootCtx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	db, err := postgres.ConnectFromEnv(rootCtx)
	if err != nil {
		logger.Error("postgres connect failed", "error", err)
		return
	}
	defer db.Close()

	redisClient, err := redisstore.ConnectFromEnv(rootCtx)
	if err != nil {
		logger.Error("redis connect failed", "error", err)
		return
	}
	defer redisClient.Close()

	jwtIssuer, err := jwtauth.NewIssuerFromEnv(cfg.ServiceName)
	if err != nil {
		logger.Error("jwt issuer init failed", "error", err)
		return
	}

	h := hub.New(logger)
	subscriber := realtimebus.NewSubscriber(redisClient)
	journal := eventjournal.New(db)
	tickets := wsticket.New(redisClient.Client)

	container := deps.Container{
		Logger:     logger,
		DB:         db,
		Redis:      redisClient,
		JWT:        jwtIssuer,
		Subscriber: subscriber,
		Journal:    journal,
		Tickets:    tickets,
		Hub:        h,
		CORS:       sharedhttp.CORS(parseCORSOrigins(os.Getenv("RUCORD_CORS_ORIGINS"))),
	}

	server := app.NewServer(cfg.ServiceName, version, container)
	httpServer := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go runSubscriber(rootCtx, subscriber, db, h)
	go runOutbox(rootCtx, journal, db, h, logger)
	go pruneJournal(rootCtx, journal, logger)

	logger.Info("starting realtime server", "address", cfg.HTTPAddress, "environment", cfg.Environment)

	serverErr := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case <-rootCtx.Done():
		logger.Info("shutdown signal received")
	case err := <-serverErr:
		logger.Error("http server error", "error", err)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown error", "error", err)
	}
}

func parseCORSOrigins(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{
			"http://127.0.0.1:1420",
			"http://localhost:1420",
			"tauri://localhost",
		}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func runSubscriber(ctx context.Context, subscriber *realtimebus.Subscriber, db *postgres.Pool, h *hub.Hub) {
	for {
		err := subscriber.Listen(ctx, func(event realtimebus.Envelope) {
			broadcastEnvelope(ctx, db, h, event)
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			time.Sleep(time.Second)
			continue
		}
		return
	}
}

func runOutbox(ctx context.Context, journal *eventjournal.Journal, db *postgres.Pool, h *hub.Hub, logger interface {
	Warn(string, ...any)
}) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			items, err := journal.Unpublished(ctx, 100)
			if err != nil {
				logger.Warn("realtime outbox read failed", "error", err)
				continue
			}
			for _, item := range items {
				if broadcastEnvelope(ctx, db, h, item) {
					_ = journal.MarkPublished(ctx, item.Seq)
				}
			}
		}
	}
}

func broadcastEnvelope(ctx context.Context, db *postgres.Pool, h *hub.Hub, event realtimebus.Envelope) bool {
	channelID, err := event.ChannelScope()
	if err != nil {
		return true // Discard malformed notification payloads without exposing them.
	}
	event.ChannelID = channelID
	payload, err := json.Marshal(event)
	if err != nil {
		return true
	}
	var users []uuid.UUID
	if event.UserID != "" {
		if uid, err := uuid.Parse(event.UserID); err == nil {
			users = []uuid.UUID{uid}
		}
	} else if event.WorkspaceID != "" {
		if wsID, err := uuid.Parse(event.WorkspaceID); err == nil {
			if event.ChannelID == "" {
				h.BroadcastWorkspace(wsID, payload)
				return true
			}
			users = h.WorkspaceUsers(wsID)
		}
	}
	if event.ChannelID != "" && len(users) > 0 {
		channelID, err := uuid.Parse(event.ChannelID)
		if err != nil {
			return true
		}
		checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		allowed, err := channelacl.VisibleMembers(checkCtx, db, channelID, users)
		if err != nil {
			return false
		}
		for _, userID := range users {
			if allowed[userID] {
				h.BroadcastUser(userID, payload)
			}
		}
	} else {
		for _, userID := range users {
			h.BroadcastUser(userID, payload)
		}
	}
	return true
}

func pruneJournal(ctx context.Context, journal *eventjournal.Journal, logger interface {
	Warn(string, ...any)
}) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pruneCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := journal.Prune(pruneCtx)
			cancel()
			if err != nil {
				logger.Warn("realtime journal prune failed", "error", err)
			}
		}
	}
}
