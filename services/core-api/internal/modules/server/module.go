// Package server — admin-эндпоинты server-wide настроек (D.1).
//
// Доступ только root-owner'у (users.is_root = true). Не путать с
// workspace-owner: workspace owner управляет только своим воркспейсом,
// root один на инстанс и видит/меняет server_settings.
package server

import (
	"log/slog"
	"net/http"
	"time"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

type Module struct {
	db       *postgres.Pool
	settings *serversettings.Provider
	logger   *slog.Logger
}

func NewModule(db *postgres.Pool, settings *serversettings.Provider, logger *slog.Logger) *Module {
	return &Module{db: db, settings: settings, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/server/settings", m.handleGet)
	router.Protected("PUT /api/v1/server/settings", m.handleUpdate)
}

type settingsView struct {
	MaxUsers                int       `json:"maxUsers"`
	MaxWorkspaces           int       `json:"maxWorkspaces"`
	MaxChannelsPerWorkspace int       `json:"maxChannelsPerWorkspace"`
	MaxMessageBytes         int       `json:"maxMessageBytes"`
	MaxAttachmentBytes      int64     `json:"maxAttachmentBytes"`
	StorageQuotaBytes       int64     `json:"storageQuotaBytes"`
	MessageRetentionDays    int       `json:"messageRetentionDays"`
	RegistrationOpen        bool      `json:"registrationOpen"`
	UpdatedAt               time.Time `json:"updatedAt"`
	UpdatedByUserID         string    `json:"updatedByUserId,omitempty"`
}

func viewFromSnapshot(s serversettings.Snapshot) settingsView {
	v := settingsView{
		MaxUsers:                s.MaxUsers,
		MaxWorkspaces:           s.MaxWorkspaces,
		MaxChannelsPerWorkspace: s.MaxChannelsPerWorkspace,
		MaxMessageBytes:         s.MaxMessageBytes,
		MaxAttachmentBytes:      s.MaxAttachmentBytes,
		StorageQuotaBytes:       s.StorageQuotaBytes,
		MessageRetentionDays:    s.MessageRetentionDays,
		RegistrationOpen:        s.RegistrationOpen,
		UpdatedAt:               s.UpdatedAt,
	}
	if s.UpdatedByUserID != nil {
		v.UpdatedByUserID = s.UpdatedByUserID.String()
	}
	return v
}

// updateRequest — все поля опциональные (PATCH-семантика, но REST PUT
// для конфигурационного singleton'а — оставляем PUT как привычно). Указатели
// чтобы отличить «не передал» (оставить как было) от «передал 0»
// (явно убрал лимит).
type updateRequest struct {
	MaxUsers                *int   `json:"maxUsers,omitempty"`
	MaxWorkspaces           *int   `json:"maxWorkspaces,omitempty"`
	MaxChannelsPerWorkspace *int   `json:"maxChannelsPerWorkspace,omitempty"`
	MaxMessageBytes         *int   `json:"maxMessageBytes,omitempty"`
	MaxAttachmentBytes      *int64 `json:"maxAttachmentBytes,omitempty"`
	StorageQuotaBytes       *int64 `json:"storageQuotaBytes,omitempty"`
	MessageRetentionDays    *int   `json:"messageRetentionDays,omitempty"`
	RegistrationOpen        *bool  `json:"registrationOpen,omitempty"`
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	if !serversettings.IsRoot(r.Context(), m.db, userID) {
		// 404 чтобы не палить факт существования root-only API
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "not found")
		return
	}
	snap := m.settings.Get(r.Context())
	sharedhttp.WriteJSON(w, http.StatusOK, viewFromSnapshot(snap))
}

func (m *Module) handleUpdate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	if !serversettings.IsRoot(r.Context(), m.db, userID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "not found")
		return
	}

	var req updateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}

	// Валидация: отрицательные числа — мусор; max_message_bytes должно
	// быть >= 1 если задан (0 = безлимит, в этом случае защита бэка
	// падает на лимит входящего тела HTTP-сервера; оставляем как есть).
	if req.MaxUsers != nil && *req.MaxUsers < 0 {
		invalid(w, r, "maxUsers must be >= 0")
		return
	}
	if req.MaxWorkspaces != nil && *req.MaxWorkspaces < 0 {
		invalid(w, r, "maxWorkspaces must be >= 0")
		return
	}
	if req.MaxChannelsPerWorkspace != nil && *req.MaxChannelsPerWorkspace < 0 {
		invalid(w, r, "maxChannelsPerWorkspace must be >= 0")
		return
	}
	if req.MaxMessageBytes != nil && *req.MaxMessageBytes < 0 {
		invalid(w, r, "maxMessageBytes must be >= 0")
		return
	}
	if req.MaxAttachmentBytes != nil && *req.MaxAttachmentBytes < 0 {
		invalid(w, r, "maxAttachmentBytes must be >= 0")
		return
	}
	if req.StorageQuotaBytes != nil && *req.StorageQuotaBytes < 0 {
		invalid(w, r, "storageQuotaBytes must be >= 0")
		return
	}
	if req.MessageRetentionDays != nil && *req.MessageRetentionDays < 0 {
		invalid(w, r, "messageRetentionDays must be >= 0")
		return
	}

	now := time.Now().UTC()
	// coalesce-стиль через nullable: если поле nil — оставляем как было.
	// Используем явные параметры с pointer/nil, postgres конвертирует в NULL,
	// дальше через coalesce(NEW, OLD).
	_, err := m.db.Exec(r.Context(),
		`update server_settings set
		   max_users                  = coalesce($1, max_users),
		   max_workspaces             = coalesce($2, max_workspaces),
		   max_channels_per_workspace = coalesce($3, max_channels_per_workspace),
		   max_message_bytes          = coalesce($4, max_message_bytes),
		   max_attachment_bytes       = coalesce($5, max_attachment_bytes),
		   storage_quota_bytes        = coalesce($6, storage_quota_bytes),
		   message_retention_days     = coalesce($7, message_retention_days),
		   registration_open          = coalesce($8, registration_open),
		   updated_at                 = $9,
		   updated_by_user_id         = $10
		 where id = true`,
		req.MaxUsers, req.MaxWorkspaces, req.MaxChannelsPerWorkspace,
		req.MaxMessageBytes, req.MaxAttachmentBytes, req.StorageQuotaBytes,
		req.MessageRetentionDays, req.RegistrationOpen,
		now, userID,
	)
	if err != nil {
		m.logger.Error("server settings update failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	m.settings.Invalidate()
	snap := m.settings.Get(r.Context())
	sharedhttp.WriteJSON(w, http.StatusOK, viewFromSnapshot(snap))
}

func invalid(w http.ResponseWriter, r *http.Request, msg string) {
	sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, msg)
}
