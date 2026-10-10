package realtimebus

import (
	"encoding/json"
	"testing"
)

func TestChannelScope(t *testing.T) {
	for _, test := range []struct {
		name, event, channel, payload, want string
		invalid                             bool
	}{
		{"explicit", "notification.created", "new", `{"payload":{"channelId":"old"}}`, "new", false},
		{"legacy", "notification.created", "", `{"payload":{"channelId":"old"}}`, "old", false},
		{"unscoped call", "notification.created", "", `{"payload":{"callId":"call"}}`, "", false},
		{"invalid", "notification.created", "", `{`, "", true},
		{"missing mention scope", "notification.created", "", `{"kind":"mention","payload":{"snippet":"private"}}`, "", true},
		{"other event", "workspace.updated", "", `{}`, "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := (Envelope{Event: test.event, ChannelID: test.channel, Payload: json.RawMessage(test.payload)}).ChannelScope()
			if got != test.want || (err != nil) != test.invalid {
				t.Fatalf("scope = %q, error = %v", got, err)
			}
		})
	}
}
