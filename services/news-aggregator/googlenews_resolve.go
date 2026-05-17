package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// googleNewsCandidate is a news_articles row whose url is a Google News
// redirect that we want to resolve to its source article URL.
type googleNewsCandidate struct {
	id  string
	url string
}

// ResolveGoogleNewsOpts controls the resolve run.
type ResolveGoogleNewsOpts struct {
	Limit       int
	Concurrency int
	DryRun      bool
	UpdateURL   bool // If true, replace url with resolved URL too (not just image)
}

// ResolveGoogleNews finds news_articles rows with googlenews URLs that
// lack an image_url, follows the redirect to the publisher's article,
// scrapes og:image, and updates the row. By default also rewrites the
// url to the resolved publisher URL so future visits hit the source
// directly rather than Google's redirector.
func ResolveGoogleNews(ctx context.Context, db *pgxpool.Pool, opts ResolveGoogleNewsOpts) error {
	if opts.Concurrency <= 0 {
		opts.Concurrency = 4
	}
	if opts.Limit <= 0 {
		opts.Limit = 500
	}

	// Pull candidates: googlenews-source rows still missing image_url.
	rows, err := db.Query(ctx, `
		SELECT id::text, url
		FROM news_articles
		WHERE source = 'googlenews'
		  AND image_url IS NULL
		  AND url LIKE 'https://news.google.com/%'
		ORDER BY published_at DESC
		LIMIT $1
	`, opts.Limit)
	if err != nil {
		return fmt.Errorf("query candidates: %w", err)
	}
	defer rows.Close()

	var candidates []googleNewsCandidate
	for rows.Next() {
		var c googleNewsCandidate
		if err := rows.Scan(&c.id, &c.url); err != nil {
			return fmt.Errorf("scan candidate: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate candidates: %w", err)
	}

	log.Printf("ResolveGoogleNews: %d candidates, concurrency=%d, dry_run=%v, update_url=%v",
		len(candidates), opts.Concurrency, opts.DryRun, opts.UpdateURL)
	if len(candidates) == 0 {
		return nil
	}

	// Stealth client with redirect-follow enabled.
	client, err := stealthhttp.New(
		stealthhttp.WithTimeout(20*time.Second),
		stealthhttp.WithMaxRedirects(8),
	)
	if err != nil {
		return fmt.Errorf("init stealth client: %w", err)
	}
	defer func() { _ = client.Close() }()

	var (
		mu        sync.Mutex
		processed int
		resolved  int
		withImage int
		failed    int
	)

	work := make(chan googleNewsCandidate, opts.Concurrency*2)
	var wg sync.WaitGroup
	for i := 0; i < opts.Concurrency; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for c := range work {
				fetchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				body, finalURL, fetchErr := client.FetchBytes(fetchCtx, c.url, "text/html, */*")
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
							p, len(candidates), workerID, c.url, fetchErr)
					}
					continue
				}

				// finalURL is the URL after redirects. If it still points
				// at news.google.com the resolver failed (Google sometimes
				// serves an interstitial page).
				resolvedURL := strings.TrimSpace(finalURL)
				if resolvedURL == "" || strings.Contains(resolvedURL, "news.google.com") {
					// Try to parse the resolved URL from a meta refresh on
					// the body before giving up.
					if alt := metaRefreshURL(body); alt != "" {
						resolvedURL = alt
					}
				}

				if resolvedURL == "" || strings.Contains(resolvedURL, "news.google.com") {
					mu.Lock()
					failed++
					mu.Unlock()
					continue
				}

				mu.Lock()
				resolved++
				mu.Unlock()

				img := extractOGImage(body)
				if img == "" && resolvedURL != c.url {
					// If the first body was an interstitial, re-fetch the
					// resolved URL directly to find the og:image.
					fetchCtx2, cancel2 := context.WithTimeout(ctx, 20*time.Second)
					body2, _, err2 := client.FetchBytes(fetchCtx2, resolvedURL, "text/html, */*")
					cancel2()
					if err2 == nil {
						img = extractOGImage(body2)
					}
				}

				if img == "" {
					continue
				}

				if opts.DryRun {
					log.Printf("  [%d/%d] %s -> %s (img=%s)", p, len(candidates), c.url, resolvedURL, img)
					mu.Lock()
					withImage++
					mu.Unlock()
					continue
				}

				updateCtx, updateCancel := context.WithTimeout(ctx, 5*time.Second)
				var qErr error
				if opts.UpdateURL {
					_, qErr = db.Exec(updateCtx,
						`UPDATE news_articles
						 SET image_url = $1, image_pulled_at = NOW(), url = $2
						 WHERE id = $3 AND image_url IS NULL`,
						img, resolvedURL, c.id,
					)
				} else {
					_, qErr = db.Exec(updateCtx,
						`UPDATE news_articles
						 SET image_url = $1, image_pulled_at = NOW()
						 WHERE id = $2 AND image_url IS NULL`,
						img, c.id,
					)
				}
				updateCancel()
				if qErr != nil {
					log.Printf("  [%d/%d] update failed for %s: %v", p, len(candidates), c.id, qErr)
					continue
				}

				mu.Lock()
				withImage++
				mu.Unlock()
				if p%50 == 0 {
					log.Printf("  [%d/%d] resolved=%d withImage=%d", p, len(candidates), resolved, withImage)
				}
			}
		}(i)
	}

	for _, c := range candidates {
		work <- c
	}
	close(work)
	wg.Wait()

	log.Printf("ResolveGoogleNews done: processed=%d resolved=%d withImage=%d failed=%d",
		processed, resolved, withImage, failed)
	return nil
}

// metaRefreshURL extracts the destination URL from an HTML meta refresh
// tag, used by some interstitial pages.
func metaRefreshURL(body []byte) string {
	const headLimit = 32 * 1024
	if len(body) > headLimit {
		body = body[:headLimit]
	}
	lower := strings.ToLower(string(body))
	idx := strings.Index(lower, "http-equiv=\"refresh\"")
	if idx < 0 {
		return ""
	}
	rest := string(body[idx:])
	urlIdx := strings.Index(strings.ToLower(rest), "url=")
	if urlIdx < 0 {
		return ""
	}
	tail := rest[urlIdx+4:]
	end := strings.IndexAny(tail, "\"'>")
	if end < 0 {
		return ""
	}
	u := strings.TrimSpace(tail[:end])
	if _, err := url.Parse(u); err != nil {
		return ""
	}
	return u
}
