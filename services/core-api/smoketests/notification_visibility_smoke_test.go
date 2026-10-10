//go:build smoke

package smoketests

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func testNotificationVisibility(t *testing.T) {
	owner, member := registerFresh(t), registerFresh(t)
	ws, channel := createWorkspace(t, owner.AccessToken), ""
	channel = createTextChannel(t, owner.AccessToken, ws)
	request := func(method, path, token string, body any, want int) []byte {
		t.Helper()
		code, raw := doReq(t, method, path, token, body)
		if code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, code, want, raw)
		}
		return raw
	}
	var invite struct {
		Code string `json:"code"`
	}
	mustJSON(t, request(http.MethodPost, "/api/v1/workspaces/"+ws+"/invites", owner.AccessToken, map[string]any{"maxUses": 2}, 201), &invite)
	request(http.MethodPost, "/api/v1/invites/"+invite.Code+"/accept", member.AccessToken, nil, 200)
	insert := func(kind string, payload map[string]string) {
		t.Helper()
		raw, _ := json.Marshal(payload)
		if _, err := dbPool.Exec(context.Background(), `insert into user_notifications(id,user_id,kind,payload) values($1,$2,$3,$4)`, uuid.New(), member.User.ID, kind, raw); err != nil {
			t.Fatal(err)
		}
	}
	insert("mention", map[string]string{"channelId": channel, "snippet": "private history"})
	insert("call_incoming", map[string]string{"callId": uuid.NewString()})
	insert("mention", map[string]string{"channelId": "invalid", "snippet": "malformed history"})
	check := func(want int) {
		t.Helper()
		var list struct {
			Items []struct {
				Payload map[string]string `json:"payload"`
			} `json:"items"`
		}
		mustJSON(t, request(http.MethodGet, "/api/v1/notifications", member.AccessToken, nil, 200), &list)
		var count struct {
			Unread int `json:"unread"`
		}
		mustJSON(t, request(http.MethodGet, "/api/v1/notifications/count", member.AccessToken, nil, 200), &count)
		if len(list.Items) != want || count.Unread != want {
			t.Fatalf("visible list/count: %d/%d want %d", len(list.Items), count.Unread, want)
		}
		for _, item := range list.Items {
			if want == 1 && item.Payload["snippet"] != "" {
				t.Fatal("revoked snippet remains in history")
			}
		}
	}
	check(2)
	request(http.MethodPut, "/api/v1/channels/"+channel+"/user-permissions", owner.AccessToken,
		map[string]any{"overrides": []map[string]any{{"userId": member.User.ID, "granted": []string{}, "denied": []string{"channel.view"}}}}, 200)
	check(1)
	var page struct {
		Items []struct {
			Kind string `json:"kind"`
		} `json:"items"`
	}
	mustJSON(t, request(http.MethodGet, "/api/v1/notifications?limit=1", member.AccessToken, nil, 200), &page)
	if len(page.Items) != 1 || page.Items[0].Kind != "call_incoming" {
		t.Fatal("hidden rows consumed the visible page limit")
	}
	request(http.MethodPut, "/api/v1/channels/"+channel+"/user-permissions", owner.AccessToken, map[string]any{"overrides": []any{}}, 200)
	check(2)
	request(http.MethodDelete, "/api/v1/channels/"+channel, owner.AccessToken, nil, 204)
	check(1)
}
