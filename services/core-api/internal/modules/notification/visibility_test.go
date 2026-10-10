package notification

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestNotificationChannelRequiresValidScopeForContent(t *testing.T) {
	id := uuid.NewString()
	for _, tc := range []struct {
		name, kind, payload string
		scoped, valid       bool
	}{
		{"mention", KindMention, `{"channelId":"` + id + `"}`, true, true},
		{"missing mention", KindMention, `{}`, true, false},
		{"missing reply", KindReply, `{}`, true, false},
		{"missing everyone", KindMentionEveryone, `{}`, true, false},
		{"nonchannel call", KindCallIncoming, `{}`, false, true},
		{"invalid channel", KindCallIncoming, `{"channelId":"invalid"}`, true, false},
		{"zero channel", KindMention, `{"channelId":"00000000-0000-0000-0000-000000000000"}`, true, false},
		{"wrong type", KindMention, `{"channelId":42}`, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, scoped, valid := notificationChannel(tc.kind, json.RawMessage(tc.payload))
			if scoped != tc.scoped || valid != tc.valid {
				t.Fatalf("scope/valid %v/%v, want %v/%v", scoped, valid, tc.scoped, tc.valid)
			}
		})
	}
}
