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
// realestate.com.au — so only a warm native Chrome survives from a residential IP),
// paces heavily, self-throttles via the per-source circuit breaker, and DEFAULTS TO
// DRY-RUN (it writes only when CRAWL_DRY_RUN=false). It returns a process exit code
// (0 ok, 3 re-warm needed), the same contract as runDetails/runAgent, so main.go's
// mode switch passes it straight through. No MV refresh is needed.
//
// Rollout is phased: (1) a Phase-0 probe of ~10 addresses in dry-run to confirm the
// property.com.au profile URL form (constructed slug vs a search-resolve step) and
// the __NEXT_DATA__/window blob + estimate/sales-history key paths the extractor
// expects (gated until the current SRP drain finishes so it doesn't compete for the
// warm-Chrome budget); (2) decide scale from the probe's hit-rate; (3) steady state,
// where the work-list naturally prioritises never-fetched then oldest addresses.

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
	sources := []string{propertySource}

	log.Printf("[property] start: %d address(es) · %s · dryRun=%v", len(worklist), crawlFetcherMode(cfg.crawlConfig), cfg.dryRun)

	var st propertyStats
	blocks := 0 // consecutive-block streak for the exit-3 rewarm signal
	fetched := 0
	rewarm := false

worklist:
	for _, t := range worklist {
		if ctx.Err() != nil {
			break
		}
		now := time.Now().UTC()
		if open, rem := cb.skip(propertySource, now); open {
			st.skipped++
			log.Printf("[property] %s: SKIPPED — circuit open (portal blocking), backing off %s", t.addressKey, rem.Round(time.Second))
			continue
		}

		url, ok := resolveProfileURL(t)
		if !ok {
			// Can't form a profile URL (missing components) — count it and move on
			// without a fetch; nothing is written so it re-appears next run.
			st.unresolved++
			log.Printf("[property] %s: could not resolve a profile URL (missing address parts) — skipping", t.addressKey)
			continue
		}

		if fetched > 0 {
			cr.sleepJitter(ctx)
		}
		fetched++
		st.attempted++

		html, finalURL, outcome := cr.fetchPage(ctx, url)
		if outcome == outcomeError {
			st.errors++ // transient — leave the address un-fetched so it's retried next run
			continue
		}
		// A rendered anti-bot STUB (200-status, tiny, no profile payload) passes
		// looksBlocked but is NOT a real page — extractPropertyProfile would find no
		// payload and we'd stamp a HEALTHY address fetch_status='error'/'notfound' for
		// the whole TTL. Treat it as a BLOCK: bump the circuit + block streak, write
		// NOTHING, so it retries next run and can still trip the exit-3 rewarm streak.
		// (Same guard the SRP/LDP crawls use — pageLooksStub, crawl_listings.go.)
		stub := outcome == outcomeOK && pageLooksStub(html, propertySource)
		if stub {
			log.Printf("[property] %s: anti-bot STUB (missing profile payload) — treating as block, not stamping", t.addressKey)
		}
		if outcome == outcomeBlocked || stub {
			if stub {
				st.stub++
			} else {
				st.blocked++
			}
			blocks++
			if opened, cd := cb.record(propertySource, true, now); opened {
				log.Printf("[property] circuit OPEN after %d consecutive blocked fetch(es) — backing off %s", cb.circuit(propertySource).consec, cd.Round(time.Second))
			}
			// Single-source tier: once its circuit is open the whole session is blocked
			// — stop and flag a re-warm rather than burn the rest of the batch on a cold
			// session.
			if allOpen, rem := cb.allOpen(sources, time.Now().UTC()); allOpen {
				log.Printf("[property] source circuit-open (session blocked) — stopping to re-warm; backoff %s", rem.Round(time.Second))
				rewarm = true
				break worklist
			}
			continue
		}
		// A clean fetch closes the circuit and resets the block streak.
		blocks = 0
		cb.record(propertySource, false, now)

		// Not-found FIRST: a 404 / redirect-to-search page has no profile to extract.
		// Stamp a minimal 'notfound' row so this address isn't re-fetched until the TTL
		// (an unresolvable address would otherwise sit at the top of the work-list
		// forever).
		if isProfileNotFound(finalURL, html) {
			st.notfound++
			if cfg.dryRun {
				log.Printf("[property] DRY %s: would mark NOTFOUND (final=%s)", t.addressKey, finalURL)
				continue
			}
			if err := upsertPropertyValuation(ctx, pool, t, "notfound", url, propertyProfile{Raw: "{}"}); err != nil {
				log.Printf("[property] %s: notfound write failed: %v", t.addressKey, err)
				st.errors++
			}
			continue
		}

		prof, ok := extractPropertyProfile(string(html))
		if !ok {
			// The page rendered and wasn't a block or a not-found, but no profile
			// payload was recognizable (an unparseable variant). Record 'error' + stamp
			// so we don't re-fetch every run — the TTL still retries it.
			st.noPayload++
			if cfg.dryRun {
				log.Printf("[property] DRY %s: no profile payload recognized (final=%s)", t.addressKey, finalURL)
				continue
			}
			if err := upsertPropertyValuation(ctx, pool, t, "error", url, propertyProfile{Raw: "{}"}); err != nil {
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
		if err := upsertPropertyValuation(ctx, pool, t, "ok", url, prof); err != nil {
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

// resolveProfileURL builds the property.com.au profile URL for an address from its
// canonical components. The IMPLEMENTED form is a constructed slug:
//
//	https://www.property.com.au/<state-lower>/<suburb-slug>-<postcode>/<street-slug>
//
// e.g. 12 Smith Street, Bondi NSW 2026 → https://www.property.com.au/nsw/bondi-2026/12-smith-street
//
// The street slug reuses the listing crawl's streetPart()+slug() (strip the suburb
// suffix off the portal display address, slugify what's left), so it is consistent
// with how address_key itself is formed. Returns ok=false when a URL can't be
// formed (no street content survives, or suburb/state/postcode is missing).
//
// PROBE-VERIFY: the exact property.com.au profile URL form — and whether a
// SEARCH/autocomplete resolve step (resolveViaSearch) is required instead of a
// constructed slug — is confirmed by the Phase-0 live probe. property.com.au also
// exposes an address search/autocomplete; if the constructed slug 404s in the
// probe, wire the real resolution through resolveViaSearch and prefer it here. We
// deliberately do NOT hardcode a numeric property id (we don't have one).
func resolveProfileURL(t propertyTarget) (string, bool) {
	if u, ok := resolveViaSearch(t); ok {
		return u, true
	}
	suburb := strings.TrimSpace(t.suburb)
	state := strings.TrimSpace(t.stateCode)
	postcode := strings.TrimSpace(t.postcode)
	if suburb == "" || state == "" || postcode == "" {
		return "", false
	}
	street := slug(streetPart(t.displayAddress, suburb))
	if street == "" {
		return "", false
	}
	suburbSlug := slug(suburb)
	if suburbSlug == "" {
		return "", false
	}
	return fmt.Sprintf("https://www.property.com.au/%s/%s-%s/%s",
		strings.ToLower(state), suburbSlug, postcode, street), true
}

// resolveViaSearch is the Phase-0 hook for property.com.au's address
// SEARCH/autocomplete resolution path: POST/GET the address, read back the canonical
// profile URL (or property id) the site assigns it. It is a STUB — it always returns
// ("", false) so resolveProfileURL falls back to the constructed slug. The Phase-0
// live probe wires the real request here if the constructed slug proves wrong; every
// caller already handles the fallback, so turning this on is a localized edit.
func resolveViaSearch(_ propertyTarget) (string, bool) {
	return "", false
}

// propertyNotFoundMarkers are page phrases that mean property.com.au has no profile
// for the address (a 404 / "couldn't find" page). Kept reasonably tight so healthy
// chrome can't false-trip; a false positive only stamps a 'notfound' row (re-tried
// after the TTL), never corrupts a real estimate. PROBE-VERIFY: the exact wording is
// confirmed by the Phase-0 probe.
var propertyNotFoundMarkers = []string{
	"we couldn't find that property",
	"we couldn’t find that property", // curly apostrophe variant
	"couldn't find that address",
	"property not found",
	"we can't find that property",
	"no property profile",
	"this property could not be found",
}

// isProfileNotFound reports whether a fetched property.com.au page is NOT a real
// profile: it 404'd, redirected to the search/find surface, or shows an explicit
// "couldn't find that property" marker. Conservative (a false positive only stamps a
// 'notfound' row). A missing final URL trusts ONLY the page markers.
//
// PROBE-VERIFY: the exact 404 markers + the search-redirect URL shape are confirmed
// by the Phase-0 live probe.
func isProfileNotFound(finalURL string, html []byte) bool {
	lower := strings.ToLower(string(html))
	for _, m := range propertyNotFoundMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	u := strings.ToLower(strings.TrimSpace(finalURL))
	if u == "" {
		return false
	}
	if strings.Contains(u, "property-not-found") || strings.Contains(u, "/not-found") || strings.Contains(u, "/404") {
		return true
	}
	// Bounced to property.com.au's own search/find surface → the address has no profile.
	if isPropertyURL(u) && (strings.Contains(u, "/find") || strings.Contains(u, "/search") || strings.Contains(u, "?q=") || strings.Contains(u, "/results")) {
		return true
	}
	return false
}

func isPropertyURL(u string) bool {
	return strings.Contains(u, "property.com.au")
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
