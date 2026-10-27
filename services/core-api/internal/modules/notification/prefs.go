// Wave 4 — персистентные уровни уведомлений (G.9.e / I.8b).
//
// Эффективный уровень: канал ← воркспейс ← 'all'. Хранится только явный
// выбор (PUT с level="" удаляет строку = «наследовать»). Видимость каналов
// здесь не проверяем: знание UUID канала не даёт ничего, кроме записи
// собственного предпочтения, а проверка стоила бы JOIN'а на каждый PUT.
package notification

import (
	"net/http"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
)

const (
	LevelAll      = "all"
	LevelMentions = "mentions"
	LevelNone     = "none"
)

func validLevel(l string) bool {
	return l == LevelAll || l == LevelMentions || l == LevelNone
}

type prefsView struct {
	Channels   map[string]string `json:"channels"`
	Workspaces map[string]string `json:"workspaces"`
}

// handleGetPrefs — все явные предпочтения юзера одним запросом (bootstrap).
func (m *Module) handleGetPrefs(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	out := prefsView{Channels: map[string]string{}, Workspaces: map[string]string{}}

	chRows, err := m.db.Query(r.Context(),
		`select channel_id, level from user_channel_preferences where user_id = $1`, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer chRows.Close()
	for chRows.Next() {
		var id uuid.UUID
		var level string
		if chRows.Scan(&id, &level) == nil {
			out.Channels[id.String()] = level
		}
	}

	wsRows, err := m.db.Query(r.Context(),
		`select workspace_id, level from user_workspace_preferences where user_id = $1`, userID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer wsRows.Close()
	for wsRows.Next() {
		var id uuid.UUID
		var level string
		if wsRows.Scan(&id, &level) == nil {
			out.Workspaces[id.String()] = level
		}
	}
	sharedhttp.WriteJSON(w, http.StatusOK, out)
}

type prefBody struct {
	Level string `json:"level"` // all | mentions | none | "" (наследовать)
}

func (m *Module) handlePutChannelPref(w http.ResponseWriter, r *http.Request) {
	m.putPref(w, r, "channelId",
		`delete from user_channel_preferences where user_id = $1 and channel_id = $2`,
		`insert into user_channel_preferences (user_id, channel_id, level) values ($1, $2, $3)
		 on conflict (user_id, channel_id) do update set level = $3, updated_at = now()`)
}

func (m *Module) handlePutWorkspacePref(w http.ResponseWriter, r *http.Request) {
	m.putPref(w, r, "workspaceId",
		`delete from user_workspace_preferences where user_id = $1 and workspace_id = $2`,
		`insert into user_workspace_preferences (user_id, workspace_id, level) values ($1, $2, $3)
		 on conflict (user_id, workspace_id) do update set level = $3, updated_at = now()`)
}

func (m *Module) putPref(w http.ResponseWriter, r *http.Request, pathKey, deleteSQL, upsertSQL string) {
	userID := authctx.MustUserID(r.Context())
	targetID, err := uuid.Parse(r.PathValue(pathKey))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid id")
		return
	}
	var req prefBody
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if req.Level == "" {
		if _, err := m.db.Exec(r.Context(), deleteSQL, userID, targetID); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reset preference")
			return
		}
		sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"level": ""})
		return
	}
	if !validLevel(req.Level) {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid level")
		return
	}
	if _, err := m.db.Exec(r.Context(), upsertSQL, userID, targetID, req.Level); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not save preference")
		return
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]string{"level": req.Level})
}
