package message

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
)

type Module struct{}

func NewModule() Module {
	return Module{}
}

func (Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/channels/{channelId}/messages", func(w http.ResponseWriter, r *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{
			"module":    "message",
			"channelId": r.PathValue("channelId"),
			"items":     []any{},
		})
	})

	mux.HandleFunc("POST /api/v1/channels/{channelId}/messages", func(w http.ResponseWriter, r *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusAccepted, map[string]any{
			"module":    "message",
			"channelId": r.PathValue("channelId"),
			"status":    "accepted",
		})
	})
}
