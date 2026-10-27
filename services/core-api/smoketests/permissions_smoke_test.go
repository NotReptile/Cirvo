//go:build smoke

package smoketests

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"
)

func testPermissionCapabilities(t *testing.T) {
	owner, member := registerFresh(t), registerFresh(t)
	wsID := createWorkspace(t, owner.AccessToken)
	chID := createTextChannel(t, owner.AccessToken, wsID)
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
	mustJSON(t, request(http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", owner.AccessToken, map[string]any{"maxUses": 2}, 201), &invite)
	request(http.MethodPost, "/api/v1/invites/"+invite.Code+"/accept", member.AccessToken, nil, 200)
	actions := func(path string) []string {
		var result struct {
			Actions []string `json:"actions"`
		}
		mustJSON(t, request(http.MethodGet, path, member.AccessToken, nil, 200), &result)
		return result.Actions
	}
	channelPath := "/api/v1/channels/" + chID
	workspacePath := "/api/v1/workspaces/" + wsID
	assertBatchVisibility := func(want bool) {
		t.Helper()
		channelID, memberID, ownerID := uuid.MustParse(chID), uuid.MustParse(member.User.ID), uuid.MustParse(owner.User.ID)
		outsiderID := uuid.New()
		visible, err := channelacl.VisibleChannels(context.Background(), dbPool, []uuid.UUID{channelID}, []uuid.UUID{memberID, ownerID, outsiderID})
		if err != nil {
			t.Fatal(err)
		}
		if visible[memberID][channelID] != want || !visible[ownerID][channelID] || visible[outsiderID][channelID] {
			t.Fatalf("batch visibility mismatch: %#v", visible)
		}
		empty, err := channelacl.VisibleMembers(context.Background(), dbPool, channelID, nil)
		if err != nil || len(empty) != 0 {
			t.Fatalf("nil recipients must mean none: %#v %v", empty, err)
		}
	}
	assertBatchVisibility(true)
	if !slices.Contains(actions(channelPath+"/capabilities"), "message.write") {
		t.Fatal("member write capability missing")
	}
	var countBefore int
	if err := dbPool.QueryRow(context.Background(), `select count(*) from realtime_events where workspace_id = $1 and event_type = 'permissions.updated'`, wsID).Scan(&countBefore); err != nil {
		t.Fatal(err)
	}
	request(http.MethodPut, channelPath+"/permissions", owner.AccessToken,
		map[string]any{"overrides": []map[string]any{{"roleCode": "member", "granted": []string{}, "denied": []string{"message.write"}}}}, 200)
	if slices.Contains(actions(channelPath+"/capabilities"), "message.write") {
		t.Fatal("denied write still advertised")
	}
	request(http.MethodPost, channelPath+"/messages", member.AccessToken, map[string]any{"body": "blocked by write override"}, 403)
	var role struct {
		ID string `json:"id"`
	}
	mustJSON(t, request(http.MethodPost, workspacePath+"/roles", owner.AccessToken,
		map[string]any{"code": "capability-test", "name": "Capability", "baseActionMask": []string{"workspace.update"}}, 201), &role)
	rolePath := workspacePath + "/roles/" + role.ID
	request(http.MethodPost, rolePath+"/members/"+member.User.ID, owner.AccessToken, nil, 204)
	if !slices.Contains(actions(workspacePath+"/capabilities"), "workspace.update") {
		t.Fatal("custom role union missing")
	}
	request(http.MethodPatch, rolePath, owner.AccessToken, map[string]any{"baseActionMask": []string{}}, 200)
	if slices.Contains(actions(workspacePath+"/capabilities"), "workspace.update") {
		t.Fatal("removed role capability remains")
	}
	request(http.MethodDelete, rolePath+"/members/"+member.User.ID, owner.AccessToken, nil, 204)
	request(http.MethodDelete, rolePath, owner.AccessToken, nil, 204)
	// Public view denial must affect list, direct read and capabilities alike.
	request(http.MethodPut, channelPath+"/permissions", owner.AccessToken,
		map[string]any{"overrides": []map[string]any{{"roleCode": "member", "granted": []string{}, "denied": []string{"channel.view"}}}}, 200)
	request(http.MethodGet, channelPath, member.AccessToken, nil, 404)
	request(http.MethodGet, channelPath+"/messages", member.AccessToken, nil, 404)
	request(http.MethodGet, channelPath+"/capabilities", member.AccessToken, nil, 404)
	assertBatchVisibility(false)
	var list struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	mustJSON(t, request(http.MethodGet, workspacePath+"/channels", member.AccessToken, nil, 200), &list)
	for _, item := range list.Items {
		if item.ID == chID {
			t.Fatal("denied public channel still listed")
		}
	}
	request(http.MethodPut, channelPath+"/user-permissions", owner.AccessToken,
		map[string]any{"overrides": []map[string]any{{"userId": member.User.ID, "granted": []string{"channel.view"}, "denied": []string{}}}}, 200)
	request(http.MethodGet, channelPath, member.AccessToken, nil, 200)
	assertBatchVisibility(true)
	// Private channels inherit category grants and highest-priority user denies.
	var category struct {
		ID string `json:"id"`
	}
	mustJSON(t, request(http.MethodPost, workspacePath+"/categories", owner.AccessToken, map[string]any{"name": "Capabilities"}, 201), &category)
	request(http.MethodPatch, channelPath, owner.AccessToken, map[string]any{"isPrivate": true, "categoryId": category.ID}, 200)
	request(http.MethodPut, channelPath+"/permissions", owner.AccessToken, map[string]any{"overrides": []any{}}, 200)
	request(http.MethodPut, channelPath+"/user-permissions", owner.AccessToken, map[string]any{"overrides": []any{}}, 200)
	request(http.MethodGet, channelPath, member.AccessToken, nil, 404)
	assertBatchVisibility(false)
	request(http.MethodPut, "/api/v1/categories/"+category.ID+"/permissions", owner.AccessToken,
		map[string]any{"overrides": []map[string]any{{"roleCode": "member", "granted": []string{"channel.view"}, "denied": []string{}}}}, 200)
	request(http.MethodGet, channelPath, member.AccessToken, nil, 200)
	assertBatchVisibility(true)
	mustJSON(t, request(http.MethodGet, workspacePath+"/channels", member.AccessToken, nil, 200), &list)
	found := false
	for _, item := range list.Items {
		found = found || item.ID == chID
	}
	if !found {
		t.Fatal("category-granted private channel missing")
	}
	request(http.MethodPut, channelPath+"/user-permissions", owner.AccessToken,
		map[string]any{"overrides": []map[string]any{{"userId": member.User.ID, "granted": []string{}, "denied": []string{"channel.view"}}}}, 200)
	request(http.MethodGet, channelPath, member.AccessToken, nil, 404)
	assertBatchVisibility(false)
	var countAfter int
	if err := dbPool.QueryRow(context.Background(), `select count(*) from realtime_events where workspace_id = $1 and event_type = 'permissions.updated'`, wsID).Scan(&countAfter); err != nil {
		t.Fatal(err)
	}
	if countAfter-countBefore < 13 {
		t.Fatalf("permission changes missing journal invalidations: got %d", countAfter-countBefore)
	}
}
