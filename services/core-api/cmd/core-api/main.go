package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"

	"github.com/NotReptile/RuCord/services/core-api/internal/app"
	"github.com/NotReptile/RuCord/services/core-api/internal/deps"
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

	publisher := realtimebus.NewPublisher(redisClient)

	container := deps.Container{
		Logger:    logger,
		DB:        db,
		Redis:     redisClient,
		JWT:       jwtIssuer,
		Publisher: publisher,
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
