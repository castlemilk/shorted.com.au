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
