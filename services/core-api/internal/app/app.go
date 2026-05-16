package app

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/deps"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/auth"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/message"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/system"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

type Module interface {
	RegisterRoutes(router routing.Router)
}

type Server struct {
	serviceName string
	version     string
	deps        deps.Container
	mux         *http.ServeMux
	router      *Router
}

func NewServer(serviceName, version string, container deps.Container) *Server {
	mux := http.NewServeMux()
	authenticator := NewAuthenticator(container.DB, container.JWT)
	router := NewRouter(mux, authenticator)

	server := &Server{
		serviceName: serviceName,
		version:     version,
		deps:        container,
		mux:         mux,
		router:      router,
	}

	server.registerBaseRoutes()
	server.registerModules(
		auth.NewModule(container.DB, container.JWT),
		workspace.NewModule(container.DB),
		channel.NewModule(container.DB),
		message.NewModule(container.DB, container.Publisher),
		system.NewModule(),
	)

	return server
}

func (s *Server) Handler() http.Handler {
	h := sharedhttp.WithRequestID(s.mux)
	h = sharedhttp.AccessLog(s.deps.Logger, h)
	h = sharedhttp.Recover(s.deps.Logger, h)
	return h
}

func (s *Server) registerBaseRoutes() {
	s.mux.Handle("/healthz", sharedhttp.HealthHandler(s.serviceName, s.version))
}

func (s *Server) registerModules(modules ...Module) {
	for _, module := range modules {
		module.RegisterRoutes(s.router)
	}
}
