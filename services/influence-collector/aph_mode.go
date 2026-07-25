package main

// Run modes for the register crawl.
//
// These modes are deliberately NOT part of -mode all. -mode all runs on every
// prod deploy (terraform-deploy.yml), and a 775-document crawl of aph.gov.au
// must never fire from a deploy step.

import (
	"context"
	"errors"
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
func runRegisterDiscover(ctx context.Context, pool *pgxpool.Pool, limit int) {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		log.Fatalf("[register-discover] start collection run: %v", err)
	}

	client := newAPHClient()

	house, err := discoverHouseRegisterDocuments(ctx, client)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-discover]", err)
		log.Fatalf("[register-discover] house discovery: %v", err)
	}
	senate, err := discoverSenateRegisterVolumes(ctx, client)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-discover]", err)
		log.Fatalf("[register-discover] senate discovery: %v", err)
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
			log.Fatalf("[register-discover] finish collection run: %v", err)
		}
		return
	}

	written, err := upsertRegisterDocuments(ctx, pool, docs)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-discover]", err)
		log.Fatalf("[register-discover] upsert after %d rows: %v", written, err)
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
		log.Fatalf("[register-discover] finish collection run: %v", err)
	}

	log.Printf("[register-discover] upserted %d documents; manifest now holds %d (%d house, %d senate, %d pending fetch)",
		written, counts.Total, counts.House, counts.Senate, counts.PendingFetch)
}

// runRegisterFetch drains the fetch queue, streaming each PDF into the sink.
//
// Politeness is deliberate and serial: one connection, REGISTER_FETCH_DELAY_MS
// (default 1500ms) between requests. A full 804-document pass therefore takes
// ~20 minutes, which is invisible to APH and fine for a scheduled job.
func runRegisterFetch(ctx context.Context, pool *pgxpool.Pool, limit int) {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		log.Fatalf("[register-fetch] start collection run: %v", err)
	}

	maxAttempts := envInt("REGISTER_MAX_ATTEMPTS", defaultRegisterMaxAttempts)
	pending, err := selectPendingDocuments(ctx, pool, maxAttempts, limit)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-fetch]", err)
		log.Fatalf("[register-fetch] select queue: %v", err)
	}
	if len(pending) == 0 {
		log.Printf("[register-fetch] queue empty — nothing to fetch")
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", 0, 0, 0, "", map[string]any{"queue_empty": true}); err != nil {
			log.Fatalf("[register-fetch] finish collection run: %v", err)
		}
		return
	}

	if registerDryRun() {
		log.Printf("[register-fetch] DRY-RUN — %d documents queued, fetching none (set REGISTER_DRY_RUN=false to fetch)", len(pending))
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", len(pending), 0, 0, "", map[string]any{
			"dry_run": true, "queued": len(pending),
		}); err != nil {
			log.Fatalf("[register-fetch] finish collection run: %v", err)
		}
		return
	}

	sink, err := newRegisterSink(ctx)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-fetch]", err)
		log.Fatalf("[register-fetch] sink: %v", err)
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
				log.Fatalf("[register-fetch] %v", err)
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
		log.Fatalf("[register-fetch] finish collection run: %v", err)
	}
	log.Printf("[register-fetch] fetched %d of %d (%d byte-identical, %d failed), %.1f MB",
		fetched, len(pending), deduped, failed, float64(bytesTotal)/(1<<20))
}

// runRegisterLoad turns extraction artifacts into normalised rows and resolves
// each document to a person.
func runRegisterLoad(ctx context.Context, pool *pgxpool.Pool, limit int) {
	runID, err := insertIndustryCollectionRun(ctx, pool, registerSource)
	if err != nil {
		log.Fatalf("[register-load] start collection run: %v", err)
	}

	pending, err := selectExtractionsToLoad(ctx, pool, limit)
	if err != nil {
		registerFinishFailure(ctx, pool, runID, "[register-load]", err)
		log.Fatalf("[register-load] select artifacts: %v", err)
	}
	if len(pending) == 0 {
		log.Printf("[register-load] no extracted artifacts to load")
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", 0, 0, 0, "", map[string]any{"queue_empty": true}); err != nil {
			log.Fatalf("[register-load] finish collection run: %v", err)
		}
		return
	}

	if registerDryRun() {
		log.Printf("[register-load] DRY-RUN — %d artifacts ready, loading none (set REGISTER_DRY_RUN=false to load)", len(pending))
		if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", len(pending), 0, 0, "", map[string]any{
			"dry_run": true, "artifacts": len(pending),
		}); err != nil {
			log.Fatalf("[register-load] finish collection run: %v", err)
		}
		return
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
		"documents_loaded":      loaded,
		"documents_failed":      failed,
		"statements_written":    statements,
		"items_written":         items,
		"politicians_total":     stats.Politicians,
		"declared_rows_total":   stats.Declared,
		"unresolved_statements": stats.Unresolved,
	}); err != nil {
		log.Fatalf("[register-load] finish collection run: %v", err)
	}

	log.Printf("[register-load] loaded %d documents (%d failed): %d statements, %d item rows", loaded, failed, statements, items)
	log.Printf("[register-load] totals: %d politicians, %d statements, %d item rows (%d declared), %d unresolved",
		stats.Politicians, stats.Statements, stats.Items, stats.Declared, stats.Unresolved)
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
