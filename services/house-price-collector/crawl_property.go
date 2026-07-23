package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// runProperty is the -mode=property entry point: the address-seeded VALUATION
// crawl. property.com.au is REA Group's per-address property-research portal (AVM
// price estimate + sales history + property attributes + year built, keyed by
// ADDRESS, ~15M properties). Unlike the listing tiers (-mode listings/details,
// which sweep the FOR-SALE market), this pass ENRICHES our existing address corpus:
// it is seeded from the distinct addresses already in property_listings and keyed
// by the SAME canonical address_key, so a valuation bridges 1:1 back to every
// listing at that address.
//
// Same residential-rig posture as the listing crawl: it drives the SAME headed
// host-Chrome fetcher (property.com.au is Kasada+Akamai — the SAME Kasada tenant as
// realestate.com.au, and a warm native Chrome clears it, PROVEN in the Phase-0
// probe), paces heavily, self-throttles via the per-source circuit breaker, and
// DEFAULTS TO DRY-RUN (it writes only when CRAWL_DRY_RUN=false). It returns a process
// exit code (0 ok, 3 re-warm needed), the same contract as runDetails/runAgent, so
// main.go's mode switch passes it straight through. No MV refresh is needed.
//
// Each address is resolved to its profile URL by TRAVERSING the site's index pages
// (suburb → street → property; see crawl_property_resolve.go) because the profile
// URL requires property.com.au's internal PID, which a constructed slug can't yield.
// Resolution fetches are cached per-suburb/per-street across a run, so a suburb's
// many seed addresses share one suburb-page fetch.

// propertySource is the single circuit-breaker / block-streak key for this tier.
const propertySource = "property"

// propertyConfig is the -mode property knobs: the shared crawl config (fetcher /
// pacing / dry-run) plus a work-list cap, the per-address refresh TTL, and the
// per-source circuit breaker.
type propertyConfig struct {
	crawlConfig               // embeds minDelay/maxDelay, dryRun, maxConsecBlocks, fetchTimeout, cdp/gateway, profileDir
	maxItems    int           // CRAWL_PROPERTY_MAX      (default 200)
	ttlDays     int           // CRAWL_PROPERTY_TTL_DAYS (default 90)
	circuitTrip int           // CRAWL_CIRCUIT_TRIP      (default 2)  — shared with the listing crawl
	circuitBase time.Duration // CRAWL_CIRCUIT_BASE_S    (default 300s)
	circuitMax  time.Duration // CRAWL_CIRCUIT_MAX_S     (default 3600s)
	// fixtureDir, when set, reads pages from saved HTML files instead of driving a
	// browser — offline testing/seeding against captured pages (same seam as the
	// listing/detail crawls' fixture dirs).
	fixtureDir string // CRAWL_PROPERTY_FIXTURE_DIR
}

func loadPropertyConfig() propertyConfig {
	return propertyConfig{
		crawlConfig: loadCrawlConfig(),
		maxItems:    envInt("CRAWL_PROPERTY_MAX", 200),
		ttlDays:     envInt("CRAWL_PROPERTY_TTL_DAYS", 90),
		circuitTrip: envInt("CRAWL_CIRCUIT_TRIP", 2),
		circuitBase: time.Duration(envInt("CRAWL_CIRCUIT_BASE_S", 300)) * time.Second,
		circuitMax:  time.Duration(envInt("CRAWL_CIRCUIT_MAX_S", 3600)) * time.Second,
		fixtureDir:  os.Getenv("CRAWL_PROPERTY_FIXTURE_DIR"),
	}
}

type propertyStats struct {
	attempted, ok, notfound, noPayload, blocked, stub, errors, skipped, unresolved int
}

func runProperty(ctx context.Context, pool *pgxpool.Pool) int {
	cfg := loadPropertyConfig()

	worklist, err := loadPropertyWorklist(ctx, pool, cfg.ttlDays, cfg.maxItems)
	if err != nil {
		log.Printf("[property] worklist load failed (%v) — aborting (non-fatal; official backbone unaffected)", err)
		_ = updateRun(ctx, pool, "property_valuations", nil, 0, "error", "worklist: "+err.Error())
		return 0
	}
	if len(worklist) == 0 {
		log.Printf("[property] no active-listing addresses due a valuation fetch")
		if !cfg.dryRun {
			_ = updateRun(ctx, pool, "property_valuations", nil, 0, "ok", "")
		}
		return 0
	}

	var fetcher crawlFetcher
	if cfg.fixtureDir != "" {
		fetcher = &fileFetcher{dir: cfg.fixtureDir}
		log.Printf("[property] FIXTURE mode: reading pages from %s (no browser)", cfg.fixtureDir)
	} else {
		f, ferr := newCrawlFetcher(cfg.crawlConfig)
		if ferr != nil {
			log.Printf("[property] crawl fetcher init failed (%v) — aborting (non-fatal; official backbone unaffected)", ferr)
			_ = updateRun(ctx, pool, "property_valuations", nil, 0, "error", "fetcher init: "+ferr.Error())
			return 0
		}
		fetcher = f
	}
	defer fetcher.Close()

	// Reuse the shared crawler wrapper (fetchPage block classification + sleepJitter
	// inter-fetch pacing); the property-specific state lives below.
	cr := &crawler{fetcher: fetcher, cfg: cfg.crawlConfig}
	cb := newCircuitBreaker(cfg.circuitTrip, cfg.circuitBase, cfg.circuitMax)
	caches := newPropertyResolveCaches()
	sources := []string{propertySource}

	// throttle paces every NETWORK fetch (resolution + profile), sleeping the shared
	// jitter before all but the very first fetch of the run — cache hits neither
	// fetch nor sleep.
	netFetches := 0
	throttle := func() {
		if netFetches > 0 {
			cr.sleepJitter(ctx)
		}
		netFetches++
	}

	log.Printf("[property] start: %d address(es) · %s · dryRun=%v", len(worklist), crawlFetcherMode(cfg.crawlConfig), cfg.dryRun)

	var st propertyStats
	blocks := 0 // consecutive-block streak for the exit-3 rewarm signal
	rewarm := false

	// recordBlock updates stats + the circuit breaker after a block/stub and reports
	// whether the whole session is now blocked (→ stop + re-warm).
	recordBlock := func(stub bool) bool {
		if stub {
			st.stub++
		} else {
			st.blocked++
		}
		blocks++
		now := time.Now().UTC()
		if opened, cd := cb.record(propertySource, true, now); opened {
			log.Printf("[property] circuit OPEN after %d consecutive blocked fetch(es) — backing off %s", cb.circuit(propertySource).consec, cd.Round(time.Second))
		}
		if allOpen, rem := cb.allOpen(sources, time.Now().UTC()); allOpen {
			log.Printf("[property] source circuit-open (session blocked) — stopping to re-warm; backoff %s", rem.Round(time.Second))
			return true
		}
		return false
	}

worklist:
	for _, t := range worklist {
		if ctx.Err() != nil {
			break
		}
		if open, rem := cb.skip(propertySource, time.Now().UTC()); open {
			st.skipped++
			log.Printf("[property] %s: SKIPPED — circuit open (portal blocking), backing off %s", t.addressKey, rem.Round(time.Second))
			continue
		}
		st.attempted++

		// Resolve the profile URL by traversing suburb → street → property.
		profileURL, rstatus := cr.resolveProfile(ctx, t, caches, throttle)
		switch rstatus {
		case resolveBlocked:
			if recordBlock(false) {
				rewarm = true
				break worklist
			}
			continue
		case resolveErr:
			st.errors++
			continue
		case resolveMiss:
			st.unresolved++
			if cfg.dryRun {
				log.Printf("[property] DRY %s: unresolved (no profile URL) — would mark NOTFOUND", t.addressKey)
				continue
			}
			if err := upsertPropertyValuation(ctx, pool, t, "notfound", "", propertyProfile{Raw: "{}"}); err != nil {
				log.Printf("[property] %s: notfound (unresolved) write failed: %v", t.addressKey, err)
				st.errors++
			}
			continue
		}

		// Fetch the resolved profile page.
		html, finalURL, outcome, stub := cr.fetchPropertyPage(ctx, profileURL, throttle)
		if outcome == outcomeError {
			st.errors++ // transient — leave the address un-fetched so it's retried next run
			continue
		}
		if stub {
			log.Printf("[property] %s: anti-bot STUB (missing profile payload) — treating as block, not stamping", t.addressKey)
		}
		if outcome == outcomeBlocked {
			if recordBlock(stub) {
				rewarm = true
				break worklist
			}
			continue
		}
		// A clean fetch closes the circuit and resets the block streak.
		blocks = 0
		cb.record(propertySource, false, time.Now().UTC())

		// Not-found FIRST: a real 404 page (page-not-found marker) has no profile to
		// extract. Stamp a minimal 'notfound' row so this address isn't re-fetched
		// until the TTL.
		if isProfileNotFound(finalURL, html) {
			st.notfound++
			if cfg.dryRun {
				log.Printf("[property] DRY %s: would mark NOTFOUND (final=%s)", t.addressKey, finalURL)
				continue
			}
			if err := upsertPropertyValuation(ctx, pool, t, "notfound", profileURL, propertyProfile{Raw: "{}"}); err != nil {
				log.Printf("[property] %s: notfound write failed: %v", t.addressKey, err)
				st.errors++
			}
			continue
		}

		prof, ok := extractPropertyProfile(string(html))
		if !ok {
			// The page rendered and wasn't a block or a not-found, but no profile
			// payload was recognizable. Record 'error' + stamp so we don't re-fetch
			// every run — the TTL still retries it.
			st.noPayload++
			if cfg.dryRun {
				log.Printf("[property] DRY %s: no profile payload recognized (final=%s)", t.addressKey, finalURL)
				continue
			}
			if err := upsertPropertyValuation(ctx, pool, t, "error", profileURL, propertyProfile{Raw: "{}"}); err != nil {
				log.Printf("[property] %s: error-row write failed: %v", t.addressKey, err)
				st.errors++
			}
			continue
		}

		st.ok++
		if cfg.dryRun {
			log.Printf("[property] DRY %s: %s", t.addressKey, previewProperty(prof))
			continue
		}
		if err := upsertPropertyValuation(ctx, pool, t, "ok", profileURL, prof); err != nil {
			log.Printf("[property] %s: valuation write failed: %v", t.addressKey, err)
			st.errors++
		}
	}

	if needsRewarmStreak(cfg.maxConsecBlocks, blocks) {
		rewarm = true
	}

	status := "ok"
	if rewarm {
		status = "needs_rewarm"
	}
	if cfg.dryRun {
		log.Printf("[property] dry-run: nothing written")
	} else {
		// A DETACHED context so a run-deadline firing mid-batch can't drop the status
		// row for work that already committed (same posture as the listing finalizers).
		finCtx, finCancel := context.WithTimeout(context.Background(), 30*time.Second)
		_ = updateRun(finCtx, pool, "property_valuations", nil, st.ok+st.notfound, status, "")
		finCancel()
	}

	log.Printf("[property] done: attempted=%d ok=%d notfound=%d noPayload=%d blocked=%d stub=%d errors=%d skipped=%d unresolved=%d",
		st.attempted, st.ok, st.notfound, st.noPayload, st.blocked, st.stub, st.errors, st.skipped, st.unresolved)
	if rewarm {
		log.Printf("[property] REWARM REQUIRED: circuit breaker tripped — re-warm the crawl Chrome profile by hand")
		return 3
	}
	return 0
}

// needsRewarmStreak reports whether the single-source block streak reached the
// rewarm threshold. A disabled breaker (maxConsec<=0) never signals — mirrors
// needsRewarm's guard for the two-source listing crawls.
func needsRewarmStreak(maxConsecBlocks, blocks int) bool {
	if maxConsecBlocks <= 0 {
		return false
	}
	return blocks >= maxConsecBlocks
}

// previewProperty is the compact one-line dry-run summary of a harvested profile.
func previewProperty(p propertyProfile) string {
	parts := []string{}
	if p.EstimateMid != nil || p.EstimateLow != nil || p.EstimateHigh != nil {
		lo, mid, hi := 0.0, 0.0, 0.0
		if p.EstimateLow != nil {
			lo = *p.EstimateLow
		}
		if p.EstimateMid != nil {
			mid = *p.EstimateMid
		}
		if p.EstimateHigh != nil {
			hi = *p.EstimateHigh
		}
		parts = append(parts, fmt.Sprintf("est=$%.0f–$%.0f (mid $%.0f)", lo, hi, mid))
	}
	if p.EstimateConfidence != "" {
		parts = append(parts, "conf="+p.EstimateConfidence)
	}
	if len(p.SalesHistory) > 0 {
		parts = append(parts, fmt.Sprintf("sales=%d", len(p.SalesHistory)))
	}
	if p.PropertyType != "" {
		parts = append(parts, "type="+p.PropertyType)
	}
	if p.Bedrooms != nil {
		parts = append(parts, fmt.Sprintf("beds=%d", *p.Bedrooms))
	}
	if p.LandSizeSqm != nil {
		parts = append(parts, fmt.Sprintf("land=%.0fm²", *p.LandSizeSqm))
	}
	if p.YearBuilt != nil {
		parts = append(parts, fmt.Sprintf("built=%d", *p.YearBuilt))
	}
	if len(parts) == 0 {
		return "(no fields harvested)"
	}
	return strings.Join(parts, " ")
}
