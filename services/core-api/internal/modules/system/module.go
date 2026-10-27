package system

import (
	"net/http"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/routing"
)

type Module struct{}

func NewModule() *Module {
	return &Module{}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Public("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{
			"module": "system",
			"status": "ready",
		})
	})
}
