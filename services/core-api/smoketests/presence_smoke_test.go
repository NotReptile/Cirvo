//go:build smoke

package smoketests

import (
	"context"
	"encoding/json"
	"testing"
)

func testPresenceStatusConsistency(t *testing.T) {
	owner, peer := registerFresh(t), registerFresh(t)
	ws := createWorkspace(t, owner.AccessToken)
	request := func(method, path, token string, body any, want int) []byte {
		t.Helper()
		code, raw := doReq(t, method, path, token, body)
		if code != want {
			t.Fatalf("%s %s got%d want%d: %s", method, path, code, want, raw)
		}
		return raw
	}
	var invite struct {
		Code string `json:"code"`
	}
	mustJSON(t, request("POST", "/api/v1/workspaces/"+ws+"/invites", owner.AccessToken, map[string]any{"maxUses": 2}, 201), &invite)
	request("POST", "/api/v1/invites/"+invite.Code+"/accept", peer.AccessToken, nil, 200)
	request("POST", "/api/v1/dm", peer.AccessToken, map[string]string{"userId": owner.User.ID}, 201)
	if _, err := dbPool.Exec(context.Background(), `insert into friendships(user_a,user_b,status,requested_by) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'accepted',$1)`, owner.User.ID, peer.User.ID); err != nil {
		t.Fatal(err)
	}
	type status struct{ PresenceMode, CustomStatus, UpdatedAt string }
	put := func(body map[string]any) status {
		var result status
		mustJSON(t, request("PUT", "/api/v1/users/me/status", owner.AccessToken, body, 200), &result)
		return result
	}
	var initial status
	mustJSON(t, request("GET", "/api/v1/users/me", owner.AccessToken, nil, 200), &initial)
	autoIdle := put(map[string]any{"mode": "idle", "customStatus": "away", "expectedMode": initial.PresenceMode, "expectedUpdatedAt": initial.UpdatedAt})
	if autoIdle.PresenceMode != "idle" {
		t.Fatal("fresh automatic idle failed")
	}
	manualIdle := put(map[string]any{"mode": "idle", "customStatus": "manual"})
	count := func() int {
		var n int
		if err := dbPool.QueryRow(context.Background(), `select count(*) from realtime_events where payload->>'userId' = $1 and event_type like 'presence.%'`, owner.User.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	restored := put(map[string]any{"mode": "online", "customStatus": "away", "expectedMode": "idle", "expectedUpdatedAt": autoIdle.UpdatedAt})
	if restored.PresenceMode != "idle" || restored.CustomStatus != "manual" || restored.UpdatedAt != manualIdle.UpdatedAt || count() != before {
		t.Fatal("stale automatic restore changed manual idle or emitted a false event")
	}
	dnd := put(map[string]any{"mode": "dnd", "customStatus": "busy"})
	denied := put(map[string]any{"mode": "idle", "expectedMode": "online", "expectedUpdatedAt": initial.UpdatedAt})
	if denied.PresenceMode != "dnd" || denied.UpdatedAt != dnd.UpdatedAt {
		t.Fatal("automatic idle overwrote manual DND")
	}
	invisible := put(map[string]any{"mode": "invisible", "customStatus": "self only"})
	if invisible.PresenceMode != "invisible" || invisible.CustomStatus != "self only" {
		t.Fatal("self lost private invisible state")
	}
	var profile status
	mustJSON(t, request("GET", "/api/v1/users/"+owner.User.ID, peer.AccessToken, nil, 200), &profile)
	if profile.PresenceMode != "offline" || profile.CustomStatus != "" {
		t.Fatal("profile disclosed invisible state")
	}
	var members struct {
		Items []struct{ UserID, PresenceMode, CustomStatus string }
	}
	mustJSON(t, request("GET", "/api/v1/workspaces/"+ws+"/members", peer.AccessToken, nil, 200), &members)
	for _, member := range members.Items {
		if member.UserID == owner.User.ID && (member.PresenceMode != "offline" || member.CustomStatus != "") {
			t.Fatal("members disclosed invisible state")
		}
	}
	var dms struct {
		Items []struct {
			Peer struct{ UserID, PresenceMode, CustomStatus string }
		}
	}
	mustJSON(t, request("GET", "/api/v1/dm", peer.AccessToken, nil, 200), &dms)
	for _, dm := range dms.Items {
		if dm.Peer.UserID == owner.User.ID && (dm.Peer.PresenceMode != "offline" || dm.Peer.CustomStatus != "") {
			t.Fatal("DM disclosed invisible state")
		}
	}
	var friends struct {
		Items []struct{ UserID, PresenceMode, CustomStatus string }
	}
	mustJSON(t, request("GET", "/api/v1/friends", peer.AccessToken, nil, 200), &friends)
	for _, friend := range friends.Items {
		if friend.UserID == owner.User.ID && (friend.PresenceMode != "offline" || friend.CustomStatus != "") {
			t.Fatal("friend disclosed invisible state")
		}
	}
	var private []byte
	if err := dbPool.QueryRow(context.Background(), `select payload from realtime_events where event_type = 'presence.self.updated' and user_id = $1 order by seq desc limit 1`, owner.User.ID).Scan(&private); err != nil {
		t.Fatal(err)
	}
	var own struct{ Mode, CustomStatus, SessionID string }
	if err := json.Unmarshal(private, &own); err != nil {
		t.Fatal(err)
	}
	if own.Mode != "invisible" || own.CustomStatus != "self only" || own.SessionID != owner.SessionID {
		t.Fatal("private self event contract wrong")
	}
	var public []byte
	if err := dbPool.QueryRow(context.Background(), `select payload from realtime_events where event_type = 'presence.updated' and user_id = $1 and payload->>'userId' = $2 order by seq desc limit 1`, peer.User.ID, owner.User.ID).Scan(&public); err != nil {
		t.Fatal(err)
	}
	var shared struct{ Mode, CustomStatus string }
	if err := json.Unmarshal(public, &shared); err != nil {
		t.Fatal(err)
	}
	if shared.Mode != "offline" || shared.CustomStatus != "" {
		t.Fatal("public realtime disclosed invisible state")
	}
}
