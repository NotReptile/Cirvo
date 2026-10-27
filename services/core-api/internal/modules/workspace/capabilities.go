package workspace

import (
	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/modules/permission"
	"net/http"
)

func (m *Module) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(r, "workspaceId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid workspace id")
		return
	}
	snapshot, err := permission.LoadWorkspace(r.Context(), m.db, id, authctx.MustUserID(r.Context()))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not load capabilities")
		return
	}
	if !snapshot.Member {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not visible")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"workspaceId": id.String(), "actions": snapshot.Actions()})
}
