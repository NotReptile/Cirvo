package deps

import (
	"log/slog"
	"net/http"

	"github.com/NotReptile/Cirvo/libs/shared-go/jwtauth"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
	"github.com/NotReptile/Cirvo/libs/shared-go/redisstore"
	"github.com/NotReptile/Cirvo/libs/shared-go/wsticket"
	"github.com/NotReptile/Cirvo/services/realtime/internal/eventjournal"
	"github.com/NotReptile/Cirvo/services/realtime/internal/hub"
)

type Container struct {
	Logger     *slog.Logger
	DB         *postgres.Pool
	Redis      *redisstore.Client
	JWT        *jwtauth.Issuer
	Subscriber *realtimebus.Subscriber
	Journal    *eventjournal.Journal
	Tickets    *wsticket.Store
	Hub        *hub.Hub
	CORS       func(http.Handler) http.Handler
}
