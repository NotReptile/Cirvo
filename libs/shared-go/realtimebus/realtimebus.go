package realtimebus

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"

	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
)

type Event struct {
	Event       string          `json:"event"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
	ChannelID   string          `json:"channelId,omitempty"`
	// UserID — таргет-юзер для приватных событий (notifications). Если
	// задан, realtime-сабскрайбер маршрутизирует через BroadcastUser
	// вместо workspace-fanout.
	UserID  string          `json:"userId,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

type Publisher struct {
	client  *redis.Client
	channel string
}

func NewPublisher(client *redisstore.Client) *Publisher {
	return &Publisher{client: client.Client, channel: redisstore.DefaultEventChannel}
}

func (p *Publisher) Publish(ctx context.Context, event Event) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	return p.client.Publish(ctx, p.channel, raw).Err()
}

type Subscriber struct {
	client  *redis.Client
	channel string
}

func NewSubscriber(client *redisstore.Client) *Subscriber {
	return &Subscriber{client: client.Client, channel: redisstore.DefaultEventChannel}
}

func (s *Subscriber) Listen(ctx context.Context, handler func(Event)) error {
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
			var event Event
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				continue
			}
			handler(event)
		}
	}
}
