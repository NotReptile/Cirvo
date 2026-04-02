package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/services/worker/internal/jobs"
)

func main() {
	cfg := sharedconfig.Load("worker", ":0")
	logger := observability.NewLogger(cfg.ServiceName)
	runner := jobs.NewRunner(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger.Info("starting worker", "environment", cfg.Environment)
	runner.Run(ctx)
}
