package main

import (
	"log"
	"net/http"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/services/realtime/internal/app"
)

const version = "0.1.0"

func main() {
	cfg := sharedconfig.Load("realtime", ":8090")
	logger := observability.NewLogger(cfg.ServiceName)
	server := app.NewServer(cfg.ServiceName, version)

	logger.Info("starting realtime server", "address", cfg.HTTPAddress, "environment", cfg.Environment)

	if err := http.ListenAndServe(cfg.HTTPAddress, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
