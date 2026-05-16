package profile

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const maxDisplayName = 64

type Module struct {
	db     *postgres.Pool
	logger *slog.Logger
}

func NewModule(db *postgres.Pool, logger *slog.Logger) *Module {
	return &Module{db: db, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("PUT /api/v1/users/me", m.handleUpdateMe)
	router.Protected("GET /api/v1/users/{userId}", m.handleGetUser)
}

type updateRequest struct {
	DisplayName *string `json:"displayName"`
}

type profileView struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName,omitempty"`
}

type meView struct {
	profileView
	Email     string    `json:"email"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (m *Module) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req updateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.DisplayName == nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "displayName is required")
		return
	}
	trimmed := strings.TrimSpace(*req.DisplayName)
	if len(trimmed) > maxDisplayName {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "displayName too long")
		return
	}

	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`update users set display_name = nullif($1, ''), updated_at = $2 where id = $3`,
		trimmed, now, userID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not update profile")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    userID,
		Action:     auditlog.ActionProfileUpdated,
		TargetType: "user",
		TargetID:   userID.String(),
	})

	var (
		email    string
		username string
		display  *string
	)
	if err := m.db.QueryRow(r.Context(),
		`select email, username, display_name from users where id = $1`,
		userID,
	).Scan(&email, &username, &display); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reload profile")
		return
	}

	view := meView{
		profileView: profileView{ID: userID.String(), Username: username},
		Email:       email,
		UpdatedAt:   now,
	}
	if display != nil {
		view.DisplayName = *display
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func (m *Module) handleGetUser(w http.ResponseWriter, r *http.Request) {
	_ = authctx.MustUserID(r.Context())
	targetID, ok := parseUUID(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	var (
		username string
		display  *string
	)
	err := m.db.QueryRow(r.Context(),
		`select username, display_name from users where id = $1`,
		targetID,
	).Scan(&username, &display)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "user not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	view := profileView{ID: targetID.String(), Username: username}
	if display != nil {
		view.DisplayName = *display
	}
	sharedhttp.WriteJSON(w, http.StatusOK, view)
}

func parseUUID(r *http.Request, name string) (uuid.UUID, bool) {
	raw := r.PathValue(name)
	if raw == "" {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
