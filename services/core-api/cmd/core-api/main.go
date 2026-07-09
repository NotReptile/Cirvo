package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/ratelimit"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"

	"github.com/NotReptile/RuCord/services/core-api/internal/app"
	"github.com/NotReptile/RuCord/services/core-api/internal/bootstrap"
	"github.com/NotReptile/RuCord/services/core-api/internal/deps"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

const version = "0.1.0"

func main() {
	cfg := sharedconfig.Load("core-api", ":8080")
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

	publisher := realtimebus.NewPublisher(redisClient, db)

	objectStore, err := objectstore.ConnectFromEnv(rootCtx)
	if err != nil {
		logger.Warn("object storage init failed, file uploads disabled", "error", err)
		objectStore = nil
	}

	if err := bootstrap.Run(rootCtx, db, logger, bootstrap.LoadFromEnv()); err != nil {
		logger.Error("bootstrap admin failed", "error", err)
		return
	}

	limiter := ratelimit.New(redisClient.Client)
	settings := serversettings.NewProvider(db)

	container := deps.Container{
		Logger:      logger,
		DB:          db,
		Redis:       redisClient,
		JWT:         jwtIssuer,
		Publisher:   publisher,
		ObjectStore: objectStore,
		Limiter:     limiter,
		Settings:    settings,
		CORS:        sharedhttp.CORS(parseCORSOrigins(os.Getenv("RUCORD_CORS_ORIGINS"))),
	}

	server := app.NewServer(cfg.ServiceName, version, container)
	httpServer := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	logger.Info("starting http server", "address", cfg.HTTPAddress, "environment", cfg.Environment)

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
