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
)

var (
	baseURL string
	client  = &http.Client{Timeout: 30 * time.Second}
	redisCl *redisstore.Client
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
			Publisher:   realtimebus.NewPublisher(redisClient),
			ObjectStore: objectStore,
			Limiter:     ratelimit.New(redisClient.Client),
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

