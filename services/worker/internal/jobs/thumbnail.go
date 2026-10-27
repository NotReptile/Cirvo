package jobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"strings"

	_ "image/gif"
	_ "image/png"

	"github.com/jackc/pgx/v5"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/NotReptile/Cirvo/libs/shared-go/objectstore"
	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
)

const (
	thumbMaxSide = 512
	thumbQuality = 80
)

type ThumbnailHandler struct {
	logger *slog.Logger
	db     *postgres.Pool
	store  *objectstore.Client
}

func NewThumbnailHandler(logger *slog.Logger, db *postgres.Pool, store *objectstore.Client) *ThumbnailHandler {
	return &ThumbnailHandler{logger: logger, db: db, store: store}
}

func (h *ThumbnailHandler) Kind() string { return "thumbnail" }

func (h *ThumbnailHandler) Handle(ctx context.Context, job Job) error {
	var (
		objectKey   string
		contentType string
	)
	err := h.db.QueryRow(ctx,
		`select object_key, content_type from media_objects where id = $1`,
		job.MediaID,
	).Scan(&objectKey, &contentType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("media not found")
		}
		return fmt.Errorf("media lookup: %w", err)
	}
	if !isImage(contentType) {
		return fmt.Errorf("unsupported content-type %q", contentType)
	}

	src, err := h.fetch(ctx, objectKey)
	if err != nil {
		return fmt.Errorf("fetch source: %w", err)
	}

	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return fmt.Errorf("decode image: %w", err)
	}

	thumb := resize(img, thumbMaxSide)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: thumbQuality}); err != nil {
		return fmt.Errorf("encode jpeg: %w", err)
	}

	thumbKey := objectKey + ".thumb.jpg"
	if err := h.store.Put(ctx, thumbKey, &buf, int64(buf.Len()), "image/jpeg"); err != nil {
		return fmt.Errorf("upload thumbnail: %w", err)
	}

	tb := thumb.Bounds()
	_, err = h.db.Exec(ctx,
		`update media_objects
		 set thumbnail_object_key = $1, thumbnail_width = $2, thumbnail_height = $3
		 where id = $4`,
		thumbKey, tb.Dx(), tb.Dy(), job.MediaID,
	)
	if err != nil {
		return fmt.Errorf("update media row: %w", err)
	}
	return nil
}

func (h *ThumbnailHandler) fetch(ctx context.Context, objectKey string) ([]byte, error) {
	rc, err := h.store.Get(ctx, objectKey)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func resize(src image.Image, maxSide int) image.Image {
	b := src.Bounds()
	w, hh := b.Dx(), b.Dy()
	if w <= maxSide && hh <= maxSide {
		return src
	}
	var nw, nh int
	if w >= hh {
		nw = maxSide
		nh = hh * maxSide / w
	} else {
		nh = maxSide
		nw = w * maxSide / hh
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.BiLinear.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}

func isImage(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	switch ct {
	case "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}
