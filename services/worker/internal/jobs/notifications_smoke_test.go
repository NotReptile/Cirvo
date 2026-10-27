//go:build smoke

package jobs

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
)

func TestNotificationDeliveryUsesCurrentChannelVisibility(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	owner, member, outsider, ws, channel, category, role := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `delete from workspaces where id = $1`, ws)
		_, _ = db.Exec(context.Background(), `delete from users where id = any($1::uuid[])`, []uuid.UUID{owner, member, outsider})
	}()
	for _, user := range []uuid.UUID{owner, member, outsider} {
		exec(`insert into users(id,email,username,password_hash) values($1,$2,$3,'not-a-real-password')`, user, user.String()+"@notification.test", user.String())
	}
	exec(`insert into workspaces(id,slug,name,owner_user_id) values($1,$2,'Notification QA',$3)`, ws, ws.String(), owner)
	exec(`insert into workspace_members(workspace_id,user_id,role_code) values($1,$2,'owner'),($1,$3,'member')`, ws, owner, member)
	exec(`insert into channel_categories(id,workspace_id,name) values($1,$2,'Private QA')`, category, ws)
	exec(`insert into channels(id,workspace_id,kind,name,is_private,category_id) values($1,$2,'text','private',true,$3)`, channel, ws, category)
	exec(`insert into workspace_roles(id,workspace_id,code,name,base_action_mask) values($1,$2,'qa','QA',array['channel.view'])`, role, ws)
	exec(`insert into workspace_role_members(workspace_id,role_id,user_id) values($1,$2,$3)`, ws, role, member)
	runner := NewNotificationRunner(slog.New(slog.NewTextHandler(io.Discard, nil)), db, nil)
	deliver := func(kind, snippet string, recipients []string) {
		t.Helper()
		p := notificationPayload{Recipients: recipients, WorkspaceID: ws.String(), ChannelID: channel.String(), Snippet: snippet, Exclude: []string{owner.String()}}
		if kind == "mention_everyone" {
			p.MentionKind = "everyone"
		}
		payload, _ := json.Marshal(p)
		if err := runner.handle(ctx, NotificationJob{Kind: kind, Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	count := func(snippet string) int {
		t.Helper()
		var n int
		if err := db.QueryRow(ctx, `select count(*) from user_notifications where payload->>'snippet' = $1 and user_id = any($2::uuid[])`, snippet, []uuid.UUID{owner, member, outsider}).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	deliver("mention", "private denied", []string{member.String(), outsider.String()})
	if count("private denied") != 0 {
		t.Fatal("private snippet delivered without view")
	}
	exec(`insert into category_role_overrides(category_id,role_id,granted_actions) values($1,$2,array['channel.view'])`, category, role)
	deliver("mention_everyone", "category grant", nil)
	if count("category grant") != 1 {
		t.Fatal("everyone ignored category grant or notified excluded owner")
	}
	var storedKind, mentionKind string
	if err := db.QueryRow(ctx, `select kind, payload->>'mentionKind' from user_notifications where user_id = $1 and payload->>'snippet' = 'category grant'`, member).Scan(&storedKind, &mentionKind); err != nil {
		t.Fatal(err)
	}
	if storedKind != "mention_everyone" || mentionKind != "everyone" {
		t.Fatalf("mass mention contract changed: %s/%s", storedKind, mentionKind)
	}
	deliver("reply", "explicit recipients", []string{member.String(), outsider.String()})
	if count("explicit recipients") != 1 {
		t.Fatal("explicit recipients bypassed membership ACL")
	}
	exec(`insert into channel_user_overrides(channel_id,user_id,denied_actions) values($1,$2,array['channel.view'])`, channel, member)
	deliver("mention_everyone", "after revoke", nil)
	if count("after revoke") != 0 {
		t.Fatal("revoked member received everyone snippet")
	}
	// A failed ACL lookup must retry the job rather than publish its snippet.
	failed := &NotificationRunner{logger: runner.logger, db: db}
	payload, _ := json.Marshal(notificationPayload{Recipients: []string{member.String()}, ChannelID: channel.String()})
	aborted, abort := context.WithCancel(ctx)
	abort()
	if err := failed.handle(aborted, NotificationJob{Kind: "mention", Payload: payload}); err == nil {
		t.Fatal("ACL lookup failure did not stop delivery")
	}
}
