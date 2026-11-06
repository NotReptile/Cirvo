package objectstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ErrNotConfigured: учётные данные MinIO не заданы, повторные попытки бессмысленны.
var ErrNotConfigured = errors.New("object storage is not configured")

// Client wraps a configured MinIO client tied to a single bucket.
type Client struct {
	mc     *minio.Client
	bucket string
}

// ConnectFromEnv reads MINIO_ENDPOINT, MINIO_ACCESS_KEY/MINIO_ROOT_USER,
// MINIO_SECRET_KEY/MINIO_ROOT_PASSWORD, MINIO_BUCKET and MINIO_USE_SSL.
// It creates the bucket if missing.
func ConnectFromEnv(ctx context.Context) (*Client, error) {
	endpoint := strings.TrimSpace(os.Getenv("MINIO_ENDPOINT"))
	if endpoint == "" {
		endpoint = "127.0.0.1:9000"
	}
	access := firstNonEmpty(os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_ROOT_USER"))
	secret := firstNonEmpty(os.Getenv("MINIO_SECRET_KEY"), os.Getenv("MINIO_ROOT_PASSWORD"))
	if access == "" || secret == "" {
		return nil, fmt.Errorf("%w: MINIO_ACCESS_KEY/MINIO_SECRET_KEY (or MINIO_ROOT_USER/MINIO_ROOT_PASSWORD) must be set", ErrNotConfigured)
	}
	bucket := strings.TrimSpace(os.Getenv("MINIO_BUCKET"))
	if bucket == "" {
		bucket = "rucord"
	}
	useSSL := strings.EqualFold(strings.TrimSpace(os.Getenv("MINIO_USE_SSL")), "true")

	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(access, secret, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio init: %w", err)
	}

	exists, err := mc.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("bucket check: %w", err)
	}
	if !exists {
		if err := mc.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("create bucket: %w", err)
		}
	}

	return &Client{mc: mc, bucket: bucket}, nil
}

// Bucket returns the bucket name this client is bound to.
func (c *Client) Bucket() string { return c.bucket }

// Put streams the reader into the bucket under objectKey with the given
// content type and total size. size may be -1 for unknown length.
func (c *Client) Put(ctx context.Context, objectKey string, reader io.Reader, size int64, contentType string) error {
	_, err := c.mc.PutObject(ctx, c.bucket, objectKey, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return fmt.Errorf("put object: %w", err)
	}
	return nil
}

// Get returns an io.ReadCloser for objectKey. Caller must Close it.
func (c *Client) Get(ctx context.Context, objectKey string) (io.ReadCloser, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get object: %w", err)
	}
	if _, err := obj.Stat(); err != nil {
		_ = obj.Close()
		return nil, fmt.Errorf("stat object: %w", err)
	}
	return obj, nil
}

// Remove deletes an object. Missing objects are not an error.
func (c *Client) Remove(ctx context.Context, objectKey string) error {
	return c.mc.RemoveObject(ctx, c.bucket, objectKey, minio.RemoveObjectOptions{})
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
