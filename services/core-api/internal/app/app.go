package app

import (
	"log/slog"
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/attachment"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/audit"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/auth"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/message"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/permission"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/profile"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/system"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/workspace"
)

type Server struct {
	serviceName string
	version     string
	logger      *slog.Logger
	mux         *http.ServeMux
}

type Module interface {
	RegisterRoutes(mux *http.ServeMux)
}

func NewServer(serviceName string, version string, logger *slog.Logger) *Server {
	server := &Server{
		serviceName: serviceName,
		version:     version,
		logger:      logger,
		mux:         http.NewServeMux(),
	}

	server.registerBaseRoutes()
	server.registerModules(
		auth.NewModule(),
		profile.NewModule(),
		workspace.NewModule(),
		permission.NewModule(),
		channel.NewModule(),
		message.NewModule(),
		attachment.NewModule(),
		audit.NewModule(),
		system.NewModule(),
	)

	return server
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) registerBaseRoutes() {
	s.mux.Handle("/healthz", sharedhttp.HealthHandler(s.serviceName, s.version))
}

func (s *Server) registerModules(modules ...Module) {
	for _, module := range modules {
		module.RegisterRoutes(s.mux)
	}
}
