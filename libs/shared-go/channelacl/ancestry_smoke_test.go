//go:build smoke

package channelacl

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
)

// Exercises both HTTP/list snapshots and the live-event/replay batch evaluator
// against real rows, including old threads whose own is_private remains false.
func TestParentVisibilityDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := postgres.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	owner, member, outsider, ws := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	parent, child, leaf := uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		db.Exec(context.Background(), `delete from workspaces where id=$1`, ws)
		db.Exec(context.Background(), `delete from users where id=any($1::uuid[])`, []uuid.UUID{owner, member, outsider})
	}()
	for _, user := range []uuid.UUID{owner, member, outsider} {
		exec(`insert into users(id,email,username,password_hash) values($1,$2,$3,'QA')`, user, user.String()+"@ancestry.test", user.String())
	}
	exec(`insert into workspaces(id,slug,name,owner_user_id) values($1,$2,'Ancestry QA',$3)`, ws, ws.String(), owner)
	exec(`insert into workspace_members(workspace_id,user_id,role_code) values($1,$2,'owner'),($1,$3,'member')`, ws, owner, member)
	exec(`insert into channels(id,workspace_id,kind,name,is_private) values($1,$2,'text','Private parent',true)`, parent, ws)
	exec(`insert into channels(id,workspace_id,kind,name,parent_channel_id) values($1,$2,'thread','Old public child',$3)`, child, ws, parent)
	exec(`insert into channels(id,workspace_id,kind,name,parent_channel_id) values($1,$2,'thread','Nested child',$3)`, leaf, ws, child)
	check := func(user uuid.UUID, want bool) {
		t.Helper()
		base, err := LoadWorkspace(ctx, db, ws, user)
		if err != nil {
			t.Fatal(err)
		}
		for _, requested := range []uuid.UUID{uuid.Nil, child, leaf} {
			snapshots, err := LoadChannels(ctx, db, ws, user, requested, base)
			if err != nil {
				t.Fatal(err)
			}
			for _, id := range []uuid.UUID{child, leaf} {
				if requested != uuid.Nil && requested != id {
					continue
				}
				if snapshots[id].Allows(ChannelView) != want || snapshots[id].Allows(MessageWrite) != want {
					t.Fatalf("snapshot %s user %s visible/write mismatch want %v", id, user, want)
				}
			}
			if requested != uuid.Nil && len(snapshots) != 1 {
				t.Fatal("single-channel result leaked ancestors")
			}
		}
		visible, err := VisibleChannels(ctx, db, []uuid.UUID{child, leaf}, []uuid.UUID{user})
		if err != nil {
			t.Fatal(err)
		}
		if len(visible[user]) != 2 {
			t.Fatal("batch result leaked ancestors")
		}
		for _, id := range []uuid.UUID{child, leaf} {
			if visible[user][id] != want {
				t.Fatalf("batch %s user %s want %v", id, user, want)
			}
		}
	}
	check(member, false)
	check(outsider, false)
	check(owner, true)
	// Child membership and explicit grants must not bypass a hidden parent.
	exec(`insert into channel_members(channel_id,user_id) values($1,$2)`, child, member)
	exec(`insert into channel_user_overrides(channel_id,user_id,granted_actions) values($1,$2,array['channel.view','message.write'])`, child, member)
	check(member, false)
	exec(`insert into channel_members(channel_id,user_id) values($1,$2)`, parent, member)
	check(member, true)
	exec(`insert into channel_user_overrides(channel_id,user_id,denied_actions) values($1,$2,array['channel.view'])`, parent, member)
	check(member, false)
	exec(`delete from channel_user_overrides where channel_id=$1`, parent)
	exec(`update channels set is_private=false where id=$1`, parent)
	check(member, true)
	// Public parents can still be denied; existing child grants cannot undo it.
	exec(`insert into channel_user_overrides(channel_id,user_id,denied_actions) values($1,$2,array['channel.view'])`, parent, member)
	check(member, false)
}
