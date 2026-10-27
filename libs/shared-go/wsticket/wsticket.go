package wsticket

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	PurposeRealtime = "realtime"
	PurposeSFU      = "sfu"
	TTL             = 30 * time.Second
	keyPrefix       = "cirvo:ws-ticket:"
)

var ErrInvalid = errors.New("invalid or expired websocket ticket")

type Claims struct {
	Purpose   string    `json:"purpose"`
	UserID    uuid.UUID `json:"userId"`
	SessionID uuid.UUID `json:"sessionId"`
	ChannelID uuid.UUID `json:"channelId,omitempty"`
}

type Store struct {
	client *redis.Client
}

func New(client *redis.Client) *Store { return &Store{client: client} }

func (s *Store) Issue(ctx context.Context, claims Claims) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	ticket := base64.RawURLEncoding.EncodeToString(raw)
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", time.Time{}, err
	}
	if err := s.client.Set(ctx, keyPrefix+ticket, payload, TTL).Err(); err != nil {
		return "", time.Time{}, err
	}
	return ticket, time.Now().UTC().Add(TTL), nil
}

func (s *Store) Consume(ctx context.Context, ticket, purpose string) (Claims, error) {
	if ticket == "" {
		return Claims{}, ErrInvalid
	}
	raw, err := s.client.GetDel(ctx, keyPrefix+ticket).Bytes()
	if err != nil {
		return Claims{}, ErrInvalid
	}
	var claims Claims
	if json.Unmarshal(raw, &claims) != nil || claims.Purpose != purpose || claims.UserID == uuid.Nil || claims.SessionID == uuid.Nil {
		return Claims{}, ErrInvalid
	}
	return claims, nil
}
