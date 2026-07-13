package main

import (
	"bytes"
	"context"
	"log"
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
	crawlConfig                // embeds cdpURL, minDelay/maxDelay, dryRun, maxConsecBlocks, fetchTimeout, profileDir, maxSuburbs
	maxPages     int           // CRAWL_LISTINGS_MAX_PAGES      (default 5)
	minPerPage   int           // CRAWL_LISTINGS_MIN_PER_PAGE   (default 5)
	pageMinDelay time.Duration // CRAWL_LISTINGS_PAGE_MIN_MS   (default 8000)
	pageMaxDelay time.Duration // CRAWL_LISTINGS_PAGE_MAX_MS   (default 20000)
	noiseAbs     float64       // CRAWL_LISTINGS_NOISE_ABS      (default 5000)
	noisePct     float64       // CRAWL_LISTINGS_NOISE_PCT      (default 0.005 == 0.5%)
	delistGrace  int           // CRAWL_LISTINGS_DELIST_GRACE   (default 2)
	// fixtureDir, when set, reads pages from saved HTML files instead of driving a
	// browser — for offline testing/seeding against captured real pages.
	fixtureDir string // CRAWL_LISTINGS_FIXTURE_DIR
}

func loadListingsConfig() listingsConfig {
	return listingsConfig{
		crawlConfig:  loadCrawlConfig(),
		maxPages:     envInt("CRAWL_LISTINGS_MAX_PAGES", 5),
		minPerPage:   envInt("CRAWL_LISTINGS_MIN_PER_PAGE", 5),
		pageMinDelay: time.Duration(envInt("CRAWL_LISTINGS_PAGE_MIN_MS", 8000)) * time.Millisecond,
		pageMaxDelay: time.Duration(envInt("CRAWL_LISTINGS_PAGE_MAX_MS", 20000)) * time.Millisecond,
		noiseAbs:     envFloat("CRAWL_LISTINGS_NOISE_ABS", 5000),
		noisePct:     envFloat("CRAWL_LISTINGS_NOISE_PCT", 0.005),
		delistGrace:  envInt("CRAWL_LISTINGS_DELIST_GRACE", 2),
		fixtureDir:   os.Getenv("CRAWL_LISTINGS_FIXTURE_DIR"),
	}
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
}

type listingsCrawler struct {
	fetcher   htmlFetcher
	cfg       listingsConfig
	reaBlocks int
	domBlocks int
	stats     listingsStats
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

	log.Printf("[listings] start: %d suburbs · %s · maxPages=%d · dryRun=%v", len(targets), crawlFetcherMode(cfg.crawlConfig), cfg.maxPages, cfg.dryRun)

	reaEvents, domEvents := 0, 0
	for i, t := range targets {
		if i > 0 {
			jitterSleep(ctx, cfg.minDelay, cfg.maxDelay)
		}
		lc.stats.suburbs++
		reaEvents += lc.crawlSuburbSource(ctx, pool, t, "rea", t.reaSearchURL, &lc.reaBlocks, runTs)
		domEvents += lc.crawlSuburbSource(ctx, pool, t, "domain", t.domainSearchURL, &lc.domBlocks, runTs)
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
	log.Printf("[listings] done: suburbs=%d pages=%d listings=%d new=%d drops=%d rises=%d relisted=%d delisted=%d status=%d blockedSweeps=%d events(rea=%d,domain=%d)",
		s.suburbs, s.pages, s.seen, s.newListings, s.drops, s.rises, s.relisted, s.delisted, s.statusChanges, s.blockedSweeps, reaEvents, domEvents)
	return rewarm
}

// crawlSuburbSource sweeps one source for one suburb and (unless dry-run, or the
// sweep was blocked) diffs it into events. Returns the number of events written.
func (lc *listingsCrawler) crawlSuburbSource(ctx context.Context, pool *pgxpool.Pool, t CrawlTarget, source string, urlFor func(int) string, blockCounter *int, runTs time.Time) int {
	sweep := lc.sweepSuburbSource(ctx, t, source, urlFor, blockCounter)
	lc.stats.pages += sweep.pages
	lc.stats.seen += len(sweep.listings)
	if sweep.status == sweepBlocked {
		lc.stats.blockedSweeps++
	}

	if lc.cfg.dryRun {
		lc.logDryRun(t, source, sweep)
		return 0
	}
	if sweep.status == sweepBlocked {
		return 0
	}
	n, err := lc.diffSuburb(ctx, pool, t, source, sweep, runTs)
	if err != nil {
		log.Printf("[listings] %s %s: diff error: %v", t.Display, source, err)
		return 0
	}
	if n > 0 {
		log.Printf("[listings] %s %s: %d event(s) from %d listing(s) (%s)", t.Display, source, n, len(sweep.listings), sweep.status)
	}
	return n
}

// sweepSuburbSource walks the paginated search results for one suburb, extracting
// and target-filtering listings, and classifies the sweep (complete/partial/
// blocked) — the classification that governs whether delisting is safe.
func (lc *listingsCrawler) sweepSuburbSource(ctx context.Context, t CrawlTarget, source string, urlFor func(int) string, blockCounter *int) suburbSweep {
	if *blockCounter >= lc.cfg.maxConsecBlocks {
		return suburbSweep{status: sweepBlocked} // breaker open: stop hammering this source
	}

	collected := map[string]RawListing{}
	var prevSig string
	pages := 0

	for page := 1; page <= lc.cfg.maxPages; page++ {
		if page > 1 {
			jitterSleep(ctx, lc.cfg.pageMinDelay, lc.cfg.pageMaxDelay)
		}
		html, finalURL, outcome := fetchAndClassify(ctx, lc.fetcher, urlFor(page))
		pages++
		if outcome == outcomeBlocked {
			*blockCounter++
			return finishSweep(collected, pages, blockedOrPartial(len(collected)))
		}
		if outcome == outcomeError {
			return finishSweep(collected, pages, blockedOrPartial(len(collected)))
		}
		*blockCounter = 0
		_ = finalURL

		doc, err := goquery.NewDocumentFromReader(bytes.NewReader(html))
		if err != nil {
			return finishSweep(collected, pages, blockedOrPartial(len(collected)))
		}
		matched, mismatch := partitionByTarget(extractListings(doc, source), t)

		// Page-level poison gates → soft block through the SAME circuit breaker.
		if mismatch > 0.30 {
			*blockCounter++
			return finishSweep(collected, pages, sweepBlocked)
		}
		if page == 1 && len(matched) < lc.cfg.minPerPage {
			*blockCounter++ // page rendered but nothing believable — empty/poisoned
			return finishSweep(collected, pages, sweepBlocked)
		}

		// Duplicate page: portals clamp an over-range page to the last page and
		// re-serve it → a natural end of the suburb.
		sig := pageSignature(matched)
		if page > 1 && sig == prevSig {
			return finishSweep(collected, pages, sweepComplete)
		}
		prevSig = sig

		// Ran out of listings on a later page → the whole suburb was seen.
		if page > 1 && len(matched) == 0 {
			return finishSweep(collected, pages, sweepComplete)
		}

		for _, m := range matched {
			if _, ok := collected[m.ListingID]; !ok {
				collected[m.ListingID] = m
			}
		}
	}

	// Reached the page cap without a natural end → more listings may exist → partial.
	return finishSweep(collected, pages, sweepPartial)
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
