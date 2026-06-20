package app

import (
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/deps"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/attachment"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/audit"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/auth"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/call"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/category"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/channel"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/dm"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/friend"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/ice"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/invite"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/message"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/notification"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/profile"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/role"
	servermod "github.com/NotReptile/RuCord/services/core-api/internal/modules/server"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/system"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/voice"
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
	messageMod := message.NewModule(container.DB, container.Publisher, container.Settings, container.Logger)
	server.registerModules(
		auth.NewModule(container.DB, container.JWT, container.Limiter, container.Settings, container.Logger),
		call.NewModule(container.DB, container.Publisher, messageMod, container.Logger),
		profile.NewModule(container.DB, container.Publisher, container.Logger),
		workspace.NewModule(container.DB, container.Settings, container.Publisher, container.Logger),
		role.NewModule(container.DB, container.Logger),
		channel.NewModule(container.DB, container.Publisher, container.Settings, messageMod, container.Logger),
		category.NewModule(container.DB, container.Publisher, container.Logger),
		dm.NewModule(container.DB, container.Publisher, container.Logger),
		friend.NewModule(container.DB, container.Publisher, container.Logger),
		messageMod,
		notification.NewModule(container.DB, container.Logger),
		attachment.NewModule(container.DB, container.ObjectStore, container.Limiter, container.Settings, container.Logger),
		invite.NewModule(container.DB, container.Limiter, messageMod, container.Logger),
		voice.NewModule(container.DB, container.Publisher, ice.SFUEnabled(), container.Logger),
		audit.NewModule(container.DB),
		ice.NewModule(),
		servermod.NewModule(container.DB, container.Settings, container.ObjectStore, container.Logger),
		system.NewModule(),
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

func (s *Server) registerBaseRoutes() {
	s.mux.Handle("/healthz", sharedhttp.HealthHandler(s.serviceName, s.version))
}

func (s *Server) registerModules(modules ...Module) {
	for _, module := range modules {
		module.RegisterRoutes(s.router)
	}
}
