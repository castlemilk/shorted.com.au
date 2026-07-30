package influence

// Run modes for the register crawl.
//
// These modes are deliberately NOT part of -mode all. -mode all runs on every
// prod deploy (terraform-deploy.yml), and a 775-document crawl of aph.gov.au
// must never fire from a deploy step.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// runRegisterDiscover scrapes the five House listing pages plus the Senate
// tabled-volumes page and writes the manifest. It downloads no PDFs.
func runRegisterDiscover(ctx context.Context, pool *pgxpool.Pool, limit int) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		return fmt.Errorf("[register-discover] start collection run: %w", err)
	}

	client := newAPHClient()

	house, err := discoverHouseRegisterDocuments(ctx, client)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-discover]", err)
		return fmt.Errorf("[register-discover] house discovery: %w", err)
	}
	senate, err := discoverSenateRegisterVolumes(ctx, client)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-discover]", err)
		return fmt.Errorf("[register-discover] senate discovery: %w", err)
	}

	docs := append(house, senate...)
	discovered := len(docs)
	truncated := 0
	if limit > 0 && len(docs) > limit {
		truncated = len(docs) - limit
		docs = docs[:limit]
	}

	perParliament := map[int]int{}
	for _, d := range house {
		perParliament[d.Parliament]++
	}
	parliaments := make([]int, 0, len(perParliament))
	for p := range perParliament {
		parliaments = append(parliaments, p)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(parliaments)))
	for _, p := range parliaments {
		log.Printf("[register-discover] house parliament %d: %d documents", p, perParliament[p])
	}
	log.Printf("[register-discover] senate volumes in window: %d", len(senate))
	if truncated > 0 {
		// Never let a cap read as full coverage.
		log.Printf("[register-discover] -register-limit truncated %d of %d discovered documents", truncated, discovered)
	}

	if registerDryRun() {
		log.Printf("[register-discover] DRY-RUN — discovered %d documents, writing none (set REGISTER_DRY_RUN=false to persist)", len(docs))
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", discovered, 0, 0, "", map[string]any{
			"dry_run":            true,
			"discovered":         discovered,
			"house_documents":    len(house),
			"senate_documents":   len(senate),
			"truncated_by_limit": truncated,
		}); err != nil {
			return fmt.Errorf("[register-discover] finish collection run: %w", err)
		}
		return nil
	}

	written, err := upsertRegisterDocuments(ctx, pool, docs)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-discover]", err)
		return fmt.Errorf("[register-discover] upsert after %d rows: %w", written, err)
	}

	counts, err := countRegisterDocuments(ctx, pool)
	if err != nil {
		log.Printf("[register-discover] manifest count: %v", err)
	}

	if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", discovered, written, 0, "", map[string]any{
		"discovered":         discovered,
		"house_documents":    len(house),
		"senate_documents":   len(senate),
		"truncated_by_limit": truncated,
		"manifest_total":     counts.Total,
		"manifest_house":     counts.House,
		"manifest_senate":    counts.Senate,
		"pending_fetch":      counts.PendingFetch,
		"blocked_fetch":      counts.BlockedFetch,
	}); err != nil {
		return fmt.Errorf("[register-discover] finish collection run: %w", err)
	}

	log.Printf("[register-discover] upserted %d documents; manifest now holds %d (%d house, %d senate, %d pending fetch)",
		written, counts.Total, counts.House, counts.Senate, counts.PendingFetch)
	return nil
}

// runRegisterFetch drains the fetch queue, streaming each PDF into the sink.
//
// Politeness is deliberate and serial: one connection, REGISTER_FETCH_DELAY_MS
// (default 1500ms) between requests. A full 804-document pass therefore takes
// ~20 minutes, which is invisible to APH and fine for a scheduled job.
func runRegisterFetch(ctx context.Context, pool *pgxpool.Pool, limit int) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		return fmt.Errorf("[register-fetch] start collection run: %w", err)
	}

	maxAttempts := envInt("REGISTER_MAX_ATTEMPTS", defaultRegisterMaxAttempts)
	pending, err := selectPendingDocuments(ctx, pool, maxAttempts, limit)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-fetch]", err)
		return fmt.Errorf("[register-fetch] select queue: %w", err)
	}
	if len(pending) == 0 {
		log.Printf("[register-fetch] queue empty — nothing to fetch")
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", 0, 0, 0, "", map[string]any{"queue_empty": true}); err != nil {
			return fmt.Errorf("[register-fetch] finish collection run: %w", err)
		}
		return nil
	}

	if registerDryRun() {
		log.Printf("[register-fetch] DRY-RUN — %d documents queued, fetching none (set REGISTER_DRY_RUN=false to fetch)", len(pending))
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", len(pending), 0, 0, "", map[string]any{
			"dry_run": true, "queued": len(pending),
		}); err != nil {
			return fmt.Errorf("[register-fetch] finish collection run: %w", err)
		}
		return nil
	}

	sink, err := newRegisterSink(ctx)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-fetch]", err)
		return fmt.Errorf("[register-fetch] sink: %w", err)
	}
	client := newAPHClient()
	delay := registerFetchDelay()
	log.Printf("[register-fetch] %d queued -> %s (delay %s, max %d attempts)", len(pending), sink.Describe(), delay, maxAttempts)

	var fetched, deduped, failed, blocked int
	var bytesTotal int64

	// Labelled so the cancellation path exits the LOOP; a bare break inside the
	// select would only leave the select and keep crawling.
fetchLoop:
	for i, doc := range pending {
		if i > 0 {
			select {
			case <-ctx.Done():
				log.Printf("[register-fetch] context cancelled after %d documents", i)
				break fetchLoop
			case <-time.After(delay):
			}
		}

		res, err := fetchWithRetry(ctx, client, doc, sink, maxAttempts-doc.Attempts)
		if err != nil {
			_, isBlocked := errors.AsType[*errBlocked](err)
			if markErr := markDocumentFailed(ctx, pool, doc.ID, res.HTTPStatus, isBlocked, err); markErr != nil {
				log.Printf("[register-fetch] mark failed: %v", markErr)
			}
			if isBlocked {
				// The WAF changed its mind about us. Stop immediately: hammering
				// on through 804 documents would be exactly the wrong response.
				blocked++
				log.Printf("[register-fetch] BLOCKED at %s — aborting run", doc.SourceURL)
				registerFinishFailure(ctx, pool, runID, "[register-fetch]", err)
				return fmt.Errorf("[register-fetch] %w", err)
			}
			failed++
			log.Printf("[register-fetch] failed %s: %v", doc.SourceURL, err)
			continue
		}

		if err := markDocumentFetched(ctx, pool, doc.ID, res); err != nil {
			log.Printf("[register-fetch] mark fetched: %v", err)
			failed++
			continue
		}
		fetched++
		bytesTotal += res.ByteSize
		if res.Deduped {
			deduped++
		}
		if fetched%50 == 0 {
			log.Printf("[register-fetch] %d/%d fetched (%.1f MB)", fetched, len(pending), float64(bytesTotal)/(1<<20))
		}
	}

	status := "succeeded"
	if failed > 0 && fetched == 0 {
		status = "failed"
	} else if failed > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(pending), fetched, failed, "", map[string]any{
		"fetched":      fetched,
		"deduplicated": deduped,
		"failed":       failed,
		"blocked":      blocked,
		"bytes":        bytesTotal,
		"sink":         sink.Describe(),
	}); err != nil {
		return fmt.Errorf("[register-fetch] finish collection run: %w", err)
	}
	log.Printf("[register-fetch] fetched %d of %d (%d byte-identical, %d failed), %.1f MB",
		fetched, len(pending), deduped, failed, float64(bytesTotal)/(1<<20))
	return nil
}

// runRegisterLoad turns extraction artifacts into normalised rows and resolves
// each document to a person.
func runRegisterLoad(ctx context.Context, pool *pgxpool.Pool, limit int) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		return fmt.Errorf("[register-load] start collection run: %w", err)
	}

	pending, err := selectExtractionsToLoad(ctx, pool, limit)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-load]", err)
		return fmt.Errorf("[register-load] select artifacts: %w", err)
	}
	if registerDryRun() {
		log.Printf("[register-load] DRY-RUN — %d artifacts ready, loading none (set REGISTER_DRY_RUN=false to load)", len(pending))
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", len(pending), 0, 0, "", map[string]any{
			"dry_run": true, "artifacts": len(pending),
		}); err != nil {
			return fmt.Errorf("[register-load] finish collection run: %w", err)
		}
		return nil
	}

	// Party seeding runs BEFORE the queue-empty return, not after the load loop.
	// It reads the committed AEC file and existing terms, so it depends on
	// nothing in this run's artifacts — and once the backlog is drained every
	// subsequent run has an empty queue. Seeding after the loop would mean a
	// refreshed federal-divisions.json (post-election) never got applied.
	party, err := seedTermParties(ctx, pool)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-load]", err)
		return fmt.Errorf("[register-load] seed term parties: %w", err)
	}
	if !party.SkippedFile {
		log.Printf("[register-load] party seed (parliament %d): %d of %d terms carry a party (%d updated from %d divisions)",
			electoratesParliament, party.WithParty, party.Terms, party.Updated, party.Divisions)
		if len(party.Unmatched) > 0 {
			// Never silent: an unmatched seat is a blank party chip on a real
			// person's profile, and after a redistribution it is the signal that
			// federal-divisions.json needs refreshing.
			log.Printf("[register-load] party seed: %d divisions did not match the AEC gazetteer: %s",
				len(party.Unmatched), strings.Join(party.Unmatched, ", "))
		}
	}

	if len(pending) == 0 {
		log.Printf("[register-load] no extracted artifacts to load")
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", 0, 0, 0, "", map[string]any{
			"queue_empty":        true,
			"party_terms_seeded": party.WithParty,
			"party_terms_total":  party.Terms,
		}); err != nil {
			return fmt.Errorf("[register-load] finish collection run: %w", err)
		}
		return nil
	}

	// Retroactive quarantine: a document downgraded to 'partial' by a re-extract
	// must lose its previously loaded rows, or the quarantine only applies to
	// documents that were never loaded in the first place.
	purged, err := purgeNonExtractedStatements(ctx, pool)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-load]", err)
		return fmt.Errorf("[register-load] purge quarantined statements: %w", err)
	}
	if purged > 0 {
		log.Printf("[register-load] purged %d statements belonging to no-longer-extracted documents", purged)
	}

	var loaded, failed, statements, items int
	for _, p := range pending {
		s, i, err := loadExtraction(ctx, pool, p)
		if err != nil {
			failed++
			log.Printf("[register-load] %s failed: %v", p.SourceURL, err)
			continue
		}
		loaded++
		statements += s
		items += i
	}

	// Terms created by THIS run's load loop need seeding too — the pass above ran
	// before them. Idempotent, and cheap once the first pass has settled.
	if reseed, err := seedTermParties(ctx, pool); err != nil {
		log.Printf("[register-load] re-seed term parties: %v", err)
	} else if reseed.Updated > 0 {
		log.Printf("[register-load] party seed: %d further terms seeded after load", reseed.Updated)
		party = reseed
	}

	stats, err := registerLoadSummary(ctx, pool)
	if err != nil {
		log.Printf("[register-load] summary: %v", err)
	}

	status := "succeeded"
	if failed > 0 && loaded == 0 {
		status = "failed"
	} else if failed > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(pending), loaded, failed, "", map[string]any{
		"documents_loaded":          loaded,
		"statements_purged":         purged,
		"documents_failed":          failed,
		"statements_written":        statements,
		"items_written":             items,
		"politicians_total":         stats.Politicians,
		"declared_rows_total":       stats.Declared,
		"unresolved_statements":     stats.Unresolved,
		"party_terms_seeded":        party.WithParty,
		"party_terms_total":         party.Terms,
		"party_divisions_unmatched": len(party.Unmatched),
	}); err != nil {
		return fmt.Errorf("[register-load] finish collection run: %w", err)
	}

	log.Printf("[register-load] loaded %d documents (%d failed): %d statements, %d item rows", loaded, failed, statements, items)
	log.Printf("[register-load] totals: %d politicians, %d statements, %d item rows (%d declared), %d unresolved",
		stats.Politicians, stats.Statements, stats.Items, stats.Declared, stats.Unresolved)
	return nil
}

// runRegisterResolve rebuilds the declared-name -> ASX code links.
func runRegisterResolve(ctx context.Context, pool *pgxpool.Pool) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		return fmt.Errorf("[register-resolve] start collection run: %w", err)
	}

	if registerDryRun() {
		log.Printf("[register-resolve] DRY-RUN — resolving nothing (set REGISTER_DRY_RUN=false to write)")
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", 0, 0, 0, "", map[string]any{"dry_run": true}); err != nil {
			return fmt.Errorf("[register-resolve] finish collection run: %w", err)
		}
		return nil
	}

	stats, err := runRegisterSecurityResolve(ctx, pool)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-resolve]", err)
		return fmt.Errorf("[register-resolve] securities: %w", err)
	}

	locs, err := runRegisterLocationResolve(ctx, pool)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-resolve]", err)
		return fmt.Errorf("[register-resolve] locations: %w", err)
	}

	// The interval fold must run AFTER both resolvers: it keys holdings on the
	// resolved stock_code / sal_code where one exists.
	fold, err := rebuildHoldingPeriods(ctx, pool)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-resolve]", err)
		return fmt.Errorf("[register-resolve] holding periods: %w", err)
	}

	if err := refreshRegisterMaterializedViews(ctx, pool); err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-resolve]", err)
		return fmt.Errorf("[register-resolve] refresh materialized views: %w", err)
	}

	resolvedPct := 0.0
	// Denominator is entity_kind='listed' — the only kind that CAN carry a
	// ticker. Prose and "Not Applicable" are not failures to resolve (leaving
	// them in makes the gauge track how chatty members are), and neither is a
	// family trust: it can never be an ASX listing, so counting it as an
	// unresolved security is a category error.
	//
	// In practice this barely moves the number, because the private vehicles
	// were ALREADY outside the old denominator: resolveSecurityCandidate sends
	// them to not_a_security. Recording it this way makes the denominator mean
	// what it says instead of meaning it by accident.
	resolvable := stats.ByKind[entityKindListed]
	if resolvable > 0 {
		resolvedPct = 100.0 * float64(stats.Resolved) / float64(resolvable)
	}

	if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", stats.Candidates, stats.Resolved, 0, "", map[string]any{
		"candidates":            stats.Candidates,
		"resolvable":            resolvable,
		"resolved":              stats.Resolved,
		"ambiguous":             stats.Ambiguous,
		"unmatched":             stats.Unmatched,
		"unlisted_fund":         stats.Unlisted,
		"not_a_security":        stats.NotSecurity,
		"security_resolved_pct": resolvedPct,
		"by_method":             stats.ByMethod,
		"by_entity_kind":        stats.ByKind,
		"location_rows":         locs.Rows,
		"location_resolved":     locs.Resolved,
		"location_ambiguous":    locs.Ambiguous,
		"location_region":       locs.Region,
		"location_no_state":     locs.NoState,
		"location_unmatched":    locs.Unmatched,
		"location_redacted":     locs.Redacted,
		"location_resolved_pct": locationPct(locs),
		"holding_events":        fold.Events,
		"holdings":              fold.Holdings,
		"holding_intervals":     fold.Intervals,
		"holdings_current":      fold.Current,
		"holdings_unknown_from": fold.UnknownFrom,
	}); err != nil {
		return fmt.Errorf("[register-resolve] finish collection run: %w", err)
	}

	log.Printf("[register-resolve] %d candidates: %d resolved (%.1f%% of %d listed candidates), %d ambiguous, %d unmatched, %d not-a-security",
		stats.Candidates, stats.Resolved, resolvedPct, resolvable, stats.Ambiguous, stats.Unmatched, stats.NotSecurity)

	// THE GATE is item 1 alone. The line above spans items 1 AND 4, which is what
	// the resolver processes, but item 4 (directorships) is almost entirely
	// private companies and resolves at ~1% — §3.4 says it must not sit in the
	// headline denominator. Reporting both makes the difference visible instead
	// of silently understating the metric by ~2.7 points.
	item1Pct := 0.0
	if stats.Item1Listed > 0 {
		item1Pct = 100.0 * float64(stats.Item1Resolved) / float64(stats.Item1Listed)
	}
	log.Printf("[register-resolve] GATE (item 1 only): %d resolved of %d listed candidates = %.2f%%",
		stats.Item1Resolved, stats.Item1Listed, item1Pct)
	for method, n := range stats.ByMethod {
		log.Printf("[register-resolve]   via %s: %d", method, n)
	}
	for kind, n := range stats.ByKind {
		log.Printf("[register-resolve]   entity_kind %s: %d", kind, n)
	}

	log.Printf("[register-resolve] locations: %d rows, %d resolved (%.1f%%), %d ambiguous, %d region, %d no-state, %d unmatched",
		locs.Rows, locs.Resolved, locationPct(locs), locs.Ambiguous, locs.Region, locs.NoState, locs.Unmatched)
	log.Printf("[register-resolve] fold: %d events -> %d holdings, %d intervals (%d current, %d closed, %d with an unknown start)",
		fold.Events, fold.Holdings, fold.Intervals, fold.Current, fold.Closed, fold.UnknownFrom)

	if locs.Redacted > 0 {
		// Never silent: the register asks for suburb only, so a street address is
		// the source over-disclosing and we must be seen not to amplify it.
		log.Printf("[register-resolve] redacted a street address from %d location rows (editorial standards §4)", locs.Redacted)
	}
	return nil
}

func locationPct(s locationResolveStats) float64 {
	if s.Rows == 0 {
		return 0
	}
	return 100.0 * float64(s.Resolved) / float64(s.Rows)
}

func registerFinishFailure(ctx context.Context, pool *pgxpool.Pool, runID, label string, err error) {
	metadata := map[string]any{
		"house_listing":  aphBase + houseRegisterPath,
		"senate_listing": aphBase + senateVolumesPath,
	}
	// A WAF block is a distinct, actionable failure — surface it as its own flag
	// so the freshness alarm can trip on it rather than on a generic error count.
	if _, ok := errors.AsType[*errSourceUnavailable](err); ok {
		metadata["source_unavailable"] = true
	}
	finishCollectionRunAfterFailure(ctx, pool, runID, label, err, metadata)
}

// registerDryRun defaults to TRUE: a crawl of a parliamentary website is never
// something to start by accident.
func registerDryRun() bool {
	return envBool("REGISTER_DRY_RUN", true)
}

// envBool reads a boolean env var, falling back when unset or unparseable.
func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	}
	if v, err := strconv.ParseBool(raw); err == nil {
		return v
	}
	log.Printf("[register] ignoring unparseable %s=%q, using %v", key, raw, fallback)
	return fallback
}

// ---------------------------------------------------------------------------
// Register mode wrappers for the shared-binary runner
// ---------------------------------------------------------------------------
//
// The standalone binary did these inline in main.go with log.Fatalf/os.Exit.
// Inside `shorted` a job must RETURN its failure so deferred cleanup runs and
// the runner still emits its status line — same posture as economy's
// runFreshness. Message text is preserved.

// runRegisterFreshnessMode is read-only and fails the job when any check alarms,
// so the weekly workflow that invokes it goes red. Same contract as the
// standalone binary's os.Exit(1).
func runRegisterFreshnessMode(ctx context.Context, pool *pgxpool.Pool) error {
	checks, err := collectRegisterFreshness(ctx, pool, time.Now())
	if err != nil {
		return fmt.Errorf("register-freshness: %w", err)
	}
	if alarms := writeRegisterFreshnessReport(os.Stdout, checks); alarms > 0 {
		return fmt.Errorf("%d register freshness alarm(s)", alarms)
	}
	return nil
}

// runRegisterProposeAliasesMode writes ONLY register_alias_proposals, which no
// resolver and no read path reads. A proposal becomes publishable exclusively via
// a human marking it 'confirmed' and then -mode register-promote-aliases.
func runRegisterProposeAliasesMode(ctx context.Context, pool *pgxpool.Pool, limit int) error {
	if limit <= 0 {
		limit = 50
	}
	n, err := runRegisterAliasPropose(ctx, pool, limit, registerDryRun())
	if err != nil {
		return fmt.Errorf("[register-propose-aliases] %w", err)
	}
	log.Printf("[register-propose-aliases] %d proposals written (dry_run=%v)", n, registerDryRun())
	return nil
}

// runRegisterPromoteAliasesMode is the ONLY path from a model's proposal to a
// published link, and it runs only over rows a human already confirmed.
func runRegisterPromoteAliasesMode(ctx context.Context, pool *pgxpool.Pool) error {
	if registerDryRun() {
		log.Printf("[register-promote-aliases] REGISTER_DRY_RUN is set; no aliases promoted")
		return nil
	}
	n, err := promoteAliasProposals(ctx, pool)
	if err != nil {
		return fmt.Errorf("[register-promote-aliases] %w", err)
	}
	log.Printf("[register-promote-aliases] promoted %d human-confirmed proposals to curated aliases", n)
	return nil
}
