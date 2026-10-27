package permission

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
)

func PublishChanged(ctx context.Context, publisher *realtimebus.Publisher, workspaceID uuid.UUID) {
	if publisher == nil {
		return
	}
	payload, _ := json.Marshal(map[string]string{"workspaceId": workspaceID.String()})
	_ = publisher.Publish(ctx, realtimebus.Event{Event: "permissions.updated", WorkspaceID: workspaceID.String(), Payload: payload})
}
