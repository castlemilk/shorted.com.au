package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"strconv"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// The Tier-3 crawl. SUPPLEMENTARY and OPTIONAL: realestate.com.au (Kasada) and
// domain.com.au (Akamai) actively block and — in REA's case — feed false data to
// suspected bots. So this tier is built to FAIL SAFE: it never blocks the
// pipeline, never stores a value that fails validation, and self-throttles via a
// per-site circuit breaker. The official ABS/RBA backbone is the source of truth;
// the crawl only ever adds licence-gated suburb detail on top.

type crawlConfig struct {
	maxSuburbs      int
	minDelay        time.Duration
	maxDelay        time.Duration
	proxy           string
	disableChromium bool
	dryRun          bool
	maxConsecBlocks int
	perFetchRetries int
	fetchTimeout    time.Duration
}

func loadCrawlConfig() crawlConfig {
	return crawlConfig{
		maxSuburbs:      envInt("CRAWL_MAX_SUBURBS", len(crawlTargets)),
		minDelay:        time.Duration(envInt("CRAWL_MIN_DELAY_MS", 5000)) * time.Millisecond,
		maxDelay:        time.Duration(envInt("CRAWL_MAX_DELAY_MS", 15000)) * time.Millisecond,
		proxy:           os.Getenv("CRAWL_PROXY"),
		disableChromium: os.Getenv("CRAWL_DISABLE_CHROMIUM") == "true",
		dryRun:          os.Getenv("CRAWL_DRY_RUN") == "true",
		maxConsecBlocks: envInt("CRAWL_MAX_CONSEC_BLOCKS", 3),
		perFetchRetries: envInt("CRAWL_FETCH_RETRIES", 2),
		fetchTimeout:    time.Duration(envInt("CRAWL_FETCH_TIMEOUT_S", 30)) * time.Second,
	}
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

type fetchOutcome int

const (
	outcomeOK fetchOutcome = iota
	outcomeBlocked
	outcomeError
)

type crawlStats struct {
	attempted, accepted, blocked, rejected, diverged int
}

type crawler struct {
	native    *stealthhttp.Client
	chromium  *stealthhttp.Client // nil if unavailable
	baselines map[string]float64  // capital GCCSA region_code -> trusted ABS median
	cfg       crawlConfig
	reaBlocks int // consecutive-block counters for the circuit breaker
	domBlocks int
	stats     crawlStats
}

// runCrawl is the -mode=crawl entry point.
func runCrawl(ctx context.Context, pool *pgxpool.Pool) {
	cfg := loadCrawlConfig()

	baselines, err := loadCapitalBaselines(ctx, pool)
	if err != nil {
		log.Printf("[crawl] ABS baselines unavailable (%v) — capital-band validation OFF, absolute bounds still enforced", err)
		baselines = map[string]float64{}
	}

	nativeOpts := []stealthhttp.Option{stealthhttp.WithTimeout(cfg.fetchTimeout)}
	if cfg.proxy != "" {
		nativeOpts = append(nativeOpts, stealthhttp.WithProxy(cfg.proxy))
	}
	native, err := stealthhttp.New(nativeOpts...)
	if err != nil {
		log.Printf("[crawl] native client init failed: %v — aborting crawl (non-fatal)", err)
		_ = updateRun(ctx, pool, "crawl", nil, 0, "error", "native client init: "+err.Error())
		return
	}

	var chromium *stealthhttp.Client
	if !cfg.disableChromium {
		copts := []stealthhttp.Option{stealthhttp.WithTimeout(cfg.fetchTimeout + 30*time.Second)}
		if cfg.proxy != "" {
			copts = append(copts, stealthhttp.WithProxy(cfg.proxy))
		}
		if c, cerr := stealthhttp.NewChromium(copts...); cerr != nil {
			log.Printf("[crawl] chromium unavailable (%v) — REA/Kasada likely unreachable; native-only", cerr)
		} else {
			chromium = c
		}
	}

	cr := &crawler{native: native, chromium: chromium, baselines: baselines, cfg: cfg}

	targets := crawlTargets
	if cfg.maxSuburbs >= 0 && cfg.maxSuburbs < len(targets) {
		targets = targets[:cfg.maxSuburbs]
	}
	log.Printf("[crawl] start: %d suburbs · chromium=%v · proxy=%v · dryRun=%v", len(targets), chromium != nil, cfg.proxy != "", cfg.dryRun)

	var obs []Observation
	for i, t := range targets {
		if i > 0 {
			cr.sleepJitter(ctx)
		}
		obs = append(obs, cr.crawlSuburb(ctx, t)...)
	}

	status, detail := "ok", ""
	if cfg.dryRun {
		log.Printf("[crawl] dry-run: %d observations NOT written", len(obs))
	} else if len(obs) > 0 {
		if err := upsertRegions(ctx, pool, obs); err != nil {
			status, detail = "error", err.Error()
			log.Printf("[crawl] region upsert error: %v", err)
		} else if n, err := upsertObservations(ctx, pool, obs); err != nil {
			status, detail = "error", err.Error()
			log.Printf("[crawl] obs upsert error: %v", err)
		} else {
			log.Printf("[crawl] upserted %d suburb observations", n)
		}
	}
	_ = updateRun(ctx, pool, "crawl", nil, len(obs), status, detail)

	s := cr.stats
	log.Printf("[crawl] done: attempted=%d accepted=%d blocked=%d rejected=%d diverged=%d",
		s.attempted, s.accepted, s.blocked, s.rejected, s.diverged)
}

// crawlSuburb fetches both sources, validates, and applies the cross-source
// trust rule. Returns the observations to store (0, 1, or 2).
func (cr *crawler) crawlSuburb(ctx context.Context, t CrawlTarget) []Observation {
	cr.stats.attempted++
	base := cr.baselines[t.Capital] // 0 == unknown -> capital-band check skipped

	reaMed, reaOK := cr.siteMedian(ctx, "rea", t.reaURL(), base, &cr.reaBlocks)
	domMed, domOK := cr.siteMedian(ctx, "domain", t.domainURL(), base, &cr.domBlocks)

	switch {
	case reaOK && domOK:
		if !crossSourceAgrees(reaMed, domMed) {
			cr.stats.diverged++
			log.Printf("[crawl] %s: REA $%.0f vs Domain $%.0f diverge — rejecting BOTH (possible poisoning)", t.Display, reaMed, domMed)
			return nil
		}
		cr.stats.accepted++
		log.Printf("[crawl] %s: accepted (REA $%.0f ~ Domain $%.0f)", t.Display, reaMed, domMed)
		return []Observation{cr.obs(t, reaMed, "crawl_rea", false), cr.obs(t, domMed, "crawl_domain", false)}
	case reaOK:
		cr.stats.accepted++
		log.Printf("[crawl] %s: accepted single-source REA $%.0f (preliminary)", t.Display, reaMed)
		return []Observation{cr.obs(t, reaMed, "crawl_rea", true)}
	case domOK:
		cr.stats.accepted++
		log.Printf("[crawl] %s: accepted single-source Domain $%.0f (preliminary)", t.Display, domMed)
		return []Observation{cr.obs(t, domMed, "crawl_domain", true)}
	default:
		return nil
	}
}

// siteMedian fetches one source (with the circuit breaker), extracts candidate
// medians and returns the validated robust median for that page.
func (cr *crawler) siteMedian(ctx context.Context, site, url string, baseline float64, blockCounter *int) (float64, bool) {
	if *blockCounter >= cr.cfg.maxConsecBlocks {
		return 0, false // breaker open: stop hammering this source for the rest of the run
	}

	doc, outcome := cr.fetchWaterfall(ctx, url)
	switch outcome {
	case outcomeBlocked:
		*blockCounter++
		cr.stats.blocked++
		if *blockCounter == cr.cfg.maxConsecBlocks {
			log.Printf("[crawl] %s circuit-breaker tripped (%d consecutive blocks) — skipping remaining %s fetches", site, *blockCounter, site)
		}
		return 0, false
	case outcomeError:
		return 0, false
	}
	*blockCounter = 0 // a success resets the breaker

	candidates := extractSaleMedians(doc)
	med, ok := robustMedian(candidates, baseline)
	if !ok {
		if len(candidates) > 0 {
			cr.stats.rejected++ // page returned numbers but none survived validation (poison / wrong page)
		}
		return 0, false
	}
	return med, true
}

// fetchWaterfall tries the cheap native engine first, then escalates to Chromium
// (for JS challenges) only if the native fetch was actively blocked.
func (cr *crawler) fetchWaterfall(ctx context.Context, url string) (*goquery.Document, fetchOutcome) {
	doc, oc := cr.fetchOne(ctx, cr.native, url)
	if oc == outcomeOK {
		return doc, outcomeOK
	}
	if oc == outcomeBlocked && cr.chromium != nil {
		if doc2, oc2 := cr.fetchOne(ctx, cr.chromium, url); oc2 == outcomeOK {
			return doc2, outcomeOK
		} else if oc2 == outcomeBlocked {
			return nil, outcomeBlocked
		}
	}
	return nil, oc
}

// fetchOne fetches with one engine, retrying transient failures with quadratic
// backoff but returning immediately on a hard block (403/429/401).
func (cr *crawler) fetchOne(ctx context.Context, client *stealthhttp.Client, url string) (*goquery.Document, fetchOutcome) {
	if client == nil {
		return nil, outcomeError
	}
	for attempt := 0; attempt <= cr.cfg.perFetchRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt*attempt) * time.Second):
			case <-ctx.Done():
				return nil, outcomeError
			}
		}
		doc, _, err := client.FetchHTML(ctx, url)
		if err == nil {
			return doc, outcomeOK
		}
		switch stealthhttp.StatusError(err) {
		case 401, 403, 429:
			return nil, outcomeBlocked // hard block — don't retry the same engine
		}
		// otherwise transient (timeout / 5xx / network) — retry
	}
	return nil, outcomeError
}

func (cr *crawler) obs(t CrawlTarget, value float64, source string, prelim bool) Observation {
	return Observation{
		RegionCode:    t.regionCode(),
		RegionType:    "suburb",
		RegionName:    t.regionName(),
		StateCode:     t.State,
		Postcode:      t.Postcode,
		Measure:       "median_price",
		DwellingType:  "all",
		Period:        currentQuarterEnd(),
		PeriodFreq:    "Q",
		Value:         value,
		Unit:          "AUD",
		IsPreliminary: prelim,
		Source:        source,
		// ToS-restricted: gated out of any commercial/republished surface via
		// the house_prices.source_licence column.
		SourceLicence: "proprietary-tos-restricted",
	}
}

func (cr *crawler) sleepJitter(ctx context.Context) {
	d := cr.cfg.minDelay
	if cr.cfg.maxDelay > cr.cfg.minDelay {
		d += time.Duration(rand.Int63n(int64(cr.cfg.maxDelay - cr.cfg.minDelay)))
	}
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}

// loadCapitalBaselines reads the trusted ABS GCCSA established-house medians that
// every crawled value is validated against.
func loadCapitalBaselines(ctx context.Context, pool *pgxpool.Pool) (map[string]float64, error) {
	rows, err := pool.Query(ctx, `
		SELECT region_code, value FROM mv_housing_headline
		WHERE measure = 'median_price' AND dwelling_type = 'established_house'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[string]float64{}
	for rows.Next() {
		var code string
		var val float64
		if err := rows.Scan(&code, &val); err != nil {
			return nil, err
		}
		m[code] = val
	}
	return m, rows.Err()
}

func currentQuarterEnd() time.Time {
	now := time.Now().UTC()
	q := (int(now.Month())-1)/3 + 1
	firstNext := time.Date(now.Year(), time.Month(q*3)+1, 1, 0, 0, 0, 0, time.UTC)
	return firstNext.AddDate(0, 0, -1)
}
