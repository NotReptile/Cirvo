//go:build smoke

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
	"github.com/NotReptile/Cirvo/services/realtime/internal/eventjournal"
	"github.com/NotReptile/Cirvo/services/realtime/internal/hub"
	"github.com/NotReptile/Cirvo/services/realtime/internal/modules/typing"
)

func TestChannelPermissionsFilterLiveReplayAndTyping(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	owner, member, ws, channel := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `delete from realtime_events where workspace_id = $1 or user_id = any($2::uuid[])`, ws, []uuid.UUID{owner, member})
		_, _ = db.Exec(context.Background(), `delete from workspaces where id = $1`, ws)
		_, _ = db.Exec(context.Background(), `delete from users where id = any($1::uuid[])`, []uuid.UUID{owner, member})
	}()
	for _, user := range []uuid.UUID{owner, member} {
		exec(`insert into users(id,email,username,password_hash) values($1,$2,$3,'not-a-real-password')`, user, user.String()+"@acl.test", user.String())
	}
	exec(`insert into workspaces(id,slug,name,owner_user_id) values($1,$2,'ACL QA',$3)`, ws, ws.String(), owner)
	exec(`insert into workspace_members(workspace_id,user_id,role_code) values($1,$2,'owner'),($1,$3,'member')`, ws, owner, member)
	exec(`insert into channels(id,workspace_id,kind,name,is_private) values($1,$2,'text','private',true)`, channel, ws)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := hub.New(logger)
	ownerConn := hub.NewConnection(uuid.New(), owner, []uuid.UUID{ws})
	memberConn := hub.NewConnection(uuid.New(), member, []uuid.UUID{ws})
	h.Add(ownerConn)
	h.Add(memberConn)
	ownerConn.Activate()
	memberConn.Activate()
	event := realtimebus.Envelope{Event: "message.created", WorkspaceID: ws.String(), ChannelID: channel.String(), Payload: json.RawMessage(`{"body":"private QA content"}`)}
	if !broadcastEnvelope(ctx, db, h, event) {
		t.Fatal("live ACL query failed")
	}
	if len(ownerConn.Send) != 1 || len(memberConn.Send) != 0 {
		t.Fatal("private live event leaked or owner missed it")
	}
	<-ownerConn.Send
	direct := event
	direct.UserID = member.String()
	if !broadcastEnvelope(ctx, db, h, direct) || len(memberConn.Send) != 0 {
		t.Fatal("direct event bypassed channel ACL")
	}
	var seq int64
	err = db.QueryRow(ctx, `insert into realtime_events(event_id,event_type,workspace_id,channel_id,payload)
	 values($1,'message.created',$2,$3,$4) returning seq`, uuid.New(), ws, channel, event.Payload).Scan(&seq)
	if err != nil {
		t.Fatal(err)
	}
	journal := eventjournal.New(db)
	legacyNotification := realtimebus.Envelope{Event: "notification.created", UserID: member.String(),
		Payload: json.RawMessage(`{"kind":"mention","payload":{"channelId":"` + channel.String() + `","snippet":"private QA"}}`)}
	var legacySeq int64
	err = db.QueryRow(ctx, `insert into realtime_events(event_id,event_type,user_id,payload)
	 values($1,'notification.created',$2,$3) returning seq`, uuid.New(), member, legacyNotification.Payload).Scan(&legacySeq)
	if err != nil {
		t.Fatal(err)
	}
	checkLegacyNotification := func(want int) {
		t.Helper()
		if !broadcastEnvelope(ctx, db, h, legacyNotification) || len(memberConn.Send) != want {
			t.Fatal("legacy notification live routing bypassed ACL")
		}
		for len(memberConn.Send) > 0 {
			<-memberConn.Send
		}
		items, err := journal.Replay(ctx, member, nil, legacySeq-1, legacySeq)
		if err != nil || len(items) != want {
			t.Fatalf("legacy notification replay = %d, want %d, error %v", len(items), want, err)
		}
	}
	checkLegacyNotification(0)
	checkReplay := func(user uuid.UUID, want int) {
		t.Helper()
		items, err := journal.Replay(ctx, user, []uuid.UUID{ws}, seq-1, seq)
		if err != nil || len(items) != want {
			t.Fatalf("replay got %d, want %d, error %v", len(items), want, err)
		}
	}
	checkReplay(member, 0)
	checkReplay(owner, 1)
	checkTyping := func(want int) {
		t.Helper()
		module := typing.NewModule(logger, db, h)
		module.Relay(ctx, "typing.start", owner, ownerConn.SessionID, json.RawMessage(`{"channel_id":"`+channel.String()+`"}`))
		if len(memberConn.Send) != want {
			t.Fatalf("typing frames = %d, want %d", len(memberConn.Send), want)
		}
		for len(memberConn.Send) > 0 {
			<-memberConn.Send
		}
		for len(ownerConn.Send) > 0 {
			<-ownerConn.Send
		}
	}
	checkTyping(0)
	exec(`insert into channel_user_overrides(channel_id,user_id,granted_actions,denied_actions)
	 values($1,$2,array['channel.view'],'{}')`, channel, member)
	if !broadcastEnvelope(ctx, db, h, event) || len(memberConn.Send) != 1 {
		t.Fatal("new grant not applied to existing live connection")
	}
	<-memberConn.Send
	<-ownerConn.Send
	checkReplay(member, 1)
	checkLegacyNotification(1)
	checkTyping(1)
	exec(`update channel_user_overrides set granted_actions='{}',denied_actions=array['channel.view'] where channel_id=$1 and user_id=$2`, channel, member)
	if !broadcastEnvelope(ctx, db, h, event) || len(memberConn.Send) != 0 {
		t.Fatal("revoked view still receives private live content")
	}
	<-ownerConn.Send
	checkReplay(member, 0)
	checkTyping(0)
	checkLegacyNotification(0)
	// A stale hub workspace subscription cannot grant access after membership loss.
	exec(`update channel_user_overrides set granted_actions=array['channel.view'],denied_actions='{}' where channel_id=$1 and user_id=$2`, channel, member)
	exec(`delete from workspace_members where workspace_id=$1 and user_id=$2`, ws, member)
	if !broadcastEnvelope(ctx, db, h, event) || len(memberConn.Send) != 0 {
		t.Fatal("stale subscription bypassed membership revocation")
	}
	checkReplay(member, 0)
	var high int64
	err = db.QueryRow(ctx, `with inserted as (
	 insert into realtime_events(event_id,event_type,workspace_id,channel_id,payload)
	 select gen_random_uuid(),'message.created',$1,$2,'{}'::jsonb from generate_series(1,$3)
	 returning seq) select max(seq) from inserted`, ws, channel, eventjournal.MaxReplayItems).Scan(&high)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Replay(ctx, member, []uuid.UUID{ws}, seq, high); !errors.Is(err, eventjournal.ErrReplayLimit) {
		t.Fatalf("ACL filtering masked a full journal page: %v", err)
	}
}
