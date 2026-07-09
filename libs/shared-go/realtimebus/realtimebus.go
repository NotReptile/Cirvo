package realtimebus

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
)

type Event struct {
	Event       string `json:"event"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	ChannelID   string `json:"channelId,omitempty"`
	// UserID — таргет-юзер для приватных событий (notifications). Если
	// задан, realtime-сабскрайбер маршрутизирует через BroadcastUser
	// вместо workspace-fanout.
	UserID  string          `json:"userId,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

type Envelope struct {
	Version     int             `json:"version"`
	Seq         int64           `json:"seq"`
	EventID     string          `json:"eventId"`
	OccurredAt  string          `json:"occurredAt"`
	Event       string          `json:"event"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
	ChannelID   string          `json:"channelId,omitempty"`
	UserID      string          `json:"userId,omitempty"`
	Payload     json.RawMessage `json:"payload"`
}

type Publisher struct {
	client  *redis.Client
	db      *postgres.Pool
	channel string
}

func NewPublisher(client *redisstore.Client, db *postgres.Pool) *Publisher {
	return &Publisher{client: client.Client, db: db, channel: redisstore.DefaultEventChannel}
}

func (p *Publisher) Publish(ctx context.Context, event Event) error {
	if len(event.Payload) == 0 {
		event.Payload = json.RawMessage(`{}`)
	}
	id := uuid.New()
	var envelope Envelope
	var occurred time.Time
	err := p.db.QueryRow(ctx, `
		insert into realtime_events (event_id, event_type, workspace_id, channel_id, user_id, payload)
		values ($1, $2, nullif($3, '')::uuid, nullif($4, '')::uuid,
		        nullif($5, '')::uuid, $6::jsonb)
		returning seq, occurred_at`, id, event.Event, event.WorkspaceID, event.ChannelID, event.UserID, event.Payload,
	).Scan(&envelope.Seq, &occurred)
	if err != nil {
		return fmt.Errorf("journal event: %w", err)
	}
	envelope.Version = 2
	envelope.EventID = id.String()
	envelope.OccurredAt = occurred.UTC().Format(time.RFC3339Nano)
	envelope.Event = event.Event
	envelope.WorkspaceID = event.WorkspaceID
	envelope.ChannelID = event.ChannelID
	envelope.UserID = event.UserID
	envelope.Payload = event.Payload
	raw, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	if err := p.client.Publish(ctx, p.channel, raw).Err(); err != nil {
		return err
	}
	_, _ = p.db.Exec(ctx, `update realtime_events set published_at = now() where event_id = $1`, id)
	return nil
}

type Subscriber struct {
	client  *redis.Client
	channel string
}

func NewSubscriber(client *redisstore.Client) *Subscriber {
	return &Subscriber{client: client.Client, channel: redisstore.DefaultEventChannel}
}

func (s *Subscriber) Listen(ctx context.Context, handler func(Envelope)) error {
	sub := s.client.Subscribe(ctx, s.channel)
	defer sub.Close()

	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-ch:
			if !ok {
				return fmt.Errorf("redis subscription channel closed")
			}
			var event Envelope
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				continue
			}
			handler(event)
		}
	}
}
