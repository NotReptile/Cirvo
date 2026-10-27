package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Pool struct {
	*pgxpool.Pool
}

func ConnectFromEnv(ctx context.Context) (*Pool, error) {
	dsn := os.Getenv("CIRVO_POSTGRES_DSN")
	if dsn == "" {
		dsn = buildDSNFromParts()
	}
	if dsn == "" {
		return nil, errors.New("postgres DSN is not configured: set CIRVO_POSTGRES_DSN or POSTGRES_* env vars")
	}
	return Connect(ctx, dsn)
}

func Connect(ctx context.Context, dsn string) (*Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres dsn: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pgx pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &Pool{Pool: pool}, nil
}

func buildDSNFromParts() string {
	host := envOr("POSTGRES_HOST", "127.0.0.1")
	port := envOr("POSTGRES_PORT", "5432")
	user := os.Getenv("POSTGRES_USER")
	pass := os.Getenv("POSTGRES_PASSWORD")
	db := os.Getenv("POSTGRES_DB")
	if user == "" || db == "" {
		return ""
	}
	sslmode := envOr("POSTGRES_SSLMODE", "disable")
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s", user, pass, host, port, db, sslmode)
}

func envOr(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}
