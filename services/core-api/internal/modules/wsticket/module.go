package wsticket

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	sharedticket "github.com/NotReptile/RuCord/libs/shared-go/wsticket"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

type Module struct {
	db    *postgres.Pool
	store *sharedticket.Store
}

func NewModule(db *postgres.Pool, store *sharedticket.Store) *Module {
	return &Module{db: db, store: store}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("POST /api/v1/realtime/ticket", m.realtime)
	router.Protected("POST /api/v1/channels/{channelId}/voice/sfu-ticket", m.sfu)
}

func (m *Module) realtime(w http.ResponseWriter, r *http.Request) {
	m.issue(w, r, sharedticket.Claims{
		Purpose: sharedticket.PurposeRealtime, UserID: authctx.MustUserID(r.Context()), SessionID: mustSession(r),
	})
}

func (m *Module) sfu(w http.ResponseWriter, r *http.Request) {
	channelID, err := uuid.Parse(r.PathValue("channelId"))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return
	}
	userID := authctx.MustUserID(r.Context())
	sessionID := mustSession(r)
	var exists bool
	err = m.db.QueryRow(r.Context(), `
		select exists(select 1 from channel_participants
		              where channel_id = $1 and user_id = $2 and session_id = $3)`,
		channelID, userID, sessionID).Scan(&exists)
	if err != nil || !exists {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "join the voice channel first")
		return
	}
	m.issue(w, r, sharedticket.Claims{
		Purpose: sharedticket.PurposeSFU, UserID: userID, SessionID: sessionID, ChannelID: channelID,
	})
}

func (m *Module) issue(w http.ResponseWriter, r *http.Request, claims sharedticket.Claims) {
	if claims.SessionID == uuid.Nil {
		sharedhttp.WriteError(w, r, http.StatusUnauthorized, sharedhttp.CodeAuthenticationFailed, "no session")
		return
	}
	ticket, expires, err := m.store.Issue(r.Context(), claims)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusServiceUnavailable, sharedhttp.CodeInternal, "ticket service unavailable")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{
		"ticket": ticket, "expiresAt": expires.Format(time.RFC3339Nano),
	})
}

func mustSession(r *http.Request) uuid.UUID {
	id, _ := authctx.SessionID(r.Context())
	return id
}
