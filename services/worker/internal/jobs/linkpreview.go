// Wave 2 — link-preview runner. Забирает задачи из link_preview_jobs,
// перечитывает body сообщения, выдёргивает до 3 http(s)-URL, тянет каждую
// страницу (с SSRF-guard'ом и лимитами) и парсит OpenGraph-мету. Результат —
// jsonb-массив в messages.link_previews + realtime-событие
// `message.previews.updated` (scope-aware: workspace-фанаут либо per-user
// для DM — та же семантика, что publishScope в core-api).
//
// Безопасность: воркер ходит по URL'ам, которые прислали пользователи.
// ssrfSafeDial резолвит хост сам и отказывает приватным/loopback/link-local
// адресам — иначе юзер мог бы заставить воркер сканировать внутреннюю сеть
// (а резолв+dial по конкретному IP закрывает и DNS-rebinding). Картинки НЕ
// скачиваем — клиент хотлинкает og:image напрямую (компромисс MVP: внешний
// сайт видит IP читателя; проксирование через MinIO — отдельная задача).
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/net/html"

	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/libs/shared-go/realtimebus"
	"github.com/NotReptile/Cirvo/libs/shared-go/redisstore"
)

const (
	maxPreviewsPerMessage = 3
	maxFetchBytes         = 512 * 1024
	fetchTimeout          = 8 * time.Second
)

var linkURLRe = regexp.MustCompile(`https?://[^\s<>"']+`)

type linkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	ImageURL    string `json:"imageUrl,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
}

type LinkPreviewJob struct {
	ID        uuid.UUID
	MessageID uuid.UUID
	Attempts  int
}

type LinkPreviewRunner struct {
	logger    *slog.Logger
	db        *postgres.Pool
	publisher *realtimebus.Publisher
	client    *http.Client
}

func NewLinkPreviewRunner(logger *slog.Logger, db *postgres.Pool, redis *redisstore.Client) *LinkPreviewRunner {
	var pub *realtimebus.Publisher
	if redis != nil {
		pub = realtimebus.NewPublisher(redis, db)
	}
	return &LinkPreviewRunner{
		logger:    logger,
		db:        db,
		publisher: pub,
		client: &http.Client{
			Timeout: fetchTimeout,
			Transport: &http.Transport{
				DialContext:         ssrfSafeDial,
				TLSHandshakeTimeout: 5 * time.Second,
				MaxIdleConns:        4,
			},
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 4 {
					return errors.New("too many redirects")
				}
				return nil
			},
		},
	}
}

func (r *LinkPreviewRunner) Run(ctx context.Context) {
	r.logger.Info("link-preview loop ready")
	lastHeartbeat := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			r.logger.Info("link-preview worker stopped")
			return
		}
		job, ok, err := r.claim(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				r.logger.Error("link-preview claim failed", "error", err)
			}
			if !sleep(ctx, pollIdle) {
				return
			}
			continue
		}
		if !ok {
			if time.Since(lastHeartbeat) >= heartbeatMin {
				r.logger.Info("link-preview worker heartbeat")
				lastHeartbeat = time.Now()
			}
			if !sleep(ctx, pollIdle) {
				return
			}
			continue
		}
		r.process(ctx, job)
		if !sleep(ctx, pollActive) {
			return
		}
	}
}

func (r *LinkPreviewRunner) claim(ctx context.Context) (LinkPreviewJob, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var job LinkPreviewJob
	err := r.db.QueryRow(ctx, `
		update link_preview_jobs
		set status = 'running',
		    started_at = now(),
		    attempts = attempts + 1
		where id = (
		  select id from link_preview_jobs
		  where status = 'pending' and scheduled_at <= now()
		  order by scheduled_at
		  for update skip locked
		  limit 1
		)
		returning id, message_id, attempts
	`).Scan(&job.ID, &job.MessageID, &job.Attempts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return LinkPreviewJob{}, false, nil
		}
		return LinkPreviewJob{}, false, err
	}
	return job, true, nil
}

func (r *LinkPreviewRunner) process(parent context.Context, job LinkPreviewJob) {
	ctx, cancel := context.WithTimeout(parent, jobTimeout)
	defer cancel()

	if err := r.handle(ctx, job); err != nil {
		r.logger.Warn("link-preview job failed", "id", job.ID, "attempt", job.Attempts, "error", err)
		terminal := job.Attempts >= maxAttempts
		r.failGeneric(parent, "link_preview_jobs", job.ID, job.Attempts, err, terminal)
		return
	}
	r.markDoneGeneric(parent, "link_preview_jobs", job.ID)
}

func (r *LinkPreviewRunner) handle(ctx context.Context, job LinkPreviewJob) error {
	var (
		body        string
		channelID   uuid.UUID
		workspaceID *uuid.UUID
	)
	err := r.db.QueryRow(ctx, `
		select m.body, m.channel_id, c.workspace_id
		from messages m
		join channels c on c.id = m.channel_id
		where m.id = $1 and m.deleted_at is null
	`, job.MessageID).Scan(&body, &channelID, &workspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // сообщение удалили до обработки — джоба done
		}
		return fmt.Errorf("load message: %w", err)
	}

	urls := extractPreviewURLs(body)
	previews := make([]linkPreview, 0, len(urls))
	for _, u := range urls {
		p, err := r.fetchPreview(ctx, u)
		if err != nil {
			r.logger.Debug("link-preview fetch skipped", "url", u, "error", err)
			continue
		}
		if p.Title == "" && p.Description == "" && p.ImageURL == "" {
			continue // страница без OG/title — карточка была бы пустой
		}
		previews = append(previews, p)
	}

	if len(previews) == 0 {
		// Чистим возможные старые превью (правка убрала ссылки/сайт лёг).
		_, err := r.db.Exec(ctx, `update messages set link_previews = null where id = $1`, job.MessageID)
		return err
	}

	encoded, err := json.Marshal(previews)
	if err != nil {
		return fmt.Errorf("marshal previews: %w", err)
	}
	if _, err := r.db.Exec(ctx,
		`update messages set link_previews = $1 where id = $2`, encoded, job.MessageID,
	); err != nil {
		return fmt.Errorf("store previews: %w", err)
	}

	r.publishPreviews(ctx, channelID, workspaceID, job.MessageID, encoded)
	return nil
}

func (r *LinkPreviewRunner) publishPreviews(ctx context.Context, channelID uuid.UUID, workspaceID *uuid.UUID, messageID uuid.UUID, previews json.RawMessage) {
	if r.publisher == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"channelId":    channelID.String(),
		"messageId":    messageID.String(),
		"linkPreviews": previews,
	})
	if workspaceID != nil {
		_ = r.publisher.Publish(context.Background(), realtimebus.Event{
			Event:       "message.previews.updated",
			WorkspaceID: workspaceID.String(),
			ChannelID:   channelID.String(),
			Payload:     payload,
		})
		return
	}
	// DM: per-user fanout по channel_members (как publishScope в core-api).
	rows, err := r.db.Query(ctx, `select user_id from channel_members where channel_id = $1`, channelID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var uid uuid.UUID
		if rows.Scan(&uid) != nil {
			continue
		}
		_ = r.publisher.Publish(context.Background(), realtimebus.Event{
			Event:     "message.previews.updated",
			UserID:    uid.String(),
			ChannelID: channelID.String(),
			Payload:   payload,
		})
	}
}

// extractPreviewURLs — до 3 уникальных http(s)-URL из тела, с обрезкой
// хвостовой пунктуации (синхронно с клиентским автолинком).
func extractPreviewURLs(body string) []string {
	matches := linkURLRe.FindAllString(body, -1)
	seen := make(map[string]struct{}, len(matches))
	out := make([]string, 0, maxPreviewsPerMessage)
	for _, raw := range matches {
		u := strings.TrimRight(raw, ".,!?;:)]")
		if _, ok := seen[u]; ok {
			continue
		}
		seen[u] = struct{}{}
		out = append(out, u)
		if len(out) >= maxPreviewsPerMessage {
			break
		}
	}
	return out
}

func (r *LinkPreviewRunner) fetchPreview(ctx context.Context, rawURL string) (linkPreview, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return linkPreview{}, err
	}
	req.Header.Set("User-Agent", "Cirvo-LinkPreview/1.0 (+self-hosted)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := r.client.Do(req)
	if err != nil {
		return linkPreview{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return linkPreview{}, fmt.Errorf("status %d", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml") {
		return linkPreview{}, fmt.Errorf("not html: %s", ct)
	}

	// html.Parse терпим к обрезанному документу — лимит безопасен.
	doc, err := html.Parse(io.LimitReader(resp.Body, maxFetchBytes))
	if err != nil {
		return linkPreview{}, err
	}

	p := linkPreview{URL: rawURL}
	var plainTitle, metaDescription string
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "meta":
				var prop, name, content string
				for _, a := range n.Attr {
					switch strings.ToLower(a.Key) {
					case "property":
						prop = strings.ToLower(a.Val)
					case "name":
						name = strings.ToLower(a.Val)
					case "content":
						content = strings.TrimSpace(a.Val)
					}
				}
				if content == "" {
					break
				}
				switch prop {
				case "og:title":
					p.Title = clampPreviewText(content, 200)
				case "og:description":
					p.Description = clampPreviewText(content, 400)
				case "og:image", "og:image:url", "og:image:secure_url":
					if p.ImageURL == "" {
						p.ImageURL = resolvePreviewImage(rawURL, content)
					}
				case "og:site_name":
					p.SiteName = clampPreviewText(content, 100)
				}
				if name == "description" && metaDescription == "" {
					metaDescription = clampPreviewText(content, 400)
				}
			case "title":
				if plainTitle == "" && n.FirstChild != nil && n.FirstChild.Type == html.TextNode {
					plainTitle = clampPreviewText(strings.TrimSpace(n.FirstChild.Data), 200)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	if p.Title == "" {
		p.Title = plainTitle
	}
	if p.Description == "" {
		p.Description = metaDescription
	}
	return p, nil
}

func clampPreviewText(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

// resolvePreviewImage — og:image бывает относительным; резолвим против
// страницы. Не-http(s) схемы отбрасываем.
func resolvePreviewImage(pageURL, img string) string {
	imgU, err := url.Parse(img)
	if err != nil {
		return ""
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return ""
	}
	abs := base.ResolveReference(imgU)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return ""
	}
	return abs.String()
}

// ssrfSafeDial — резолвит хост и соединяется с первым ПУБЛИЧНЫМ адресом.
// Приватные/loopback/link-local/multicast отклоняются целиком. Дial по
// конкретному проверенному IP (а не по имени) закрывает DNS-rebinding.
func ssrfSafeDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	for _, ip := range ips {
		if isForbiddenIP(ip) {
			return nil, fmt.Errorf("blocked address %s for host %s", ip, host)
		}
	}
	var lastErr error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no addresses for %s", host)
	}
	return nil, lastErr
}

func isForbiddenIP(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified()
}

// markDoneGeneric/failGeneric — те же done/fail, что у notification-runner'а,
// но с параметризованной таблицей (имя таблицы — литерал из кода, не ввод).
func (r *LinkPreviewRunner) markDoneGeneric(ctx context.Context, table string, id uuid.UUID) {
	ctx, cancel := context.WithTimeout(detach(ctx), 5*time.Second)
	defer cancel()
	_, err := r.db.Exec(ctx,
		`update `+table+` set status = 'done', finished_at = now(), last_error = null where id = $1`, id)
	if err != nil {
		r.logger.Error("could not mark link-preview job done", "id", id, "error", err)
		return
	}
	r.logger.Info("link-preview job done", "id", id)
}

func (r *LinkPreviewRunner) failGeneric(ctx context.Context, table string, id uuid.UUID, attempts int, jobErr error, terminal bool) {
	ctx, cancel := context.WithTimeout(detach(ctx), 5*time.Second)
	defer cancel()
	status := "pending"
	scheduledAt := time.Now().Add(backoff(attempts))
	if terminal {
		status = "failed"
	}
	_, err := r.db.Exec(ctx,
		`update `+table+`
		 set status = $1, last_error = $2, scheduled_at = $3,
		     finished_at = case when $1 = 'failed' then now() else null end
		 where id = $4`,
		status, jobErr.Error(), scheduledAt, id)
	if err != nil {
		r.logger.Error("could not mark link-preview job failed", "id", id, "error", err)
	}
}
