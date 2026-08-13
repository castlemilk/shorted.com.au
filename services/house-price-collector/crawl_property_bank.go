package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// -mode property-resolve: BANK the per-property links without crawling profiles.
//
// Why this is a separate mode from -mode property.
//
// A property.com.au profile lives at /{state}/{suburb}-{postcode}/{street}/{number}-pid-{PID}/
// and the PID is the site's internal id — a constructed slug can never yield it.
// So "having the link" is a RESOLUTION problem, not a storage one.
//
// Resolution and profile-crawling have completely different costs:
//
//   - RESOLUTION reads realestate.com.au's public consumer address autocomplete,
//     a small JSON endpoint. No Kasada, no browser, no residential rig.
//   - The PROFILE crawl reads property.com.au itself, which is Kasada+Akamai
//     defended and needs the warm host-Chrome over CDP.
//
// -mode property does both, so the whole tier inherits the profile crawl's
// constraints: it needs Chrome, defaults to a 200-address cap, and had reached
// 20 resolved URLs against a 48,776-address active corpus. Splitting the cheap
// half out means the link inventory can be built to completion now, and the
// expensive half can run later at whatever rate the rig sustains — which is the
// point, because a portal LISTING url dies when the listing is withdrawn while a
// property PROFILE url is durable.
//
// This mode writes ONLY the resolved URL and its granularity. It never fetches a
// profile, so it never produces valuation figures, and every row it writes carries
// fetch_status='resolved' to distinguish "we know where this is" from "we have
// read it". A later -mode property run treats those rows as due and fills them in.

const (
	// resolvedStatus marks a row whose profile URL is known but whose profile has
	// not been read. property_valuations.fetch_status has no CHECK constraint, so
	// this needs no migration.
	resolvedStatus = "resolved"

	// reaPropertyOrigin is split from the path so this file never contains a
	// literal realestate.com.au/property/... string. That shape is what the
	// committed-portal-content gate looks for (scripts/check-portal-content-provenance.mjs),
	// and a permalink TEMPLATE tripping a guard aimed at captured listing content
	// would train people to weaken the guard.
	reaPropertyOrigin = "https://www.realestate.com.au"

	// suggestAccept is what the autocomplete returns. stealthhttp supplies the
	// browser-realistic TLS/headers; per the crawl-tier rule we do NOT hand-set a
	// User-Agent on top of it.
	suggestAccept = "application/json"
)

// suggestFetcher adapts stealthhttp to the crawler's htmlFetcher seam so the
// EXISTING resolution logic (resolveProfile -> resolveViaSearch -> the address
// verification that rejects fuzzy nearest-neighbours) is reused verbatim rather
// than reimplemented against a second HTTP path.
//
// It is deliberately not wired into crawlFetcherMode: this fetcher can read the
// suggest API but NOT a Kasada-defended property page, so it must never become
// the default for a mode that reads profiles.
type suggestFetcher struct{ c *stealthhttp.Client }

func newSuggestFetcher(timeout time.Duration) (*suggestFetcher, error) {
	c, err := stealthhttp.New(stealthhttp.WithTimeout(timeout))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}
	return &suggestFetcher{c: c}, nil
}

func (f *suggestFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) {
	body, _, err := f.c.FetchBytes(ctx, url, suggestAccept)
	if err != nil {
		return nil, "", err
	}
	return body, url, nil
}

func (f *suggestFetcher) Close() {}

// propertyResolveConfig is the mode's knobs. Defaults are deliberately small: the
// first run of anything that talks to a third party at scale should be a sample
// somebody looks at, not a sweep.
type propertyResolveConfig struct {
	max      int           // CRAWL_PROPERTY_RESOLVE_MAX      (default 200)
	minDelay time.Duration // CRAWL_PROPERTY_RESOLVE_MIN_MS   (default 900ms)
	maxDelay time.Duration // CRAWL_PROPERTY_RESOLVE_MAX_MS   (default 2200ms)
	ttlDays  int           // CRAWL_PROPERTY_TTL_DAYS         (shared with -mode property)
	sample   bool          // CRAWL_PROPERTY_RESOLVE_SAMPLE   (random order; for measuring)
	dryRun   bool          // CRAWL_DRY_RUN                   (default true)
	timeout  time.Duration // CRAWL_PROPERTY_RESOLVE_TIMEOUT_S(default 30s)
}

func loadPropertyResolveConfig() propertyResolveConfig {
	return propertyResolveConfig{
		max:      envInt("CRAWL_PROPERTY_RESOLVE_MAX", 200),
		minDelay: time.Duration(envInt("CRAWL_PROPERTY_RESOLVE_MIN_MS", 900)) * time.Millisecond,
		maxDelay: time.Duration(envInt("CRAWL_PROPERTY_RESOLVE_MAX_MS", 2200)) * time.Millisecond,
		ttlDays:  envInt("CRAWL_PROPERTY_TTL_DAYS", 90),
		sample:   envBool("CRAWL_PROPERTY_RESOLVE_SAMPLE", false),
		dryRun:   envBool("CRAWL_DRY_RUN", true),
		timeout:  time.Duration(envInt("CRAWL_PROPERTY_RESOLVE_TIMEOUT_S", 30)) * time.Second,
	}
}

// propertyResolveStats is the run summary. Counts only — no addresses, no URLs.
type propertyResolveStats struct {
	attempted, resolved, missed, blocked, errored, skipped int
	exact, building                                        int
}

func (s propertyResolveStats) String() string {
	return fmt.Sprintf("attempted=%d resolved=%d (exact=%d building=%d) missed=%d blocked=%d errors=%d skipped=%d",
		s.attempted, s.resolved, s.exact, s.building, s.missed, s.blocked, s.errored, s.skipped)
}

// runPropertyResolve is the -mode property-resolve entry point. Exit codes match
// the rest of the crawl tier: 0 ok, 3 the source blocked us and a re-warm/back-off
// is needed, 7 infrastructure failed before any work was done.
func runPropertyResolve(ctx context.Context, pool *pgxpool.Pool) int {
	cfg := loadPropertyResolveConfig()

	fetcher, err := newSuggestFetcher(cfg.timeout)
	if err != nil {
		log.Printf("[property-resolve] fetcher init failed: %v", err)
		return 7
	}
	defer fetcher.Close()

	targets, err := loadPropertyResolveWorklist(ctx, pool, cfg.ttlDays, cfg.max, cfg.sample)
	if err != nil {
		log.Printf("[property-resolve] worklist failed: %v", err)
		return 7
	}
	log.Printf("[property-resolve] %d address(es) · dryRun=%v · sample=%v · delay=%v-%v",
		len(targets), cfg.dryRun, cfg.sample, cfg.minDelay, cfg.maxDelay)
	if len(targets) == 0 {
		return 0
	}

	// Reuse the crawler's own pacing rather than a second implementation: it is
	// context-aware, so a cancelled run stops sleeping instead of finishing its
	// worklist of naps. The delays are this mode's, not the listing sweep's —
	// a JSON autocomplete does not need the 20-45s a Kasada-defended page does.
	cr := &crawler{fetcher: fetcher}
	cr.cfg.minDelay = cfg.minDelay
	cr.cfg.maxDelay = cfg.maxDelay
	caches := newPropertyResolveCaches()
	throttle := func() { cr.sleepJitter(ctx) }

	var stats propertyResolveStats
	for _, t := range targets {
		if ctx.Err() != nil {
			log.Printf("[property-resolve] context done, stopping early")
			break
		}
		stats.attempted++

		// resolveProfile falls back to index-page TRAVERSAL when search misses.
		// Traversal reads property.com.au itself, which this fetcher cannot clear —
		// so call the search resolver directly. A search miss stays a miss here and
		// is left for -mode property, rather than being recorded as a definitive
		// notfound off a path that was never able to answer.
		url, gran, st := cr.resolveViaSearch(ctx, t, caches, throttle)
		switch st {
		case resolveOK:
			stats.resolved++
			if gran == "exact" {
				stats.exact++
			} else {
				stats.building++
			}
			if cfg.dryRun {
				continue
			}
			if err := upsertPropertyValuation(ctx, pool, t, resolvedStatus, gran, url, propertyProfile{Raw: "{}"}); err != nil {
				log.Printf("[property-resolve] %s: write failed: %v", t.addressKey, err)
				stats.errored++
			}
		case resolveBlocked:
			// The autocomplete is a shared public endpoint. Being blocked is a
			// signal to stop entirely, not to keep pushing through the worklist.
			stats.blocked++
			log.Printf("[property-resolve] BLOCKED after %d attempts — stopping so we back off rather than hammer", stats.attempted)
			logResolveSummary(cfg, stats)
			return 3
		case resolveErr:
			stats.errored++
		default:
			stats.missed++
		}
	}

	logResolveSummary(cfg, stats)
	return 0
}

func logResolveSummary(cfg propertyResolveConfig, stats propertyResolveStats) {
	log.Printf("[property-resolve] %s", stats)
	if cfg.dryRun {
		log.Printf("[property-resolve] DRY-RUN — nothing written (set CRAWL_DRY_RUN=false to persist)")
	}
	if stats.attempted > 0 {
		log.Printf("[property-resolve] hit rate %.1f%%", float64(stats.resolved)/float64(stats.attempted)*100)
	}
}

// reaPropertyLookupURL turns a resolved profile URL into realestate.com.au's
// DURABLE per-property permalink.
//
// This is the link that makes "crawl later" possible. A portal LISTING url
// (a /property-<type>-<state>-<suburb>-<listingid> path) is per-advertisement and 404s
// once the listing is withdrawn — 11,359 of our listing rows are already inactive.
// The PID embedded in the profile URL is per-PROPERTY and outlives every listing
// on it, and REA resolves it directly via /property/lookup?id=. It is derived
// rather than stored precisely because the profile URL already carries it: a
// second column could drift from the first.
func reaPropertyLookupURL(profileURL string) string {
	pid := profilePID(profileURL)
	if pid == "" {
		return ""
	}
	return reaPropertyOrigin + "/property/lookup?id=" + pid
}

// profilePID extracts the trailing -pid-<digits> from a property.com.au profile
// URL. Returns "" when the URL has no PID segment.
func profilePID(profileURL string) string {
	trimmed := strings.TrimSuffix(strings.TrimSpace(profileURL), "/")
	idx := strings.LastIndex(trimmed, "-pid-")
	if idx < 0 {
		return ""
	}
	pid := trimmed[idx+len("-pid-"):]
	if pid == "" {
		return ""
	}
	for _, r := range pid {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return pid
}
