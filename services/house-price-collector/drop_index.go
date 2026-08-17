package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// drop_index.go computes the daily discounting index behind /price-drops.
//
// The whole design turns on ONE choice: the index is the equal-weighted mean of
// per-suburb drop rates, NOT sum(dropped)/sum(active).
//
// Measured 2026-08-16: suburbs with listing data per week ran 115, 124, 88,
// 491, 499 — zero suburbs appear in every week, because the crawl catalog grew
// from ~115 to 500. A pooled ratio over that history measures catalog growth.
// Reconstructed naively the active denominator reads 1,246 -> 19,977 -> 27,301
// -> 60,934 -> 36,397, where the final fall is the 2026-08-13..15 crawl outage.
// Published as a market index that is a crash which did not happen.
//
// Equal weighting makes an added suburb move the mean by 1/N instead of by
// however many listings it brought. TestIndexWeightsSuburbsEqually pins this
// — a pooled ratio yields 0.2942 there where the mean yields 0.254.
//
// SECOND BUG, shipped alongside the first and diagnosed 2026-08-16/17:
// "active on date d" was defined as first_seen_at <= d AND last_seen_at >= d.
// last_seen_at is a CENSORED observation — "last time we looked", not "last
// day on market" — and the crawl only sweeps ~20-40 suburbs/day. For dates
// near the present that filter degenerates into "was this suburb re-crawled
// since d", so the panel collapsed 499 -> 24 as the date approached today and
// the index rose 0.0149 -> 0.0677 on the collapse alone. Fixed by sourcing the
// panel from ACTUAL SWEEPS in a trailing indexSweepWindowDays window instead —
// see suburbDaysSQL. Coverage is now measured against the full suburb catalog
// (queryCatalogSize) rather than against the panel itself: previously
// sweptRecently was computed from rows already filtered to last_seen_at >= d,
// so it was true by construction and coverage=1.00/gap=false was reported even
// on 2026-08-14, when the crawl swept zero suburbs.

// suburbDay is one suburb's contribution to one snapshot date. A suburb only
// appears here if it was actually swept (had a listing with last_seen_at) in
// the trailing indexSweepWindowDays window ending on the snapshot date — see
// suburbDaysSQL. There is no longer a per-row "was this swept" flag: every row
// is, by construction, a real sweep observation. Coverage is a panel-level
// property computed against the full catalog, not a per-suburb one.
type suburbDay struct {
	salCode       string
	stateCode     string  // used when rolling suburbs up to a state grain
	active        int     // deduped physical addresses observed in the sweep window
	dropped       int     // addresses with a price_drop in the trailing 30d, still observed
	medianDropPct float64 // depth of cut within the suburb, 0..1
}

// indexPoint is one row of housing_drop_index_daily.
type indexPoint struct {
	ActiveAddresses       int
	DroppedAddresses      int
	DropRate              float64
	MedianDropPct         float64
	WithdrawnThenRelisted int
	DelistedCount         int
	PanelSuburbs          int
	CoverageRatio         float64
	IsGap                 bool
}

// aggregateIndex folds per-suburb rows into one snapshot point.
//
// minActive excludes suburbs too small to carry a meaningful rate — a
// three-listing suburb reports 33% off a single cut. gapThreshold is the
// coverage ratio below which the day is not a fair reading at all. catalogSize
// is the full suburb catalog (queryCatalogSize) — coverage is measured against
// it, NOT against the panel itself, so a thin day is visibly thin rather than
// silently renormalised to "100% of what we happened to see".
func aggregateIndex(rows []suburbDay, minActive int, gapThreshold float64, catalogSize int) indexPoint {
	var out indexPoint

	rates := make([]float64, 0, len(rows))
	depths := make([]float64, 0, len(rows))

	for _, r := range rows {
		// active == 0 would make the rate NaN and poison the whole day's mean.
		// Guarded independently of minActive because minActive's zero value is 0.
		if r.active <= 0 {
			continue
		}
		if r.active < minActive {
			continue // too small to weigh equally with a real suburb
		}
		out.PanelSuburbs++
		out.ActiveAddresses += r.active
		out.DroppedAddresses += r.dropped
		rates = append(rates, float64(r.dropped)/float64(r.active))
		// medianDropPct is 0 when the suburb recorded no drops at all, so a zero is
		// "no depth to report" rather than "a 0% cut". Excluding it keeps the
		// national depth figure from being dragged down by suburbs with no cuts.
		if r.medianDropPct > 0 {
			depths = append(depths, r.medianDropPct)
		}
	}

	if out.PanelSuburbs == 0 {
		// No panel is not "zero discounting" — it is no reading.
		out.IsGap = true
		return out
	}

	var sum float64
	for _, v := range rates {
		sum += v
	}
	out.DropRate = sum / float64(len(rates))
	out.MedianDropPct = median(depths)

	if catalogSize <= 0 {
		// No catalog to measure coverage against — never claim a full house.
		// A zero here means the caller failed to wire catalogSize, and treating
		// it as "0/0 = 100%" would repeat exactly the bug this rewrite fixes.
		out.CoverageRatio = 0
		out.IsGap = true
		return out
	}
	out.CoverageRatio = float64(out.PanelSuburbs) / float64(catalogSize)
	out.IsGap = out.CoverageRatio < gapThreshold

	return out
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	mid := len(s) / 2
	if len(s)%2 == 1 {
		return s[mid]
	}
	return (s[mid-1] + s[mid]) / 2
}

// indexBackfillStart is 2026-08-13, for a reason that has nothing to do with
// catalog growth: price_drop events begin 2026-07-14 in prod, so a trailing
// 30-day (indexWindowDays) numerator is not COMPLETE until 30 days later, on
// 2026-08-13 — before that the index rises purely because its own event
// window is still filling, not because discounting increased. Coverage
// (measured against the catalog, see aggregateIndex) is separately only
// >=0.9 from 2026-08-10. 2026-08-13 satisfies both constraints.
var indexBackfillStart = time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)

const (
	indexMinActive = 20
	// indexGapThreshold is the CATALOG coverage ratio below which a day is not
	// a fair reading. Coverage is panel suburbs / full catalog size, not panel
	// suburbs / suburbs swept — see aggregateIndex.
	indexGapThreshold = 0.6
	indexWindowDays   = 30 // matches the existing boards so headline and leaderboard agree
	// indexSweepWindowDays is how far back a listing's last_seen_at may sit and
	// still count as "observed on date d". A full crawl pass over the suburb
	// catalog takes ~2 weeks, so a 14-day trailing window is the shortest
	// window that gives every suburb a fair chance to appear regardless of
	// where in the sweep cycle date d falls. This REPLACES the old
	// first_seen_at <= d <= last_seen_at "active span" filter, which measured
	// crawl coverage rather than market presence (see the file-level comment).
	indexSweepWindowDays = 14
	// indexRelistGapDays is the floor on the gap between a delisted event and
	// the subsequent relisted event for it to count as a genuine
	// withdrawn-then-relisted capitulation signal, rather than crawl noise.
	//
	// Measured 2026-08-17 over 60 days of property_price_events: 544
	// delist->relist pairs total, split sharply by source. REA: 450 pairs, of
	// which 188 (42%) are <=2 days apart — that is the known REA page-
	// truncation artefact (a partial sweep drops a listing off a page
	// boundary; it "reappears" on the very next sweep), not a vendor
	// withdrawing and returning. Domain, which does not truncate the same way:
	// 94 pairs, of which 57 (61%) are >7 days apart — genuine capitulation
	// behaviour. Built across both sources with no floor, ~83% of the count
	// (450/544) would be REA sweep noise. With a >7 day gap requirement the
	// rate drops to ~64 genuine events per 60 days. Do not remove this floor
	// "to simplify" — it is the only thing keeping the counter honest.
	indexRelistGapDays = 7
)

// suburbDaysSQL is the query behind querySuburbDays, extracted so tests can
// assert on its shape directly (see TestActiveCTEUsesSweepWindowNotSpanningDates
// and TestDroppedCTEIsConstrainedToTheSweepWindow).
//
// Both CTEs source membership from ACTUAL SWEEPS in a trailing
// indexSweepWindowDays window ($1::date - ($2::int - 1) .. $1::date on
// last_seen_at), not from a first_seen_at <= d <= last_seen_at spanning-date
// filter. The old filter measured "has this suburb been re-crawled since d",
// which collapses toward the present because the crawl only sweeps ~20-40
// suburbs/day — see the file-level comment for the measured 499 -> 24 collapse.
func suburbDaysSQL() string {
	return `
WITH active AS (
    SELECT l.sal_code,
           max(l.state_code) AS state_code,
           count(DISTINCT coalesce(nullif(l.display_address, ''), l.listing_id)) AS active_addr
    FROM property_listings l
    WHERE l.sal_code IS NOT NULL
      AND l.last_seen_at::date BETWEEN $1::date - ($2::int - 1) AND $1::date
    GROUP BY l.sal_code
),
dropped AS (
    SELECT l.sal_code,
           count(DISTINCT coalesce(nullif(l.display_address, ''), l.listing_id)) AS dropped_addr,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e.drop_pct) AS median_drop_pct
    FROM property_price_events e
    JOIN property_listings l ON l.id = e.listing_pk
    WHERE e.event_type = 'price_drop'
      AND l.sal_code IS NOT NULL
      -- Same sweep-window membership as the active CTE. Without this a listing
      -- that cut its price and then dropped out of the sweep window stays in
      -- the numerator while leaving the denominator, so drop_rate can exceed 1
      -- and we publish "110% of listings cut their price".
      AND l.last_seen_at::date BETWEEN $1::date - ($2::int - 1) AND $1::date
      AND e.observed_at::date <= $1::date
      AND e.observed_at::date >  $1::date - $3::int
    GROUP BY l.sal_code
)
SELECT a.sal_code,
       coalesce(a.state_code, ''),
       a.active_addr,
       coalesce(d.dropped_addr, 0),
       coalesce(d.median_drop_pct, 0)
FROM active a
LEFT JOIN dropped d ON d.sal_code = a.sal_code`
}

// querySuburbDays returns one row per suburb for a snapshot date, sourced from
// suburbs actually swept within the trailing indexSweepWindowDays window.
func querySuburbDays(ctx context.Context, pool *pgxpool.Pool, day time.Time) ([]suburbDay, error) {
	rows, err := pool.Query(ctx, suburbDaysSQL(), day, indexSweepWindowDays, indexWindowDays)
	if err != nil {
		return nil, fmt.Errorf("querySuburbDays %s: %w", day.Format("2006-01-02"), err)
	}
	defer rows.Close()

	var out []suburbDay
	for rows.Next() {
		var s suburbDay
		if err := rows.Scan(&s.salCode, &s.stateCode, &s.active, &s.dropped, &s.medianDropPct); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// capitulationSQL is the query behind the national capitulation counters
// (withdrawn-then-relisted, delisted), extracted so tests can assert on its
// shape directly (see TestCapitulationRequiresARealGap).
//
// withdrawn-then-relisted pairs each 'delisted' event with the EARLIEST
// subsequent 'relisted' event for the same listing_pk, then counts distinct
// listings where that pair's gap exceeds indexRelistGapDays AND the relist
// itself lands inside the trailing window ($1 - $2..$1). The window applies
// to the RELIST side, not the delist side, deliberately: a listing delisted
// 40 days ago and relisted yesterday is a capitulation event happening today,
// even though its delisting fell outside the window.
//
// The >indexRelistGapDays floor exists because, without it, this counter is
// mostly not a market signal — see indexRelistGapDays' comment for the
// measured REA-truncation numbers that motivated it. Do not drop the $3 gap
// parameter to "simplify" this query.
func capitulationSQL() string {
	return `
WITH delist_relist AS (
    SELECT
        d.listing_pk,
        d.observed_at AS delisted_at,
        min(r.observed_at) AS relisted_at
    FROM property_price_events d
    JOIN property_price_events r
        ON r.listing_pk = d.listing_pk
       AND r.event_type = 'relisted'
       AND r.observed_at > d.observed_at
    WHERE d.event_type = 'delisted'
    GROUP BY d.listing_pk, d.observed_at
)
SELECT
  count(DISTINCT listing_pk) FILTER (
    WHERE relisted_at::date <= $1::date
      AND relisted_at::date >  $1::date - $2::int
      AND relisted_at - delisted_at > $3::int * interval '1 day'
  ),
  (SELECT count(*)
   FROM property_price_events e
   WHERE e.event_type = 'delisted'
     AND e.observed_at::date <= $1::date
     AND e.observed_at::date >  $1::date - $2::int)
FROM delist_relist`
}

// catalogSizes is the suburb-catalog denominator aggregateIndex measures
// coverage against, resolved PER GRAIN: national coverage against the full
// catalog, state coverage against that state's own (much smaller) catalog.
//
// BUG this fixes: runDropIndex used to pass the same national Total (500) as
// the denominator for every state too, so NSW's 135-suburb catalog read as
// 135/500 = 0.27 coverage — below the 0.6 gap threshold — and every state row
// was permanently flagged is_gap=true even at full state coverage. Measured
// in prod 2026-08-17: NSW 135, VIC 135, QLD 97, WA 67, SA 66.
type catalogSizes struct {
	Total   int
	ByState map[string]int
}

// forState resolves the denominator for grain "state" key state. An unknown
// state must not silently fall back to Total — that would reintroduce the
// exact bug this type exists to fix, just relocated to the lookup. Callers
// that hit this (a state present in the panel but absent from the catalog
// query) should treat it as zero coverage, not full coverage.
func (c catalogSizes) forState(state string) int {
	return c.ByState[state]
}

// queryCatalogSizes returns the number of distinct suburbs ever seen by the
// crawl, both nationally and per state. aggregateIndex measures coverage
// against the catalog for the grain being aggregated — see the file-level
// comment and catalogSizes for why a single national figure is wrong for
// state grain.
//
// The national Total is deliberately queried SEPARATELY rather than summed
// from the per-state counts. sal_code (ABS SAL_CODE21) is a national primary
// key elsewhere in this schema (suburb_demographics, suburb_lga, ...), so a
// suburb cannot appear under two states and summing would in fact be safe —
// but a direct COUNT(DISTINCT sal_code) with no GROUP BY doesn't depend on
// that assumption holding forever, at negligible extra cost (one query, once
// per job run, not once per day in the backfill loop).
func queryCatalogSizes(ctx context.Context, pool *pgxpool.Pool) (catalogSizes, error) {
	out := catalogSizes{ByState: map[string]int{}}

	rows, err := pool.Query(ctx, `
SELECT coalesce(state_code, ''), count(DISTINCT sal_code)
FROM property_listings
WHERE sal_code IS NOT NULL
GROUP BY 1`)
	if err != nil {
		return catalogSizes{}, fmt.Errorf("queryCatalogSizes: %w", err)
	}
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			rows.Close()
			return catalogSizes{}, fmt.Errorf("queryCatalogSizes: %w", err)
		}
		if state != "" {
			out.ByState[state] = n
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return catalogSizes{}, fmt.Errorf("queryCatalogSizes: %w", err)
	}
	rows.Close()

	if err := pool.QueryRow(ctx,
		`SELECT count(DISTINCT sal_code) FROM property_listings WHERE sal_code IS NOT NULL`,
	).Scan(&out.Total); err != nil {
		return catalogSizes{}, fmt.Errorf("queryCatalogSizes total: %w", err)
	}

	return out, nil
}

func upsertIndexPointSQL() string {
	return `
INSERT INTO housing_drop_index_daily (
    snapshot_date, grain, grain_key,
    active_addresses, dropped_addresses, drop_rate, median_drop_pct,
    withdrawn_then_relisted, delisted_count,
    panel_suburbs, coverage_ratio, is_gap, computed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
ON CONFLICT (snapshot_date, grain, grain_key) DO UPDATE SET
    active_addresses  = EXCLUDED.active_addresses,
    dropped_addresses = EXCLUDED.dropped_addresses,
    drop_rate         = EXCLUDED.drop_rate,
    median_drop_pct   = EXCLUDED.median_drop_pct,
    withdrawn_then_relisted = EXCLUDED.withdrawn_then_relisted,
    delisted_count    = EXCLUDED.delisted_count,
    panel_suburbs     = EXCLUDED.panel_suburbs,
    coverage_ratio    = EXCLUDED.coverage_ratio,
    is_gap            = EXCLUDED.is_gap,
    computed_at = now()`
}

func writeIndexPoint(ctx context.Context, pool *pgxpool.Pool, day time.Time, grain, key string, p indexPoint) error {
	_, err := pool.Exec(ctx, upsertIndexPointSQL(),
		day, grain, key,
		p.ActiveAddresses, p.DroppedAddresses, p.DropRate, p.MedianDropPct,
		p.WithdrawnThenRelisted, p.DelistedCount,
		p.PanelSuburbs, p.CoverageRatio, p.IsGap)
	if err != nil {
		return fmt.Errorf("writeIndexPoint %s/%s %s: %w", grain, key, day.Format("2006-01-02"), err)
	}
	return nil
}

// indexBatchChunk bounds a single pgx.Batch. A large batch HANGS against the
// Supabase transaction pooler — the crime importer hit exactly this — so the
// suburb writes are chunked rather than queued in one go.
const indexBatchChunk = 100

// writeSuburbPoints upserts a day's suburb rows in chunked batches. One round
// trip per ~100 suburbs instead of per suburb: a 14-day backfill over ~500
// suburbs goes from ~7,000 round trips to ~70.
func writeSuburbPoints(ctx context.Context, pool *pgxpool.Pool, day time.Time, rows []suburbDay) error {
	for start := 0; start < len(rows); start += indexBatchChunk {
		end := start + indexBatchChunk
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]

		batch := &pgx.Batch{}
		for _, r := range chunk {
			p := suburbPoint(r)
			batch.Queue(upsertIndexPointSQL(),
				day, "suburb", r.salCode,
				p.ActiveAddresses, p.DroppedAddresses, p.DropRate, p.MedianDropPct,
				p.WithdrawnThenRelisted, p.DelistedCount,
				p.PanelSuburbs, p.CoverageRatio, p.IsGap)
		}

		br := pool.SendBatch(ctx, batch)
		for i := range chunk {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return fmt.Errorf("writeSuburbPoints %s %s: %w", day.Format("2006-01-02"), chunk[i].salCode, err)
			}
		}
		if err := br.Close(); err != nil {
			return fmt.Errorf("writeSuburbPoints close %s: %w", day.Format("2006-01-02"), err)
		}
	}
	return nil
}

func groupByState(rows []suburbDay) map[string][]suburbDay {
	out := map[string][]suburbDay{}
	for _, r := range rows {
		if r.stateCode == "" {
			continue
		}
		out[r.stateCode] = append(out[r.stateCode], r)
	}
	return out
}

// suburbPoint is a suburb's own reading. The >=20-active floor deliberately does
// NOT apply here: it exists to stop small suburbs distorting an AGGREGATE, and a
// suburb's own rate is not distorted by being small. A suburb can therefore
// appear on its own page while being excluded from the national panel — that is
// correct, not an inconsistency.
//
// There is no more per-suburb sweptRecently/gap logic here (deleted, not kept):
// under the new sourcing a suburb only appears in querySuburbDays' output at
// all if it had a listing observed within the trailing sweep window, so "was
// this suburb swept" is true by construction for every row this function ever
// sees — the same tautology bug that made the old national-level gap flag
// worthless. The only real failure mode left at suburb grain is zero active
// addresses, which the DropRate/IsGap fields below guard directly.
func suburbPoint(r suburbDay) indexPoint {
	p := indexPoint{
		ActiveAddresses:  r.active,
		DroppedAddresses: r.dropped,
		MedianDropPct:    r.medianDropPct,
		PanelSuburbs:     1,
	}
	if r.active > 0 {
		p.DropRate = float64(r.dropped) / float64(r.active)
		p.CoverageRatio = 1
	}
	p.IsGap = r.active <= 0
	return p
}

// runDropIndex computes and stores snapshots for [from, to]. Dates before
// indexBackfillStart are skipped, not zero-filled.
func runDropIndex(ctx context.Context, pool *pgxpool.Pool, from, to time.Time) int {
	if from.Before(indexBackfillStart) {
		log.Printf("[drop-index] clamping start %s -> %s (no stable panel before then)",
			from.Format("2006-01-02"), indexBackfillStart.Format("2006-01-02"))
		from = indexBackfillStart
	}

	catalog, err := queryCatalogSizes(ctx, pool)
	if err != nil {
		log.Printf("[drop-index] %v", err)
		return 1
	}

	days := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		rows, err := querySuburbDays(ctx, pool, d)
		if err != nil {
			log.Printf("[drop-index] %s: %v", d.Format("2006-01-02"), err)
			return 1
		}

		national := aggregateIndex(rows, indexMinActive, indexGapThreshold, catalog.Total)

		// Capitulation counters (withdrawn-then-relisted, delisted) are computed
		// at NATIONAL grain only for now — they exist to carry the page while
		// the drop-rate index is still thin (two weeks of stable panel vs five
		// weeks of these events), not to replace the per-suburb index, so there
		// is no product need yet to slice them by state/suburb. They are also
		// inherently less sensitive to crawl-catalog growth than the index: the
		// index divides by an "active addresses" denominator that grew 5x as the
		// catalog expanded, while these are plain counts of events on listings
		// we actually observed — no denominator to be distorted by newly-added
		// suburbs.
		if err := pool.QueryRow(ctx, capitulationSQL(), d, indexWindowDays, indexRelistGapDays).
			Scan(&national.WithdrawnThenRelisted, &national.DelistedCount); err != nil {
			log.Printf("[drop-index] capitulation %s: %v", d.Format("2006-01-02"), err)
			return 1
		}

		if err := writeIndexPoint(ctx, pool, d, "national", "AU", national); err != nil {
			log.Printf("[drop-index] %v", err)
			return 1
		}

		for state, sub := range groupByState(rows) {
			p := aggregateIndex(sub, indexMinActive, indexGapThreshold, catalog.forState(state))
			if err := writeIndexPoint(ctx, pool, d, "state", state, p); err != nil {
				log.Printf("[drop-index] %v", err)
				return 1
			}
		}

		if err := writeSuburbPoints(ctx, pool, d, rows); err != nil {
			log.Printf("[drop-index] %v", err)
			return 1
		}

		log.Printf("[drop-index] %s national rate=%.4f panel=%d coverage=%.2f gap=%v",
			d.Format("2006-01-02"), national.DropRate, national.PanelSuburbs,
			national.CoverageRatio, national.IsGap)
		days++
	}

	log.Printf("[drop-index] wrote %d day(s)", days)
	return 0
}
