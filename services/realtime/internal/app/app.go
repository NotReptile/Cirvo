package app

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/realtime/internal/modules/presence"
	"github.com/NotReptile/RuCord/services/realtime/internal/modules/signaling"
	"github.com/NotReptile/RuCord/services/realtime/internal/modules/transport"
)

type Module interface {
	RegisterRoutes(mux *http.ServeMux)
}

type Server struct {
	serviceName string
	version     string
	mux         *http.ServeMux
}

func NewServer(serviceName string, version string) *Server {
	server := &Server{
		serviceName: serviceName,
		version:     version,
		mux:         http.NewServeMux(),
	}

	server.mux.Handle("/healthz", sharedhttp.HealthHandler(serviceName, version))
	server.registerModules(
		transport.NewModule(),
		presence.NewModule(),
		signaling.NewModule(),
	)

	return server
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) registerModules(modules ...Module) {
	for _, module := range modules {
		module.RegisterRoutes(s.mux)
	}
}
