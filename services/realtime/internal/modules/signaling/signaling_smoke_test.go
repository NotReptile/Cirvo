//go:build smoke

package signaling

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/services/realtime/internal/hub"
)

func TestVoiceRelayRequiresCurrentChannelAccessAndSessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	owner, sender, target, ws, ch, other := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	sourceSession, targetSession, unusedSession := uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		db.Exec(context.Background(), `delete from workspaces where id=$1`, ws)
		db.Exec(context.Background(), `delete from users where id=any($1::uuid[])`, []uuid.UUID{owner, sender, target})
	}()
	for _, user := range []uuid.UUID{owner, sender, target} {
		exec(`insert into users(id,email,username,password_hash) values($1,$2,$3,'QA')`, user, user.String()+"@relay.test", user.String())
	}
	exec(`insert into workspaces(id,slug,name,owner_user_id) values($1,$2,'Relay QA',$3)`, ws, ws.String(), owner)
	exec(`insert into workspace_members(workspace_id,user_id,role_code) values($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`, ws, owner, sender, target)
	for _, channel := range []uuid.UUID{ch, other} {
		exec(`insert into channels(id,workspace_id,kind,name) values($1,$2,'voice','Relay QA')`, channel, ws)
	}
	for session, user := range map[uuid.UUID]uuid.UUID{sourceSession: sender, targetSession: target, unusedSession: target} {
		exec(`insert into user_sessions(id,user_id,refresh_token_hash,refresh_expires_at,device_label) values($1,$2,$3,now()+interval '1 day','QA')`, session, user, session.String())
	}
	exec(`insert into channel_participants(channel_id,user_id,session_id) values($1,$2,$3),($1,$4,$5)`, ch, sender, sourceSession, target, targetSession)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := hub.New(logger)
	receiving := hub.NewConnection(targetSession, target, []uuid.UUID{ws})
	unused := hub.NewConnection(unusedSession, target, []uuid.UUID{ws})
	h.Add(receiving)
	h.Add(unused)
	receiving.Activate()
	unused.Activate()
	module := NewModule(logger, db, h)
	relay := func(event string, channel, source uuid.UUID, sessionTarget bool, want bool) {
		t.Helper()
		p := map[string]string{"call_id": "QA", "channel_id": channel.String(), "target_user_id": target.String()}
		if sessionTarget {
			p["target_session_id"] = targetSession.String()
		}
		raw, _ := json.Marshal(p)
		module.Relay(ctx, event, sender, source, raw)
		if (len(receiving.Send) > 0) != want {
			t.Fatalf("%s channel %s delivered=%v want=%v", event, channel, len(receiving.Send) > 0, want)
		}
		if len(receiving.Send) > 0 {
			<-receiving.Send
		}
		if len(unused.Send) > 0 {
			t.Fatal("voice signal reached non-participating target session")
		}
	}
	for _, event := range []string{"voice.offer", "voice.answer", "voice.ice", "voice.state", "voice.hangup"} {
		relay(event, ch, sourceSession, true, true)
	}
	relay("voice.state", ch, sourceSession, false, true)
	missingChannel, _ := json.Marshal(map[string]string{"call_id": "QA", "target_session_id": targetSession.String()})
	module.Relay(ctx, "voice.ice", sender, sourceSession, missingChannel)
	if len(receiving.Send) != 0 {
		t.Fatal("voice signal without channel context accepted")
	}
	relay("voice.offer", other, sourceSession, true, false) // workspace membership is insufficient.
	relay("voice.offer", ch, uuid.New(), true, false)
	exec(`delete from channel_participants where session_id=$1`, sourceSession)
	relay("voice.offer", ch, sourceSession, true, false)
	exec(`insert into channel_participants(channel_id,user_id,session_id) values($1,$2,$3)`, ch, sender, sourceSession)
	exec(`delete from channel_participants where session_id=$1`, targetSession)
	relay("voice.offer", ch, sourceSession, true, false)
	exec(`insert into channel_participants(channel_id,user_id,session_id) values($1,$2,$3)`, ch, target, targetSession)
	exec(`update channels set is_private=true where id=$1`, ch)
	relay("voice.offer", ch, sourceSession, true, false) // stale participant does not grant private view.
	exec(`insert into channel_members(channel_id,user_id) values($1,$2),($1,$3)`, ch, sender, target)
	relay("voice.offer", ch, sourceSession, true, true)
	for _, user := range []uuid.UUID{sender, target} {
		exec(`insert into channel_user_overrides(channel_id,user_id,denied_actions) values($1,$2,array['channel.view'])`, ch, user)
		relay("voice.offer", ch, sourceSession, true, false)
		exec(`delete from channel_user_overrides where channel_id=$1 and user_id=$2`, ch, user)
	}
	exec(`update user_sessions set revoked_at=now() where id=$1`, sourceSession)
	relay("voice.offer", ch, sourceSession, true, false)
	exec(`update user_sessions set revoked_at=null where id=$1`, sourceSession)
	exec(`update user_sessions set revoked_at=now() where id=$1`, targetSession)
	relay("voice.offer", ch, sourceSession, true, false)
	exec(`update user_sessions set revoked_at=null where id=$1`, targetSession)
	exec(`update user_sessions set refresh_expires_at=now()-interval '1 minute' where id=$1`, sourceSession)
	relay("voice.offer", ch, sourceSession, true, false)
	exec(`update user_sessions set refresh_expires_at=now()+interval '1 day' where id=$1`, sourceSession)
	exec(`update channels set archived_at=now() where id=$1`, ch)
	relay("voice.offer", ch, sourceSession, true, false)
	// Direct-call namespace retains its existing workspace relay, independently of voice participation.
	raw, _ := json.Marshal(map[string]string{"call_id": "direct", "target_session_id": unusedSession.String(), "target_user_id": target.String()})
	module.Relay(ctx, "call.offer", sender, sourceSession, raw)
	if len(unused.Send) != 1 {
		t.Fatal("direct call relay changed")
	}
	<-unused.Send
	raw, _ = json.Marshal(map[string]string{"call_id": "spoof", "channel_id": ch.String(), "target_session_id": unusedSession.String(), "target_user_id": owner.String()})
	module.Relay(ctx, "call.offer", sender, sourceSession, raw)
	if len(unused.Send) != 0 {
		t.Fatal("target session/user mismatch accepted")
	}
}
