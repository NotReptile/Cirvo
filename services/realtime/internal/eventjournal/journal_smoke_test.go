//go:build smoke

package eventjournal

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

func TestAppendAndReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	journal := New(db)
	userID := uuid.New()
	workspaceID := uuid.New()
	eventID := uuid.New()
	var envelope Envelope
	err = db.QueryRow(ctx, `
		insert into realtime_events (event_id, event_type, workspace_id, user_id, payload)
		values ($1, 'test.replay', $2, $3, '{"ok":true}'::jsonb)
		returning seq`, eventID, workspaceID, userID).Scan(&envelope.Seq)
	if err != nil {
		t.Fatal(err)
	}
	envelope.EventID = eventID.String()
	defer func() {
		_, _ = db.Exec(context.Background(), `delete from realtime_events where event_id = $1`, envelope.EventID)
	}()

	items, err := journal.Replay(ctx, userID, []uuid.UUID{workspaceID}, envelope.Seq-1, envelope.Seq)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].EventID != envelope.EventID || items[0].Version != Version {
		t.Fatalf("unexpected replay: %+v", items)
	}
}
