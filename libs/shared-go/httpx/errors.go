package httpx

import (
	"net/http"
)

type ErrorEnvelope struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId,omitempty"`
}

func WriteError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	envelope := ErrorEnvelope{
		Error: ErrorBody{
			Code:      code,
			Message:   message,
			RequestID: RequestIDFromContext(r.Context()),
		},
	}
	WriteJSON(w, status, envelope)
}

const (
	CodeValidationFailed     = "validation_failed"
	CodeAuthenticationFailed = "authentication_failed"
	CodeAuthorizationDenied  = "authorization_denied"
	CodeResourceNotFound     = "resource_not_found_or_not_visible"
	CodeConflict             = "conflict"
	CodeRateLimited          = "rate_limited"
	CodeSessionRevoked       = "session_revoked"
	// Пользователю выдан временный пароль: до его смены доступны только смена
	// пароля, GET /users/me и logout (app.Authenticator.Middleware).
	CodePasswordChangeRequired = "password_change_required"
	CodeInternal               = "internal_error"
	// Зависимость (например, объектное хранилище) временно недоступна.
	CodeUnavailable          = "service_unavailable"
	CodeMessageAlreadyExists = "message_already_processed"
)
