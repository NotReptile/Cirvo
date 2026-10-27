package redisstore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const DefaultEventChannel = "cirvo:events"

type Client struct {
	*redis.Client
}

func ConnectFromEnv(ctx context.Context) (*Client, error) {
	addr := os.Getenv("CIRVO_REDIS_ADDR")
	if addr == "" {
		host := envOr("REDIS_HOST", "127.0.0.1")
		port := envOr("REDIS_PORT", "6379")
		addr = host + ":" + port
	}
	if addr == "" {
		return nil, errors.New("redis address is not configured")
	}
	password := os.Getenv("REDIS_PASSWORD")
	db := 0
	if v := os.Getenv("REDIS_DB"); v != "" {
		parsed, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid REDIS_DB: %w", err)
		}
		db = parsed
	}

	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return &Client{Client: client}, nil
}

func envOr(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}
