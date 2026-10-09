// SFU (Selective Forwarding Unit) для voice-каналов — F.2. Снимает
// mesh-потолок (~5 участников): каждый клиент держит ровно два
// RTCPeerConnection с сервером (publisher + subscriber), сервер
// форвардит RTP-пакеты между участниками комнаты без транскодинга.
//
// Сигналинг — собственный WebSocket /sfu/ws (не realtime-relay: SFU сам
// сторона переговоров, а не посредник между клиентами). Авторизация —
// одноразовый тикет от core-api + проверка, что сессия уже
// сделала POST /voice/join (строка в channel_participants).
//
// Медиа — один UDP-порт (UDPMux, RUCORD_SFU_UDP_PORT) — простой
// проброс через docker/NAT; публичный IP сервера задаётся
// RUCORD_SFU_PUBLIC_IP (NAT 1:1 host-кандидаты).
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	sharedconfig "github.com/NotReptile/RuCord/libs/shared-go/config"
	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/observability"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
	"github.com/NotReptile/RuCord/libs/shared-go/wsticket"

	"github.com/NotReptile/RuCord/services/sfu/internal/rtc"
	"github.com/NotReptile/RuCord/services/sfu/internal/transport"
)

const version = "0.1.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		runHealthcheck()
		return
	}
	cfg := sharedconfig.Load("sfu", ":8095")
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

	engineConfig := loadEngineConfig()
	if cfg.Environment == "production" && len(engineConfig.PublicIPs) == 0 {
		logger.Error("RUCORD_SFU_PUBLIC_IP is required in production")
		return
	}
	engine, err := rtc.NewEngine(logger, engineConfig)
	if err != nil {
		logger.Error("rtc engine init failed", "error", err)
		return
	}
	defer engine.Close()

	manager := rtc.NewManager(logger, engine)

	mux := http.NewServeMux()
	mux.Handle("/healthz", sharedhttp.HealthHandler(cfg.ServiceName, version))
	transport.NewModule(logger, db, jwtIssuer, manager, wsticket.New(redisClient.Client)).RegisterRoutes(mux)

	handler := sharedhttp.WithRequestID(mux)
	handler = sharedhttp.AccessLog(logger, handler)
	handler = sharedhttp.Recover(logger, handler)

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	logger.Info("starting sfu server", "address", cfg.HTTPAddress, "environment", cfg.Environment)

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

func runHealthcheck() {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:8095/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
	_ = resp.Body.Close()
}

func loadEngineConfig() rtc.EngineConfig {
	cfg := rtc.EngineConfig{UDPPort: 8443}
	if raw := strings.TrimSpace(os.Getenv("RUCORD_SFU_UDP_PORT")); raw != "" {
		if port, err := strconv.Atoi(raw); err == nil && port > 0 && port < 65536 {
			cfg.UDPPort = port
		}
	}
	if raw := strings.TrimSpace(os.Getenv("RUCORD_SFU_PUBLIC_IP")); raw != "" {
		for _, ip := range strings.Split(raw, ",") {
			if v := strings.TrimSpace(ip); v != "" {
				cfg.PublicIPs = append(cfg.PublicIPs, v)
			}
		}
	}
	return cfg
}
