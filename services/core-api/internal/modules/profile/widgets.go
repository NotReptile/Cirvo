// widgets.go — Wave 7 (I.13). Виджеты профиля: ссылки под bio в карточке.
//
// GET /users/{userId}/widgets — публично для любого авторизованного
// (виджеты — такая же открытая часть профиля, как bio/баннер).
// PUT /users/me/widgets — полная замена списка (позиции = индексы массива;
// drag/перестановка на клиенте = просто другой порядок в body).
package profile

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/auditlog"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
)

const (
	maxWidgetsPerUser = 8
	maxWidgetLabel    = 48
	maxWidgetURL      = 300
)

type widgetPayload struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type widgetView struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	URL      string `json:"url"`
	Position int    `json:"position"`
}

type updateWidgetsRequest struct {
	Widgets []struct {
		Kind  string `json:"kind"`
		Label string `json:"label"`
		URL   string `json:"url"`
	} `json:"widgets"`
}

func (m *Module) handleListWidgets(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseUUID(r, "userId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid user id")
		return
	}
	rows, err := m.db.Query(r.Context(),
		`select id, kind, payload, position
		 from user_profile_widgets
		 where user_id = $1
		 order by position, created_at`,
		targetID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()
	items := make([]widgetView, 0)
	for rows.Next() {
		var (
			id      uuid.UUID
			kind    string
			rawJSON []byte
			pos     int
		)
		if err := rows.Scan(&id, &kind, &rawJSON, &pos); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		var p widgetPayload
		_ = json.Unmarshal(rawJSON, &p)
		items = append(items, widgetView{
			ID:       id.String(),
			Kind:     kind,
			Label:    p.Label,
			URL:      p.URL,
			Position: pos,
		})
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (m *Module) handleUpdateWidgets(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	var req updateWidgetsRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	if len(req.Widgets) > maxWidgetsPerUser {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "too many widgets (max 8)")
		return
	}
	type parsedWidget struct {
		kind    string
		payload []byte
	}
	parsed := make([]parsedWidget, 0, len(req.Widgets))
	for _, wgt := range req.Widgets {
		if wgt.Kind != "link" {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "unknown widget kind: "+wgt.Kind)
			return
		}
		label := strings.TrimSpace(wgt.Label)
		rawURL := strings.TrimSpace(wgt.URL)
		if label == "" || len(label) > maxWidgetLabel {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "widget label must be 1-48 chars")
			return
		}
		if len(rawURL) > maxWidgetURL {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "widget url too long")
			return
		}
		// Только http(s) с хостом — javascript:/data: и прочее отсекаем,
		// клиент рендерит url в href.
		u, err := url.Parse(rawURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "widget url must be http(s)")
			return
		}
		raw, _ := json.Marshal(widgetPayload{Label: label, URL: rawURL})
		parsed = append(parsed, parsedWidget{kind: wgt.Kind, payload: raw})
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := tx.Exec(r.Context(),
		`delete from user_profile_widgets where user_id = $1`, userID); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not reset widgets")
		return
	}
	now := time.Now().UTC()
	for i, wgt := range parsed {
		if _, err := tx.Exec(r.Context(),
			`insert into user_profile_widgets (id, user_id, position, kind, payload, created_at)
			 values ($1, $2, $3, $4, $5, $6)`,
			uuid.New(), userID, i, wgt.kind, wgt.payload, now,
		); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not write widget")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	auditlog.Record(r.Context(), m.db, m.logger, auditlog.Entry{
		ActorID:    userID,
		Action:     auditlog.ActionProfileUpdated,
		TargetType: "user",
		TargetID:   userID.String(),
	})

	// Отдаём свежий список — тот же формат, что GET.
	r2 := r.Clone(r.Context())
	r2.SetPathValue("userId", userID.String())
	m.handleListWidgets(w, r2)
}
