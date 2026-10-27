package presence

import (
	"net/http"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/realtime/internal/hub"
)

type Module struct {
	hub *hub.Hub
}

func NewModule(h *hub.Hub) *Module {
	return &Module{hub: h}
}

func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/presence/stats", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{
			"module":      "presence",
			"connections": m.hub.Count(),
		})
	})
}
