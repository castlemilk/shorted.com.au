package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A Valuer-General ingest that recomputes a whole calendar year from the raw
// sales file is AUTHORITATIVE for that year: a suburb-year it no longer emits
// has no median any more, so the stored one must go. An upsert alone cannot
// express that. When the NSW parser learned to drop whole-building contracts
// (2026-09-24) the rig re-ran and upserted 5,782 medians, but 169 suburb-years
// the filtered parser no longer emits kept their inflated value (St Leonards
// 2024 $110.5M, Rhodes 2023 $22.5M, Point Piper 2025 $60.5M), because nothing
// ever deleted them.
//
// replaceScope names the slice a run is authoritative for. The prune runs in
// the SAME transaction as the upsert, so a reader sees the old year or the new
// year, never a year half-deleted.
type replaceScope struct {
	Source       string
	Measure      string
	DwellingType string
	PeriodFreq   string
	// Years are the calendar years whose full emission set this run holds.
	// A year absent here is upserted but never pruned.
	Years []int
	// Withheld explains each fetched year left out of Years because its
	// emission set cannot be trusted (a thin download). It is carried into
	// replaceResult.HeldBack so the run can say so with its exit code.
	Withheld []string
}

// replaceResult is what one authoritative write did. HeldBack lists every
// fetched year that kept its stale rows — a thin download, or a prune over
// replaceMaxPruneShare. The upsert still commits (the new medians are better
// than the old ones), but a held year means the parser or the download
// probably regressed, so the rig must exit non-zero rather than log and
// carry on (see exitVGPruneHeldBack).
type replaceResult struct {
	Upserted int
	Pruned   int64
	HeldBack []string
}

// replaceMaxPruneShare is the most of one year's stored rows a single run may
// prune. The sales floor (nswReplaceMinSales) catches a truncated download;
// this catches the other way an emission set shrinks by accident, a parser
// regression that silently drops a district or a zone. Measured 2026-09-24:
// the legitimate whole-building clean-up pruned 1.6% (2023), 1.5% (2024) and
// 4.9% (2025). A year over the cap keeps every row, says so in the log, and
// fails the rig's exit code (exitVGPruneHeldBack) so the wrapper alerts.
const replaceMaxPruneShare = 0.20

// yearPruneStats is one authoritative year as stored after the upsert: total
// rows in the scope, and how many of them the run did not emit.
type yearPruneStats struct {
	Year  int
	Total int
	Stale int
}

// prunableYears applies replaceMaxPruneShare: it returns the years whose stale
// rows may be deleted, and a reason for each year that is held back.
func prunableYears(stats []yearPruneStats, maxShare float64) (allowed []int, held []string) {
	for _, s := range stats {
		switch {
		case s.Stale == 0:
			continue
		case s.Total <= 0 || float64(s.Stale) > maxShare*float64(s.Total):
			held = append(held, fmt.Sprintf("%d: %d of %d rows unemitted (over the %.0f%% prune cap)",
				s.Year, s.Stale, s.Total, maxShare*100))
		default:
			allowed = append(allowed, s.Year)
		}
	}
	sort.Ints(allowed)
	return allowed, held
}

// emittedKeys is the (region_code, period) set a run wrote, as parallel text
// arrays: simple protocol (the Supabase transaction pooler) binds text arrays
// portably, and the SQL casts the periods back to date.
func emittedKeys(obs []Observation, scope replaceScope) (regions, periods []string) {
	for _, o := range obs {
		if o.Source != scope.Source || o.Measure != scope.Measure || o.DwellingType != scope.DwellingType {
			continue
		}
		regions = append(regions, o.RegionCode)
		periods = append(periods, o.Period.Format("2006-01-02"))
	}
	return regions, periods
}

// scopeWhere is the slice predicate shared by the stats and the delete. $1-$4
// are the scope, $5 the authoritative years.
const scopeWhere = `
	h.source = $1 AND h.measure = $2 AND h.dwelling_type = $3 AND h.period_freq = $4
	AND extract(year FROM h.period)::int = ANY($5::int[])`

// unemittedPredicate matches a stored row the run did not write. $6/$7 are the
// emitted (region_code, period) keys.
const unemittedPredicate = `NOT EXISTS (
		SELECT 1 FROM unnest($6::text[], $7::date[]) AS k(region_code, period)
		WHERE k.region_code = h.region_code AND k.period = h.period)`

var replaceStatsSQL = `
	SELECT extract(year FROM h.period)::int AS yr,
	       count(*) AS total,
	       count(*) FILTER (WHERE ` + unemittedPredicate + `) AS stale
	FROM house_prices h
	WHERE ` + scopeWhere + `
	GROUP BY 1
	ORDER BY 1`

var replacePruneSQL = `
	DELETE FROM house_prices h
	WHERE ` + scopeWhere + `
	  AND ` + unemittedPredicate + `
	RETURNING h.region_code, extract(year FROM h.period)::int, h.value`

// replaceObservations upserts obs and, in the same transaction, deletes every
// row of the scope's authoritative years that obs does not contain — subject
// to replaceMaxPruneShare. The result's HeldBack names every year that kept
// its stale rows, whether withheld up front or over the prune cap.
func replaceObservations(ctx context.Context, pool *pgxpool.Pool, obs []Observation, scope replaceScope) (replaceResult, error) {
	res := replaceResult{HeldBack: append([]string(nil), scope.Withheld...)}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	res.Upserted, err = upsertObservationsOn(ctx, tx, obs)
	if err != nil {
		return res, err
	}
	pruned, held, err := pruneUnemitted(ctx, tx, obs, scope)
	if err != nil {
		return res, fmt.Errorf("prune unemitted %s rows: %w", scope.Source, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	res.Pruned = pruned
	res.HeldBack = append(res.HeldBack, held...)
	return res, nil
}

func pruneUnemitted(ctx context.Context, tx pgx.Tx, obs []Observation, scope replaceScope) (int64, []string, error) {
	if len(scope.Years) == 0 {
		log.Printf("[%s] no authoritative year this run; nothing pruned", scope.Source)
		return 0, nil, nil
	}
	regions, periods := emittedKeys(obs, scope)
	args := []any{scope.Source, scope.Measure, scope.DwellingType, scope.PeriodFreq, scope.Years, regions, periods}

	rows, err := tx.Query(ctx, replaceStatsSQL, args...)
	if err != nil {
		return 0, nil, err
	}
	stats, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (yearPruneStats, error) {
		var s yearPruneStats
		err := r.Scan(&s.Year, &s.Total, &s.Stale)
		return s, err
	})
	if err != nil {
		return 0, nil, err
	}
	allowed, held := prunableYears(stats, replaceMaxPruneShare)
	for _, h := range held {
		log.Printf("[%s] WARNING prune held back for %s — every row kept; investigate the parser before re-running", scope.Source, h)
	}
	if len(allowed) == 0 {
		return 0, held, nil
	}
	args[4] = allowed
	rows, err = tx.Query(ctx, replacePruneSQL, args...)
	if err != nil {
		return 0, nil, err
	}
	type prunedRow struct {
		region string
		year   int
		value  float64
	}
	gone, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (prunedRow, error) {
		var p prunedRow
		err := r.Scan(&p.region, &p.year, &p.value)
		return p, err
	})
	if err != nil {
		return 0, nil, err
	}
	perYear := map[int]int{}
	var examples []string
	for _, p := range gone {
		perYear[p.year]++
		if len(examples) < 5 {
			examples = append(examples, fmt.Sprintf("%s %d $%.0f", strings.TrimPrefix(p.region, "SUBURB:"), p.year, p.value))
		}
	}
	for _, yr := range allowed {
		log.Printf("[%s] %d: pruned %d stored row(s) this run no longer emits", scope.Source, yr, perYear[yr])
	}
	if len(examples) > 0 {
		log.Printf("[%s] pruned e.g. %s", scope.Source, strings.Join(examples, "; "))
	}
	return int64(len(gone)), held, nil
}
