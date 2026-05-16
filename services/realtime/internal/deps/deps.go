package deps

import (
	"log/slog"
	"net/http"

	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
	"github.com/NotReptile/RuCord/services/realtime/internal/hub"
)

type Container struct {
	Logger     *slog.Logger
	DB         *postgres.Pool
	Redis      *redisstore.Client
	JWT        *jwtauth.Issuer
	Subscriber *realtimebus.Subscriber
	Hub        *hub.Hub
	CORS       func(http.Handler) http.Handler
}
