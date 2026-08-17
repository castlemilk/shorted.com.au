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

// suburbDay is one suburb's contribution to one snapshot date.
type suburbDay struct {
	salCode       string
	stateCode     string  // used when rolling suburbs up to a state grain
	active        int     // deduped physical addresses active that day
	dropped       int     // addresses with a price_drop in the trailing 30d, still active
	medianDropPct float64 // depth of cut within the suburb, 0..1
	sweptRecently bool    // crawled within the prior 48h
}

// indexPoint is one row of housing_drop_index_daily.
type indexPoint struct {
	ActiveAddresses  int
	DroppedAddresses int
	DropRate         float64
	MedianDropPct    float64
	RelistedLower    int
	DelistedCount    int
	PanelSuburbs     int
	CoverageRatio    float64
	IsGap            bool
}

// aggregateIndex folds per-suburb rows into one snapshot point.
//
// minActive excludes suburbs too small to carry a meaningful rate — a
// three-listing suburb reports 33% off a single cut. gapThreshold is the
// coverage ratio below which the day is not a fair reading at all.
func aggregateIndex(rows []suburbDay, minActive int, gapThreshold float64) indexPoint {
	var out indexPoint

	rates := make([]float64, 0, len(rows))
	depths := make([]float64, 0, len(rows))
	swept := 0

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
		if r.sweptRecently {
			swept++
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
	// Zero coverage is ALWAYS a gap, whatever the threshold. Without this a
	// gapThreshold of 0 (the Go zero value, i.e. an unwired config field) turns
	// a total crawl outage into a normal-looking reading — the exact failure
	// this file exists to prevent.
	out.CoverageRatio = float64(swept) / float64(out.PanelSuburbs)
	out.IsGap = swept == 0 || out.CoverageRatio < gapThreshold

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

// indexBackfillStart is the first date with a stable panel. Before this the
// catalog was still growing from ~115 to ~500 suburbs and no like-for-like
// comparison exists — measured 2026-08-16, zero suburbs appear in every
// earlier week. Refusing to compute those dates is deliberate.
var indexBackfillStart = time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)

const (
	indexMinActive    = 20
	indexGapThreshold = 0.6
	indexWindowDays   = 30 // matches the existing boards so headline and leaderboard agree
	indexSweptHours   = 48
)

// suburbDaysSQL is the query behind querySuburbDays, extracted so tests can
// assert on its shape directly (see TestDroppedCTEIsConstrainedToActiveOnDate).
func suburbDaysSQL() string {
	return `
WITH active AS (
    SELECT l.sal_code,
           max(l.state_code) AS state_code,
           count(DISTINCT coalesce(nullif(l.display_address, ''), l.listing_id)) AS active_addr,
           max(l.last_seen_at) AS last_swept
    FROM property_listings l
    WHERE l.sal_code IS NOT NULL
      AND l.first_seen_at::date <= $1::date
      AND l.last_seen_at::date  >= $1::date
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
      -- Still active on this date. Without this a listing that cut its price and
      -- then delisted stays in the numerator while leaving the denominator, so
      -- drop_rate can exceed 1 and we publish "110% of listings cut their price".
      AND l.first_seen_at::date <= $1::date
      AND l.last_seen_at::date  >= $1::date
      AND e.observed_at::date <= $1::date
      AND e.observed_at::date >  $1::date - $2::int
    GROUP BY l.sal_code
)
SELECT a.sal_code,
       coalesce(a.state_code, ''),
       a.active_addr,
       coalesce(d.dropped_addr, 0),
       coalesce(d.median_drop_pct, 0),
       (a.last_swept >= $1::timestamptz - make_interval(hours => $3)) AS swept_recently
FROM active a
LEFT JOIN dropped d ON d.sal_code = a.sal_code`
}

// querySuburbDays returns one row per suburb for a snapshot date. Active-on-date
// is reconstructed from the listing's observed lifespan, which is sound because
// last_seen_at advances while a listing is live.
func querySuburbDays(ctx context.Context, pool *pgxpool.Pool, day time.Time) ([]suburbDay, error) {
	rows, err := pool.Query(ctx, suburbDaysSQL(), day, indexWindowDays, indexSweptHours)
	if err != nil {
		return nil, fmt.Errorf("querySuburbDays %s: %w", day.Format("2006-01-02"), err)
	}
	defer rows.Close()

	var out []suburbDay
	for rows.Next() {
		var s suburbDay
		if err := rows.Scan(&s.salCode, &s.stateCode, &s.active, &s.dropped, &s.medianDropPct, &s.sweptRecently); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func upsertIndexPointSQL() string {
	return `
INSERT INTO housing_drop_index_daily (
    snapshot_date, grain, grain_key,
    active_addresses, dropped_addresses, drop_rate, median_drop_pct,
    relisted_lower, delisted_count,
    panel_suburbs, coverage_ratio, is_gap, computed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
ON CONFLICT (snapshot_date, grain, grain_key) DO UPDATE SET
    active_addresses  = EXCLUDED.active_addresses,
    dropped_addresses = EXCLUDED.dropped_addresses,
    drop_rate         = EXCLUDED.drop_rate,
    median_drop_pct   = EXCLUDED.median_drop_pct,
    relisted_lower    = EXCLUDED.relisted_lower,
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
		p.RelistedLower, p.DelistedCount,
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
				p.RelistedLower, p.DelistedCount,
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
func suburbPoint(r suburbDay) indexPoint {
	p := indexPoint{
		ActiveAddresses:  r.active,
		DroppedAddresses: r.dropped,
		MedianDropPct:    r.medianDropPct,
		PanelSuburbs:     1,
	}
	if r.active > 0 {
		p.DropRate = float64(r.dropped) / float64(r.active)
	}
	if r.sweptRecently {
		p.CoverageRatio = 1
	}
	p.IsGap = !r.sweptRecently
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

	days := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		rows, err := querySuburbDays(ctx, pool, d)
		if err != nil {
			log.Printf("[drop-index] %s: %v", d.Format("2006-01-02"), err)
			return 1
		}

		national := aggregateIndex(rows, indexMinActive, indexGapThreshold)

		// Capitulation counters (relisted-lower, delisted) are computed at NATIONAL
		// grain only for now — they exist to carry the page while the drop-rate
		// index is still thin (two weeks of stable panel vs five weeks of these
		// events), not to replace the per-suburb index, so there is no product
		// need yet to slice them by state/suburb. They are also inherently less
		// sensitive to crawl-catalog growth than the index: the index divides by
		// an "active addresses" denominator that grew 5x as the catalog expanded,
		// while these are plain counts of events on listings we actually observed
		// — no denominator to be distorted by newly-added suburbs.
		const capitulationQ = `
SELECT
  count(*) FILTER (WHERE e.event_type = 'relisted' AND e.price < e.prev_price AND e.prev_price > 0),
  count(*) FILTER (WHERE e.event_type = 'delisted')
FROM property_price_events e
WHERE e.observed_at::date <= $1::date
  AND e.observed_at::date >  $1::date - $2::int`

		if err := pool.QueryRow(ctx, capitulationQ, d, indexWindowDays).
			Scan(&national.RelistedLower, &national.DelistedCount); err != nil {
			log.Printf("[drop-index] capitulation %s: %v", d.Format("2006-01-02"), err)
			return 1
		}

		if err := writeIndexPoint(ctx, pool, d, "national", "AU", national); err != nil {
			log.Printf("[drop-index] %v", err)
			return 1
		}

		for state, sub := range groupByState(rows) {
			p := aggregateIndex(sub, indexMinActive, indexGapThreshold)
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
