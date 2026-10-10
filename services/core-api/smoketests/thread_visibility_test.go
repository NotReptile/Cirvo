//go:build smoke

package smoketests

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestPrivateParentThreadVisibility(t *testing.T) {
	owner, member := registerFresh(t), registerFresh(t)
	ws, parent := createWorkspace(t, owner.AccessToken), ""
	parent = createTextChannel(t, owner.AccessToken, ws)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := dbPool.Exec(context.Background(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into workspace_members(workspace_id,user_id,role_code) values($1,$2,'member')`, ws, member.User.ID)
	exec(`update channels set is_private=true where id=$1`, parent)
	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+parent+"/messages", owner.AccessToken, map[string]any{"body": "private root context", "clientMessageId": uuid.NewString()})
	if code != http.StatusCreated {
		t.Fatalf("root create: %d %s", code, raw)
	}
	var root idView
	mustJSON(t, raw, &root)
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+parent+"/messages/"+root.ID+"/thread", owner.AccessToken, map[string]any{})
	if code != http.StatusCreated {
		t.Fatalf("thread create: %d %s", code, raw)
	}
	var thread idView
	mustJSON(t, raw, &thread)
	check := func(want bool) {
		t.Helper()
		code, raw := doReq(t, http.MethodGet, "/api/v1/channels/"+thread.ID+"/messages", member.AccessToken, nil)
		if (code == http.StatusOK) != want || (!want && code != http.StatusNotFound) {
			t.Fatalf("thread read: %d %s want visible %v", code, raw, want)
		}
		code, raw = doReq(t, http.MethodGet, "/api/v1/workspaces/"+ws+"/channels", member.AccessToken, nil)
		if code != http.StatusOK {
			t.Fatalf("list: %d %s", code, raw)
		}
		var list struct {
			Items []idView `json:"items"`
		}
		mustJSON(t, raw, &list)
		found := false
		for _, item := range list.Items {
			if item.ID == thread.ID {
				found = true
			}
		}
		if found != want {
			t.Fatalf("thread list exposed=%v want=%v", found, want)
		}
		code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+thread.ID+"/messages", member.AccessToken, map[string]any{"body": "child reply", "clientMessageId": uuid.NewString()})
		if (code == http.StatusCreated) != want || (!want && code != http.StatusNotFound) {
			t.Fatalf("thread write: %d %s want visible %v", code, raw, want)
		}
	}
	check(false)
	exec(`insert into channel_user_overrides(channel_id,user_id,granted_actions) values($1,$2,array['channel.view','message.write'])`, thread.ID, member.User.ID)
	check(false)
	exec(`insert into channel_members(channel_id,user_id) values($1,$2)`, parent, member.User.ID)
	check(true)
	exec(`insert into channel_user_overrides(channel_id,user_id,denied_actions) values($1,$2,array['channel.view'])`, parent, member.User.ID)
	check(false)
	// The owner still sees the thread and the private context system message.
	code, raw = doReq(t, http.MethodGet, "/api/v1/channels/"+thread.ID+"/messages", owner.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("owner thread read: %d %s", code, raw)
	}
}
