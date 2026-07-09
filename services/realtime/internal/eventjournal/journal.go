package eventjournal

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
)

const (
	Version        = 2
	Retention      = 7 * 24 * time.Hour
	MaxReplayItems = 2000
)

type Envelope = realtimebus.Envelope

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
		items = append(items, item)
	}
	return items, rows.Err()
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
