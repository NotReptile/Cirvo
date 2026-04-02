package transport

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
)

type Module struct{}

func NewModule() Module {
	return Module{}
}

func (Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusNotImplemented, map[string]string{
			"module": "transport",
			"status": "websocket-handshake-placeholder",
		})
	})
}
