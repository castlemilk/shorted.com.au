package main

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// articleNeedingImage is a row we'll try to enrich with an og:image scrape.
type articleNeedingImage struct {
	id     string
	url    string
	source string
}

// ogImageRegexes try multiple meta-tag patterns. We don't need a real HTML
// parser for this — articles uniformly emit og:image at a known shape.
var ogImageRegexes = []*regexp.Regexp{
	regexp.MustCompile(`(?i)<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']`),
	regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']`),
	regexp.MustCompile(`(?i)<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']`),
	regexp.MustCompile(`(?i)<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']`),
}

// extractOGImage returns the first og:image (or fallback meta) URL it finds
// in the response body. Empty string if none.
func extractOGImage(body []byte) string {
	// Only scan the first 200KB — og tags live near the top of <head>.
	const headLimit = 200 * 1024
	if len(body) > headLimit {
		body = body[:headLimit]
	}
	for _, re := range ogImageRegexes {
		if m := re.FindSubmatch(body); len(m) >= 2 {
			candidate := strings.TrimSpace(string(m[1]))
			if candidate == "" {
				continue
			}
			// Skip data: URIs and obvious tracking pixels
			lower := strings.ToLower(candidate)
			if strings.HasPrefix(lower, "data:") {
				continue
			}
			if strings.Contains(lower, "spacer") || strings.Contains(lower, "pixel.gif") {
				continue
			}
			return candidate
		}
	}
	return ""
}

// BackfillImagesOpts controls the backfill run.
type BackfillImagesOpts struct {
	Limit       int      // Max articles to process
	Concurrency int      // Parallel scrapers
	Sources     []string // If non-empty, only process these sources
	SkipSources []string // Always skip these (e.g. googlenews redirects)
	DryRun      bool
}

// BackfillImages scrapes og:image from existing article URLs that have no
// image_url and updates the row. Uses stealthhttp to avoid most anti-bot
// defenses. googlenews URLs are skipped — they're redirects through Google
// and the resolved target is what matters.
func BackfillImages(ctx context.Context, db *pgxpool.Pool, opts BackfillImagesOpts) error {
	if opts.Concurrency <= 0 {
		opts.Concurrency = 4
	}
	if opts.Limit <= 0 {
		opts.Limit = 1000
	}

	// Build candidate query. Filter by source if requested.
	query := `SELECT id::text, url, source
		FROM news_articles
		WHERE image_url IS NULL`
	args := []interface{}{}
	argIdx := 1
	if len(opts.Sources) > 0 {
		query += fmt.Sprintf(" AND source = ANY($%d)", argIdx)
		args = append(args, opts.Sources)
		argIdx++
	}
	if len(opts.SkipSources) > 0 {
		query += fmt.Sprintf(" AND source <> ALL($%d)", argIdx)
		args = append(args, opts.SkipSources)
		argIdx++
	}
	query += fmt.Sprintf(" ORDER BY published_at DESC LIMIT $%d", argIdx)
	args = append(args, opts.Limit)

	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("query candidates: %w", err)
	}
	defer rows.Close()

	var candidates []articleNeedingImage
	for rows.Next() {
		var a articleNeedingImage
		if err := rows.Scan(&a.id, &a.url, &a.source); err != nil {
			return fmt.Errorf("scan candidate: %w", err)
		}
		candidates = append(candidates, a)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate candidates: %w", err)
	}

	log.Printf("BackfillImages: %d candidates, concurrency=%d, dry_run=%v",
		len(candidates), opts.Concurrency, opts.DryRun)
	if len(candidates) == 0 {
		return nil
	}

	// One stealth client shared across workers — it manages its own connection
	// pool internally.
	client, err := stealthhttp.New(
		stealthhttp.WithTimeout(15*time.Second),
		stealthhttp.WithMaxRedirects(5),
	)
	if err != nil {
		return fmt.Errorf("init stealth client: %w", err)
	}
	defer func() { _ = client.Close() }()

	var (
		mu        sync.Mutex
		processed int
		found     int
		failed    int
	)

	work := make(chan articleNeedingImage, opts.Concurrency*2)
	var wg sync.WaitGroup
	for i := 0; i < opts.Concurrency; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for a := range work {
				fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				body, _, fetchErr := client.FetchBytes(fetchCtx, a.url, "text/html, */*")
				cancel()

				mu.Lock()
				processed++
				p := processed
				mu.Unlock()

				if fetchErr != nil {
					mu.Lock()
					failed++
					mu.Unlock()
					if p%50 == 0 {
						log.Printf("  [%d/%d] worker %d: fetch %s: %v",
							p, len(candidates), workerID, a.url, fetchErr)
					}
					continue
				}

				img := extractOGImage(body)
				if img == "" {
					if p%50 == 0 {
						log.Printf("  [%d/%d] no og:image on %s", p, len(candidates), a.url)
					}
					continue
				}

				if opts.DryRun {
					log.Printf("  [%d/%d] %s -> %s", p, len(candidates), a.url, img)
					mu.Lock()
					found++
					mu.Unlock()
					continue
				}

				updateCtx, updateCancel := context.WithTimeout(ctx, 5*time.Second)
				_, err := db.Exec(updateCtx,
					`UPDATE news_articles SET image_url = $1, image_pulled_at = NOW() WHERE id = $2 AND image_url IS NULL`,
					img, a.id,
				)
				updateCancel()
				if err != nil {
					log.Printf("  [%d/%d] update failed for %s: %v", p, len(candidates), a.id, err)
					continue
				}

				mu.Lock()
				found++
				mu.Unlock()
				if p%50 == 0 {
					log.Printf("  [%d/%d] %d found so far", p, len(candidates), found)
				}
			}
		}(i)
	}

	for _, a := range candidates {
		work <- a
	}
	close(work)
	wg.Wait()

	log.Printf("BackfillImages done: processed=%d found=%d failed=%d", processed, found, failed)
	return nil
}
