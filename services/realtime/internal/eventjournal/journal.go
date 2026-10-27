package eventjournal

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"

	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
)

const (
	Version        = 2
	Retention      = 7 * 24 * time.Hour
	MaxReplayItems = 2000
)

type Envelope = realtimebus.Envelope

var ErrReplayLimit = errors.New("realtime replay requires snapshot: journal page limit")

type Journal struct {
	db *postgres.Pool
}

func New(db *postgres.Pool) *Journal { return &Journal{db: db} }

func (j *Journal) HighWater(ctx context.Context) (int64, error) {
	var seq int64
	err := j.db.QueryRow(ctx, `select coalesce(max(seq), 0) from realtime_events`).Scan(&seq)
	return seq, err
}

func (j *Journal) MinimumCursor(ctx context.Context) (int64, error) {
	var seq int64
	err := j.db.QueryRow(ctx, `
		select coalesce(min(seq), 0)
		from realtime_events
		where occurred_at >= now() - interval '7 days'`).Scan(&seq)
	return seq, err
}

func (j *Journal) Replay(ctx context.Context, userID uuid.UUID, workspaces []uuid.UUID, after, through int64) ([]Envelope, error) {
	rows, err := j.db.Query(ctx, `
		select seq, event_id, occurred_at, event_type,
		       coalesce(workspace_id::text, ''), coalesce(channel_id::text, ''),
		       coalesce(user_id::text, ''), payload
		from realtime_events
		where seq > $1 and seq <= $2
		  and occurred_at >= now() - interval '7 days'
		  and (user_id = $3 or workspace_id = any($4::uuid[]))
		order by seq
		limit $5`, after, through, userID, workspaces, MaxReplayItems)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]Envelope, 0)
	for rows.Next() {
		var item Envelope
		var id uuid.UUID
		var occurred time.Time
		if err := rows.Scan(&item.Seq, &id, &occurred, &item.Event, &item.WorkspaceID,
			&item.ChannelID, &item.UserID, &item.Payload); err != nil {
			return nil, err
		}
		item.Version = Version
		item.EventID = id.String()
		item.OccurredAt = occurred.UTC().Format(time.RFC3339Nano)
		scope, scopeErr := item.ChannelScope()
		if scopeErr != nil {
			return nil, scopeErr
		}
		item.ChannelID = scope
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	// Test the original page, not its ACL-filtered size: otherwise hidden events
	// can consume the limit and cause later visible events to be skipped.
	if len(items) >= MaxReplayItems {
		return nil, ErrReplayLimit
	}
	// Journal routing records who the event originally targeted. Read access
	// must be evaluated again after permission changes, including direct events.
	channelIDs := make([]uuid.UUID, 0)
	seen := make(map[uuid.UUID]bool)
	for _, item := range items {
		if item.ChannelID == "" {
			continue
		}
		id, err := uuid.Parse(item.ChannelID)
		if err != nil {
			continue
		}
		if !seen[id] {
			seen[id] = true
			channelIDs = append(channelIDs, id)
		}
	}
	if len(channelIDs) == 0 {
		return items, nil
	}
	visible, err := channelacl.VisibleChannels(ctx, j.db, channelIDs, []uuid.UUID{userID})
	if err != nil {
		return nil, err
	}
	filtered := items[:0]
	for _, item := range items {
		if item.ChannelID == "" {
			filtered = append(filtered, item)
			continue
		}
		id, err := uuid.Parse(item.ChannelID)
		if err == nil && visible[userID][id] {
			filtered = append(filtered, item)
		}
	}
	return filtered, nil
}

func (j *Journal) Prune(ctx context.Context) error {
	_, err := j.db.Exec(ctx, `delete from realtime_events where occurred_at < now() - interval '7 days'`)
	return err
}

func (j *Journal) Unpublished(ctx context.Context, limit int) ([]Envelope, error) {
	rows, err := j.db.Query(ctx, `
		select seq, event_id, occurred_at, event_type,
		       coalesce(workspace_id::text, ''), coalesce(channel_id::text, ''),
		       coalesce(user_id::text, ''), payload
		from realtime_events
		where published_at is null
		order by seq
		limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Envelope, 0)
	for rows.Next() {
		var item Envelope
		var id uuid.UUID
		var occurred time.Time
		if err := rows.Scan(&item.Seq, &id, &occurred, &item.Event, &item.WorkspaceID,
			&item.ChannelID, &item.UserID, &item.Payload); err != nil {
			return nil, err
		}
		item.Version = Version
		item.EventID = id.String()
		item.OccurredAt = occurred.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (j *Journal) MarkPublished(ctx context.Context, seq int64) error {
	_, err := j.db.Exec(ctx, `update realtime_events set published_at = now() where seq = $1`, seq)
	return err
}
