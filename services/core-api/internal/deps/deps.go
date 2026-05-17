package deps

import (
	"log/slog"
	"net/http"

	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"
)

type Container struct {
	Logger      *slog.Logger
	DB          *postgres.Pool
	Redis       *redisstore.Client
	JWT         *jwtauth.Issuer
	Publisher   *realtimebus.Publisher
	ObjectStore *objectstore.Client
	CORS        func(http.Handler) http.Handler
}
