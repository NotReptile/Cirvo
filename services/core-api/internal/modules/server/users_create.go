package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/passwords"
	"github.com/NotReptile/RuCord/services/core-api/internal/accountrules"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/modules/role"
)

// Длина сгенерированного временного пароля. 16 знаков из алфавита без похожих
// символов: достаточно стойко и удобно переписать с экрана.
const generatedPasswordLength = 16

type publicConfigView struct {
	RegistrationOpen bool `json:"registrationOpen"`
}

// handlePublicConfig отдаёт без авторизации единственное поле: открыта ли
// самостоятельная регистрация.
func (m *Module) handlePublicConfig(w http.ResponseWriter, r *http.Request) {
	open := true
	if m.settings != nil {
		open = m.settings.Get(r.Context()).RegistrationOpen
	}
	sharedhttp.WriteJSON(w, http.StatusOK, publicConfigView{RegistrationOpen: open})
}

type createUserRequest struct {
	Email       string `json:"email"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	// Пустой пароль: сервер генерирует временный и возвращает его один раз.
	Password string `json:"password"`
	// nil: true (смена обязательна). false допустим только с явным паролем.
	MustChangePassword *bool `json:"mustChangePassword,omitempty"`
	// Необязательно: воркспейс, в который добавить нового пользователя
	// участником. Без него пользователь никого и ничего не увидит до инвайта.
	JoinWorkspaceID string `json:"joinWorkspaceId,omitempty"`
}

type createUserResponse struct {
	adminUserView
	MustChangePassword bool `json:"mustChangePassword"`
	// Только если пароль сгенерирован сервером. Повторно получить его нельзя.
	TemporaryPassword string `json:"temporaryPassword,omitempty"`
}

// handleCreateUser: POST /api/v1/server/users. Только root. Создаёт аккаунт
// без самостоятельной регистрации (нужно при закрытом наборе). Новый
// пользователь не root и по умолчанию обязан сменить пароль при первом входе.
func (m *Module) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	actorID, ok := m.requireRoot(w, r)
	if !ok {
		return
	}

	var req createUserRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Email = accountrules.NormalizeEmail(req.Email)
	req.Username = accountrules.NormalizeUsername(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if err := accountrules.ValidateEmail(req.Email); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, err.Error())
		return
	}
	if err := accountrules.ValidateUsername(req.Username); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, err.Error())
		return
	}
	if len(req.DisplayName) > 64 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "displayName too long")
		return
	}

	var workspaceID uuid.UUID
	if raw := strings.TrimSpace(req.JoinWorkspaceID); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid joinWorkspaceId")
			return
		}
		workspaceID = id
	}

	// Лимит числа пользователей действует и на создание из админки.
	if m.settings != nil {
		if snap := m.settings.Get(r.Context()); snap.MaxUsers > 0 {
			var n int
			if err := m.db.QueryRow(r.Context(), `select count(*) from users`).Scan(&n); err == nil && n >= snap.MaxUsers {
				sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "user limit reached on this server")
				return
			}
		}
	}

	password := req.Password
	generated := false
	if password == "" {
		p, err := accountrules.GeneratePassword(generatedPasswordLength)
		if err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "password generation failed")
			return
		}
		password, generated = p, true
	} else if err := accountrules.ValidatePassword(password); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, err.Error())
		return
	}
	// Сгенерированный пароль всегда временный; заданный вручную админ может
	// объявить постоянным (mustChangePassword=false).
	mustChange := true
	if !generated && req.MustChangePassword != nil {
		mustChange = *req.MustChangePassword
	}

	passwordHash, err := passwords.Hash(password)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "password hashing failed")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	userID := uuid.New()
	var createdAt time.Time
	err = tx.QueryRow(r.Context(),
		`insert into users (id, email, username, display_name, password_hash, is_root, must_change_password, created_at, updated_at)
		 values ($1, $2, $3, nullif($4, ''), $5, false, $6, now(), now())
		 returning created_at`,
		userID, req.Email, req.Username, req.DisplayName, passwordHash, mustChange,
	).Scan(&createdAt)
	if err != nil {
		if isUniqueViolation(err) {
			sharedhttp.WriteError(w, r, http.StatusConflict, sharedhttp.CodeConflict, "email or username already taken")
			return
		}
		m.logger.Error("admin create user failed", "error", err)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create user")
		return
	}

	if workspaceID != uuid.Nil {
		var exists bool
		if err := tx.QueryRow(r.Context(), `select exists(select 1 from workspaces where id = $1)`, workspaceID).Scan(&exists); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
			return
		}
		if !exists {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "workspace not found")
			return
		}
		if _, err := tx.Exec(r.Context(),
			`insert into workspace_members (workspace_id, user_id, role_code, joined_at)
			 values ($1, $2, $3, now())`,
			workspaceID, userID, role.CodeMember,
		); err != nil {
			m.logger.Error("admin create user: add member failed", "error", err)
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not add member")
			return
		}
		if err := role.AssignSystemRole(r.Context(), tx, workspaceID, userID, role.CodeMember); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not assign member role")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    actorID,
		Action:     auditlog.ActionUserCreated,
		TargetType: "user",
		TargetID:   userID.String(),
	})
	// Как при вступлении по приглашению: в журнале воркспейса видно, кто и когда добавлен.
	if workspaceID != uuid.Nil {
		auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
			ActorID:     actorID,
			WorkspaceID: workspaceID,
			Action:      auditlog.ActionWorkspaceMemberAdded,
			TargetType:  "user",
			TargetID:    userID.String(),
		})
	}

	resp := createUserResponse{
		adminUserView: adminUserView{
			ID:          userID.String(),
			Email:       req.Email,
			Username:    req.Username,
			DisplayName: req.DisplayName,
			CreatedAt:   createdAt,
		},
		MustChangePassword: mustChange,
	}
	if generated {
		resp.TemporaryPassword = password
	}
	// Ответ содержит временный пароль: кэшировать его нельзя.
	w.Header().Set("Cache-Control", "no-store")
	sharedhttp.WriteJSON(w, http.StatusCreated, resp)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
