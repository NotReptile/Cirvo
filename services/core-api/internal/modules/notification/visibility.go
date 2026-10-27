package notification

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"
)

// Missing channels are valid only for notifications unrelated to channel content.
func notificationChannel(kind string, payload json.RawMessage) (uuid.UUID, bool, bool) {
	var value struct {
		ChannelID string `json:"channelId"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return uuid.Nil, true, false
	}
	if value.ChannelID == "" {
		scoped := kind == KindMention || kind == KindReply || kind == KindMentionEveryone
		return uuid.Nil, scoped, !scoped
	}
	id, err := uuid.Parse(value.ChannelID)
	return id, true, err == nil && id != uuid.Nil
}

func (m *Module) visibleChannelIDs(ctx context.Context, user uuid.UUID, before time.Time) ([]string, error) {
	ids := []uuid.UUID{}
	seen := map[uuid.UUID]bool{}
	rawIDs := map[uuid.UUID][]string{}
	rows, err := m.db.Query(ctx, `select distinct payload->>'channelId' from user_notifications
	 where user_id = $1 and created_at < $2 and coalesce(payload->>'channelId', '') <> ''`, user, before)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			return nil, err
		}
		id, err := uuid.Parse(raw)
		if err == nil && id != uuid.Nil {
			rawIDs[id] = append(rawIDs[id], raw)
		}
		if err == nil && id != uuid.Nil && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	access, err := channelacl.VisibleChannels(ctx, m.db, ids, []uuid.UUID{user})
	if err != nil {
		return nil, err
	}
	visible := []string{}
	for _, id := range ids {
		if access[user][id] {
			visible = append(visible, rawIDs[id]...)
		}
	}
	return visible, nil
}
