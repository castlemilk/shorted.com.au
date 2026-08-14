package news

import (
	"context"
	"fmt"
	"html"
	"log"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const digestDefaultSiteURL = "https://shorted.com.au"

// thumbWidth is the display width (px) of a digest card thumbnail. The proxy
// renders it at 2x (3:2), so 120 → a 240x160 source shown as 120x80.
const thumbWidth = 120

// digestCfg carries the per-run config needed to build absolute, signed URLs.
type digestCfg struct {
	siteURL   string // public origin, no trailing slash (PUBLIC_SITE_URL)
	imgSecret string // EMAIL_IMG_SECRET; empty => text-only cards (no thumbnails)
}

func loadDigestCfg() digestCfg {
	site := strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_SITE_URL")), "/")
	if site == "" {
		site = digestDefaultSiteURL
	}
	return digestCfg{siteURL: site, imgSecret: os.Getenv("EMAIL_IMG_SECRET")}
}

// digestItem is one row in the digest (a news article or an editorial take).
type digestItem struct {
	title    string
	url      string
	imageURL string // upstream image; "" => no thumbnail
	source   string // byline (news host, or "Shorted newsroom")
}

// hostOf returns the bare host (sans www.) for a byline, or "".
func hostOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Host), "www.")
}

// isHTTPURL reports whether s is a safe absolute http(s) link. Article URLs come
// from untrusted RSS feeds, so we only emit an <a> when the scheme is http(s)
// (guards against e.g. javascript: URLs), mirroring emailImageURL's image guard.
func isHTTPURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// renderCardHTML renders one email-safe (table-based) card. When the item has a
// usable image it gets a left thumbnail via the signed proxy; otherwise a
// single-cell text card (never a broken image).
func renderCardHTML(cfg digestCfg, it digestItem) string {
	title := html.EscapeString(it.title)
	source := html.EscapeString(it.source)
	linked := isHTTPURL(it.url)
	href := html.EscapeString(it.url)

	const titleStyle = "color:#f4f6fa;font-size:15px;font-weight:600;text-decoration:none;line-height:1.4"
	titleHTML := fmt.Sprintf(`<span style="%s">%s</span>`, titleStyle, title)
	if linked {
		titleHTML = fmt.Sprintf(`<a href="%s" style="%s">%s</a>`, href, titleStyle, title)
	}
	titleCell := titleHTML + fmt.Sprintf(`<div style="color:#8b97a8;font-size:12px;margin-top:6px">%s</div>`, source)

	const shell = `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;background:#111826;border:1px solid #233044;border-radius:8px">%s</table>`

	var thumb string
	if it.imageURL != "" {
		thumb = emailImageURL(cfg.siteURL, cfg.imgSecret, it.imageURL, thumbWidth)
	}
	if thumb == "" {
		return fmt.Sprintf(shell,
			fmt.Sprintf(`<tr><td style="padding:12px 14px;vertical-align:top">%s</td></tr>`, titleCell))
	}
	img := fmt.Sprintf(`<img src="%s" width="120" height="80" alt="" style="display:block;border:0;width:120px;height:80px;border-radius:8px 0 0 8px"/>`, html.EscapeString(thumb))
	if linked {
		img = fmt.Sprintf(`<a href="%s">%s</a>`, href, img)
	}
	row := fmt.Sprintf(
		`<tr>`+
			`<td width="120" style="padding:0;vertical-align:top">%s</td>`+
			`<td style="padding:10px 14px;vertical-align:top">%s</td>`+
			`</tr>`,
		img, titleCell)
	return fmt.Sprintf(shell, row)
}

// renderCardText renders one plaintext-alternative line.
func renderCardText(it digestItem) string {
	if it.source != "" {
		return fmt.Sprintf("- %s — %s\n  %s\n", it.title, it.source, it.url)
	}
	return fmt.Sprintf("- %s\n  %s\n", it.title, it.url)
}

// buildDigestBody assembles the full HTML + text body from the collected items.
// Pure (no DB) so it's unit-testable and reusable by the preview harness.
func buildDigestBody(cfg digestCfg, news, takes []digestItem) (htmlBody, textBody string) {
	var h, t strings.Builder
	h.WriteString(`<h2 style="font-size:18px;color:#f4f6fa;margin:8px 0 12px">Top news</h2>`)
	t.WriteString("Top news\n")
	for _, it := range news {
		h.WriteString(renderCardHTML(cfg, it))
		t.WriteString(renderCardText(it))
	}
	if len(takes) > 0 {
		h.WriteString(`<h2 style="font-size:18px;color:#f4f6fa;margin:24px 0 12px">From the newsroom</h2>`)
		t.WriteString("\nFrom the newsroom\n")
		for _, it := range takes {
			h.WriteString(renderCardHTML(cfg, it))
			t.WriteString(renderCardText(it))
		}
	}
	return h.String(), t.String()
}

// runDigest assembles the past 7 days' top news (cluster primaries only) and
// new published editorial takes into a draft 'news_digest' broadcast row, each
// as an image card. Idempotent on ISO week via the unique (type, source_ref).
func runDigest(ctx context.Context, db *pgxpool.Pool) error {
	cfg := loadDigestCfg()
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	year, week := time.Now().UTC().ISOWeek()
	weekRef := fmt.Sprintf("%d-W%02d", year, week)

	// Top news from the last 7 days: cluster primaries only (or unclustered).
	// NB: the column is `headline` (migration 000023) — not `title`. The old
	// `SELECT title` silently failed at runtime, aborting the whole digest.
	newsRows, err := db.Query(cctx, `
		SELECT headline, url, COALESCE(image_url, '') FROM news_articles
		WHERE published_at > now() - interval '7 days'
		  AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
		ORDER BY published_at DESC LIMIT 10`)
	if err != nil {
		return fmt.Errorf("digest: query news_articles: %w", err)
	}
	var news []digestItem
	for newsRows.Next() {
		var title, articleURL, imageURL string
		if err := newsRows.Scan(&title, &articleURL, &imageURL); err != nil {
			newsRows.Close()
			return fmt.Errorf("digest: scan news row: %w", err)
		}
		news = append(news, digestItem{
			title:    title,
			url:      articleURL,
			imageURL: imageURL,
			source:   hostOf(articleURL),
		})
	}
	newsRows.Close()
	if err := newsRows.Err(); err != nil {
		return fmt.Errorf("digest: iterate news rows: %w", err)
	}

	if len(news) == 0 {
		log.Printf("digest: no news in the last 7 days; skipping broadcast for %s", weekRef)
		return nil
	}

	// Published editorial takes from the last 7 days, with hero/og image.
	takeRows, err := db.Query(cctx, `
		SELECT headline, slug, COALESCE(hero_image_url, og_image_url, '') FROM editorial_takes
		WHERE published_at > now() - interval '7 days'
		  AND published_at IS NOT NULL
		ORDER BY published_at DESC LIMIT 5`)
	if err != nil {
		return fmt.Errorf("digest: query editorial_takes: %w", err)
	}
	var takes []digestItem
	for takeRows.Next() {
		var headline, slug, imageURL string
		if err := takeRows.Scan(&headline, &slug, &imageURL); err != nil {
			takeRows.Close()
			return fmt.Errorf("digest: scan takes row: %w", err)
		}
		takes = append(takes, digestItem{
			title:    headline,
			url:      cfg.siteURL + "/news/" + slug,
			imageURL: imageURL,
			source:   "Shorted newsroom",
		})
	}
	takeRows.Close()
	if err := takeRows.Err(); err != nil {
		return fmt.Errorf("digest: iterate takes rows: %w", err)
	}

	subject := fmt.Sprintf("Shorted weekly: the short side this week (%s)", weekRef)
	htmlBody, textBody := buildDigestBody(cfg, news, takes)

	_, err = db.Exec(cctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ('news_digest', $1, $2, $3, $4)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
		subject, htmlBody, textBody, weekRef)
	if err != nil {
		return fmt.Errorf("digest: insert broadcast: %w", err)
	}

	log.Printf("digest: created draft broadcast for %s (%d news, %d takes)", weekRef, len(news), len(takes))
	return nil
}
