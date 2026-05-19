package deps

import (
	"log/slog"
	"net/http"

	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/ratelimit"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"

	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

type Container struct {
	Logger      *slog.Logger
	DB          *postgres.Pool
	Redis       *redisstore.Client
	JWT         *jwtauth.Issuer
	Publisher   *realtimebus.Publisher
	ObjectStore *objectstore.Client
	Limiter     *ratelimit.Limiter
	Settings    *serversettings.Provider
	CORS        func(http.Handler) http.Handler
}
