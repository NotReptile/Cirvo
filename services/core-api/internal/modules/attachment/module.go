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

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/libs/shared-go/objectstore"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

const (
	maxUploadBytes = 25 * 1024 * 1024 // 25 MiB
	streamCopyBuf  = 64 * 1024
)

var safeFilenameRE = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

type Module struct {
	db     *postgres.Pool
	store  *objectstore.Client
	logger *slog.Logger
}

func NewModule(db *postgres.Pool, store *objectstore.Client, logger *slog.Logger) *Module {
	return &Module{db: db, store: store, logger: logger}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("POST /api/v1/uploads", m.handleUpload)
	router.Protected("GET /api/v1/media/{mediaId}", m.handleDownload)
	router.Protected("GET /api/v1/media/{mediaId}/thumb", m.handleThumbnail)
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
	if m.store == nil {
		sharedhttp.WriteError(w, r, http.StatusServiceUnavailable, sharedhttp.CodeInternal, "object storage is not configured")
		return
	}
	userID := authctx.MustUserID(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+4096)
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
	if header.Size <= 0 || header.Size > maxUploadBytes {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "file too large or empty")
		return
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

	if err := m.store.Put(r.Context(), objectKey, file, header.Size, contentType); err != nil {
		m.logger.Warn("upload to object store failed", slog.String("error", err.Error()))
		sharedhttp.WriteError(w, r, http.StatusBadGateway, sharedhttp.CodeInternal, "could not store object")
		return
	}

	tx, err := m.db.Begin(r.Context())
	if err != nil {
		_ = m.store.Remove(context.Background(), objectKey)
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	now := time.Now().UTC()
	_, err = tx.Exec(r.Context(),
		`insert into media_objects (id, object_key, bucket, content_type, size_bytes, original_filename, uploaded_by_user_id, created_at)
		 values ($1, $2, $3, $4, $5, nullif($6, ''), $7, $8)`,
		mediaID, objectKey, m.store.Bucket(), contentType, header.Size, header.Filename, userID, now,
	)
	if err != nil {
		_ = m.store.Remove(context.Background(), objectKey)
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
		_ = m.store.Remove(context.Background(), objectKey)
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
		_ = m.store.Remove(context.Background(), objectKey)
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
	if m.store == nil {
		sharedhttp.WriteError(w, r, http.StatusServiceUnavailable, sharedhttp.CodeInternal, "object storage is not configured")
		return
	}
	_ = authctx.MustUserID(r.Context())
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
	)
	err = m.db.QueryRow(r.Context(),
		`select object_key, content_type, size_bytes, original_filename
		 from media_objects where id = $1`,
		mediaID,
	).Scan(&objectKey, &contentType, &sizeBytes, &filename)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
		return
	}

	reader, err := m.store.Get(r.Context(), objectKey)
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
	if m.store == nil {
		sharedhttp.WriteError(w, r, http.StatusServiceUnavailable, sharedhttp.CodeInternal, "object storage is not configured")
		return
	}
	_ = authctx.MustUserID(r.Context())
	rawID := r.PathValue("mediaId")
	mediaID, err := uuid.Parse(rawID)
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "invalid media id")
		return
	}

	var (
		thumbKey  *string
		origKey   string
		origCT    string
		origSize  int64
	)
	err = m.db.QueryRow(r.Context(),
		`select thumbnail_object_key, object_key, content_type, size_bytes
		 from media_objects where id = $1`,
		mediaID,
	).Scan(&thumbKey, &origKey, &origCT, &origSize)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			sharedhttp.WriteError(w, r, http.StatusNotFound, sharedhttp.CodeResourceNotFound, "media not found")
			return
		}
		sharedhttp.WriteError(w, r, http.StatusInternalServerError, sharedhttp.CodeInternal, "database error")
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

	reader, err := m.store.Get(r.Context(), objectKey)
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
