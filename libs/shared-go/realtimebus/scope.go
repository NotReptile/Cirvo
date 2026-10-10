package realtimebus

import (
	"encoding/json"
	"errors"
)

// ChannelScope also recovers routing for older notification journal entries,
// which stored channelId only inside the notification payload.
func (e Envelope) ChannelScope() (string, error) {
	if e.ChannelID != "" || e.Event != "notification.created" {
		return e.ChannelID, nil
	}
	var notification struct {
		Kind    string `json:"kind"`
		Payload struct {
			ChannelID string `json:"channelId"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(e.Payload, &notification); err != nil {
		return "", err
	}
	if notification.Payload.ChannelID == "" &&
		(notification.Kind == "mention" || notification.Kind == "reply" || notification.Kind == "mention_everyone") {
		return "", errors.New("channel notification has no channel scope")
	}
	return notification.Payload.ChannelID, nil
}
