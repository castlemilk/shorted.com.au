package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// runDigest assembles the past 7 days' top news (cluster primaries only) and
// new published editorial takes into a draft 'news_digest' broadcast row.
// It is idempotent on ISO week via the unique index on (type, source_ref).
func runDigest(ctx context.Context, db *pgxpool.Pool) error {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	year, week := time.Now().UTC().ISOWeek()
	weekRef := fmt.Sprintf("%d-W%02d", year, week)

	// Top news from the last 7 days: cluster primaries only (or unclustered).
	newsRows, err := db.Query(cctx, `
		SELECT title, url FROM news_articles
		WHERE published_at > now() - interval '7 days'
		  AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
		ORDER BY published_at DESC LIMIT 10`)
	if err != nil {
		return fmt.Errorf("digest: query news_articles: %w", err)
	}
	var news, newsText strings.Builder
	n := 0
	for newsRows.Next() {
		var title, url string
		if err := newsRows.Scan(&title, &url); err != nil {
			newsRows.Close()
			return fmt.Errorf("digest: scan news row: %w", err)
		}
		fmt.Fprintf(&news, `<li><a href="%s">%s</a></li>`, url, title)
		fmt.Fprintf(&newsText, "- %s (%s)\n", title, url)
		n++
	}
	newsRows.Close()
	if err := newsRows.Err(); err != nil {
		return fmt.Errorf("digest: iterate news rows: %w", err)
	}

	if n == 0 {
		log.Printf("digest: no news in the last 7 days; skipping broadcast for %s", weekRef)
		return nil
	}

	// Published editorial takes from the last 7 days.
	// editorial_takes columns: headline (title), slug, published_at.
	takeRows, err := db.Query(cctx, `
		SELECT headline, slug FROM editorial_takes
		WHERE published_at > now() - interval '7 days'
		  AND published_at IS NOT NULL
		ORDER BY published_at DESC LIMIT 5`)
	if err != nil {
		return fmt.Errorf("digest: query editorial_takes: %w", err)
	}
	var takes, takesText strings.Builder
	for takeRows.Next() {
		var headline, slug string
		if err := takeRows.Scan(&headline, &slug); err != nil {
			takeRows.Close()
			return fmt.Errorf("digest: scan takes row: %w", err)
		}
		fmt.Fprintf(&takes, `<li><a href="https://shorted.com.au/news/%s">%s</a></li>`, slug, headline)
		fmt.Fprintf(&takesText, "- %s (https://shorted.com.au/news/%s)\n", headline, slug)
	}
	takeRows.Close()
	if err := takeRows.Err(); err != nil {
		return fmt.Errorf("digest: iterate takes rows: %w", err)
	}

	subject := fmt.Sprintf("Shorted weekly: the short side this week (%s)", weekRef)
	html := "<h2>Top news</h2><ul>" + news.String() + "</ul>"
	text := "Top news\n" + newsText.String()
	if takes.Len() > 0 {
		html += "<h2>From the newsroom</h2><ul>" + takes.String() + "</ul>"
		text += "\nFrom the newsroom\n" + takesText.String()
	}

	_, err = db.Exec(cctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ('news_digest', $1, $2, $3, $4)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
		subject, html, text, weekRef)
	if err != nil {
		return fmt.Errorf("digest: insert broadcast: %w", err)
	}

	log.Printf("digest: created draft broadcast for %s (%d news items)", weekRef, n)
	return nil
}
