package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/NotReptile/Cirvo/libs/shared-go/channelacl"
	sharedhttp "github.com/NotReptile/Cirvo/libs/shared-go/httpx"
	"github.com/NotReptile/Cirvo/libs/shared-go/objectstore"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/ratelimit"
	"github.com/NotReptile/Cirvo/services/core-api/internal/authctx"
	"github.com/NotReptile/Cirvo/services/core-api/internal/routing"
	"github.com/NotReptile/Cirvo/services/core-api/internal/serversettings"
)

const (
	maxUploadBytes = 25 * 1024 * 1024 // 25 MiB
	streamCopyBuf  = 64 * 1024
)

// Лимиты на uploads — per user. Token bucket защищает от спама запросами,
// Charge — кумулятивный размер за окно (защита от DoS дискового места).
// Когда D.1 добавит server_settings — эти константы переедут туда.
var (
	uploadRequestRule = ratelimit.Rule{Capacity: 60, Window: 10 * time.Minute}
	uploadSizeBudget  = ratelimit.Budget{Max: 500 * 1024 * 1024, Window: time.Hour} // 500 MiB/час/юзер
)

var safeFilenameRE = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

type Module struct {
	db       *postgres.Pool
	store    *objectstore.Lazy
	limiter  *ratelimit.Limiter
	settings *serversettings.Provider
	logger   *slog.Logger
}

func NewModule(db *postgres.Pool, store *objectstore.Lazy, limiter *ratelimit.Limiter, settings *serversettings.Provider, logger *slog.Logger) *Module {
	return &Module{db: db, store: store, limiter: limiter, settings: settings, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	uploadLimited := ratelimit.Middleware(m.limiter, m.logger, "upload_count", uploadRequestRule, userIDKey)(m.handleUpload)
	router.Protected("POST /api/v1/uploads", uploadLimited)
	router.Protected("GET /api/v1/media/{mediaId}", m.handleDownload)
	router.Protected("GET /api/v1/media/{mediaId}/thumb", m.handleThumbnail)
}

func userIDKey(r *http.Request) string {
	uid, ok := authctx.UserID(r.Context())
	if !ok {
		return ""
	}
	return uid.String()
}

// requireStore возвращает готовый клиент хранилища, при необходимости пробуя
// подключиться. Если не вышло, сам отвечает клиенту и возвращает ok=false.
func (m *Module) requireStore(w http.ResponseWriter, r *http.Request) (*objectstore.Client, bool) {
	store, err := m.store.Get(r.Context())
	if err == nil {
		return store, true
	}
	if errors.Is(err, objectstore.ErrNotConfigured) {
		sharedhttp.WriteError(w, r, http.StatusServiceUnavailable, sharedhttp.CodeInternal,
			"хранилище файлов не настроено на сервере")
		return nil, false
	}
	sharedhttp.WriteError(w, r, http.StatusServiceUnavailable, sharedhttp.CodeUnavailable,
		"хранилище файлов временно недоступно, повтори позже")
	return nil, false
}

type mediaView struct {
	ID          string    `json:"id"`
	ContentType string    `json:"contentType"`
	SizeBytes   int64     `json:"sizeBytes"`
	Filename    string    `json:"filename,omitempty"`
	URL         string    `json:"url"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (m *Module) handleUpload(w http.ResponseWriter, r *http.Request) {
	store, ok := m.requireStore(w, r)
	if !ok {
		return
	}
	userID := authctx.MustUserID(r.Context())

	// D.1: размер аплоада берётся из server_settings.max_attachment_bytes.
	// 0 / отсутствие Provider'а — fallback на исторический maxUploadBytes.
	uploadLimit := int64(maxUploadBytes)
	if m.settings != nil {
		if v := m.settings.Get(r.Context()).MaxAttachmentBytes; v > 0 {
			uploadLimit = v
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, uploadLimit+4096)
	if err := r.ParseMultipartForm(streamCopyBuf); err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed multipart body")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "missing 'file' part")
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > uploadLimit {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "file too large or empty")
		return
	}

	// Кумулятивный лимит размера: суммарно за окно один юзер не может
	// засосать больше uploadSizeBudget.Max байт.
	if m.limiter != nil {
		decision, err := m.limiter.Charge(r.Context(),
			ratelimit.Key("upload_bytes", userID.String()),
			header.Size,
			uploadSizeBudget,
		)
		if err != nil {
			m.logger.Warn("ratelimit charge failed, falling open",
				slog.String("scope", "upload_bytes"),
				slog.String("error", err.Error()),
			)
		} else if !decision.Allowed {
			ratelimit.WriteTooMany(w, r, decision.RetryAfter)
			return
		}
	}

	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = sniffByExt(header.Filename)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	mediaID := uuid.New()
	safeName := safeFilename(header.Filename)
	objectKey := fmt.Sprintf("media/%s/%s", mediaID.String(), safeName)

	if err := store.Put(r.Context(), objectKey, file, header.Size, contentType); err != nil {
		m.logger.Warn("upload to object store failed", slog.String("error", err.Error()))
		sharedhttp.WriteError(w, r, http.StatusBadGateway, sharedhttp.CodeInternal, "could not store object")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		_ = store.Remove(context.Background(), objectKey)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into media_objects (id, object_key, bucket, content_type, size_bytes, original_filename, uploaded_by_user_id, created_at)
		 values ($1, $2, $3, $4, $5, nullif($6, ''), $7, $8)`,
		mediaID, objectKey, store.Bucket(), contentType, header.Size, header.Filename, userID, now,
	)
	if err != nil {
		_ = store.Remove(context.Background(), objectKey)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not record media")
		return
	}

	uploadID := uuid.New()
	_, err = tx.Exec(r.Context(),
		`insert into upload_sessions (id, object_key, content_type, size_bytes, created_by_user_id, created_at, media_id, status, completed_at)
		 values ($1, $2, $3, $4, $5, $6, $7, 'completed', $6)`,
		uploadID, objectKey, contentType, header.Size, userID, now, mediaID,
	)
	if err != nil {
		_ = store.Remove(context.Background(), objectKey)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "could not record upload session")
		return
	}

	if isThumbnailable(contentType) {
		jobID := uuid.New()
		_, err = tx.Exec(r.Context(),
			`insert into media_jobs (id, media_id, kind, status, scheduled_at, created_at)
			 values ($1, $2, 'thumbnail', 'pending', $3, $3)`,
			jobID, mediaID, now,
		)
		if err != nil {
			m.logger.Warn("could not schedule thumbnail job", slog.String("error", err.Error()), slog.String("media_id", mediaID.String()))
			// не валим аплоад — превью построится при следующем заходе
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		_ = store.Remove(context.Background(), objectKey)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "commit failed")
		return
	}

	sharedhttp.WriteJSON(w, http.StatusCreated, mediaView{
		ID:          mediaID.String(),
		ContentType: contentType,
		SizeBytes:   header.Size,
		Filename:    header.Filename,
		URL:         "/api/v1/media/" + mediaID.String(),
		CreatedAt:   now,
	})
}

func (m *Module) handleDownload(w http.ResponseWriter, r *http.Request) {
	store, ok := m.requireStore(w, r)
	if !ok {
		return
	}
	userID := authctx.MustUserID(r.Context())
	rawID := r.PathValue("mediaId")
	mediaID, err := uuid.Parse(rawID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid media id")
		return
	}

	var (
		objectKey   string
		contentType string
		sizeBytes   int64
		filename    *string
		ownerID     *uuid.UUID
	)
	err = m.db.QueryRow(r.Context(),
		`select object_key, content_type, size_bytes, original_filename, uploaded_by_user_id
		 from media_objects where id = $1`,
		mediaID,
	).Scan(&objectKey, &contentType, &sizeBytes, &filename, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	if !m.canAccess(r.Context(), mediaID, userID, ownerID) {
		// 404 вместо 403, чтобы не палить факт существования media.
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
		return
	}

	reader, err := store.Get(r.Context(), objectKey)
	if err != nil {
		m.logger.Warn("media fetch failed", slog.String("error", err.Error()))
		sharedhttp.WriteError(w, r, http.StatusBadGateway, sharedhttp.CodeInternal, "object store unavailable")
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", sizeBytes))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if filename != nil && *filename != "" {
		w.Header().Set("Content-Disposition", "inline; filename=\""+safeHeaderValue(*filename)+"\"")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

func (m *Module) handleThumbnail(w http.ResponseWriter, r *http.Request) {
	store, ok := m.requireStore(w, r)
	if !ok {
		return
	}
	userID := authctx.MustUserID(r.Context())
	rawID := r.PathValue("mediaId")
	mediaID, err := uuid.Parse(rawID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid media id")
		return
	}

	var (
		thumbKey *string
		origKey  string
		origCT   string
		origSize int64
		ownerID  *uuid.UUID
	)
	err = m.db.QueryRow(r.Context(),
		`select thumbnail_object_key, object_key, content_type, size_bytes, uploaded_by_user_id
		 from media_objects where id = $1`,
		mediaID,
	).Scan(&thumbKey, &origKey, &origCT, &origSize, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	if !m.canAccess(r.Context(), mediaID, userID, ownerID) {
		sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
		return
	}

	objectKey := origKey
	contentType := origCT
	sizeHint := origSize
	if thumbKey != nil && *thumbKey != "" {
		objectKey = *thumbKey
		contentType = "image/jpeg"
		sizeHint = 0
	}

	reader, err := store.Get(r.Context(), objectKey)
	if err != nil {
		m.logger.Warn("thumbnail fetch failed", slog.String("error", err.Error()))
		sharedhttp.WriteError(w, r, http.StatusBadGateway, sharedhttp.CodeInternal, "object store unavailable")
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", contentType)
	if sizeHint > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", sizeHint))
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

// canAccess решает, можно ли отдать содержимое media текущему юзеру.
// Разрешено если:
//  1. юзер — владелец загрузки (`media_objects.uploaded_by_user_id`),
//     даже если media ещё не приложена к сообщению (свежий аплоад);
//  2. media приложена к сообщению в канале, который юзеру видим:
//     эффективный channel.view разрешён общим ACL; для DM — участник канала.
//
// При отсутствии доступа возвращаем false — вызывающий пишет 404, чтобы
// не палить факт существования media.
func (m *Module) canAccess(ctx context.Context, mediaID, userID uuid.UUID, ownerID *uuid.UUID) bool {
	if ownerID != nil && *ownerID == userID {
		return true
	}
	var allowed bool
	err := m.db.QueryRow(ctx,
		`select
		   exists (
		     select 1
		     from message_attachments ma
		     join messages msg on msg.id = ma.message_id
		     join channels c on c.id = msg.channel_id
		     where ma.media_id = $1 and c.workspace_id is null
             and exists (select 1 from channel_members cm where cm.channel_id=c.id and cm.user_id=$2)
		   )
		   -- H.1: avatar media is public-readable to any authenticated user.
		   -- Avatars by design must be visible to anyone who might see this user
		   -- in a member list. Self-host scope keeps the audience trusted.
		   or exists (select 1 from users where avatar_media_id = $1)
		   -- I.6: banner-картинка профиля — публично читаема (тот же scope,
		   -- что и аватар: видна всем кто открывает профиль юзера).
		   or exists (select 1 from users where banner_media_id = $1)
		   -- H.2: иконка воркспейса — публично читаемая (видят все, кто
		   -- получит инвайт-код; в self-host сценарии аудитория ограничена).
		   or exists (select 1 from workspaces where avatar_media_id = $1)`,
		mediaID, userID,
	).Scan(&allowed)
	if err != nil {
		m.logger.Warn("media acl check failed", slog.String("error", err.Error()), slog.String("media_id", mediaID.String()))
		return false
	}
	if allowed {
		return true
	}
	rows, err := m.db.Query(ctx, `select distinct msg.channel_id from message_attachments ma join messages msg on msg.id=ma.message_id join channels c on c.id=msg.channel_id where ma.media_id=$1 and c.workspace_id is not null`, mediaID)
	if err != nil {
		return false
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return false
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false
	}
	access, err := channelacl.VisibleChannels(ctx, m.db, ids, []uuid.UUID{userID})
	if err != nil {
		return false
	}
	for _, id := range ids {
		if access[userID][id] {
			return true
		}
	}
	return false
}

func safeFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "file"
	}
	name = filepath.Base(name)
	name = safeFilenameRE.ReplaceAllString(name, "_")
	name = strings.Trim(name, "._")
	if name == "" {
		return "file"
	}
	if len(name) > 120 {
		name = name[len(name)-120:]
	}
	return name
}

func safeHeaderValue(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r < 0x20 || r == 0x7f {
			return '_'
		}
		return r
	}, s)
}

func isThumbnailable(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	switch ct {
	case "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}

func sniffByExt(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == "" {
		return ""
	}
	if mt := mime.TypeByExtension(ext); mt != "" {
		return mt
	}
	return ""
}
