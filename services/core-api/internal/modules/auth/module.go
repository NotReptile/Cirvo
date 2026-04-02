package auth

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
)

type Module struct{}

func NewModule() Module {
	return Module{}
}

func (Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/register", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusAccepted, map[string]string{
			"module": "auth",
			"status": "registered-route",
		})
	})

	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		sharedhttp.WriteJSON(w, http.StatusAccepted, map[string]string{
			"module": "auth",
			"status": "login-route",
		})
	})
}
