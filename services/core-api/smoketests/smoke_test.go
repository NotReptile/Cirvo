//go:build smoke

// Package smoketests прогоняет критичные пути core-api на живой
// инфраструктуре (Postgres + Redis + MinIO). Тесты исполняются с тегом
// `smoke` — обычный `go test ./...` их не запускает. CI поднимает
// service-контейнеры и зовёт `go test -tags=smoke ./...`.
//
// Гарантии: тесты идемпотентны при работе с непустой БД — каждый создаёт
// уникальные сущности (через uuid). После прогона данные не удаляются —
// CI стартует с чистой БД, локально допустимы повторные запуски.
package smoketests

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/jwtauth"
	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/libs/shared-go/ratelimit"
	"github.com/NotReptile/RuCord/libs/shared-go/realtimebus"
	"github.com/NotReptile/RuCord/libs/shared-go/redisstore"

	"github.com/NotReptile/RuCord/services/core-api/internal/app"
	"github.com/NotReptile/RuCord/services/core-api/internal/deps"
	"github.com/NotReptile/RuCord/services/core-api/internal/serversettings"
)

var (
	baseURL string
	client  = &http.Client{Timeout: 30 * time.Second}
	redisCl *redisstore.Client
	dbPool  *postgres.Pool
)

func TestMain(m *testing.M) {
	code := func() int {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		db, err := postgres.ConnectFromEnv(ctx)
		if err != nil {
			log.Printf("smoke: skip — postgres not reachable: %v", err)
			return 0
		}
		defer db.Close()
		dbPool = db

		redisClient, err := redisstore.ConnectFromEnv(ctx)
		if err != nil {
			log.Printf("smoke: skip — redis not reachable: %v", err)
			return 0
		}
		defer redisClient.Close()
		redisCl = redisClient

		jwt, err := jwtauth.NewIssuerFromEnv("core-api")
		if err != nil {
			log.Printf("smoke: skip — RUCORD_JWT_SECRET not set: %v", err)
			return 0
		}

		objectStore, err := objectstore.ConnectFromEnv(ctx)
		if err != nil {
			log.Printf("smoke: skip — minio not reachable: %v", err)
			return 0
		}

		// Сбрасываем ratelimit-счётчики, чтобы повторные запуски и серии
		// register'ов внутри теста не упирались в auth_register лимит
		// (5/час per-IP). Затрагиваем только rl:* — без вреда для presence
		// и других ключей realtime-шины.
		if keys, err := redisClient.Keys(ctx, "rl:*").Result(); err == nil && len(keys) > 0 {
			_ = redisClient.Del(ctx, keys...).Err()
		}

		logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
		container := deps.Container{
			Logger:      logger,
			DB:          db,
			Redis:       redisClient,
			JWT:         jwt,
			Publisher:   realtimebus.NewPublisher(redisClient, db),
			ObjectStore: objectStore,
			Limiter:     ratelimit.New(redisClient.Client),
			Settings:    serversettings.NewProvider(db),
			CORS:        sharedhttp.CORS([]string{"http://localhost"}),
		}
		server := app.NewServer("core-api", "smoke", container)
		ts := httptest.NewServer(server.Handler())
		defer ts.Close()
		baseURL = ts.URL

		return m.Run()
	}()
	os.Exit(code)
}

// ---- helpers -----------------------------------------------------------------

type tokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	SessionID    string `json:"sessionId"`
	User         struct {
		ID       string `json:"id"`
		Email    string `json:"email"`
		Username string `json:"username"`
	} `json:"user"`
}

func uniqSuffix() string {
	// 8 hex символов из uuid — короткий идентификатор для генерации
	// уникальных email/username/slug.
	return strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
}

func doReq(t *testing.T, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rd = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, baseURL+path, rd)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

func mustJSON(t *testing.T, raw []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatalf("unmarshal: %v — body=%s", err, string(raw))
	}
}

// resetAuthLimits снимает лимит auth_register для текущего IP. Тесты
// делают много регистраций за секунды, штатные 5/час не подходят.
func resetAuthLimits(t *testing.T) {
	t.Helper()
	if redisCl == nil {
		return
	}
	ctx := context.Background()
	keys, err := redisCl.Keys(ctx, "rl:auth_*:*").Result()
	if err != nil || len(keys) == 0 {
		return
	}
	_ = redisCl.Del(ctx, keys...).Err()
}

func registerFresh(t *testing.T) tokens {
	t.Helper()
	resetAuthLimits(t)
	suffix := uniqSuffix()
	body := map[string]any{
		"email":       "smoke-" + suffix + "@example.test",
		"username":    "smoke_" + suffix,
		"password":    "smoke-password-12345",
		"displayName": "Smoke " + suffix,
	}
	code, raw := doReq(t, http.MethodPost, "/api/v1/auth/register", "", body)
	if code != http.StatusCreated {
		t.Fatalf("register: status %d, body %s", code, string(raw))
	}
	var tk tokens
	mustJSON(t, raw, &tk)
	if tk.AccessToken == "" || tk.RefreshToken == "" {
		t.Fatalf("register: empty tokens — %s", string(raw))
	}
	return tk
}

// ---- subtests ----------------------------------------------------------------

func TestSmoke(t *testing.T) {
	t.Run("auth_flow", testAuthFlow)
	t.Run("message_crud", testMessageCRUD)
	t.Run("permission_deny", testPermissionDeny)
	t.Run("attachment_upload", testAttachmentUpload)
	t.Run("voice_channel", testVoiceChannel)
	t.Run("call_lifecycle", testCallLifecycle)
	t.Run("message_reply", testMessageReply)
	t.Run("message_thread", testMessageThread)
	t.Run("message_mentions", testMessageMentions)
	t.Run("unread_counts", testUnreadCounts)
	t.Run("message_search", testMessageSearch)
	t.Run("notifications", testNotifications)
	t.Run("server_settings", testServerSettings)
	t.Run("admin_panel", testAdminPanel)
	t.Run("retention_sweep", testRetentionSweep)
	t.Run("channel_overrides", testChannelOverrides)
}

// drainNotificationJobs прогоняет все pending-задачи из notification_jobs
// (мини-копия worker'а — см. services/worker/internal/jobs/notifications.go).
// В smoke-тестах настоящий воркер не крутится; нам нужно убедиться, что
// core-api enqueue'ит правильно и что выходные user_notifications
// корректно достижимы через API.
func drainNotificationJobs(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var (
			jobID   string
			kind    string
			payload []byte
		)
		err := dbPool.QueryRow(ctx, `
			update notification_jobs
			set status = 'done', started_at = now(), finished_at = now(),
			    attempts = attempts + 1
			where id = (
			  select id from notification_jobs
			  where status = 'pending' and scheduled_at <= now()
			  order by scheduled_at
			  for update skip locked
			  limit 1
			)
			returning id, kind, payload
		`).Scan(&jobID, &kind, &payload)
		if err != nil {
			// нет больше задач
			return
		}
		var p struct {
			Recipients  []string `json:"recipients"`
			ActorID     string   `json:"actorId"`
			WorkspaceID string   `json:"workspaceId"`
			ChannelID   string   `json:"channelId"`
			MessageID   string   `json:"messageId"`
			CallID      string   `json:"callId"`
			Snippet     string   `json:"snippet"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			t.Fatalf("drain: decode payload: %v", err)
		}
		for _, recipient := range p.Recipients {
			row := map[string]any{
				"actorId":     p.ActorID,
				"workspaceId": p.WorkspaceID,
				"channelId":   p.ChannelID,
				"messageId":   p.MessageID,
				"callId":      p.CallID,
				"snippet":     p.Snippet,
			}
			rowJSON, _ := json.Marshal(row)
			if _, err := dbPool.Exec(ctx,
				`insert into user_notifications (user_id, kind, payload) values ($1, $2, $3)`,
				recipient, kind, rowJSON,
			); err != nil {
				t.Fatalf("drain: insert notification: %v", err)
			}
		}
	}
}

func testNotifications(t *testing.T) {
	// A создаёт ws + канал, B принимает инвайт.
	a := registerFresh(t)
	wsID := createWorkspace(t, a.AccessToken)
	chID := createTextChannel(t, a.AccessToken, wsID)

	b := registerFresh(t)
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", a.AccessToken, map[string]any{"maxUses": 10})
	if code != http.StatusCreated {
		t.Fatalf("invite: %d %s", code, string(raw))
	}
	var inv struct {
		Code string `json:"code"`
	}
	mustJSON(t, raw, &inv)
	code, raw = doReq(t, http.MethodPost, "/api/v1/invites/"+inv.Code+"/accept", b.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("accept: %d %s", code, string(raw))
	}

	// (1) mention: A пишет @B → у B mention-нотификация.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", a.AccessToken, map[string]any{
		"body":            "@" + b.User.Username + " глянь",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("post mention: %d %s", code, string(raw))
	}
	var mentionMsg struct {
		ID string `json:"id"`
	}
	mustJSON(t, raw, &mentionMsg)

	// (2) B пишет своё сообщение, A на него отвечает → reply-нотификация для B.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", b.AccessToken, map[string]any{
		"body":            "первое сообщение B",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("B post: %d %s", code, string(raw))
	}
	var bMsg struct {
		ID string `json:"id"`
	}
	mustJSON(t, raw, &bMsg)
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", a.AccessToken, map[string]any{
		"body":             "ответ A",
		"clientMessageId":  uuid.NewString(),
		"replyToMessageId": bMsg.ID,
	})
	if code != http.StatusCreated {
		t.Fatalf("A reply: %d %s", code, string(raw))
	}

	// (3) A звонит B (1-к-1) → call_incoming-нотификация для B.
	code, raw = doReq(t, http.MethodPost, "/api/v1/calls", a.AccessToken, map[string]any{
		"kind":       "one_to_one",
		"peerUserId": b.User.ID,
	})
	if code != http.StatusCreated {
		t.Fatalf("call start: %d %s", code, string(raw))
	}

	// Эмулируем worker.
	drainNotificationJobs(t)

	// /count и /list у B — должно быть 3 непрочитанных (mention, reply, call).
	code, raw = doReq(t, http.MethodGet, "/api/v1/notifications/count", b.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("count: %d %s", code, string(raw))
	}
	var cnt struct {
		Unread int `json:"unread"`
	}
	mustJSON(t, raw, &cnt)
	if cnt.Unread != 3 {
		t.Fatalf("expected unread=3, got %d", cnt.Unread)
	}

	code, raw = doReq(t, http.MethodGet, "/api/v1/notifications", b.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("list: %d %s", code, string(raw))
	}
	var list struct {
		Items []struct {
			ID      string  `json:"id"`
			Kind    string  `json:"kind"`
			ReadAt  *string `json:"readAt"`
			Payload struct {
				ActorID   string `json:"actorId"`
				ChannelID string `json:"channelId"`
				MessageID string `json:"messageId"`
				CallID    string `json:"callId"`
				Snippet   string `json:"snippet"`
			} `json:"payload"`
		} `json:"items"`
	}
	mustJSON(t, raw, &list)
	if len(list.Items) != 3 {
		t.Fatalf("expected 3 notifications, got %d", len(list.Items))
	}
	kinds := map[string]bool{}
	for _, it := range list.Items {
		kinds[it.Kind] = true
		if it.Payload.ActorID != a.User.ID {
			t.Fatalf("actorId mismatch: want %s, got %s", a.User.ID, it.Payload.ActorID)
		}
		if it.ReadAt != nil {
			t.Fatalf("notification should be unread initially")
		}
	}
	for _, k := range []string{"mention", "reply", "call_incoming"} {
		if !kinds[k] {
			t.Fatalf("missing notification kind=%s", k)
		}
	}

	// (4) Mark one read → count уменьшается.
	target := list.Items[0]
	code, raw = doReq(t, http.MethodPost, "/api/v1/notifications/"+target.ID+"/read", b.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("mark read: %d %s", code, string(raw))
	}
	code, raw = doReq(t, http.MethodGet, "/api/v1/notifications/count", b.AccessToken, nil)
	mustJSON(t, raw, &cnt)
	if cnt.Unread != 2 {
		t.Fatalf("after single read: expected 2, got %d", cnt.Unread)
	}

	// (5) Mark all read → 0.
	code, raw = doReq(t, http.MethodPost, "/api/v1/notifications/read", b.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("mark all: %d %s", code, string(raw))
	}
	code, raw = doReq(t, http.MethodGet, "/api/v1/notifications/count", b.AccessToken, nil)
	mustJSON(t, raw, &cnt)
	if cnt.Unread != 0 {
		t.Fatalf("after mark all: expected 0, got %d", cnt.Unread)
	}

	// (6) Чужой не видит уведомления B (404 на mark-read чужого id).
	stranger := registerFresh(t)
	code, raw = doReq(t, http.MethodPost, "/api/v1/notifications/"+target.ID+"/read", stranger.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("stranger mark read: expected 404, got %d %s", code, string(raw))
	}

	// (7) A не получает уведомлений от собственных действий.
	code, raw = doReq(t, http.MethodGet, "/api/v1/notifications/count", a.AccessToken, nil)
	mustJSON(t, raw, &cnt)
	if cnt.Unread != 0 {
		t.Fatalf("A self-notifications: expected 0, got %d", cnt.Unread)
	}
}

func testAuthFlow(t *testing.T) {
	tk := registerFresh(t)

	// /users/me — успех
	code, raw := doReq(t, http.MethodGet, "/api/v1/users/me", tk.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("me: %d %s", code, string(raw))
	}

	// login повторно — должен пройти
	loginBody := map[string]any{
		"login":    tk.User.Username,
		"password": "smoke-password-12345",
	}
	code, raw = doReq(t, http.MethodPost, "/api/v1/auth/login", "", loginBody)
	if code != http.StatusOK {
		t.Fatalf("login: %d %s", code, string(raw))
	}

	// refresh
	code, raw = doReq(t, http.MethodPost, "/api/v1/auth/refresh", "", map[string]any{"refreshToken": tk.RefreshToken})
	if code != http.StatusOK {
		t.Fatalf("refresh: %d %s", code, string(raw))
	}
	var refreshed tokens
	mustJSON(t, raw, &refreshed)

	// logout с новым access токеном
	code, raw = doReq(t, http.MethodPost, "/api/v1/auth/logout", refreshed.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", code, string(raw))
	}

	// после logout — /users/me 401 (сессия revoked)
	code, raw = doReq(t, http.MethodGet, "/api/v1/users/me", refreshed.AccessToken, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("me after logout: expected 401, got %d %s", code, string(raw))
	}
}

type idView struct {
	ID string `json:"id"`
}

func createWorkspace(t *testing.T, token string) string {
	t.Helper()
	suffix := uniqSuffix()
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces", token, map[string]any{
		"slug": "smk-" + suffix,
		"name": "Smoke " + suffix,
	})
	if code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", code, string(raw))
	}
	var v idView
	mustJSON(t, raw, &v)
	return v.ID
}

func createTextChannel(t *testing.T, token, wsID string) string {
	t.Helper()
	suffix := uniqSuffix()
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/channels", token, map[string]any{
		"kind":      "text",
		"name":      "ch-" + suffix,
		"isPrivate": false,
	})
	if code != http.StatusCreated {
		t.Fatalf("create channel: %d %s", code, string(raw))
	}
	var v idView
	mustJSON(t, raw, &v)
	return v.ID
}

func createVoiceChannel(t *testing.T, token, wsID string) string {
	t.Helper()
	suffix := uniqSuffix()
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/channels", token, map[string]any{
		"kind":      "voice",
		"name":      "vc-" + suffix,
		"isPrivate": false,
	})
	if code != http.StatusCreated {
		t.Fatalf("create voice channel: %d %s", code, string(raw))
	}
	var v idView
	mustJSON(t, raw, &v)
	return v.ID
}

func testVoiceChannel(t *testing.T) {
	tk := registerFresh(t)
	wsID := createWorkspace(t, tk.AccessToken)
	chID := createVoiceChannel(t, tk.AccessToken, wsID)

	// join — должен вернуть self и пустой others
	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/voice/join", tk.AccessToken, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("voice join: %d %s", code, string(raw))
	}
	var join struct {
		ChannelID string `json:"channelId"`
		Self      struct {
			UserID    string `json:"userId"`
			SessionID string `json:"sessionId"`
		} `json:"self"`
		Others []map[string]any `json:"others"`
	}
	mustJSON(t, raw, &join)
	if join.Self.UserID != tk.User.ID || join.Self.SessionID == "" {
		t.Fatalf("voice join: bad self %+v", join.Self)
	}
	if len(join.Others) != 0 {
		t.Fatalf("voice join: expected empty others, got %d", len(join.Others))
	}

	// list — содержит self
	code, raw = doReq(t, http.MethodGet, "/api/v1/channels/"+chID+"/voice/participants", tk.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("voice list: %d %s", code, string(raw))
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	mustJSON(t, raw, &list)
	if len(list.Items) != 1 {
		t.Fatalf("voice list: expected 1, got %d", len(list.Items))
	}

	// чужой в воркспейсе НЕ участвует — second user joins → others=1
	other := registerFresh(t)
	// добавляем other'а в workspace через invite
	code, raw = doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", tk.AccessToken, map[string]any{"maxUses": 10})
	if code != http.StatusCreated {
		t.Fatalf("create invite: %d %s", code, string(raw))
	}
	var inv struct {
		Code string `json:"code"`
	}
	mustJSON(t, raw, &inv)
	code, raw = doReq(t, http.MethodPost, "/api/v1/invites/"+inv.Code+"/accept", other.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("accept invite: %d %s", code, string(raw))
	}
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/voice/join", other.AccessToken, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("voice join (other): %d %s", code, string(raw))
	}
	mustJSON(t, raw, &join)
	if len(join.Others) != 1 || join.Others[0]["userId"] != tk.User.ID {
		t.Fatalf("voice join (other): expected to see first user, got %+v", join.Others)
	}

	// leave — list возвращается к одному
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/voice/leave", tk.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("voice leave: %d %s", code, string(raw))
	}
	code, raw = doReq(t, http.MethodGet, "/api/v1/channels/"+chID+"/voice/participants", other.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("voice list after leave: %d %s", code, string(raw))
	}
	mustJSON(t, raw, &list)
	if len(list.Items) != 1 || list.Items[0]["userId"] != other.User.ID {
		t.Fatalf("voice list after leave: expected only other user, got %+v", list.Items)
	}

	// text-канал отказывается с 400
	textCh := createTextChannel(t, tk.AccessToken, wsID)
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+textCh+"/voice/join", tk.AccessToken, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("voice join on text channel: expected 400, got %d %s", code, string(raw))
	}
}

func testCallLifecycle(t *testing.T) {
	// Два пира в одном workspace. Initiator (A) создаёт звонок, peer (B)
	// его завершает (как rejectIncoming). Проверяем что durationMs > 0,
	// что end идемпотентен, что не-участник не видит запись.
	a := registerFresh(t)
	wsID := createWorkspace(t, a.AccessToken)
	// инвайт для B и accept
	b := registerFresh(t)
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", a.AccessToken, map[string]any{"maxUses": 10})
	if code != http.StatusCreated {
		t.Fatalf("invite: %d %s", code, string(raw))
	}
	var inv struct {
		Code string `json:"code"`
	}
	mustJSON(t, raw, &inv)
	code, raw = doReq(t, http.MethodPost, "/api/v1/invites/"+inv.Code+"/accept", b.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("accept: %d %s", code, string(raw))
	}

	// A инициирует звонок
	code, raw = doReq(t, http.MethodPost, "/api/v1/calls", a.AccessToken, map[string]any{
		"kind":       "one_to_one",
		"peerUserId": b.User.ID,
	})
	if code != http.StatusCreated {
		t.Fatalf("call start: %d %s", code, string(raw))
	}
	var call struct {
		ID          string  `json:"id"`
		Kind        string  `json:"kind"`
		InitiatorID string  `json:"initiatorId"`
		PeerID      string  `json:"peerId"`
		StartedAt   string  `json:"startedAt"`
		EndedAt     *string `json:"endedAt"`
		DurationMs  *int64  `json:"durationMs"`
	}
	mustJSON(t, raw, &call)
	if call.ID == "" || call.Kind != "one_to_one" || call.InitiatorID != a.User.ID || call.PeerID != b.User.ID {
		t.Fatalf("call start: bad fields %+v", call)
	}
	if call.EndedAt != nil {
		t.Fatalf("call start: ended_at should be null on fresh row")
	}

	// B завершает (rejectIncoming)
	time.Sleep(20 * time.Millisecond) // чтобы durationMs точно > 0
	code, raw = doReq(t, http.MethodPost, "/api/v1/calls/"+call.ID+"/end", b.AccessToken, map[string]any{"reason": "rejected"})
	if code != http.StatusOK {
		t.Fatalf("call end: %d %s", code, string(raw))
	}
	mustJSON(t, raw, &call)
	if call.EndedAt == nil || call.DurationMs == nil || *call.DurationMs <= 0 {
		t.Fatalf("call end: expected durationMs > 0, got %+v", call)
	}

	// Идемпотентность: повторный end не падает
	code, raw = doReq(t, http.MethodPost, "/api/v1/calls/"+call.ID+"/end", a.AccessToken, map[string]any{"reason": "again"})
	if code != http.StatusOK {
		t.Fatalf("call end (idempotent): %d %s", code, string(raw))
	}

	// Чужой не видит звонок
	stranger := registerFresh(t)
	code, raw = doReq(t, http.MethodGet, "/api/v1/calls/"+call.ID, stranger.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("call get by stranger: expected 404, got %d %s", code, string(raw))
	}

	// validation: peer не в shared workspace
	code, raw = doReq(t, http.MethodPost, "/api/v1/calls", a.AccessToken, map[string]any{
		"kind":       "one_to_one",
		"peerUserId": stranger.User.ID,
	})
	if code != http.StatusForbidden {
		t.Fatalf("call start to stranger: expected 403, got %d %s", code, string(raw))
	}
}

func testMessageReply(t *testing.T) {
	tk := registerFresh(t)
	wsID := createWorkspace(t, tk.AccessToken)
	chID := createTextChannel(t, tk.AccessToken, wsID)
	otherCh := createTextChannel(t, tk.AccessToken, wsID)

	// родительское сообщение
	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", tk.AccessToken, map[string]any{
		"body":            "оригинал — на этот текст будет ответ",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("parent: %d %s", code, string(raw))
	}
	var parent idView
	mustJSON(t, raw, &parent)

	// reply в том же канале — OK
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", tk.AccessToken, map[string]any{
		"body":             "ответ",
		"clientMessageId":  uuid.NewString(),
		"replyToMessageId": parent.ID,
	})
	if code != http.StatusCreated {
		t.Fatalf("reply: %d %s", code, string(raw))
	}
	var reply struct {
		ID      string `json:"id"`
		ReplyTo *struct {
			MessageID string `json:"messageId"`
			AuthorID  string `json:"authorId"`
			Body      string `json:"body"`
			Deleted   bool   `json:"deleted"`
		} `json:"replyTo"`
	}
	mustJSON(t, raw, &reply)
	if reply.ReplyTo == nil || reply.ReplyTo.MessageID != parent.ID {
		t.Fatalf("reply: replyTo missing or wrong: %+v", reply.ReplyTo)
	}
	if reply.ReplyTo.AuthorID != tk.User.ID {
		t.Fatalf("reply: author mismatch %s vs %s", reply.ReplyTo.AuthorID, tk.User.ID)
	}
	if !strings.HasPrefix(reply.ReplyTo.Body, "оригинал") {
		t.Fatalf("reply: snippet body bad: %q", reply.ReplyTo.Body)
	}

	// reply на parent из другого канала — 400
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+otherCh+"/messages", tk.AccessToken, map[string]any{
		"body":             "ответ из чужого канала",
		"clientMessageId":  uuid.NewString(),
		"replyToMessageId": parent.ID,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("cross-channel reply: expected 400, got %d %s", code, string(raw))
	}

	// удалим parent, повторим reply — должно отказать (parent deleted)
	code, raw = doReq(t, http.MethodDelete, "/api/v1/messages/"+parent.ID, tk.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete parent: %d %s", code, string(raw))
	}
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", tk.AccessToken, map[string]any{
		"body":             "ответ на удалённый",
		"clientMessageId":  uuid.NewString(),
		"replyToMessageId": parent.ID,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("reply to deleted: expected 400, got %d %s", code, string(raw))
	}

	// несуществующий id — 400
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", tk.AccessToken, map[string]any{
		"body":             "ответ в никуда",
		"clientMessageId":  uuid.NewString(),
		"replyToMessageId": uuid.NewString(),
	})
	if code != http.StatusBadRequest {
		t.Fatalf("reply to nonexistent: expected 400, got %d %s", code, string(raw))
	}
}

// Wave 10: тред из сообщения. Создание, идемпотентность повторного POST,
// постинг внутрь kind='thread' (регресс: гейт «channel does not accept
// messages» не должен резать треды) и thread-агрегат в message list.
func testMessageThread(t *testing.T) {
	tk := registerFresh(t)
	wsID := createWorkspace(t, tk.AccessToken)
	chID := createTextChannel(t, tk.AccessToken, wsID)

	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", tk.AccessToken, map[string]any{
		"body":            "корневое сообщение для треда",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("root message: %d %s", code, string(raw))
	}
	var root idView
	mustJSON(t, raw, &root)

	type threadView struct {
		ID              string  `json:"id"`
		Kind            string  `json:"kind"`
		Name            string  `json:"name"`
		ParentChannelID *string `json:"parentChannelId"`
		RootMessageID   *string `json:"rootMessageId"`
	}
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages/"+root.ID+"/thread", tk.AccessToken, map[string]any{})
	if code != http.StatusCreated {
		t.Fatalf("thread create: %d %s", code, string(raw))
	}
	var th threadView
	mustJSON(t, raw, &th)
	if th.Kind != "thread" || th.ParentChannelID == nil || *th.ParentChannelID != chID {
		t.Fatalf("thread view: %+v", th)
	}
	if th.RootMessageID == nil || *th.RootMessageID != root.ID {
		t.Fatalf("thread rootMessageId: %+v", th.RootMessageID)
	}
	if !strings.HasPrefix(th.Name, "корневое сообщение") {
		t.Fatalf("thread title not derived from body: %q", th.Name)
	}

	// Повторный POST — идемпотентность: 200 и тот же id.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages/"+root.ID+"/thread", tk.AccessToken, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("thread re-create: expected 200, got %d %s", code, string(raw))
	}
	var again threadView
	mustJSON(t, raw, &again)
	if again.ID != th.ID {
		t.Fatalf("thread re-create: id mismatch %s vs %s", again.ID, th.ID)
	}

	// Сообщение внутрь треда — 201 (kind='thread' принимает сообщения).
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+th.ID+"/messages", tk.AccessToken, map[string]any{
		"body":            "первый ответ в треде",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("post into thread: %d %s", code, string(raw))
	}

	// Message list родителя: у корневого сообщения thread-агрегат c
	// messageCount=1 (system-плашка контекста не считается user-ответом).
	code, raw = doReq(t, http.MethodGet, "/api/v1/channels/"+chID+"/messages?limit=50", tk.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("list parent: %d %s", code, string(raw))
	}
	var list struct {
		Items []struct {
			ID     string `json:"id"`
			Thread *struct {
				ThreadID     string `json:"threadId"`
				Title        string `json:"title"`
				MessageCount int    `json:"messageCount"`
			} `json:"thread"`
		} `json:"items"`
	}
	mustJSON(t, raw, &list)
	found := false
	for _, it := range list.Items {
		if it.ID != root.ID {
			continue
		}
		found = true
		if it.Thread == nil {
			t.Fatalf("root message has no thread aggregate")
		}
		if it.Thread.ThreadID != th.ID || it.Thread.MessageCount != 1 {
			t.Fatalf("thread aggregate: %+v", it.Thread)
		}
	}
	if !found {
		t.Fatalf("root message not in list")
	}

	// Тред на сообщение из чужого канала — 404.
	otherCh := createTextChannel(t, tk.AccessToken, wsID)
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+otherCh+"/messages/"+root.ID+"/thread", tk.AccessToken, map[string]any{})
	if code != http.StatusNotFound {
		t.Fatalf("cross-channel thread: expected 404, got %d %s", code, string(raw))
	}
}

func testMessageMentions(t *testing.T) {
	// A — автор, B — упоминаемый участник того же воркспейса. Кроме B
	// в body есть `@ghost000000` — несуществующий slug, должен молча
	// отвалиться (валидный синтаксис, но не участник). И `bad@bademail`
	// — НЕ упоминание (перед @ слово-символ).
	a := registerFresh(t)
	wsID := createWorkspace(t, a.AccessToken)
	chID := createTextChannel(t, a.AccessToken, wsID)

	b := registerFresh(t)
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", a.AccessToken, map[string]any{"maxUses": 10})
	if code != http.StatusCreated {
		t.Fatalf("invite: %d %s", code, string(raw))
	}
	var inv struct {
		Code string `json:"code"`
	}
	mustJSON(t, raw, &inv)
	code, raw = doReq(t, http.MethodPost, "/api/v1/invites/"+inv.Code+"/accept", b.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("accept: %d %s", code, string(raw))
	}

	// C — посторонний, НЕ в воркспейсе — упоминание @C должно отвалиться.
	c := registerFresh(t)

	body := "@" + b.User.Username + " привет, и @" + c.User.Username + " тоже, и @ghost000000, и bad@bademail"
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", a.AccessToken, map[string]any{
		"body":            body,
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, string(raw))
	}
	var msg struct {
		ID       string   `json:"id"`
		Mentions []string `json:"mentions"`
	}
	mustJSON(t, raw, &msg)
	if len(msg.Mentions) != 1 || msg.Mentions[0] != b.User.ID {
		t.Fatalf("mentions: expected [%s], got %v", b.User.ID, msg.Mentions)
	}

	// Edit: убираем mention @B → mentions пустой.
	code, raw = doReq(t, http.MethodPatch, "/api/v1/messages/"+msg.ID, a.AccessToken, map[string]any{
		"body": "просто текст без упоминаний",
	})
	if code != http.StatusOK {
		t.Fatalf("edit (clear): %d %s", code, string(raw))
	}
	var edited struct {
		Mentions []string `json:"mentions"`
	}
	mustJSON(t, raw, &edited)
	if len(edited.Mentions) != 0 {
		t.Fatalf("mentions after clear: expected empty, got %v", edited.Mentions)
	}

	// Edit обратно: возвращаем @B → снова один mention.
	code, raw = doReq(t, http.MethodPatch, "/api/v1/messages/"+msg.ID, a.AccessToken, map[string]any{
		"body": "снова @" + b.User.Username,
	})
	if code != http.StatusOK {
		t.Fatalf("edit (restore): %d %s", code, string(raw))
	}
	mustJSON(t, raw, &edited)
	if len(edited.Mentions) != 1 || edited.Mentions[0] != b.User.ID {
		t.Fatalf("mentions after restore: expected [%s], got %v", b.User.ID, edited.Mentions)
	}

	// list возвращает mentions в выдаче.
	code, raw = doReq(t, http.MethodGet, "/api/v1/channels/"+chID+"/messages", a.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("list: %d %s", code, string(raw))
	}
	var list struct {
		Items []struct {
			ID       string   `json:"id"`
			Mentions []string `json:"mentions"`
		} `json:"items"`
	}
	mustJSON(t, raw, &list)
	var found bool
	for _, it := range list.Items {
		if it.ID == msg.ID {
			found = true
			if len(it.Mentions) != 1 || it.Mentions[0] != b.User.ID {
				t.Fatalf("list mentions: got %v", it.Mentions)
			}
		}
	}
	if !found {
		t.Fatalf("message not in list")
	}

	_ = c
}

func testUnreadCounts(t *testing.T) {
	a := registerFresh(t)
	wsID := createWorkspace(t, a.AccessToken)
	chID := createTextChannel(t, a.AccessToken, wsID)

	// B принимает инвайт в воркспейс A.
	b := registerFresh(t)
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", a.AccessToken, map[string]any{"maxUses": 10})
	if code != http.StatusCreated {
		t.Fatalf("invite: %d %s", code, string(raw))
	}
	var inv struct {
		Code string `json:"code"`
	}
	mustJSON(t, raw, &inv)
	code, raw = doReq(t, http.MethodPost, "/api/v1/invites/"+inv.Code+"/accept", b.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("accept: %d %s", code, string(raw))
	}

	type unreadResp struct {
		Items []struct {
			ChannelID   string `json:"channelId"`
			UnreadCount int    `json:"unreadCount"`
		} `json:"items"`
	}
	getUnread := func(token, ch string) int {
		c, r := doReq(t, http.MethodGet, "/api/v1/workspaces/"+wsID+"/unread", token, nil)
		if c != http.StatusOK {
			t.Fatalf("unread: %d %s", c, string(r))
		}
		var ur unreadResp
		mustJSON(t, r, &ur)
		for _, it := range ur.Items {
			if it.ChannelID == ch {
				return it.UnreadCount
			}
		}
		t.Fatalf("channel %s not in unread response", ch)
		return -1
	}

	// A пишет 3 сообщения; B их ещё не читал.
	var lastID string
	for i := 0; i < 3; i++ {
		c, r := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", a.AccessToken, map[string]any{
			"body":            "msg",
			"clientMessageId": uuid.NewString(),
		})
		if c != http.StatusCreated {
			t.Fatalf("post: %d %s", c, string(r))
		}
		var m idView
		mustJSON(t, r, &m)
		lastID = m.ID
	}

	// Раньше мы ждали 3, но теперь при создании канала автор (А) пишет
	// 1 system-сообщение (Канал создан) + 3 своих msg-сообщения.
	// Для B это 4 непрочитанных.
	if got := getUnread(b.AccessToken, chID); got != 4 {
		t.Fatalf("B unread before read: expected 4, got %d", got)
	}
	// Свои сообщения не считаются непрочитанными у автора.
	if got := getUnread(a.AccessToken, chID); got != 0 {
		t.Fatalf("A unread (own messages): expected 0, got %d", got)
	}

	// B отмечает прочитанным до последнего.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/read", b.AccessToken, map[string]any{
		"messageId": lastID,
	})
	if code != http.StatusOK {
		t.Fatalf("mark read: %d %s", code, string(raw))
	}
	if got := getUnread(b.AccessToken, chID); got != 0 {
		t.Fatalf("B unread after read: expected 0, got %d", got)
	}

	// A пишет ещё одно — B снова видит 1.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", a.AccessToken, map[string]any{
		"body":            "fresh",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("fresh post: %d %s", code, string(raw))
	}
	if got := getUnread(b.AccessToken, chID); got != 1 {
		t.Fatalf("B unread after fresh: expected 1, got %d", got)
	}

	// Чужой пользователь не имеет доступа к воркспейсу — 404.
	stranger := registerFresh(t)
	code, raw = doReq(t, http.MethodGet, "/api/v1/workspaces/"+wsID+"/unread", stranger.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("stranger unread: expected 404, got %d %s", code, string(raw))
	}
}

func testMessageSearch(t *testing.T) {
	// A создаёт workspace + два канала, пишет три сообщения. Поиск по
	// уникальному токену даёт ровно одно совпадение; highlight содержит
	// sentinel'ы. Чужой пользователь — 404 по workspace.
	a := registerFresh(t)
	wsID := createWorkspace(t, a.AccessToken)
	ch1 := createTextChannel(t, a.AccessToken, wsID)
	ch2 := createTextChannel(t, a.AccessToken, wsID)

	needle := "квазимодулярная" + uniqSuffix() // уникальный токен на сессию
	post := func(ch, body string) string {
		c, r := doReq(t, http.MethodPost, "/api/v1/channels/"+ch+"/messages", a.AccessToken, map[string]any{
			"body":            body,
			"clientMessageId": uuid.NewString(),
		})
		if c != http.StatusCreated {
			t.Fatalf("post: %d %s", c, string(r))
		}
		var v idView
		mustJSON(t, r, &v)
		return v.ID
	}
	post(ch1, "обычное сообщение без иголки")
	hit := post(ch2, "тут спрятана "+needle+" в середине текста")
	post(ch1, "ещё одно без неё")

	type searchResult struct {
		ID          string `json:"id"`
		ChannelID   string `json:"channelId"`
		ChannelName string `json:"channelName"`
		Highlight   string `json:"highlight"`
		Body        string `json:"body"`
	}
	type searchResp struct {
		Items      []searchResult `json:"items"`
		NextCursor string         `json:"nextCursor"`
	}

	code, raw := doReq(t, http.MethodGet, "/api/v1/workspaces/"+wsID+"/search?q="+needle, a.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("search: %d %s", code, string(raw))
	}
	var sr searchResp
	mustJSON(t, raw, &sr)
	if len(sr.Items) != 1 {
		t.Fatalf("search: expected 1 hit, got %d (%+v)", len(sr.Items), sr.Items)
	}
	got := sr.Items[0]
	if got.ID != hit {
		t.Fatalf("search: expected id %s, got %s", hit, got.ID)
	}
	if got.ChannelID != ch2 {
		t.Fatalf("search: wrong channelId %s", got.ChannelID)
	}
	if got.ChannelName == "" {
		t.Fatalf("search: empty channelName")
	}
	if !strings.Contains(got.Highlight, "⟨MARK⟩") || !strings.Contains(got.Highlight, "⟨/MARK⟩") {
		t.Fatalf("search: highlight missing sentinels: %q", got.Highlight)
	}

	// Слишком короткий запрос — 400.
	code, raw = doReq(t, http.MethodGet, "/api/v1/workspaces/"+wsID+"/search?q=a", a.AccessToken, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("search short q: expected 400, got %d %s", code, string(raw))
	}

	// Чужой не видит — 404 по workspace.
	stranger := registerFresh(t)
	code, raw = doReq(t, http.MethodGet, "/api/v1/workspaces/"+wsID+"/search?q="+needle, stranger.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("search stranger: expected 404, got %d %s", code, string(raw))
	}

	// Запрос без совпадений — пустой items, 200.
	code, raw = doReq(t, http.MethodGet, "/api/v1/workspaces/"+wsID+"/search?q=несуществующеетокеноидонеслово", a.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("search no match: %d %s", code, string(raw))
	}
	mustJSON(t, raw, &sr)
	if len(sr.Items) != 0 {
		t.Fatalf("search no match: expected 0, got %d", len(sr.Items))
	}
}

func testMessageCRUD(t *testing.T) {
	tk := registerFresh(t)
	wsID := createWorkspace(t, tk.AccessToken)
	chID := createTextChannel(t, tk.AccessToken, wsID)

	// create
	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", tk.AccessToken, map[string]any{
		"body":            "hello smoke",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("create message: %d %s", code, string(raw))
	}
	var msg idView
	mustJSON(t, raw, &msg)

	// edit
	code, raw = doReq(t, http.MethodPatch, "/api/v1/messages/"+msg.ID, tk.AccessToken, map[string]any{
		"body": "hello smoke (edited)",
	})
	if code != http.StatusOK {
		t.Fatalf("edit message: %d %s", code, string(raw))
	}

	// delete
	code, raw = doReq(t, http.MethodDelete, "/api/v1/messages/"+msg.ID, tk.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete message: %d %s", code, string(raw))
	}
}

func testPermissionDeny(t *testing.T) {
	owner := registerFresh(t)
	wsID := createWorkspace(t, owner.AccessToken)
	chID := createTextChannel(t, owner.AccessToken, wsID)

	// posting as owner — allow
	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", owner.AccessToken, map[string]any{
		"body":            "owner can post",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusCreated {
		t.Fatalf("owner post: %d %s", code, string(raw))
	}

	// чужой юзер не должен видеть канал
	stranger := registerFresh(t)
	code, raw = doReq(t, http.MethodGet, "/api/v1/channels/"+chID+"/messages", stranger.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("stranger list messages: expected 404, got %d %s", code, string(raw))
	}

	// и не должен мочь постить
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", stranger.AccessToken, map[string]any{
		"body":            "stranger cannot post",
		"clientMessageId": uuid.NewString(),
	})
	if code != http.StatusNotFound {
		t.Fatalf("stranger post: expected 404, got %d %s", code, string(raw))
	}
}

// 1x1 transparent PNG.
var pngBytes = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
	0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
}

func testAttachmentUpload(t *testing.T) {
	tk := registerFresh(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="smoke.png"`)
	hdr.Set("Content-Type", "image/png")
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("multipart part: %v", err)
	}
	if _, err := part.Write(pngBytes); err != nil {
		t.Fatalf("multipart write: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/uploads", &buf)
	if err != nil {
		t.Fatalf("new req: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+tk.AccessToken)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d %s", resp.StatusCode, string(raw))
	}
	var up idView
	mustJSON(t, raw, &up)

	// Owner-shortcut: GET /media/{id} проходит даже если media не приложена
	// к сообщению (это валидно сразу после upload, перед отправкой
	// сообщения). Проверяем что ACL не ломает этот сценарий.
	code, body := doReq(t, http.MethodGet, "/api/v1/media/"+up.ID, tk.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("download as owner: %d %s", code, string(body))
	}
	if !bytes.Equal(body, pngBytes) {
		t.Fatalf("download mismatch: got %d bytes, want %d", len(body), len(pngBytes))
	}

	// Чужой не должен видеть unattached media (owner-only до прикрепления).
	stranger := registerFresh(t)
	code, raw = doReq(t, http.MethodGet, "/api/v1/media/"+up.ID, stranger.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("download as stranger: expected 404, got %d %s", code, string(raw))
	}
}

// testServerSettings — D.1. Проверяем root-only доступ, GET/PUT и что
// сниженный max_message_bytes действительно ловит сообщение в handleCreate.
func testServerSettings(t *testing.T) {
	root := registerFresh(t)
	regular := registerFresh(t)

	// Принудительно делаем root'ом — в shared smoke-БД мог уже жить
	// другой root от прошлого теста / bootstrap. is_root остаётся
	// у первого юзера; чтобы детерминированно проверить ручки, явно
	// промоутим обоих в нужное состояние через прямой UPDATE.
	ctx := context.Background()
	if _, err := dbPool.Exec(ctx, `update users set is_root = (id = $1) where id in ($1, $2)`,
		root.User.ID, regular.User.ID); err != nil {
		t.Fatalf("promote root: %v", err)
	}

	// regular: GET → 404 (не палим существование ручки).
	code, raw := doReq(t, http.MethodGet, "/api/v1/server/settings", regular.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("non-root GET: expected 404, got %d %s", code, string(raw))
	}
	code, raw = doReq(t, http.MethodPut, "/api/v1/server/settings", regular.AccessToken, map[string]any{"maxUsers": 999})
	if code != http.StatusNotFound {
		t.Fatalf("non-root PUT: expected 404, got %d %s", code, string(raw))
	}

	// root: GET → 200, defaults применены (max_message_bytes=8000 из миграции).
	code, raw = doReq(t, http.MethodGet, "/api/v1/server/settings", root.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("root GET: expected 200, got %d %s", code, string(raw))
	}
	var view struct {
		MaxMessageBytes  int  `json:"maxMessageBytes"`
		RegistrationOpen bool `json:"registrationOpen"`
	}
	mustJSON(t, raw, &view)
	if view.MaxMessageBytes <= 0 {
		t.Fatalf("default maxMessageBytes should be positive, got %d", view.MaxMessageBytes)
	}

	// root: PUT — снижаем лимит до 5 байт, чтобы любое содержательное
	// сообщение упёрлось в проверку.
	code, raw = doReq(t, http.MethodPut, "/api/v1/server/settings", root.AccessToken, map[string]any{"maxMessageBytes": 5})
	if code != http.StatusOK {
		t.Fatalf("root PUT: expected 200, got %d %s", code, string(raw))
	}
	mustJSON(t, raw, &view)
	if view.MaxMessageBytes != 5 {
		t.Fatalf("PUT didn't persist: maxMessageBytes=%d", view.MaxMessageBytes)
	}

	// Provider кешируется TTL=30s — для smoke надо обойти. invalidate уже
	// произошёл при PUT, так что следующий запрос увидит новое значение.
	wsID := createWorkspace(t, root.AccessToken)
	chID := createTextChannel(t, root.AccessToken, wsID)
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", root.AccessToken,
		map[string]any{"body": "way too long body"})
	if code != http.StatusBadRequest {
		t.Fatalf("message with body over limit: expected 400, got %d %s", code, string(raw))
	}

	// Возвращаем разумный лимит, чтобы не сломать другие тесты при
	// повторном прогоне (smoke не чистит БД между запусками локально).
	code, raw = doReq(t, http.MethodPut, "/api/v1/server/settings", root.AccessToken, map[string]any{"maxMessageBytes": 8000})
	if code != http.StatusOK {
		t.Fatalf("root PUT restore: %d %s", code, string(raw))
	}

	// Валидация: отрицательное значение → 400.
	code, raw = doReq(t, http.MethodPut, "/api/v1/server/settings", root.AccessToken, map[string]any{"maxUsers": -1})
	if code != http.StatusBadRequest {
		t.Fatalf("negative maxUsers: expected 400, got %d %s", code, string(raw))
	}
}

// testAdminPanel — D.2. Проверяем list/ban/unban/delete пользователей и метрики.
// Root-only доступ, бан блокирует login и ревокирует refresh, root защищён от
// бана/удаления, self-action запрещён.
func testAdminPanel(t *testing.T) {
	root := registerFresh(t)
	regular := registerFresh(t)
	victim := registerFresh(t)
	victimPassword := "smoke-password-12345"

	// Промоутим root детерминированно (см. комментарий в testServerSettings).
	ctx := context.Background()
	if _, err := dbPool.Exec(ctx,
		`update users set is_root = (id = $1) where id in ($1, $2, $3)`,
		root.User.ID, regular.User.ID, victim.User.ID); err != nil {
		t.Fatalf("promote root: %v", err)
	}

	// regular → 404 на admin-ручках.
	code, _ := doReq(t, http.MethodGet, "/api/v1/server/users", regular.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("regular list users: expected 404, got %d", code)
	}
	code, _ = doReq(t, http.MethodGet, "/api/v1/server/metrics", regular.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("regular metrics: expected 404, got %d", code)
	}

	// root list — root присутствует.
	code, raw := doReq(t, http.MethodGet, "/api/v1/server/users?limit=20&q="+root.User.Username, root.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("root list: %d %s", code, string(raw))
	}
	var listResp struct {
		Items []struct {
			ID       string  `json:"id"`
			Username string  `json:"username"`
			IsRoot   bool    `json:"isRoot"`
			BannedAt *string `json:"bannedAt,omitempty"`
		} `json:"items"`
		Total int `json:"total"`
	}
	mustJSON(t, raw, &listResp)
	var rootInList, victimInList bool
	for _, it := range listResp.Items {
		if it.ID == root.User.ID {
			rootInList = true
			if !it.IsRoot {
				t.Fatalf("root user shows isRoot=false")
			}
		}
	}

	// root list — victim присутствует.
	code, raw = doReq(t, http.MethodGet, "/api/v1/server/users?limit=20&q="+victim.User.Username, root.AccessToken, nil)
	mustJSON(t, raw, &listResp)
	for _, it := range listResp.Items {
		if it.ID == victim.User.ID {
			victimInList = true
		}
	}

	if !rootInList || !victimInList {
		t.Fatalf("missing users in list (root=%v victim=%v)", rootInList, victimInList)
	}

	// Self-ban запрещён.
	code, _ = doReq(t, http.MethodPost, "/api/v1/server/users/"+root.User.ID+"/ban", root.AccessToken, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("self-ban: expected 400, got %d", code)
	}

	// Бан root'а запрещён (даже если делает другой root — здесь актёр и так root).
	// Создаём промежуточный — promote victim в root временно нельзя, поэтому
	// проверим прямой запрет банить root'а через попытку забанить себя выше.
	// Бан обычного юзера: victim.
	code, raw = doReq(t, http.MethodPost, "/api/v1/server/users/"+victim.User.ID+"/ban", root.AccessToken,
		map[string]any{"reason": "тест"})
	if code != http.StatusNoContent {
		t.Fatalf("ban victim: %d %s", code, string(raw))
	}

	// victim не может залогиниться.
	code, raw = doReq(t, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"login":    victim.User.Username,
		"password": victimPassword,
	})
	if code != http.StatusForbidden {
		t.Fatalf("banned login: expected 403, got %d %s", code, string(raw))
	}

	// victim refresh тоже не работает (сессия revoked при бане).
	code, _ = doReq(t, http.MethodPost, "/api/v1/auth/refresh", "", map[string]any{
		"refreshToken": victim.RefreshToken,
	})
	if code != http.StatusUnauthorized && code != http.StatusForbidden {
		t.Fatalf("banned refresh: expected 401/403, got %d", code)
	}

	// Unban → login снова работает.
	code, _ = doReq(t, http.MethodPost, "/api/v1/server/users/"+victim.User.ID+"/unban", root.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("unban: %d", code)
	}
	code, raw = doReq(t, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"login":    victim.User.Username,
		"password": victimPassword,
	})
	if code != http.StatusOK {
		t.Fatalf("login after unban: %d %s", code, string(raw))
	}

	// Self-delete запрещён.
	code, _ = doReq(t, http.MethodDelete, "/api/v1/server/users/"+root.User.ID, root.AccessToken, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("self-delete: expected 400, got %d", code)
	}

	// Удаление обычного юзера.
	code, raw = doReq(t, http.MethodDelete, "/api/v1/server/users/"+victim.User.ID, root.AccessToken, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete victim: %d %s", code, string(raw))
	}
	// После удаления — попытка снова забанить вернёт 404.
	code, _ = doReq(t, http.MethodPost, "/api/v1/server/users/"+victim.User.ID+"/ban", root.AccessToken, map[string]any{})
	if code != http.StatusNotFound {
		t.Fatalf("ban deleted user: expected 404, got %d", code)
	}

	// Метрики: ожидаем непустые значения.
	code, raw = doReq(t, http.MethodGet, "/api/v1/server/metrics", root.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("metrics: %d %s", code, string(raw))
	}
	var m struct {
		UserCount         int   `json:"userCount"`
		WorkspaceCount    int   `json:"workspaceCount"`
		ChannelCount      int   `json:"channelCount"`
		MessageCount      int64 `json:"messageCount"`
		ActiveSessions24h int   `json:"activeSessions24h"`
		DatabaseSizeBytes int64 `json:"databaseSizeBytes"`
	}
	mustJSON(t, raw, &m)
	if m.UserCount <= 0 || m.DatabaseSizeBytes <= 0 {
		t.Fatalf("metrics zero: %+v", m)
	}
}

// testRetentionSweep — D.3. Прогоняем ручной POST /server/retention/run:
// (1) старое сообщение удаляется по message_retention_days; (2) свежее —
// остаётся; (3) non-root → 404.
func testRetentionSweep(t *testing.T) {
	root := registerFresh(t)
	regular := registerFresh(t)

	ctx := context.Background()
	if _, err := dbPool.Exec(ctx,
		`update users set is_root = (id = $1) where id in ($1, $2)`,
		root.User.ID, regular.User.ID); err != nil {
		t.Fatalf("promote root: %v", err)
	}

	// non-root → 404
	code, _ := doReq(t, http.MethodPost, "/api/v1/server/retention/run", regular.AccessToken, nil)
	if code != http.StatusNotFound {
		t.Fatalf("regular sweep: expected 404, got %d", code)
	}

	// Создаём ws + канал + два сообщения, одно «состарим» в БД на 60 дней.
	wsID := createWorkspace(t, root.AccessToken)
	chID := createTextChannel(t, root.AccessToken, wsID)

	code, raw := doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", root.AccessToken,
		map[string]any{"body": "старое", "clientMessageId": uuid.NewString()})
	if code != http.StatusCreated {
		t.Fatalf("post old: %d %s", code, string(raw))
	}
	var oldMsg struct {
		ID string `json:"id"`
	}
	mustJSON(t, raw, &oldMsg)

	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", root.AccessToken,
		map[string]any{"body": "новое", "clientMessageId": uuid.NewString()})
	if code != http.StatusCreated {
		t.Fatalf("post new: %d %s", code, string(raw))
	}
	var newMsg struct {
		ID string `json:"id"`
	}
	mustJSON(t, raw, &newMsg)

	if _, err := dbPool.Exec(ctx,
		`update messages set created_at = now() - interval '60 days' where id = $1`, oldMsg.ID); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	// Ставим retention=30 дней через PUT (попутно инвалидирует кеш Provider'а).
	code, _ = doReq(t, http.MethodPut, "/api/v1/server/settings", root.AccessToken,
		map[string]any{"messageRetentionDays": 30})
	if code != http.StatusOK {
		t.Fatalf("set retention: %d", code)
	}

	// Запускаем sweep.
	code, raw = doReq(t, http.MethodPost, "/api/v1/server/retention/run", root.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("sweep: %d %s", code, string(raw))
	}
	var stats struct {
		MessagesDeleted int64 `json:"messagesDeleted"`
	}
	mustJSON(t, raw, &stats)
	if stats.MessagesDeleted < 1 {
		t.Fatalf("expected at least 1 message deleted, got %d", stats.MessagesDeleted)
	}

	// Старое — отсутствует, новое — на месте.
	var exists bool
	if err := dbPool.QueryRow(ctx,
		`select exists(select 1 from messages where id = $1)`, oldMsg.ID).Scan(&exists); err != nil {
		t.Fatalf("check old: %v", err)
	}
	if exists {
		t.Fatalf("old message should be deleted")
	}
	if err := dbPool.QueryRow(ctx,
		`select exists(select 1 from messages where id = $1)`, newMsg.ID).Scan(&exists); err != nil {
		t.Fatalf("check new: %v", err)
	}
	if !exists {
		t.Fatalf("new message should still be there")
	}

	// Откатываем retention в 0, чтобы не дёргать остальные тесты при повторном прогоне.
	doReq(t, http.MethodPut, "/api/v1/server/settings", root.AccessToken,
		map[string]any{"messageRetentionDays": 0})
}

// testChannelOverrides — D.4. Per-channel permission overrides:
// (1) обычный member не может править permissions (403);
// (2) deny message.write блокирует POST сообщения от member'а;
// (3) очищение override возвращает право.
func testChannelOverrides(t *testing.T) {
	owner := registerFresh(t)
	member := registerFresh(t)

	wsID := createWorkspace(t, owner.AccessToken)
	chID := createTextChannel(t, owner.AccessToken, wsID)

	// Member вступает через инвайт.
	code, raw := doReq(t, http.MethodPost, "/api/v1/workspaces/"+wsID+"/invites", owner.AccessToken,
		map[string]any{"maxUses": 10})
	if code != http.StatusCreated {
		t.Fatalf("invite: %d %s", code, string(raw))
	}
	var inv struct {
		Code string `json:"code"`
	}
	mustJSON(t, raw, &inv)
	code, _ = doReq(t, http.MethodPost, "/api/v1/invites/"+inv.Code+"/accept", member.AccessToken, nil)
	if code != http.StatusOK {
		t.Fatalf("accept: %d", code)
	}

	// Sanity: member может писать.
	code, _ = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", member.AccessToken,
		map[string]any{"body": "до запрета", "clientMessageId": uuid.NewString()})
	if code != http.StatusCreated {
		t.Fatalf("initial post: expected 201, got %d", code)
	}

	// Member не вправе менять permissions канала.
	code, _ = doReq(t, http.MethodPut, "/api/v1/channels/"+chID+"/permissions", member.AccessToken,
		map[string]any{"overrides": []any{}})
	if code != http.StatusForbidden {
		t.Fatalf("member PUT: expected 403, got %d", code)
	}

	// Owner запрещает message.write для роли member.
	code, raw = doReq(t, http.MethodPut, "/api/v1/channels/"+chID+"/permissions", owner.AccessToken,
		map[string]any{
			"overrides": []map[string]any{
				{"roleCode": "member", "granted": []string{}, "denied": []string{"message.write"}},
			},
		})
	if code != http.StatusOK {
		t.Fatalf("owner PUT deny: %d %s", code, string(raw))
	}

	// Member теперь получает 403 на post.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", member.AccessToken,
		map[string]any{"body": "после запрета", "clientMessageId": uuid.NewString()})
	if code != http.StatusForbidden {
		t.Fatalf("denied post: expected 403, got %d %s", code, string(raw))
	}

	// Owner — не подчиняется override'у, пишет нормально.
	code, _ = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", owner.AccessToken,
		map[string]any{"body": "owner всё ещё пишет", "clientMessageId": uuid.NewString()})
	if code != http.StatusCreated {
		t.Fatalf("owner write under deny: %d", code)
	}

	// Сбрасываем override (пустой массив).
	code, _ = doReq(t, http.MethodPut, "/api/v1/channels/"+chID+"/permissions", owner.AccessToken,
		map[string]any{"overrides": []any{}})
	if code != http.StatusOK {
		t.Fatalf("clear overrides: %d", code)
	}

	// Member снова может писать.
	code, raw = doReq(t, http.MethodPost, "/api/v1/channels/"+chID+"/messages", member.AccessToken,
		map[string]any{"body": "после разбана", "clientMessageId": uuid.NewString()})
	if code != http.StatusCreated {
		t.Fatalf("restored post: %d %s", code, string(raw))
	}

	// Невалидный action в granted → 400.
	code, _ = doReq(t, http.MethodPut, "/api/v1/channels/"+chID+"/permissions", owner.AccessToken,
		map[string]any{
			"overrides": []map[string]any{
				{"roleCode": "member", "granted": []string{"made.up.action"}, "denied": []string{}},
			},
		})
	if code != http.StatusBadRequest {
		t.Fatalf("invalid action: expected 400, got %d", code)
	}
}
