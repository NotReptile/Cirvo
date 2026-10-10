//go:build smoke

package smoketests

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

func TestMessageSearchUnreadAndMediaEffectiveVisibility(t *testing.T) {
	owner, member := registerFresh(t), registerFresh(t)
	ws := createWorkspace(t, owner.AccessToken)
	visible, hidden := createTextChannel(t, owner.AccessToken, ws), createTextChannel(t, owner.AccessToken, ws)
	request := func(method, path, token string, body any, want int) []byte {
		t.Helper()
		code, raw := doReq(t, method, path, token, body)
		if code != want {
			t.Fatalf("%s %s: got%d want%d: %s", method, path, code, want, raw)
		}
		return raw
	}
	var invite struct{ Code string }
	mustJSON(t, request("POST", "/api/v1/workspaces/"+ws+"/invites", owner.AccessToken, map[string]any{"maxUses": 2}, 201), &invite)
	request("POST", "/api/v1/invites/"+invite.Code+"/accept", member.AccessToken, nil, 200)
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", "acl.txt")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("attachment protected by channel ACL"))
	writer.Close()
	req, _ := http.NewRequest("POST", baseURL+"/api/v1/uploads", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+owner.AccessToken)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("upload %d: %s", response.StatusCode, raw)
	}
	var media idView
	mustJSON(t, raw, &media)
	request("POST", "/api/v1/channels/"+visible+"/messages", owner.AccessToken, map[string]any{"body": "aclsearchtoken visible"}, 201)
	request("POST", "/api/v1/channels/"+hidden+"/messages", owner.AccessToken, map[string]any{"body": "aclsearchtoken secret", "attachmentIds": []string{media.ID}}, 201)
	check := func(token string, allowed bool) {
		t.Helper()
		var search struct {
			Items []struct {
				ChannelID string `json:"channelId"`
			}
		}
		mustJSON(t, request("GET", "/api/v1/workspaces/"+ws+"/search?q=aclsearchtoken&limit=1", token, nil, 200), &search)
		want := visible
		if allowed {
			want = hidden
		}
		if len(search.Items) != 1 || search.Items[0].ChannelID != want {
			t.Fatalf("search visibility/pagination: %+v want %s", search.Items, want)
		}
		var unread struct {
			Items []struct {
				ChannelID   string `json:"channelId"`
				UnreadCount int    `json:"unreadCount"`
			}
		}
		mustJSON(t, request("GET", "/api/v1/workspaces/"+ws+"/unread", token, nil, 200), &unread)
		found := false
		for _, item := range unread.Items {
			if item.ChannelID == hidden {
				found = true
			}
		}
		if found != allowed {
			t.Fatalf("hidden channel unread ID leaked or disappeared: %+v", unread.Items)
		}
		status := 404
		if allowed {
			status = 200
		}
		request("GET", "/api/v1/media/"+media.ID, token, nil, status)
	}
	check(member.AccessToken, true)
	request("PUT", "/api/v1/channels/"+hidden+"/user-permissions", owner.AccessToken, map[string]any{"overrides": []map[string]any{{"userId": member.User.ID, "granted": []string{}, "denied": []string{"channel.view"}}}}, 200)
	check(member.AccessToken, false)
	check(owner.AccessToken, true) // owner and upload-owner exceptions remain valid.
	request("PUT", "/api/v1/channels/"+hidden+"/user-permissions", owner.AccessToken, map[string]any{"overrides": []any{}}, 200)
	check(member.AccessToken, true)
}
