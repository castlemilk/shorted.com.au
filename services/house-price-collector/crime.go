package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// runCrime is the -mode crime orchestrator: load the SAL registry → fetch + parse
// the ABS CVS scaling anchor + ERP denominator → fetch each state police source
// → crosswalk → scale → rate → within-jurisdiction pop-weighted rank → upsert → refresh MV.
//
// Operator-run (like census), yearly cadence (CVS pacing input, ~9-mo lag). NOT
// part of -mode all / the scheduled run. DRY-RUN by default (CRIME_DRY_RUN=false
// to write). Phase 1 = NSW (BOCSAR) only; VIC/QLD/SA/ACT are drop-in follow-ups
// that add a fetcher + crosswalk and append to the jds slice below.
const crimeRunSource = "crime_primaries"

func runCrime(ctx context.Context, pool *pgxpool.Pool) error {
	mode := crimeScalerMode()
	dryRun := envBool("CRIME_DRY_RUN", true)
	log.Printf("[crime] scaler mode=%s dry_run=%v", mode, dryRun)

	// 1. SAL registry (name → sal_code), from suburb_demographics (census first).
	registry, err := loadCrimeSalRegistry(ctx, pool)
	if err != nil {
		log.Printf("[crime] sal registry error: %v", err)
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", err.Error())
		return err
	}

	// 2. ABS CVS (state scaling anchor) + population bases.
	pooledB, popB, err := fetchCVSWorkbooks(ctx)
	if err != nil {
		log.Printf("[crime] CVS fetch error: %v", err)
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", err.Error())
		return err
	}
	cvs, err := parseCVS(pooledB, popB)
	if err != nil {
		log.Printf("[crime] CVS parse error: %v", err)
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", err.Error())
		return err
	}
	log.Printf("[crime] CVS parsed: %d states, base FY %d", len(cvs.StateBase), cvs.BaseFY)

	// 3. SAL FY ERP (denominator + rank weight).
	erp, err := buildSalFyERP(ctx, pool)
	if err != nil {
		log.Printf("[crime] ERP build error: %v", err)
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", err.Error())
		return err
	}

	// 4. Per-jurisdiction police fetch + crosswalk + SAL bridge.
	var jds []*jurisdictionData
	nsw, err := fetchNSW(ctx, registry["NSW"])
	if err != nil {
		log.Printf("[crime] NSW fetch error: %v", err)
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", err.Error())
		return err
	}
	minMatch := envFloat("CRIME_MIN_MATCH_RATE", 0.95)
	log.Printf("[crime] NSW: %d suburbs matched, %d unmatched (%.1f%%), %d raw rows",
		nsw.matched, nsw.unmatched, nsw.matchRate()*100, len(nsw.rows))
	if nsw.matchRate() < minMatch {
		msg := fmt.Sprintf("NSW name→SAL match rate %.1f%% < %.1f%% floor; sample unmatched: %v",
			nsw.matchRate()*100, minMatch*100, nsw.unmatchedSample)
		log.Printf("[crime] %s", msg)
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", msg)
		return errors.New(msg)
	}
	if nsw.matchRate() < 0.98 {
		log.Printf("[crime] WARNING: NSW match rate %.1f%% below the 98%% plan target; unmatched: %v",
			nsw.matchRate()*100, nsw.unmatchedSample)
	}
	jds = append(jds, nsw)

	// 5. Scale + rate + within-jurisdiction pop-weighted percentile rank (single + pooled).
	rows, stats := computeCrime(jds, cvs, erp, mode)
	log.Printf("[crime] computed %d rows (%d single + %d pooled), %d state scales, latest FY %d",
		len(rows), stats.SingleRows, stats.PooledRows, stats.StateScales, stats.LatestFY)
	logCrimeSample(rows)
	if len(rows) == 0 {
		const msg = "no rows computed (no CVS/ERP overlap?)"
		_ = updateRun(ctx, pool, crimeRunSource, nil, 0, "error", msg)
		return errors.New(msg)
	}

	lastFY := fyEndDate(stats.LatestFY)
	if dryRun {
		log.Printf("[crime] DRY-RUN — not writing %d rows (set CRIME_DRY_RUN=false to apply)", len(rows))
		_ = updateRun(ctx, pool, crimeRunSource, lastFY, len(rows), "ok", "dry-run")
		// A dry run that got this far succeeded: it computed rows and chose not
		// to write them. Exiting non-zero here would make the default invocation
		// look like a failure.
		return nil
	}

	// 6. Upsert + refresh the housing MVs (mv_suburb_crime_latest folded in).
	n, err := upsertCrime(ctx, pool, rows)
	if err != nil {
		log.Printf("[crime] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, crimeRunSource, lastFY, n, "error", err.Error())
		return err
	}
	log.Printf("[crime] upserted %d rows", n)
	if err := refresh(ctx, pool); err != nil {
		// The rows are committed but stay invisible until the MVs rebuild, so this
		// is not an "ok" run — record it as an error and let the freshness sentinel
		// see it rather than banking a success the read path can't observe.
		log.Printf("[crime] mv refresh failed after %d rows: %v", n, err)
		_ = updateRun(ctx, pool, crimeRunSource, lastFY, n, "error", fmt.Sprintf("mv refresh: %v", err))
		return err
	}
	_ = updateRun(ctx, pool, crimeRunSource, lastFY, n, "ok", fmt.Sprintf("mode=%s", mode))
	return nil
}

// loadCrimeSalRegistry builds state → (normalised sal_name → sal_code) from
// suburb_demographics. Ambiguous names (same normalised name → >1 SAL within a
// state) keep the first and are logged — they never silently overwrite.
func loadCrimeSalRegistry(ctx context.Context, pool *pgxpool.Pool) (map[string]map[string]string, error) {
	rows, err := pool.Query(ctx, `SELECT sal_code, sal_name, state_code FROM suburb_demographics`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reg := map[string]map[string]string{}
	ambiguous := 0
	total := 0
	for rows.Next() {
		var sal, name, state string
		if err := rows.Scan(&sal, &name, &state); err != nil {
			return nil, err
		}
		total++
		if reg[state] == nil {
			reg[state] = map[string]string{}
		}
		key := normCrimeSuburb(name)
		if key == "" {
			continue
		}
		if _, exists := reg[state][key]; exists {
			ambiguous++
			continue
		}
		reg[state][key] = sal
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if total == 0 {
		return nil, fmt.Errorf("suburb_demographics empty — run -mode census first")
	}
	if ambiguous > 0 {
		log.Printf("[crime] sal registry: %d ambiguous normalised names across %d suburbs (kept first)", ambiguous, total)
	}
	return reg, nil
}

// logCrimeSample logs the top-5 latest-pooled break-in ranks as a spot-check.
func logCrimeSample(rows []CrimeStatRow) {
	latest := 0
	for _, r := range rows {
		if r.Pooled && r.FYEnding > latest {
			latest = r.FYEnding
		}
	}
	var sample []CrimeStatRow
	for _, r := range rows {
		if r.Pooled && r.FYEnding == latest && r.CrimeType == string(crimeBreakIns) && !r.SmallPop {
			sample = append(sample, r)
		}
	}
	sort.Slice(sample, func(i, j int) bool { return sample[i].PctRank > sample[j].PctRank })
	if len(sample) > 5 {
		sample = sample[:5]
	}
	for _, r := range sample {
		log.Printf("[crime] top break_ins FY%d: sal=%s rank=%.1f rate=%.0f/100k adj=%.0f raw=%.0f pop=%d",
			r.FYEnding, r.SalCode, r.PctRank, r.RatePer100k, r.AdjustedCount, r.RawCount, r.Population)
	}
}

// fyEndDate returns 30 June of the FY-ending year (or nil for 0).
func fyEndDate(fy int) *time.Time {
	if fy == 0 {
		return nil
	}
	t := time.Date(fy, time.June, 30, 0, 0, 0, 0, time.UTC)
	return &t
}

// envBool parses a boolean env knob (default def). "false"/"0"/"no" → false.
func envBool(key string, def bool) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if v == "" {
		return def
	}
	switch v {
	case "false", "0", "no", "off":
		return false
	case "true", "1", "yes", "on":
		return true
	default:
		return def
	}
}
