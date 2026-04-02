package audit

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
)

type Module struct{}

func NewModule() Module {
	return Module{}
}

func (Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/audit/events", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{
			"module": "audit",
			"items":  []any{},
		})
	})
}
