package channel

import (
	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"net/http"
)

func (m *Module) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	userID := authctx.MustUserID(r.Context())
	scope, snapshot, ok := ResolveSnapshot(r.Context(), m.db, id, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"channelId": id.String(), "workspaceId": scope.WorkspaceID.String(), "actions": snapshot.Actions()})
}
