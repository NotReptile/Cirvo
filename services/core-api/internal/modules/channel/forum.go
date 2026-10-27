// Wave 9: форум-каналы. Пост форума = дочерний канал kind='thread'
// (parent_channel_id → форум): сообщения/вложения/reactions/mentions/
// realtime работают через существующую message-инфраструктуру бесплатно —
// клиент открывает пост как обычный канал. Первое сообщение поста клиент
// шлёт обычным POST /channels/{threadId}/messages сразу после создания —
// endpoint здесь заводит только контейнер (title).
//
// Приватные форумы отложены (см. handleCreate) — треды всегда
// is_private=false и наследуют видимость от workspace-membership.
package channel

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/modules/permission"
)

type forumPostView struct {
	// ID — id тред-канала; клиент открывает его как обычный канал.
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	// Автор = автор первого user-сообщения; для свежесозданного поста без
	// сообщений (клиент ещё не успел отправить) поля пустые.
	AuthorID          string `json:"authorId,omitempty"`
	AuthorUsername    string `json:"authorUsername,omitempty"`
	AuthorDisplayName string `json:"authorDisplayName,omitempty"`
	AuthorAvatarID    string `json:"authorAvatarId,omitempty"`
	// Preview — начало первого сообщения (обрезано на сервере).
	Preview        string    `json:"preview,omitempty"`
	MessageCount   int       `json:"messageCount"`
	LastActivityAt time.Time `json:"lastActivityAt"`
}

const forumPreviewLen = 160

type forumPostCreateRequest struct {
	Title string `json:"title"`
}

// resolveForum — общая проверка для обоих хендлеров: канал видим,
// kind='forum', не в архиве.
func (m *Module) resolveForum(w http.ResponseWriter, r *http.Request) (uuid.UUID, Scope, bool) {
	userID := authctx.MustUserID(r.Context())
	channelID, ok := parseUUID(r, "channelId")
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid channel id")
		return uuid.Nil, Scope{}, false
	}
	scope, ok := Resolve(r.Context(), m.db, channelID, userID)
	if !ok {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "channel not visible")
		return uuid.Nil, Scope{}, false
	}
	if scope.Kind != "forum" {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "channel is not a forum")
		return uuid.Nil, Scope{}, false
	}
	return channelID, scope, true
}

func (m *Module) handleForumPostCreate(w http.ResponseWriter, r *http.Request) {
	userID := authctx.MustUserID(r.Context())
	forumID, scope, ok := m.resolveForum(w, r)
	if !ok {
		return
	}
	var archivedAt *time.Time
	if err := m.db.QueryRow(r.Context(),
		`select archived_at from channels where id = $1`, forumID).Scan(&archivedAt); err == nil && archivedAt != nil {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "channel is archived")
		return
	}
	// Право на пост = право писать сообщения в форум (та же семантика, что
	// у message-модуля): роль без message.write не может открывать посты.
	if !permission.CanInChannel(r.Context(), m.db, scope.WorkspaceID, forumID, userID, permission.MessageWrite) {
		sharedhttp.WriteError(w, r, http.StatusForbidden, sharedhttp.CodeAuthorizationDenied, "insufficient role")
		return
	}

	var req forumPostCreateRequest
	if err := sharedhttp.ReadJSON(w, r, &req); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed request body")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len([]rune(req.Title)) > 96 {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "title must be 1-96 chars")
		return
	}

	threadID := uuid.New()
	now := time.Now().UTC()
	_, err := m.db.Exec(r.Context(),
		`insert into channels (id, workspace_id, kind, name, is_private, position, created_at, updated_at, parent_channel_id)
		 values ($1, $2, 'thread', $3, false, 0, $4, $4, $5)`,
		threadID, scope.WorkspaceID, req.Title, now, forumID,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not create post")
		return
	}

	parent := forumID.String()
	view := channelView{
		ID:              threadID.String(),
		WorkspaceID:     scope.WorkspaceID.String(),
		Kind:            "thread",
		Name:            req.Title,
		IsPrivate:       false,
		Position:        0,
		CreatedAt:       now,
		ParentChannelID: &parent,
	}
	// channel.created — существующий клиентский handler добавит тред в
	// state.channels (sidebar его прячет по kind), а открытый форум-вью
	// перечитает список постов.
	m.publish("channel.created", scope.WorkspaceID, threadID.String(), view)
	sharedhttp.WriteJSON(w, http.StatusCreated, view)
}

func (m *Module) handleForumPostList(w http.ResponseWriter, r *http.Request) {
	forumID, _, ok := m.resolveForum(w, r)
	if !ok {
		return
	}
	// Агрегаты по каждому посту: счётчик живых сообщений, последняя
	// активность, автор+превью из первого user-сообщения. LATERAL —
	// чтобы не городить три коррелированных подзапроса в select-списке.
	rows, err := m.db.Query(r.Context(),
		`select c.id, c.name, c.created_at,
		        coalesce(agg.cnt, 0), coalesce(agg.last_at, c.created_at),
		        coalesce(fm.author_user_id::text, ''), coalesce(u.username, ''),
		        coalesce(u.display_name, ''), coalesce(u.avatar_media_id::text, ''),
		        coalesce(left(fm.body, $2), '')
		 from channels c
		 left join lateral (
		   select count(*) cnt, max(m.created_at) last_at
		   from messages m
		   where m.channel_id = c.id and m.deleted_at is null and m.kind = 'user'
		 ) agg on true
		 left join lateral (
		   select m.author_user_id, m.body
		   from messages m
		   where m.channel_id = c.id and m.deleted_at is null and m.kind = 'user'
		   order by m.created_at asc
		   limit 1
		 ) fm on true
		 left join users u on u.id = fm.author_user_id
		 where c.parent_channel_id = $1
		 order by coalesce(agg.last_at, c.created_at) desc`,
		forumID, forumPreviewLen,
	)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer rows.Close()

	items := make([]forumPostView, 0)
	for rows.Next() {
		var v forumPostView
		var id uuid.UUID
		if err := rows.Scan(&id, &v.Title, &v.CreatedAt, &v.MessageCount, &v.LastActivityAt,
			&v.AuthorID, &v.AuthorUsername, &v.AuthorDisplayName, &v.AuthorAvatarID, &v.Preview); err != nil {
			sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "row scan failed")
			return
		}
		v.ID = id.String()
		items = append(items, v)
	}
	sharedhttp.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}
