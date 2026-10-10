//go:build smoke

package transport

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

func TestPresenceLifecycleAcrossSessionsAndSnapshot(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	actor, peer, ws, firstID, secondID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `delete from workspaces where id=$1`, ws)
		_, _ = db.Exec(context.Background(), `delete from users where id=any($1::uuid[])`, []uuid.UUID{actor, peer})
	}()
	for _, user := range []uuid.UUID{actor, peer} {
		exec(`insert into users(id,email,username,password_hash) values($1,$2,$3,'not-a-real-password')`, user, user.String()+"@presence.test", user.String())
	}
	exec(`update users set presence_mode='dnd',custom_status='working' where id=$1`, actor)
	exec(`insert into workspaces(id,slug,name,owner_user_id) values($1,$2,'Presence QA',$3)`, ws, ws.String(), actor)
	exec(`insert into workspace_members(workspace_id,user_id,role_code) values($1,$2,'owner'),($1,$3,'member')`, ws, actor, peer)
	for _, session := range []uuid.UUID{firstID, secondID} {
		exec(`insert into user_sessions(id,user_id,refresh_token_hash,device_label,last_seen_at,refresh_expires_at) values($1,$2,$3,'QA',now()-interval '10 minutes',now()+interval '1 day')`, session, actor, session.String())
	}
	h := hub.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	observer := hub.NewConnection(uuid.New(), peer, []uuid.UUID{ws})
	h.Add(observer)
	observer.Activate()
	m := &Module{db: db, hub: h}
	check := func(mode, custom string) {
		t.Helper()
		select {
		case raw := <-observer.Send:
			var event struct {
				Payload struct{ UserID, Mode, CustomStatus string }
			}
			if json.Unmarshal(raw, &event) != nil || event.Payload.UserID != actor.String() || event.Payload.Mode != mode || event.Payload.CustomStatus != custom {
				t.Fatalf("bad lifecycle event: %s", raw)
			}
		default:
			t.Fatal("presence transition missing")
		}
	}
	first := hub.NewConnection(firstID, actor, []uuid.UUID{ws})
	second := hub.NewConnection(secondID, actor, []uuid.UUID{ws})
	m.connectPresence(first)
	check("dnd", "working")
	m.connectPresence(second)
	check("dnd", "working")
	m.disconnectPresence(first)
	check("dnd", "working")
	var fresh bool
	if err := db.QueryRow(ctx, `select last_seen_at>now()-interval '5 minutes' from user_sessions where id=$1`, secondID).Scan(&fresh); err != nil || !fresh {
		t.Fatal("disconnect expired another session")
	}
	m.disconnectPresence(second)
	check("offline", "working")
	if err := db.QueryRow(ctx, `select exists(select 1 from user_sessions where user_id=$1 and revoked_at is null and last_seen_at>now()-interval '5 minutes')`, actor).Scan(&fresh); err != nil || fresh {
		t.Fatal("last disconnect stayed online in HTTP snapshot")
	}
	exec(`update users set presence_mode='invisible',custom_status='private' where id=$1`, actor)
	m.connectPresence(first)
	check("offline", "")
	replacement := hub.NewConnection(firstID, actor, []uuid.UUID{ws})
	m.connectPresence(replacement)
	check("offline", "")
	m.disconnectPresence(first)
	check("offline", "")
	if !h.SessionConnected(firstID) {
		t.Fatal("old connection cleanup removed replacement")
	}
	for _, value := range m.visiblePresenceSnapshot(peer, []uuid.UUID{ws}) {
		if value.UserID == actor.String() && (value.Mode != "offline" || value.CustomStatus != "") {
			t.Fatal("snapshot disclosed invisible state")
		}
	}
	m.disconnectPresence(replacement)
	check("offline", "")
	if len(m.presenceLocks) != 0 {
		t.Fatal("per-user locks retained after transitions")
	}
}
