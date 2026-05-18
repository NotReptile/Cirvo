package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/worker/internal/jobs"
)

func main() {
	cfg := sharedconfig.Load("worker", ":0")
	logger := observability.NewLogger(cfg.ServiceName)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		logger.Error("postgres connect failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	store, err := objectstore.ConnectFromEnv(ctx)
	if err != nil {
		logger.Warn("object store unavailable; thumbnail jobs will fail", "error", err)
	}

	runner := jobs.NewRunner(logger, db, store)

	logger.Info("starting worker", "environment", cfg.Environment)
	runner.Run(ctx)
}
