package app

import "testing"

func TestAllowedWhilePasswordChangePending(t *testing.T) {
	allowed := []string{
		"POST /api/v1/users/me/password",
		"GET /api/v1/users/me",
		"POST /api/v1/auth/logout",
	}
	for _, p := range allowed {
		if !allowedWhilePasswordChangePending(p) {
			t.Errorf("%q должен быть доступен до смены пароля", p)
		}
	}
	denied := []string{
		"",
		"GET /api/v1/workspaces",
		"POST /api/v1/channels/{channelId}/messages",
		"PATCH /api/v1/users/me",
		"GET /api/v1/users/me/sessions",
		"POST /api/v1/auth/logout-all",
		"POST /api/v1/realtime/ticket",
	}
	for _, p := range denied {
		if allowedWhilePasswordChangePending(p) {
			t.Errorf("%q не должен быть доступен до смены пароля", p)
		}
	}
}
