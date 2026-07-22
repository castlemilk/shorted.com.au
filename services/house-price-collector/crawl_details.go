package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// runDetails is the -mode=details entry point: the SECONDARY listing crawl. The
// SRP sweep (-mode listings/agent) leaves a per-portal gap — REA's search blob
// carries no geo/land-size/property-type, Domain's carries no agency/agents — so
// this pass visits each active listing's own DETAIL page (LDP) to close both, and
// gets definitive delist detection for free (a dead ad 404s or redirects to a
// search page). Same residential-rig posture as the SRP crawl: it drives the SAME
// headed host-Chrome fetcher (the only client that beats Kasada/Akamai from a
// residential IP), paces heavily, self-throttles via the per-source circuit
// breaker, and DEFAULTS TO DRY-RUN — it writes only when CRAWL_DRY_RUN=false.
//
// Rollout is phased: (1) a Phase-0 probe of ~10 listings in dry-run to confirm the
// LDP JSON shapes the extractor expects (gated until the current SRP drain
// finishes so it doesn't compete for the warm-Chrome budget); (2) ~500 details/run
// nightly; (3) steady state, where the work-list naturally prioritises never-
// fetched then price-moved listings. Politeness budget: the shared 20–45s
// inter-fetch jitter (loadCrawlConfig) — one listing every ~30s, ~500/run.

// detailsConfig is the -mode details knobs: the shared crawl config (fetcher /
// pacing / dry-run) plus a work-list cap and the per-source circuit breaker.
type detailsConfig struct {
	crawlConfig               // embeds minDelay/maxDelay, dryRun, maxConsecBlocks, fetchTimeout, cdp/gateway, profileDir
	maxItems    int           // CRAWL_DETAILS_MAX     (default 500)
	circuitTrip int           // CRAWL_CIRCUIT_TRIP    (default 2)  — shared with the SRP crawl
	circuitBase time.Duration // CRAWL_CIRCUIT_BASE_S  (default 300s)
	circuitMax  time.Duration // CRAWL_CIRCUIT_MAX_S   (default 3600s)
	// fixtureDir, when set, reads pages from saved HTML files instead of driving a
	// browser — offline testing/seeding against captured pages (same seam as the
	// SRP crawl's CRAWL_LISTINGS_FIXTURE_DIR).
	fixtureDir string // CRAWL_DETAILS_FIXTURE_DIR
}

func loadDetailsConfig() detailsConfig {
	return detailsConfig{
		crawlConfig: loadCrawlConfig(),
		maxItems:    envInt("CRAWL_DETAILS_MAX", 500),
		circuitTrip: envInt("CRAWL_CIRCUIT_TRIP", 2),
		circuitBase: time.Duration(envInt("CRAWL_CIRCUIT_BASE_S", 300)) * time.Second,
		circuitMax:  time.Duration(envInt("CRAWL_CIRCUIT_MAX_S", 3600)) * time.Second,
		fixtureDir:  os.Getenv("CRAWL_DETAILS_FIXTURE_DIR"),
	}
}

type detailStats struct {
	attempted, ok, delisted, noPayload, blocked, errors, skipped int
}

// runDetails returns a process exit code (0 ok, 3 re-warm needed) — same contract
// as runAgent/runListings, so main.go's mode switch passes it straight through.
func runDetails(ctx context.Context, pool *pgxpool.Pool) int {
	cfg := loadDetailsConfig()

	worklist, err := loadDetailWorklist(ctx, pool, cfg.maxItems)
	if err != nil {
		log.Printf("[details] worklist load failed (%v) — aborting (non-fatal; official backbone unaffected)", err)
		_ = updateRun(ctx, pool, "listing_details", nil, 0, "error", "worklist: "+err.Error())
		return 0
	}
	if len(worklist) == 0 {
		log.Printf("[details] no active listings due a detail fetch")
		if !cfg.dryRun {
			_ = updateRun(ctx, pool, "listing_details", nil, 0, "ok", "")
		}
		return 0
	}

	var fetcher crawlFetcher
	if cfg.fixtureDir != "" {
		fetcher = &fileFetcher{dir: cfg.fixtureDir}
		log.Printf("[details] FIXTURE mode: reading pages from %s (no browser)", cfg.fixtureDir)
	} else {
		f, ferr := newCrawlFetcher(cfg.crawlConfig)
		if ferr != nil {
			log.Printf("[details] crawl fetcher init failed (%v) — aborting (non-fatal; official backbone unaffected)", ferr)
			_ = updateRun(ctx, pool, "listing_details", nil, 0, "error", "fetcher init: "+ferr.Error())
			return 0
		}
		fetcher = f
	}
	defer fetcher.Close()

	// The crawler wrapper reuses the SRP crawl's fetchPage (block classification) +
	// sleepJitter (inter-fetch pacing); the detail-specific state lives below.
	cr := &crawler{fetcher: fetcher, cfg: cfg.crawlConfig}
	cb := newCircuitBreaker(cfg.circuitTrip, cfg.circuitBase, cfg.circuitMax)
	circuitSources := worklistSources(worklist)

	log.Printf("[details] start: %d listing(s) · %s · dryRun=%v · sources=%s", len(worklist), crawlFetcherMode(cfg.crawlConfig), cfg.dryRun, strings.Join(circuitSources, ","))

	var st detailStats
	reaBlocks, domBlocks := 0, 0
	fetched := 0
	rewarm := false

worklist:
	for _, it := range worklist {
		if ctx.Err() != nil {
			break
		}
		now := time.Now().UTC()
		if open, rem := cb.skip(it.source, now); open {
			st.skipped++
			log.Printf("[details] %s %s: SKIPPED — circuit open (portal blocking), backing off %s", it.listingID, it.source, rem.Round(time.Second))
			continue
		}
		if fetched > 0 {
			cr.sleepJitter(ctx)
		}
		fetched++
		st.attempted++

		html, finalURL, outcome := cr.fetchPage(ctx, it.url)
		switch outcome {
		case outcomeBlocked:
			st.blocked++
			bumpBlock(&reaBlocks, &domBlocks, it.source)
			if opened, cd := cb.record(it.source, true, now); opened {
				log.Printf("[details] %s circuit OPEN after %d consecutive blocked fetch(es) — backing off %s", it.source, cb.circuit(it.source).consec, cd.Round(time.Second))
			}
			// If EVERY source in the work-list is circuit-open the whole session is
			// blocked — stop and flag a re-warm rather than burn the rest on a cold
			// session (single-source work-lists trip on that one source alone).
			if allOpen, rem := cb.allOpen(circuitSources, time.Now().UTC()); allOpen {
				log.Printf("[details] all sources circuit-open (session blocked) — stopping to re-warm; longest backoff %s", rem.Round(time.Second))
				rewarm = true
				break worklist
			}
			continue
		case outcomeError:
			st.errors++ // transient — leave the row un-stamped so it's retried next run
			continue
		}
		// A clean fetch closes the source's circuit.
		resetBlock(&reaBlocks, &domBlocks, it.source)
		cb.record(it.source, false, now)

		// Delist detection FIRST: a 404/redirect-to-search page has no listing to
		// extract, and is the whole reason a listing "disappeared" from the SRP.
		if isDelistedDetail(finalURL, it.source, html) {
			st.delisted++
			if cfg.dryRun {
				log.Printf("[details] DRY %s %s: would DELIST (final=%s)", it.listingID, it.source, finalURL)
				continue
			}
			if err := writeDetailDelist(ctx, pool, it); err != nil {
				log.Printf("[details] %s %s: delist write failed: %v", it.listingID, it.source, err)
				st.errors++
			}
			continue
		}

		rec, ok := extractDetail(string(html), it.source)
		if !ok {
			// The page rendered and wasn't a block or a delist, but no listing payload
			// was recognizable (an unparseable variant). Record it as 'error' + stamp
			// so we don't re-fetch it every run — the 90-day window still retries it.
			st.noPayload++
			if cfg.dryRun {
				log.Printf("[details] DRY %s %s: no listing payload recognized (final=%s)", it.listingID, it.source, finalURL)
				continue
			}
			if err := writeDetail(ctx, pool, it, "error", finalURL, detailRecord{Raw: "{}"}); err != nil {
				log.Printf("[details] %s %s: detail(error) write failed: %v", it.listingID, it.source, err)
				st.errors++
			}
			continue
		}

		st.ok++
		if cfg.dryRun {
			log.Printf("[details] DRY %s %s: %s", it.listingID, it.source, previewDetail(rec))
			continue
		}
		if err := writeDetail(ctx, pool, it, "ok", finalURL, rec); err != nil {
			log.Printf("[details] %s %s: detail write failed: %v", it.listingID, it.source, err)
			st.errors++
		}
	}

	if needsRewarm(cfg.maxConsecBlocks, reaBlocks, domBlocks) {
		rewarm = true
	}

	status := "ok"
	if rewarm {
		status = "needs_rewarm"
	}
	if cfg.dryRun {
		log.Printf("[details] dry-run: nothing written")
	} else {
		// A DETACHED context so a run-deadline firing mid-batch can't drop the status
		// row for work that already committed (same posture as the SRP finalizers).
		finCtx, finCancel := context.WithTimeout(context.Background(), 30*time.Second)
		_ = updateRun(finCtx, pool, "listing_details", nil, st.ok+st.delisted, status, "")
		finCancel()
	}

	log.Printf("[details] done: attempted=%d ok=%d delisted=%d noPayload=%d blocked=%d errors=%d skipped=%d",
		st.attempted, st.ok, st.delisted, st.noPayload, st.blocked, st.errors, st.skipped)
	if rewarm {
		log.Printf("[details] REWARM REQUIRED: circuit breaker tripped — re-warm the crawl Chrome profile by hand")
		return 3
	}
	return 0
}

// writeDetail persists one listing's detail snapshot: upsert the detail row, stamp
// the base cursor, and (on a good extraction) backfill the base row's missing
// geo/land/type — all in one transaction.
func writeDetail(ctx context.Context, pool *pgxpool.Pool, it detailTarget, status, finalURL string, rec detailRecord) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := upsertListingDetail(ctx, tx, it.pk, it.source, status, finalURL, rec); err != nil {
		return err
	}
	if err := stampDetailFetched(ctx, tx, it.pk); err != nil {
		return err
	}
	if status == "ok" {
		if err := backfillBaseRow(ctx, tx, it.pk, rec); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// writeDetailDelist records a definitive removal (a 404/redirect on the LDP): flip
// the base row inactive/withdrawn, append a 'delisted' price event, and stamp the
// detail cursor so the row leaves the work-list. Grace is 0 — unlike a missed SRP
// sweep (which might be a transient block), a detail 404 is unambiguous.
func writeDetailDelist(ctx context.Context, pool *pgxpool.Pool, it detailTarget) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := markAbsent(ctx, tx, it.pk, 0, true); err != nil {
		return err
	}
	// Same shape as the SRP delisted event (crawl_listings_diff.go): identity +
	// EventType/Status only, no price fields. PrevStatus is left empty — the
	// work-list doesn't carry the prior listing_status, and the delist signal is
	// the event + is_active=false, not the prior status.
	ev := priceEvent{
		ListingPK:  it.pk,
		Source:     it.source,
		ListingID:  it.listingID,
		RegionCode: it.regionCode,
		AddressKey: it.addressKey,
		ObservedAt: time.Now().UTC(),
		EventType:  "delisted",
		Status:     "withdrawn",
	}
	if err := insertPriceEvent(ctx, tx, ev); err != nil {
		return err
	}
	if err := stampDetailFetched(ctx, tx, it.pk); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// worklistSources returns the distinct sources present in the work-list, sorted —
// the set the session-blocked (allOpen) check considers, so an all-REA batch trips
// on REA alone rather than waiting on a domain circuit that never opens.
func worklistSources(items []detailTarget) []string {
	set := map[string]bool{}
	for _, it := range items {
		if it.source != "" {
			set[it.source] = true
		}
	}
	if len(set) == 0 {
		return []string{"rea", "domain"}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func bumpBlock(rea, dom *int, source string) {
	if source == "domain" {
		*dom++
		return
	}
	*rea++
}

func resetBlock(rea, dom *int, source string) {
	if source == "domain" {
		*dom = 0
		return
	}
	*rea = 0
}

// previewDetail is the compact one-line dry-run summary of a harvested detail.
func previewDetail(rec detailRecord) string {
	parts := []string{}
	if rec.PropertyType != "" {
		parts = append(parts, "type="+rec.PropertyType)
	}
	if rec.LandSizeSqm != nil {
		parts = append(parts, fmt.Sprintf("land=%.0fm²", *rec.LandSizeSqm))
	}
	if rec.Lat != nil && rec.Lng != nil {
		parts = append(parts, fmt.Sprintf("geo=%.4f,%.4f", *rec.Lat, *rec.Lng))
	}
	if len(rec.Features) > 0 {
		parts = append(parts, fmt.Sprintf("features=%d", len(rec.Features)))
	}
	if rec.ImageCount != nil {
		parts = append(parts, fmt.Sprintf("images=%d", *rec.ImageCount))
	}
	if rec.AgencyName != "" {
		parts = append(parts, "agency="+rec.AgencyName)
	}
	if len(rec.AgentPhones) > 0 {
		parts = append(parts, fmt.Sprintf("phones=%d", len(rec.AgentPhones)))
	}
	if len(rec.Description) > 0 {
		parts = append(parts, fmt.Sprintf("desc=%dch", len(rec.Description)))
	}
	if len(parts) == 0 {
		return "(no fields harvested)"
	}
	return strings.Join(parts, " ")
}

// detailIDSuffixRe matches a portal listing id at the END of a URL path segment
// (portal advert ids are >=6-digit numbers, e.g. .../...-2020524930). Postcodes
// (4 digits) don't match, so a suburb-search path like /sale/bondi-nsw-2026/ is
// correctly seen as "no listing id".
var detailIDSuffixRe = regexp.MustCompile(`\d{6,}$`)

// delistMarkers are page phrases that unambiguously mean the ad is gone. Kept tight
// (specific removal wording, not generic "page not found" chrome) so a healthy
// page can't false-trip.
var delistMarkers = []string{
	"no longer available",
	"no longer on the market",
	"listing has been removed",
	"has been removed from",
	"this property is not currently on the market",
	"property is no longer listed",
}

// isDelistedDetail reports whether a fetched detail page is really a delist: the
// listing 404'd or redirected off its own detail URL. Rules (conservative — each
// commented):
//
//	R1 (both portals): the rendered page carries an explicit removal phrase. The
//	    surest signal, independent of the URL, so it's checked first.
//	R2 (source-specific): the final URL bounced to that portal's search shape —
//	    Domain to /sale/<suburb>, REA to /buy/ or /neighbourhoods/ — i.e. it left
//	    the listing detail entirely.
//	R3 (both portals): the final URL hit an explicit not-found path.
//	R4 (both portals): a live LDP URL always ends in the portal's numeric advert
//	    id; when the FINAL url (after redirects) on a recognized portal host has
//	    lost that id, it bounced to a search/suburb/sold index page → delisted.
//
// A missing final URL (fetcher didn't report one) trusts ONLY the page markers
// (R1) — we never infer a delist from an empty URL.
func isDelistedDetail(finalURL, source string, html []byte) bool {
	lower := strings.ToLower(string(html))
	for _, m := range delistMarkers { // R1
		if strings.Contains(lower, m) {
			return true
		}
	}

	u := strings.ToLower(strings.TrimSpace(finalURL))
	if u == "" {
		return false
	}

	if source == "domain" && strings.Contains(u, "/sale/") { // R2 (Domain search shape)
		return true
	}
	if source == "rea" && (strings.Contains(u, "/buy/") || strings.Contains(u, "/neighbourhoods/")) { // R2 (REA search shape)
		return true
	}
	if strings.Contains(u, "property-not-found") || strings.Contains(u, "/not-found") { // R3
		return true
	}
	if isPortalURL(u) && !finalURLHasListingID(u) { // R4
		return true
	}
	return false
}

func isPortalURL(u string) bool {
	return strings.Contains(u, "realestate.com.au") || strings.Contains(u, "domain.com.au")
}

// finalURLHasListingID reports whether the URL's last path segment ends in a
// >=6-digit advert id (the signature of a live listing detail URL).
func finalURLHasListingID(u string) bool {
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	u = strings.TrimRight(u, "/")
	seg := u
	if i := strings.LastIndex(u, "/"); i >= 0 {
		seg = u[i+1:]
	}
	return detailIDSuffixRe.MatchString(seg)
}
