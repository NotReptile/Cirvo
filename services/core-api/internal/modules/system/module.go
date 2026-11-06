package system

import (
	"net/http"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/objectstore"
	"github.com/NotReptile/Cirvo/services/core-api/internal/routing"
)

type Module struct {
	store *objectstore.Lazy
}

func NewModule(store *objectstore.Lazy) *Module {
	return &Module{store: store}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Public("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		// status остаётся "ready" (по нему клиент узнаёт сервер). Состояние
		// хранилища файлов отдельным полем: ready, unavailable, not_configured.
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{
			"module":  "system",
			"status":  "ready",
			"storage": m.store.Status(),
		})
	})
}
