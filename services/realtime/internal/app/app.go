package app

import (
	"net/http"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/realtime/internal/deps"
	"github.com/NotReptile/Cirvo/services/realtime/internal/modules/presence"
	"github.com/NotReptile/Cirvo/services/realtime/internal/modules/signaling"
	"github.com/NotReptile/Cirvo/services/realtime/internal/modules/transport"
	"github.com/NotReptile/Cirvo/services/realtime/internal/modules/typing"
)

type Module interface {
	RegisterRoutes(mux *http.ServeMux)
}

type Server struct {
	serviceName string
	version     string
	deps        deps.Container
	mux         *http.ServeMux
}

func NewServer(serviceName, version string, container deps.Container) *Server {
	mux := http.NewServeMux()
	server := &Server{
		serviceName: serviceName,
		version:     version,
		deps:        container,
		mux:         mux,
	}

	mux.Handle("/healthz", sharedhttp.HealthHandler(serviceName, version))
	signalingModule := signaling.NewModule(container.Logger, container.DB, container.Hub)
	typingModule := typing.NewModule(container.Logger, container.DB, container.Hub)
	server.registerModules(
		transport.NewModule(container.Logger, container.DB, container.JWT, container.Hub, container.Journal, container.Tickets, signalingModule, typingModule),
		presence.NewModule(container.Hub),
		signalingModule,
		typingModule,
	)
	return server
}

func (s *Server) Handler() http.Handler {
	h := sharedhttp.WithRequestID(s.mux)
	h = sharedhttp.AccessLog(s.deps.Logger, h)
	h = sharedhttp.Recover(s.deps.Logger, h)
	if cors := s.deps.CORS; cors != nil {
		h = cors(h)
	}
	return h
}

func (s *Server) registerModules(modules ...Module) {
	for _, module := range modules {
		module.RegisterRoutes(s.mux)
	}
}
