//go:build smoke

package smoketests

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestMessageHistoryWindows(t *testing.T) {
	owner := registerFresh(t)
	workspaceID := createWorkspace(t, owner.AccessToken)
	channelID := createTextChannel(t, owner.AccessToken, workspaceID)
	stamp := time.Now().UTC().Truncate(time.Microsecond).Add(time.Minute)
	ids := make([]string, 25)
	for i := range ids {
		ids[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		// Keep IDs unique across repeated runs while preserving lexical order in a channel.
		ids[i] = channelID[:24] + fmt.Sprintf("%012d", i+1)
		_, err := dbPool.Exec(context.Background(), "insert into messages(id,channel_id,author_user_id,body,created_at) values($1,$2,$3,$4,$5)", ids[i], channelID, owner.User.ID, fmt.Sprintf("history %d", i), stamp)
		if err != nil {
			t.Fatal(err)
		}
	}
	type pageView struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		NextCursor string `json:"nextCursor"`
	}
	read := func(query string) pageView {
		t.Helper()
		code, raw := doReq(t, http.MethodGet, "/api/v1/channels/"+channelID+"/messages?"+query, owner.AccessToken, nil)
		if code != 200 {
			t.Fatalf("list: %d %s", code, raw)
		}
		var page pageView
		mustJSON(t, raw, &page)
		return page
	}
	first := read("limit=5")
	if len(first.Items) != 5 || first.Items[0].ID != ids[24] || first.Items[4].ID != ids[20] {
		t.Fatalf("latest page: %+v", first)
	}
	second := read("limit=5&before=" + url.QueryEscape(first.NextCursor))
	if len(second.Items) != 5 || second.Items[0].ID != ids[19] || second.Items[4].ID != ids[15] {
		t.Fatalf("tied timestamps skipped: %+v", second)
	}
	around := read("limit=7&around=" + ids[12])
	if len(around.Items) != 7 || around.Items[0].ID != ids[15] || around.Items[6].ID != ids[9] {
		t.Fatalf("around: %+v", around)
	}
	newer := read("limit=5&after=" + url.QueryEscape(stamp.Format(time.RFC3339Nano)+"|"+ids[12]))
	if len(newer.Items) != 5 || newer.Items[0].ID != ids[17] || newer.Items[4].ID != ids[13] {
		t.Fatalf("after: %+v", newer)
	}
	otherChannel := createTextChannel(t, owner.AccessToken, workspaceID)
	code, _ := doReq(t, http.MethodGet, "/api/v1/channels/"+otherChannel+"/messages?around="+ids[12], owner.AccessToken, nil)
	if code != 404 {
		t.Fatalf("cross-channel anchor visible: %d", code)
	}
	outsider := registerFresh(t)
	code, _ = doReq(t, http.MethodGet, "/api/v1/channels/"+channelID+"/messages?around="+ids[12], outsider.AccessToken, nil)
	if code != 404 {
		t.Fatalf("outsider can load history: %d", code)
	}
	for _, query := range []string{"around=bad", "around=" + ids[12] + "&before=bad", "after=bad"} {
		code, _ = doReq(t, http.MethodGet, "/api/v1/channels/"+channelID+"/messages?"+query, owner.AccessToken, nil)
		if code != 400 {
			t.Fatalf("accepted cursor %s: %d", query, code)
		}
	}
}
