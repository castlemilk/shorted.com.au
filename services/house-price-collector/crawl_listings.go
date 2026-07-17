package main

import (
	"bytes"
	"context"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/jackc/pgx/v5/pgxpool"
)

// runListings is the -mode=listings entry point: a peer of the suburb-median
// crawl (runCrawl) that instead sweeps portal SEARCH-results pages for individual
// for-sale listings, diffs each listing's asking price across runs, and records
// price-drop/rise/relist/delist events. Like the median crawl it drives the SAME
// headed host-Chrome-over-CDP fetcher (the only client that beats Kasada/Akamai
// from a residential IP), paces heavily, self-throttles via the per-site circuit
// breaker, defaults to dry-run, and is opt-in / residential-rig only. Raw rows are
// proprietary-tos-restricted; only the derived mv_suburb_price_drops is public.

type sweepStatus int

const (
	// sweepComplete: paged to an empty or duplicate (clamped) page — the whole
	// suburb was seen, so absent listings may be safely delisted.
	sweepComplete sweepStatus = iota
	// sweepPartial: real data, but the page cap was hit / a late page failed —
	// update what we saw, delist NOTHING.
	sweepPartial
	// sweepBlocked: nothing believable (block/poison/empty page 1) — touch nothing.
	sweepBlocked
)

func (s sweepStatus) String() string {
	switch s {
	case sweepComplete:
		return "complete"
	case sweepPartial:
		return "partial"
	default:
		return "blocked"
	}
}

// suburbSweep is the outcome of sweeping one (source, suburb): the deduped
// listings found across pages, the trust classification, and pages fetched.
type suburbSweep struct {
	listings []RawListing
	status   sweepStatus
	pages    int
}

type listingsConfig struct {
	crawlConfig                 // embeds cdpURL, minDelay/maxDelay, dryRun, maxConsecBlocks, fetchTimeout, profileDir, maxSuburbs
	maxPages      int           // CRAWL_LISTINGS_MAX_PAGES      (default 5)
	maxPagesHard  int           // CRAWL_LISTINGS_MAX_PAGES_HARD (default maxPages*3) — absolute ceiling softPageCap may grow into
	minPerPage    int           // CRAWL_LISTINGS_MIN_PER_PAGE   (default 5)
	minNewPerPage int           // CRAWL_LISTINGS_MIN_NEW_PER_PAGE (default 1) — yield-decay floor
	pageMinDelay  time.Duration // CRAWL_LISTINGS_PAGE_MIN_MS   (default 8000)
	pageMaxDelay  time.Duration // CRAWL_LISTINGS_PAGE_MAX_MS   (default 20000)
	noiseAbs      float64       // CRAWL_LISTINGS_NOISE_ABS      (default 5000)
	noisePct      float64       // CRAWL_LISTINGS_NOISE_PCT      (default 0.005 == 0.5%)
	delistGrace   int           // CRAWL_LISTINGS_DELIST_GRACE   (default 2)
	// resumeWindow gates the checkpoint/resume cursor (crawl_resume.go): a
	// (source,suburb) swept within this window of "now" is skipped. Defaults to
	// 0 == DISABLED (today's behaviour: always sweep every selected target) —
	// set CRAWL_LISTINGS_RESUME_WINDOW_H (a recommended value is 20, i.e. 20h)
	// to opt in.
	resumeWindow time.Duration // CRAWL_LISTINGS_RESUME_WINDOW_H (default 0/disabled)
	// traceCfg gates the debug-trace mode (crawl_trace.go): off by default
	// (CRAWL_TRACE unset and CRAWL_TRACE_DIR empty) — see loadTraceConfig.
	traceCfg traceConfig
	// fixtureDir, when set, reads pages from saved HTML files instead of driving a
	// browser — for offline testing/seeding against captured real pages.
	fixtureDir string // CRAWL_LISTINGS_FIXTURE_DIR
	// CRAWL_LISTINGS_SOURCES allowlist (default rea+domain)
	sources map[string]bool
	// Per-source circuit breaker (crawl_circuit.go, -mode agent only): after
	// circuitTrip consecutive blocked sweeps of a source, that source is skipped
	// for an exponentially-growing cooldown (circuitBase, doubling up to
	// circuitMax) so a portal that starts blocking isn't hammered on every suburb.
	circuitTrip int           // CRAWL_CIRCUIT_TRIP    (default 2)
	circuitBase time.Duration // CRAWL_CIRCUIT_BASE_S  (default 300s = 5m)
	circuitMax  time.Duration // CRAWL_CIRCUIT_MAX_S   (default 3600s = 60m)
}

func loadListingsConfig() listingsConfig {
	maxPages := envInt("CRAWL_LISTINGS_MAX_PAGES", 5)
	return listingsConfig{
		crawlConfig:   loadCrawlConfig(),
		maxPages:      maxPages,
		maxPagesHard:  envInt("CRAWL_LISTINGS_MAX_PAGES_HARD", maxPages*3),
		minPerPage:    envInt("CRAWL_LISTINGS_MIN_PER_PAGE", 5),
		minNewPerPage: envInt("CRAWL_LISTINGS_MIN_NEW_PER_PAGE", 1),
		pageMinDelay:  time.Duration(envInt("CRAWL_LISTINGS_PAGE_MIN_MS", 8000)) * time.Millisecond,
		pageMaxDelay:  time.Duration(envInt("CRAWL_LISTINGS_PAGE_MAX_MS", 20000)) * time.Millisecond,
		noiseAbs:      envFloat("CRAWL_LISTINGS_NOISE_ABS", 5000),
		noisePct:      envFloat("CRAWL_LISTINGS_NOISE_PCT", 0.005),
		delistGrace:   envInt("CRAWL_LISTINGS_DELIST_GRACE", 2),
		resumeWindow:  time.Duration(envInt("CRAWL_LISTINGS_RESUME_WINDOW_H", 0)) * time.Hour,
		traceCfg:      loadTraceConfig(),
		fixtureDir:    os.Getenv("CRAWL_LISTINGS_FIXTURE_DIR"),
		sources:       parseListingsSources(),
		circuitTrip:   envInt("CRAWL_CIRCUIT_TRIP", 2),
		circuitBase:   time.Duration(envInt("CRAWL_CIRCUIT_BASE_S", 300)) * time.Second,
		circuitMax:    time.Duration(envInt("CRAWL_CIRCUIT_MAX_S", 3600)) * time.Second,
	}
}

// parseListingsSources reads CRAWL_LISTINGS_SOURCES (comma-separated, case-
// insensitive, trimmed) and returns the set of enabled listing sources. An
// unset/empty var, or one with no valid tokens, defaults to BOTH sources
// (rea+domain) — the crawl must never silently enable zero sources.
func parseListingsSources() map[string]bool {
	both := map[string]bool{"rea": true, "domain": true}

	raw := os.Getenv("CRAWL_LISTINGS_SOURCES")
	if strings.TrimSpace(raw) == "" {
		return both
	}

	out := map[string]bool{}
	for _, tok := range strings.Split(raw, ",") {
		tok = strings.ToLower(strings.TrimSpace(tok))
		if tok == "rea" || tok == "domain" {
			out[tok] = true
		}
	}
	if len(out) == 0 {
		return both
	}
	return out
}

// sourceEnabled reports whether the given source ("rea" or "domain") is in
// the active allowlist.
func (c listingsConfig) sourceEnabled(src string) bool {
	return c.sources[src]
}

// enabledSourceNames returns the enabled source names, sorted, for
// deterministic startup logging.
func enabledSourceNames(sources map[string]bool) []string {
	names := make([]string, 0, len(sources))
	for src, enabled := range sources {
		if enabled {
			names = append(names, src)
		}
	}
	sort.Strings(names)
	return names
}

// fileFetcher reads pages from saved HTML files (offline mode). A URL maps to a
// deterministic filename; a missing file (e.g. page 2) returns an empty page so
// the sweep ends cleanly. Satisfies crawlFetcher.
type fileFetcher struct{ dir string }

func (f *fileFetcher) fetch(_ context.Context, url string) ([]byte, string, error) {
	b, err := os.ReadFile(filepath.Join(f.dir, fixtureFilename(url)))
	if err != nil {
		return []byte("<html><body></body></html>"), url, nil
	}
	return b, url, nil
}
func (f *fileFetcher) Close() {}

// fixtureFilename derives a stable file name from a search URL, dropping the query
// so page-2+ re-serve page-1's file (a duplicate page → the sweep completes).
//
//	https://www.domain.com.au/sale/bondi-nsw-2026/?page=2 -> domain-sale-bondi-nsw-2026.html
func fixtureFilename(rawurl string) string {
	src := "rea"
	if strings.Contains(rawurl, "domain.com.au") {
		src = "domain"
	}
	u := rawurl
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
	}
	if i := strings.IndexByte(u, '/'); i >= 0 {
		u = u[i:]
	} else {
		u = "/"
	}
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	var b strings.Builder
	for _, r := range strings.ToLower(u) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return src + "-" + strings.Trim(b.String(), "-") + ".html"
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

type listingsStats struct {
	suburbs, pages, seen, newListings, drops, rises, relisted, delisted, statusChanges, blockedSweeps int
	// addressRelistDrops/addressRelistRises count price_drop/price_rise events
	// fired by addressPriceMove (crawl_listings_diff.go) — a brand-new
	// listing_id at a known address, priced against that address's most recent
	// active listing across ANY listing_id/source. Tracked separately from
	// drops/rises (which are listing_id-level moves on a listing we already
	// track) so the relist-driven signal is visible in the run summary.
	addressRelistDrops, addressRelistRises int
}

type listingsCrawler struct {
	fetcher   htmlFetcher
	cfg       listingsConfig
	reaBlocks int
	domBlocks int
	stats     listingsStats
	// tel is the optional LIVE telemetry stream (crawl_telemetry.go); nil (or a
	// disabled writer) is a no-op. Set by -mode agent so the co-located macOS
	// agent UI can tail extraction + failures in-flight.
	tel *telemetryWriter
}

// runListings returns true when the run detected that the browser profile needs a
// human to re-warm its anti-bot clearance (the per-source circuit breaker tripped).
func runListings(ctx context.Context, pool *pgxpool.Pool) bool {
	cfg := loadListingsConfig()

	var fetcher crawlFetcher
	if cfg.fixtureDir != "" {
		fetcher = &fileFetcher{dir: cfg.fixtureDir}
		log.Printf("[listings] FIXTURE mode: reading pages from %s (no browser)", cfg.fixtureDir)
	} else {
		f, err := newCrawlFetcher(cfg.crawlConfig)
		if err != nil {
			log.Printf("[listings] crawl fetcher init failed (%v) — aborting (non-fatal; official backbone unaffected)", err)
			_ = updateRun(ctx, pool, "listings_rea", nil, 0, "error", "fetcher init: "+err.Error())
			return false
		}
		fetcher = f
	}
	defer fetcher.Close()

	lc := &listingsCrawler{fetcher: fetcher, cfg: cfg}

	targets := selectTargets(crawlTargets, cfg.crawlConfig)

	runTs := time.Now().UTC()

	// Ensure region rows exist (the listings FK target) before any insert.
	if !cfg.dryRun {
		if err := upsertRegions(ctx, pool, listingRegionObs(targets)); err != nil {
			log.Printf("[listings] region upsert failed: %v", err)
			_ = updateRun(ctx, pool, "listings_rea", nil, 0, "error", "region upsert: "+err.Error())
			return false
		}
	}

	log.Printf("[listings] start: %d suburbs · %s · maxPages=%d · dryRun=%v · sources=%s", len(targets), crawlFetcherMode(cfg.crawlConfig), cfg.maxPages, cfg.dryRun, strings.Join(enabledSourceNames(cfg.sources), ","))

	// Checkpoint/resume: OFF unless CRAWL_LISTINGS_RESUME_WINDOW_H is set. When
	// enabled, load the last-swept snapshot ONCE and skip any (source,suburb)
	// swept within the window — never silently: every skip is logged.
	rs, resumeErr := loadResumeSnapshot(ctx, pool, cfg.resumeWindow)
	if resumeErr != nil {
		log.Printf("[listings] resume snapshot load failed (%v) — resume disabled for this run", resumeErr)
	} else if cfg.resumeWindow > 0 {
		log.Printf("[listings] resume window=%s — %d (source,suburb) pair(s) loaded", cfg.resumeWindow, len(rs))
	}

	reaEvents, domEvents := 0, 0
	for i, t := range targets {
		if i > 0 {
			jitterSleep(ctx, cfg.minDelay, cfg.maxDelay)
		}
		lc.stats.suburbs++
		if cfg.sourceEnabled("rea") {
			if rs.shouldSkipTarget("rea", t, runTs, cfg.resumeWindow) {
				log.Printf("[listings] %s rea: skipped (swept within the resume window)", t.Display)
			} else {
				reaEvents += lc.crawlSuburbSource(ctx, pool, t, "rea", t.reaSearchURL, &lc.reaBlocks, runTs)
			}
		}
		if cfg.sourceEnabled("domain") {
			if rs.shouldSkipTarget("domain", t, runTs, cfg.resumeWindow) {
				log.Printf("[listings] %s domain: skipped (swept within the resume window)", t.Display)
			} else {
				domEvents += lc.crawlSuburbSource(ctx, pool, t, "domain", t.domainSearchURL, &lc.domBlocks, runTs)
			}
		}
	}

	if cfg.dryRun {
		log.Printf("[listings] dry-run: nothing written")
	} else {
		if n, err := linkSuburbSalCodes(ctx, pool); err != nil {
			log.Printf("[listings] suburb sal_code link failed: %v", err)
		} else if n > 0 {
			log.Printf("[listings] linked %d suburb region(s) to sal_code", n)
		}
		if n, err := linkListingSalCodes(ctx, pool); err != nil {
			log.Printf("[listings] listing sal_code link failed: %v", err)
		} else if n > 0 {
			log.Printf("[listings] linked %d listing(s) to sal_code", n)
		}
		if err := refreshHousingMV(ctx, pool); err != nil {
			log.Printf("[listings] mv refresh failed: %v", err)
		}
		_ = updateRun(ctx, pool, "listings_rea", nil, reaEvents, "ok", "")
		_ = updateRun(ctx, pool, "listings_domain", nil, domEvents, "ok", "")
	}

	rewarm := needsRewarm(cfg.maxConsecBlocks, lc.reaBlocks, lc.domBlocks)
	if rewarm {
		if !cfg.dryRun {
			_ = updateRun(ctx, pool, "listings_rewarm", nil, 0, "needs_rewarm", "circuit breaker tripped — re-warm the crawl Chrome profile")
		}
		log.Printf("[listings] REWARM REQUIRED: circuit breaker tripped (rea=%d dom=%d ≥ %d) — re-warm the dedicated Chrome profile by hand",
			lc.reaBlocks, lc.domBlocks, cfg.maxConsecBlocks)
	}

	s := lc.stats
	log.Printf("[listings] done: suburbs=%d pages=%d listings=%d new=%d drops=%d rises=%d relisted=%d delisted=%d status=%d blockedSweeps=%d addressRelistDrops=%d addressRelistRises=%d events(rea=%d,domain=%d)",
		s.suburbs, s.pages, s.seen, s.newListings, s.drops, s.rises, s.relisted, s.delisted, s.statusChanges, s.blockedSweeps, s.addressRelistDrops, s.addressRelistRises, reaEvents, domEvents)
	return rewarm
}

// crawlSuburbSource sweeps one source for one suburb and (unless dry-run, or the
// sweep was blocked) diffs it into events. Returns the number of events written.
func (lc *listingsCrawler) crawlSuburbSource(ctx context.Context, pool *pgxpool.Pool, t CrawlTarget, source string, urlFor func(int) string, blockCounter *int, runTs time.Time) int {
	lc.tel.suburbStart(t.Display, source)
	sweep := lc.sweepSuburbSource(ctx, t, source, urlFor, blockCounter)
	lc.stats.pages += sweep.pages
	lc.stats.seen += len(sweep.listings)
	if sweep.status == sweepBlocked {
		lc.stats.blockedSweeps++
		lc.tel.failure(t.Display, source, "blocked/poison sweep", map[string]any{"pages": sweep.pages})
		lc.tel.suburbDone(t.Display, source, 0, 0, sweep.status.String())
	}

	if lc.cfg.dryRun {
		lc.logDryRun(t, source, sweep)
		return 0
	}
	if sweep.status == sweepBlocked {
		return 0
	}
	// Stream each extracted listing live (the "intelligent extraction info").
	for i := range sweep.listings {
		lc.tel.listing(t.Display, source, sweep.listings[i])
	}
	n, err := lc.diffSuburb(ctx, pool, t, source, sweep, runTs)
	if err != nil {
		log.Printf("[listings] %s %s: diff error: %v", t.Display, source, err)
		lc.tel.failure(t.Display, source, "diff error", map[string]any{"err": err.Error()})
		return 0
	}
	if n > 0 {
		log.Printf("[listings] %s %s: %d event(s) from %d listing(s) (%s)", t.Display, source, n, len(sweep.listings), sweep.status)
	}
	lc.tel.suburbDone(t.Display, source, len(sweep.listings), n, sweep.status.String())
	return n
}

// sweepSuburbSource walks the paginated search results for one suburb, extracting
// and target-filtering listings, and classifies the sweep (complete/partial/
// blocked) — the classification that governs whether delisting is safe.
//
// Before fetching, softPageCap derives a per-suburb page ceiling from
// t.Dwellings (a coarse population/dwelling-count hint — see CrawlTarget),
// bounded by cfg.maxPagesHard. This softCap is the operative ceiling for the
// REST of this function wherever cfg.maxPages appeared before Task 6 — for a
// suburb with no hint (Dwellings==0, the whole catalog today), softCap ==
// cfg.maxPages exactly, so nothing changes until real hints are populated.
//
// Page 1's PageMeta (the portal's own totalResultsCount/totalPages/pageSize —
// see extractPageMeta) then bounds the walk. When meta.OnTargetResults is
// available (REA only — the SRP blob's exact on-target "listings_total", as
// opposed to the broadened totalResultsCount; see PageMeta's doc comment),
// wantPages = clamp(ceil(OnTargetResults/PageSize), 1, softCap) — sized off
// the REAL on-target inventory, not the broadened count, so a small suburb
// stops after 1-2 pages and a dense one is sized to its true on-target page
// count. Otherwise (Domain, or REA when OnTargetResults is unavailable)
// wantPages = clamp(meta.TotalPages, 1, softCap) — but meta.TotalPages is
// itself the BROADENED count (confirmed live: New Farm reports
// TotalResults≈969(REA)/608(Domain) while on-target inventory is only
// ~54-65), so for a genuinely large/broadened suburb meta.TotalPages is
// always >= softCap and this clamp is a no-op (identical to today's
// behaviour, no over-fetch risk) — it only SHORTENS the walk for suburbs
// whose portal-reported extent is smaller than the cap.
//
// Three natural-stop paths additionally use PageMeta to upgrade a sweepPartial
// to the delist-safe sweepComplete (see upgradeIfPageMetaConfirms): (a) below,
// when the walk reaches wantPages cleanly with no natural-end signal (a
// "capped-complete" sweep — we saw everything the portal itself said
// existed); (b) when a later page hits the broadening/poison gate; (c) when a
// later page hits yield decay (near-zero NEW ids). For (b)/(c), pages <
// wantPages confirms we stopped well short of the portal's own reported
// extent, i.e. we saw the whole on-target suburb before the surrounds began.
// When PageMeta.OK is false (extraction failed / portal changed shape),
// wantPages falls back to softCap and every classification falls back to
// today's behaviour exactly — nothing regresses.
func (lc *listingsCrawler) sweepSuburbSource(ctx context.Context, t CrawlTarget, source string, urlFor func(int) string, blockCounter *int) suburbSweep {
	if *blockCounter >= lc.cfg.maxConsecBlocks {
		return suburbSweep{status: sweepBlocked} // breaker open: stop hammering this source
	}

	// Debug-trace mode (crawl_trace.go): off by default, a zero-cost no-op
	// writer when disabled or this suburb isn't wanted (CRAWL_TRACE_SUBURB).
	tw := newTraceWriter(lc.cfg.traceCfg, t.Display, source)

	softCap := softPageCap(t.Dwellings, lc.cfg.maxPagesHard, lc.cfg.maxPages)

	collected := map[string]RawListing{}
	var prevSig string
	pages := 0
	wantPages := softCap
	metaOK := false
	totalResults := 0    // PageMeta.TotalResults once page 1's meta is read, for the trace record only
	onTargetResults := 0 // PageMeta.OnTargetResults once page 1's meta is read (REA only), for the trace record only

	// Block-risk pacing signals: consecBlocksAtEntry is a MEDIUM-term signal
	// (how many consecutive blocks this source already racked up entering this
	// sweep — fixed for the whole sweep, since a block THIS sweep ends the
	// function immediately, never leaving a nonzero *blockCounter to read
	// mid-loop); lastMismatch is an IMMEDIATE, page-by-page signal (updated
	// below after every page). See paceBounds.
	consecBlocksAtEntry := *blockCounter
	lastMismatch := 0.0
	baseDelay := paceRange{lo: lc.cfg.pageMinDelay, hi: lc.cfg.pageMaxDelay}

	// finish wraps finishSweep with the trace summary write, so every return
	// path below is guaranteed to emit summary.json when tracing is on.
	finish := func(status sweepStatus) suburbSweep {
		sw := finishSweep(collected, pages, status)
		tw.WriteSummary(traceSummary{Suburb: t.Display, Source: source, Pages: sw.pages, Listings: len(sw.listings), Status: status.String()})
		return sw
	}

	for page := 1; page <= wantPages; page++ {
		if page > 1 {
			delay := paceBounds(consecBlocksAtEntry, lastMismatch, baseDelay)
			jitterSleep(ctx, delay.lo, delay.hi)
		}
		fetchStart := time.Now()
		html, finalURL, outcome := fetchAndClassify(ctx, lc.fetcher, urlFor(page))
		fetchMs := time.Since(fetchStart).Milliseconds()
		pages++
		if outcome == outcomeBlocked {
			*blockCounter++
			status := blockedOrPartial(len(collected))
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), WantPages: wantPages, Outcome: "blocked", Status: status.String(), Decision: "stop-blocked"})
			return finish(status)
		}
		if outcome == outcomeError {
			status := blockedOrPartial(len(collected))
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, WantPages: wantPages, Outcome: "error", Status: status.String(), Decision: "stop-error"})
			return finish(status)
		}
		*blockCounter = 0
		_ = finalURL
		tw.WriteHTML(page, html)

		doc, err := goquery.NewDocumentFromReader(bytes.NewReader(html))
		if err != nil {
			status := blockedOrPartial(len(collected))
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), WantPages: wantPages, Outcome: "ok", Status: status.String(), Decision: "stop-parse-error"})
			return finish(status)
		}

		// Trace-only, and only ever attempted when the active fetcher implements
		// pageScreenshotter (cdpFetcher — see crawl_cdp.go); a silent no-op
		// otherwise (fileFetcher/playwrightFetcher, i.e. every unit test).
		if shooter, ok := lc.fetcher.(pageScreenshotter); ok && tw.enabled() {
			if png, serr := shooter.screenshot(ctx, urlFor(page)); serr == nil {
				tw.WriteScreenshot(page, png)
			} else {
				log.Printf("[trace] %s %s p%d: screenshot failed: %v", t.Display, source, page, serr)
			}
		}

		// Page 1 only: read the portal's own pagination signal and (re)size the
		// walk. wantPages can only ever SHRINK the loop bound below softCap here,
		// never grow it — see the func doc for why that's safe.
		if page == 1 {
			if meta := extractPageMeta(doc, source); meta.OK {
				metaOK = true
				totalResults = meta.TotalResults
				onTargetResults = meta.OnTargetResults
				if meta.OnTargetResults > 0 {
					// REA: size off the exact on-target count, not the broadened total.
					wantOnTargetPages := int(math.Ceil(float64(meta.OnTargetResults) / float64(meta.PageSize)))
					wantPages = max(1, min(wantOnTargetPages, softCap))
				} else {
					// Domain, or REA when OnTargetResults is unavailable: unchanged
					// broadened-TotalPages clamp (today's behaviour).
					wantPages = max(1, min(meta.TotalPages, softCap))
				}
			}
		}

		raw := extractListings(doc, source)
		matched, mismatch := partitionByTarget(raw, t)
		lastMismatch = mismatch

		// Anti-bot stub guard — runs on EVERY page, BEFORE any natural-end branch.
		// A rendered Kasada KPSDK stub (~800B) or Akamai edgesuite stub carries no
		// listing container and extracts 0 listings, but looksBlocked misses it (no
		// marker string, >0 bytes). On a LATER page the empty-page/duplicate-page
		// branches below would then read it as "ran out" → sweepComplete → the
		// delist path flips the suburb's real pages-2+ listings to withdrawn. Treat
		// a stub as a BLOCK instead (trips the per-source breaker, delists nothing).
		// This is the in-sweep analogue of -mode warmcheck's reaLooksWarm, extended
		// to Domain — deliberately biased toward blocking, since a false "stub" only
		// skips this run's delisting (safe) while a MISSED stub corrupts the corpus.
		if pageLooksStub(html, source) {
			*blockCounter++
			status := blockedOrPartial(len(collected))
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, Outcome: "ok", Status: status.String(), Decision: "stop-stub"})
			return finish(status)
		}

		// Page-level poison gate. A high off-target ratio is the poison signal —
		// BUT small suburbs legitimately run out of real inventory, after which
		// REA/Domain broaden the SRP to nearby stock (e.g. New Farm 4005 → Newstead
		// 4006 / Fortitude Valley 4006 / Kangaroo Point 4169). That broadening is
		// not poison: partitionByTarget already dropped the off-target rows, and the
		// suburb's real listings are already in `collected` from cleaner earlier
		// pages. sweepPoisonVerdict treats a late high-mismatch page (after a healthy
		// on-target set) as paging PAST the suburb — keep what we have (partial ⇒
		// write events, delist nothing; or sweepComplete when PageMeta confirms we
		// stopped short of the portal's own reported extent — delist-safe) — and
		// only BLOCKS an early high-mismatch page (genuine page-1 poison /
		// bot-variant), which still trips the breaker.
		if mismatch > 0.30 {
			if sweepPoisonVerdict(page, len(collected), lc.cfg.minPerPage) == sweepPartial {
				// PageMeta confirms we stopped short of the portal's own reported
				// (broadened) extent — the on-target suburb was fully seen on the
				// clean earlier pages before the surrounds began. Delist-safe.
				status := upgradeIfPageMetaConfirms(metaOK && pages < wantPages, sweepPartial)
				tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, Outcome: "ok", Status: status.String(), Decision: "stop-broadening"})
				return finish(status)
			}
			*blockCounter++
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, Outcome: "ok", Status: sweepBlocked.String(), Decision: "stop-poison-blocked"})
			return finish(sweepBlocked)
		}
		if page == 1 && len(matched) < lc.cfg.minPerPage {
			*blockCounter++ // page rendered but nothing believable — empty/poisoned
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, Outcome: "ok", Status: sweepBlocked.String(), Decision: "stop-thin-page1"})
			return finish(sweepBlocked)
		}

		// Duplicate page: portals clamp an over-range page to the last page and
		// re-serve it → a natural end of the suburb.
		sig := pageSignature(matched)
		if page > 1 && sig == prevSig {
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, Outcome: "ok", Status: sweepComplete.String(), Decision: "stop-duplicate-page"})
			return finish(sweepComplete)
		}
		prevSig = sig

		// Ran out of listings on a later page → the whole suburb was seen.
		if page > 1 && len(matched) == 0 {
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, Outcome: "ok", Status: sweepComplete.String(), Decision: "stop-empty-page"})
			return finish(sweepComplete)
		}

		newThisPage := 0
		for _, m := range matched {
			if prev, ok := collected[m.ListingID]; !ok {
				collected[m.ListingID] = m
				newThisPage++
			} else {
				collected[m.ListingID] = mergeListing(prev, m)
			}
		}

		// Yield decay: a later page rendered real, on-target-passing content, but
		// contributed nothing we hadn't already collected (`collected` IS the
		// running seen-all set — no separate index needed). That happens when a
		// portal re-serves overlapping/reordered stock once real inventory runs
		// out WITHOUT going through an exact duplicate page (same signature) or a
		// wholly empty one — e.g. a partial repeat. It's at least as strong an
		// exhaustion signal as those two, so it ends the sweep the same way, under
		// the same PageMeta-confirmed delist-safety rule as the broadening branch
		// above (conservative default: sweepPartial, upgraded to sweepComplete
		// only when PageMeta confirms we stopped short of the portal's own
		// reported extent).
		if page > 1 && newThisPage < lc.cfg.minNewPerPage {
			status := upgradeIfPageMetaConfirms(metaOK && pages < wantPages, sweepPartial)
			tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, NewIDs: newThisPage, Outcome: "ok", Status: status.String(), Decision: "stop-yield-decay"})
			return finish(status)
		}

		tw.WritePage(tracePageRecord{Page: page, URL: urlFor(page), Ms: fetchMs, Bytes: len(html), Extracted: len(raw), Matched: len(matched), Mismatch: mismatch, TotalResults: totalResults, OnTargetResults: onTargetResults, WantPages: wantPages, NewIDs: newThisPage, Outcome: "ok", Status: "continuing", Decision: "continue"})
	}

	// Reached the loop bound with no natural end signal. When PageMeta sized
	// that bound BELOW softCap (wantPages < softCap), we've walked every page
	// the portal itself claims exists — a "capped-complete" sweep, delist-safe.
	// Otherwise (PageMeta unusable, or the broadened extent is itself >=
	// softCap) more listings may exist beyond the cap → partial, today's
	// behaviour.
	return finish(upgradeIfPageMetaConfirms(metaOK && wantPages < softCap, sweepPartial))
}

// softPageCap derives a per-suburb page ceiling from a coarse
// population/dwelling-count hint, used to size the walk when the portal's own
// PageMeta is unusable (meta.OK==false) — Task 3's exact per-page sizing
// always wins once PageMeta is available. A dense suburb has legitimately
// more genuine on-target inventory than a flat default can cover in cfg.
// maxPages pages; a sparse one should stop sooner rather than wastefully
// walking pages that will just broaden into surrounding-suburb stock.
// dwellings<=0 (unknown — the whole catalog today, until a real ABS backfill
// lands) returns defaultCap unchanged, so nothing regresses for any suburb
// without a hint. The result is always clamped to >=1 and, when hardCeiling
// is positive, to <=hardCeiling (hardCeiling<=0 is treated as "no override" —
// a defensive fallback for callers/tests that don't set one, NOT an implicit
// re-widening of an explicitly-passed low ceiling).
func softPageCap(dwellings, hardCeiling, defaultCap int) int {
	n := defaultCap
	switch {
	case dwellings >= 20000:
		n = defaultCap * 2
	case dwellings >= 8000:
		n = defaultCap + 2
	case dwellings > 0 && dwellings < 2000:
		n = defaultCap - 2
	}
	if n < 1 {
		n = 1
	}
	if hardCeiling > 0 && n > hardCeiling {
		n = hardCeiling
	}
	return n
}

// upgradeIfPageMetaConfirms upgrades a natural-stop status to the delist-safe
// sweepComplete when the caller has confirmed (via PageMeta) that the sweep
// can be trusted as having seen the whole on-target suburb — see the two call
// sites in sweepSuburbSource for the exact confirmation conditions. Falls back
// to `def` — today's behaviour — otherwise (PageMeta unusable for this sweep,
// or not yet confirmed).
func upgradeIfPageMetaConfirms(confirmed bool, def sweepStatus) sweepStatus {
	if confirmed {
		return sweepComplete
	}
	return def
}

// mergeListing keeps the richer of two same-id sightings of a listing, using
// the SAME fieldScore rule extractListings/walkForListingsDepth already use to
// dedupe candidates WITHIN a single page — applied here ACROSS pages too, so a
// thin early sighting (e.g. a promo/teaser card carrying just a price) doesn't
// shadow a richer later one (full address/beds/baths) for the same listing_id.
// Ties keep `existing` (stable, no churn when both pages agree).
func mergeListing(existing, incoming RawListing) RawListing {
	if fieldScore(incoming) > fieldScore(existing) {
		return incoming
	}
	return existing
}

func finishSweep(collected map[string]RawListing, pages int, status sweepStatus) suburbSweep {
	out := make([]RawListing, 0, len(collected))
	for _, l := range collected {
		out = append(out, l)
	}
	return suburbSweep{listings: out, status: status, pages: pages}
}

// blockedOrPartial: earlier pages already yielded believable data → partial
// (update, don't delist); nothing yet → blocked (touch nothing).
func blockedOrPartial(collectedN int) sweepStatus {
	if collectedN > 0 {
		return sweepPartial
	}
	return sweepBlocked
}

// pageLooksStub reports whether a rendered page is an anti-bot stub rather than a
// real search-results page: too small to be a real SRP (a genuine REA/Domain SRP
// is hundreds of KB even with zero results, while the KPSDK/edgesuite stubs are
// ~1KB), OR missing the portal's listing-data container. It's the in-sweep
// analogue of reaLooksWarm (crawl_warmcheck.go), extended to Domain. Biased
// toward reporting a stub on purpose: a false positive only skips this run's
// delisting for that suburb (safe, self-corrects next warm run), whereas a missed
// stub read as "ran out" delists real listings. A real SRP (large + container
// present, which is what the working crawl always fetches) is never a stub, so
// this changes nothing on the healthy path.
func pageLooksStub(html []byte, source string) bool {
	s := string(html)
	switch source {
	case "rea":
		// REA's SRP always carries the ArgonautExchange blob; the KPSDK stub does
		// not. Container-presence (not size) is the reliable signal — it also
		// catches schema drift (a real page that stopped carrying the blob is,
		// for our purposes, unusable and must not enable delisting).
		return !strings.Contains(s, "ArgonautExchange")
	case "domain":
		return !strings.Contains(s, "__NEXT_DATA__")
	default:
		// Unknown source: fall back to a size floor (a real SRP is hundreds of KB).
		return len(html) < reaWarmMinBytes
	}
}

// sweepPoisonVerdict classifies a page whose off-target ratio exceeded the poison
// threshold. If it lands on a LATER page after a healthy on-target set is already
// collected, the search simply broadened past a small suburb's real inventory —
// return sweepPartial so the confirmed early-page listings are still diffed
// (events written, nothing delisted). Otherwise (an early / among-the-first page,
// before any healthy set exists) it is a genuine bot-variant / page-1 poison —
// return sweepBlocked so the caller trips the circuit breaker and discards it.
func sweepPoisonVerdict(page, collectedMatched, minPerPage int) sweepStatus {
	if page > 1 && collectedMatched >= minPerPage {
		return sweepPartial
	}
	return sweepBlocked
}

func pageSignature(ls []RawListing) string {
	ids := make([]string, 0, len(ls))
	for _, l := range ls {
		ids = append(ids, l.ListingID)
	}
	sort.Strings(ids)
	return strings.Join(ids, ",")
}

// fetchAndClassify is the free-function analogue of (*crawler).fetchPage: fetch
// via the injected fetcher and classify the outcome using the SHARED looksBlocked
// / isBlockError detectors.
func fetchAndClassify(ctx context.Context, f htmlFetcher, url string) ([]byte, string, fetchOutcome) {
	html, finalURL, err := f.fetch(ctx, url)
	if err != nil {
		if isBlockError(err) {
			return nil, "", outcomeBlocked
		}
		return nil, "", outcomeError
	}
	if looksBlocked(html, finalURL) {
		return nil, "", outcomeBlocked
	}
	return html, finalURL, outcomeOK
}

// paceRange is a [lo,hi] jitter window for the page-to-page delay.
type paceRange struct{ lo, hi time.Duration }

const (
	paceWidenPerConsecBlock = 0.5 // +50% pace per consecutive block already observed on this source, capped by paceWidenFactorMax
	paceWidenOnMismatch     = 0.5 // +50% pace after a high-mismatch (>30%) page
	paceWidenFactorMax      = 3.0 // never widen the pace bounds beyond 3x base
)

// paceBounds picks the [lo,hi] delay bounds for the NEXT page fetch from two
// block-risk signals: consecBlocks (consecutive blocks this source has
// already racked up — a medium-term risk signal) and lastMismatch (the
// PREVIOUS page's target-mismatch ratio — an immediate freshness signal; a
// high-mismatch page is often the first sign of a bot-variant/poisoned
// response even before an outright block). Either signal widens the bounds so
// a rate-limited/suspicious site gets more room to cool down before the next
// request, instead of being hammered at the same pace that likely
// contributed to the risk. A clean run (consecBlocks<=0 &&
// lastMismatch<=0.30) returns `base` unchanged — today's flat pacing.
func paceBounds(consecBlocks int, lastMismatch float64, base paceRange) paceRange {
	factor := 1.0
	if consecBlocks > 0 {
		factor += float64(consecBlocks) * paceWidenPerConsecBlock
	}
	if lastMismatch > 0.30 {
		factor += paceWidenOnMismatch
	}
	if factor > paceWidenFactorMax {
		factor = paceWidenFactorMax
	}
	if factor <= 1.0 {
		return base
	}
	return paceRange{
		lo: time.Duration(float64(base.lo) * factor),
		hi: time.Duration(float64(base.hi) * factor),
	}
}

func jitterSleep(ctx context.Context, lo, hi time.Duration) {
	d := lo
	if hi > lo {
		d += time.Duration(rand.Int63n(int64(hi - lo)))
	}
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}

func listingRegionObs(targets []CrawlTarget) []Observation {
	obs := make([]Observation, 0, len(targets))
	for _, t := range targets {
		obs = append(obs, Observation{
			RegionCode: t.regionCode(),
			RegionType: "suburb",
			// Use the bare suburb name (not "Bondi, NSW 2026") so linkSuburbSalCodes
			// can match region_name to the ABS SAL name and bridge sal_code — that
			// bridge is what links a drop suburb to its /housing/[state]/[suburb] page.
			RegionName: t.Display,
			StateCode:  t.State,
			Postcode:   t.Postcode,
		})
	}
	return obs
}

func (lc *listingsCrawler) logDryRun(t CrawlTarget, source string, sweep suburbSweep) {
	log.Printf("[listings] DRY %s %s: status=%s pages=%d listings=%d", t.Display, source, sweep.status, sweep.pages, len(sweep.listings))
	sample := sweep.listings
	if len(sample) > 3 {
		sample = sample[:3]
	}
	for _, l := range sample {
		price := "n/a"
		if cp := canonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind); cp != nil {
			price = strconv.FormatFloat(*cp, 'f', 0, 64)
		}
		log.Printf("[listings] DRY   %s | $%s (%s) | %s", l.DisplayAddr, price, l.PriceKind, l.ListingURL)
	}
}
