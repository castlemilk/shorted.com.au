# Price-Drops Discounting Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/price-drops` a headline that answers "is discounting rising or falling?" without the crawl catalog's growth masquerading as a market signal.

**Architecture:** A daily append-only snapshot table (`housing_drop_index_daily`) written by a new collector mode on Cloud Run. The index is an equal-weighted mean of per-suburb drop rates — not a pooled ratio — so adding suburbs to the catalog shifts composition by `1/N` rather than swamping the numerator. Panel size, coverage ratio and a gap flag travel to the client so the chart can draw the 13–15 Aug crawl outage as a break instead of a crash.

**Tech Stack:** Go 1.26, pgx/v5, Postgres (Supabase), Connect-RPC + protobuf, Next.js App Router, visx.

**Spec:** `docs/superpowers/specs/2026-08-16-price-drops-index-design.md`

---

## File Structure

**Create:**
- `services/migrations/000110_add_housing_drop_index.up.sql` — table + indexes
- `services/migrations/000110_add_housing_drop_index.down.sql` — drop
- `services/migrations/housing_drop_index.test.mjs` — DDL assertions
- `services/house-price-collector/drop_index.go` — metric + snapshot writer
- `services/house-price-collector/drop_index_test.go` — metric tests
- `web/src/@/components/housing/price-drops/drop-index-hero.tsx` — chart (client)
- `web/src/@/components/housing/price-drops/drop-index-hero-loader.tsx` — `ssr:false` wrapper
- `web/src/@/components/housing/price-drops/drop-index-hero.test.tsx`

**Modify:**
- `services/house-price-collector/main.go:42` — add `drop-index` to the mode flag + switch
- `proto/shortedapi/shorts/v1alpha1/housing.proto` — rpc + messages
- `proto/shortedapi/shorts/v1alpha1/shorts.proto` — dual-add to legacy service
- `services/shorts/internal/store/shorts/store.go` — row type + interface method
- `services/shorts/internal/store/shorts/postgres_house_prices.go` — query
- `services/shorts/internal/services/shorts/interfaces.go` — store + cache interfaces
- `services/shorts/internal/services/shorts/cache.go` — cache key
- `services/shorts/internal/services/shorts/house_prices.go` — handler
- `services/shorts/internal/services/shorts/adapters.go` — adapter passthrough
- `web/src/app/actions/getHousing.ts` — server action
- `web/src/app/price-drops/page.tsx` — mount the hero
- `terraform/modules/house-price-collector/main.tf` — daily scheduler

**Not modified:** `web/next.config.mjs` already carries the `HousingService` rewrite. Do not add one.

---

### Task 1: Migration 000110 — the snapshot table

**Files:**
- Create: `services/migrations/000110_add_housing_drop_index.up.sql`
- Create: `services/migrations/000110_add_housing_drop_index.down.sql`
- Test: `services/migrations/housing_drop_index.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// services/migrations/housing_drop_index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000110_add_housing_drop_index.up.sql", import.meta.url),
  "utf8",
);

test("snapshot table is keyed so a re-run repairs rather than duplicates", () => {
  assert.match(up, /PRIMARY KEY \(snapshot_date, grain, grain_key\)/);
});

test("honesty columns exist — without them a crawl gap reads as a market move", () => {
  for (const col of ["panel_suburbs", "coverage_ratio", "is_gap"]) {
    assert.match(up, new RegExp(`\\b${col}\\b`), `missing ${col}`);
  }
});

test("grain is constrained to the three supported levels", () => {
  assert.match(up, /grain\s+text\s+NOT NULL/i);
  assert.match(up, /CHECK \(grain IN \('national', 'state', 'suburb'\)\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test services/migrations/housing_drop_index.test.mjs`
Expected: FAIL — `ENOENT` opening `000110_add_housing_drop_index.up.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- services/migrations/000110_add_housing_drop_index.up.sql
-- Daily discounting index for /price-drops.
--
-- Append-only rather than a view: this number gets published, and a derived
-- series would let a listings purge or a late backfill silently rewrite a
-- figure quoted last week.
--
-- panel_suburbs / coverage_ratio / is_gap are not optional. The crawl catalog
-- grew 115 -> 500 suburbs over July-August 2026 and stopped entirely on
-- 2026-08-13..15; without these columns a reader cannot tell a market move
-- from a crawl artefact.

CREATE TABLE IF NOT EXISTS housing_drop_index_daily (
    snapshot_date     date             NOT NULL,
    grain             text             NOT NULL,
    grain_key         text             NOT NULL,

    active_addresses  integer          NOT NULL DEFAULT 0,
    dropped_addresses integer          NOT NULL DEFAULT 0,
    drop_rate         double precision NOT NULL DEFAULT 0,
    median_drop_pct   double precision NOT NULL DEFAULT 0,
    relisted_lower    integer          NOT NULL DEFAULT 0,
    delisted_count    integer          NOT NULL DEFAULT 0,

    panel_suburbs     integer          NOT NULL DEFAULT 0,
    coverage_ratio    double precision NOT NULL DEFAULT 0,
    is_gap            boolean          NOT NULL DEFAULT false,

    computed_at       timestamptz      NOT NULL DEFAULT now(),

    PRIMARY KEY (snapshot_date, grain, grain_key),
    CONSTRAINT housing_drop_index_grain_check
        CHECK (grain IN ('national', 'state', 'suburb'))
);

-- The read path is always "one series for one grain_key over a date range".
CREATE INDEX IF NOT EXISTS idx_housing_drop_index_series
    ON housing_drop_index_daily (grain, grain_key, snapshot_date DESC);
```

```sql
-- services/migrations/000110_add_housing_drop_index.down.sql
DROP INDEX IF EXISTS idx_housing_drop_index_series;
DROP TABLE IF EXISTS housing_drop_index_daily;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test services/migrations/housing_drop_index.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Apply locally and verify**

```bash
cd services && make migrate-up
psql postgresql://admin:password@localhost:5438/shorts -c "\d housing_drop_index_daily"
```

Expected: table listed with the primary key and the check constraint.

- [ ] **Step 6: Commit**

```bash
git add services/migrations/000110_add_housing_drop_index.up.sql \
        services/migrations/000110_add_housing_drop_index.down.sql \
        services/migrations/housing_drop_index.test.mjs
git commit -m "feat(housing): snapshot table for the daily discounting index"
```

---

### Task 2: The metric — equal-weighted mean over pooled ratio

This is the load-bearing task. The test in Step 1 is the design's entire justification: it fails for a pooled ratio and passes for an equal-weighted mean.

**Files:**
- Create: `services/house-price-collector/drop_index.go`
- Test: `services/house-price-collector/drop_index_test.go`

- [ ] **Step 1: Write the failing test**

```go
// services/house-price-collector/drop_index_test.go
package main

import (
	"math"
	"testing"
)

// panel builds n suburbs that all discount at the same rate, each with the
// given number of active addresses.
func panel(n, active int, rate float64) []suburbDay {
	rows := make([]suburbDay, 0, n)
	for i := 0; i < n; i++ {
		rows = append(rows, suburbDay{
			salCode:       string(rune('a'+i%26)) + string(rune('a'+i/26)),
			active:        active,
			dropped:       int(math.Round(float64(active) * rate)),
			medianDropPct: 0.05,
			sweptRecently: true,
		})
	}
	return rows
}

// THE test. The crawl catalog grew from 115 to 500 suburbs between July and
// August 2026. If the index moves when suburbs are ADDED at an unchanged
// discount rate, it is measuring our crawl coverage and not the market — the
// exact failure that would have published a market "crash" on 2026-08-13.
//
// A pooled sum(dropped)/sum(active) fails this only when the added suburbs
// differ in size, so the added cohort here is deliberately larger.
func TestIndexIsUnmovedByCatalogExpansion(t *testing.T) {
	small := aggregateIndex(panel(115, 40, 0.10), 20, 0.6)

	expanded := append(panel(115, 40, 0.10), panel(385, 400, 0.10)...)
	big := aggregateIndex(expanded, 20, 0.6)

	if math.Abs(big.DropRate-small.DropRate) > 1e-9 {
		t.Fatalf("index moved on catalog expansion: %.6f -> %.6f (want unchanged)",
			small.DropRate, big.DropRate)
	}
	if small.PanelSuburbs != 115 || big.PanelSuburbs != 500 {
		t.Fatalf("panel sizes = %d, %d; want 115, 500", small.PanelSuburbs, big.PanelSuburbs)
	}
}

// A three-listing suburb reports a 33% rate off one cut. Without a floor it
// drags the national mean around.
func TestTinySuburbsExcludedFromPanel(t *testing.T) {
	rows := append(panel(10, 40, 0.10), suburbDay{
		salCode: "tiny", active: 3, dropped: 1, sweptRecently: true,
	})

	got := aggregateIndex(rows, 20, 0.6)

	if got.PanelSuburbs != 10 {
		t.Fatalf("PanelSuburbs = %d, want 10 (the 3-listing suburb is excluded)", got.PanelSuburbs)
	}
	if math.Abs(got.DropRate-0.10) > 1e-9 {
		t.Fatalf("DropRate = %.6f, want 0.10", got.DropRate)
	}
}

// 2026-08-13..15: the crawl stopped. Those days must render as a break, not as
// a collapse in discounting.
func TestUnderSweptDayIsFlaggedAsGap(t *testing.T) {
	rows := panel(100, 40, 0.10)
	for i := 0; i < 50; i++ {
		rows[i].sweptRecently = false // only half the panel was swept
	}

	got := aggregateIndex(rows, 20, 0.6)

	if !got.IsGap {
		t.Fatalf("IsGap = false at coverage %.2f, want true", got.CoverageRatio)
	}
	if math.Abs(got.CoverageRatio-0.5) > 1e-9 {
		t.Fatalf("CoverageRatio = %.4f, want 0.5", got.CoverageRatio)
	}
}

func TestFullySweptDayIsNotAGap(t *testing.T) {
	got := aggregateIndex(panel(100, 40, 0.10), 20, 0.6)
	if got.IsGap {
		t.Fatalf("IsGap = true at coverage %.2f, want false", got.CoverageRatio)
	}
}

// An empty panel must not divide by zero.
func TestEmptyPanelIsZeroAndGapped(t *testing.T) {
	got := aggregateIndex(nil, 20, 0.6)
	if got.DropRate != 0 || got.PanelSuburbs != 0 {
		t.Fatalf("got %+v, want zero-valued", got)
	}
	if !got.IsGap {
		t.Fatalf("IsGap = false for an empty panel, want true")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services && GOWORK=off go test ./house-price-collector/ -run 'TestIndex|TestTiny|TestUnderSwept|TestFullySwept|TestEmptyPanel'`
Expected: FAIL — `undefined: suburbDay`, `undefined: aggregateIndex`.

- [ ] **Step 3: Write minimal implementation**

```go
// services/house-price-collector/drop_index.go
package main

import "sort"

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
// however many listings it brought. TestIndexIsUnmovedByCatalogExpansion pins
// this; a pooled ratio fails it.

// suburbDay is one suburb's contribution to one snapshot date.
type suburbDay struct {
	salCode       string
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
		if r.active < minActive {
			continue // too small to weigh equally with a real suburb
		}
		out.PanelSuburbs++
		out.ActiveAddresses += r.active
		out.DroppedAddresses += r.dropped
		rates = append(rates, float64(r.dropped)/float64(r.active))
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
	out.CoverageRatio = float64(swept) / float64(out.PanelSuburbs)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services && GOWORK=off go test ./house-price-collector/ -run 'TestIndex|TestTiny|TestUnderSwept|TestFullySwept|TestEmptyPanel' -v`
Expected: PASS — 5 tests.

- [ ] **Step 5: Prove the test discriminates**

Temporarily replace the mean with a pooled ratio to confirm the test actually catches the bug it exists for:

```go
	out.DropRate = float64(out.DroppedAddresses) / float64(out.ActiveAddresses)
```

Run: `cd services && GOWORK=off go test ./house-price-collector/ -run TestIndexIsUnmovedByCatalogExpansion`
Expected: FAIL — "index moved on catalog expansion".
Then revert to the equal-weighted mean and confirm PASS again.

- [ ] **Step 6: Commit**

```bash
git add services/house-price-collector/drop_index.go \
        services/house-price-collector/drop_index_test.go
git commit -m "feat(housing): coverage-honest discounting index metric

Equal-weighted mean of per-suburb rates, not sum(dropped)/sum(active): the
crawl catalog grew 115 -> 500 suburbs, so a pooled ratio measures our own
coverage. The catalog-expansion test fails for a pooled ratio and passes for
the mean."
```

---

### Task 3: Query the panel and write snapshots

**Files:**
- Modify: `services/house-price-collector/drop_index.go`
- Test: `services/house-price-collector/drop_index_test.go`

- [ ] **Step 1: Write the failing test for idempotency**

Append to `drop_index_test.go`:

```go
func TestUpsertIndexPointSQLIsIdempotent(t *testing.T) {
	sql := upsertIndexPointSQL()
	if !contains(sql, "ON CONFLICT (snapshot_date, grain, grain_key) DO UPDATE") {
		t.Fatalf("upsert must repair on re-run, got:\n%s", sql)
	}
	if !contains(sql, "computed_at = now()") {
		t.Fatalf("a repaired row must record when it was recomputed, got:\n%s", sql)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) &&
		(haystack == needle || len(haystack) > 0 && indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services && GOWORK=off go test ./house-price-collector/ -run TestUpsertIndexPointSQL`
Expected: FAIL — `undefined: upsertIndexPointSQL`.

- [ ] **Step 3: Implement the query and writer**

Extend the **existing** import block at the top of `drop_index.go` (it already
imports `sort`) so it reads:

```go
import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)
```

Then append to `drop_index.go`:

```go

// indexBackfillStart is the first date with a stable panel. Before this the
// catalog was still growing from ~115 to ~500 suburbs and no like-for-like
// comparison exists — measured 2026-08-16, zero suburbs appear in every
// earlier week. Refusing to compute those dates is deliberate.
var indexBackfillStart = time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)

const (
	indexMinActive     = 20
	indexGapThreshold  = 0.6
	indexWindowDays    = 30 // matches the existing boards so headline and leaderboard agree
	indexSweptHours    = 48
)

// querySuburbDays returns one row per suburb for a snapshot date. Active-on-date
// is reconstructed from the listing's observed lifespan, which is sound because
// last_seen_at advances while a listing is live.
func querySuburbDays(ctx context.Context, pool *pgxpool.Pool, day time.Time) ([]suburbDay, error) {
	const q = `
WITH active AS (
    SELECT l.sal_code,
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
      AND e.observed_at::date <= $1::date
      AND e.observed_at::date >  $1::date - $2::int
    GROUP BY l.sal_code
)
SELECT a.sal_code,
       a.active_addr,
       coalesce(d.dropped_addr, 0),
       coalesce(d.median_drop_pct, 0),
       (a.last_swept >= $1::timestamptz - make_interval(hours => $3)) AS swept_recently
FROM active a
LEFT JOIN dropped d ON d.sal_code = a.sal_code`

	rows, err := pool.Query(ctx, q, day, indexWindowDays, indexSweptHours)
	if err != nil {
		return nil, fmt.Errorf("querySuburbDays %s: %w", day.Format("2006-01-02"), err)
	}
	defer rows.Close()

	var out []suburbDay
	for rows.Next() {
		var s suburbDay
		if err := rows.Scan(&s.salCode, &s.active, &s.dropped, &s.medianDropPct, &s.sweptRecently); err != nil {
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
    computed_at       = now()`
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

		for _, r := range rows {
			if err := writeIndexPoint(ctx, pool, d, "suburb", r.salCode, suburbPoint(r)); err != nil {
				log.Printf("[drop-index] %v", err)
				return 1
			}
		}

		log.Printf("[drop-index] %s national rate=%.4f panel=%d coverage=%.2f gap=%v",
			d.Format("2006-01-02"), national.DropRate, national.PanelSuburbs,
			national.CoverageRatio, national.IsGap)
		days++
	}

	log.Printf("[drop-index] wrote %d day(s)", days)
	return 0
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

// suburbPoint is a suburb's own reading. The ≥20-active floor deliberately does
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
```

`suburbDay` gains a `stateCode string` field; add it to the struct in Task 2's
file, to the `SELECT` in `querySuburbDays` (`a.state_code`, grouped alongside
`sal_code`), and to the `rows.Scan` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services && GOWORK=off go test ./house-price-collector/ -run 'TestUpsert|TestIndex|TestTiny|TestUnderSwept|TestFullySwept|TestEmptyPanel'`
Expected: PASS.

- [ ] **Step 5: Wire the mode**

In `services/house-price-collector/main.go`, add `drop-index` to the `-mode` flag string on line 42 and to the `log.Fatalf` list at line 225, then add before `default:` in the switch:

```go
	case "drop-index":
		from := time.Now().UTC().AddDate(0, 0, -1)
		if v := os.Getenv("DROP_INDEX_FROM"); v != "" {
			parsed, perr := time.Parse("2006-01-02", v)
			if perr != nil {
				log.Fatalf("DROP_INDEX_FROM %q: %v", v, perr)
			}
			from = parsed
		}
		return runDropIndex(ctx, pool, from, time.Now().UTC())
```

Also add `8 = crawl environment broken` sibling doc note is unaffected; no exit-code change here.

- [ ] **Step 6: Verify against the local database**

```bash
cd services && GOWORK=off go build -o /tmp/hpc ./house-price-collector/
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts \
  DROP_INDEX_FROM=2026-08-03 /tmp/hpc -mode drop-index
```

Expected: one `[drop-index] <date> national rate=… panel=… coverage=… gap=…` line per day, then `wrote N day(s)`.

- [ ] **Step 7: Verify idempotency**

Run the same command twice, then:

```bash
psql postgresql://admin:password@localhost:5438/shorts \
  -c "select count(*) from housing_drop_index_daily where grain='national';"
```

Expected: the row count is identical after the second run.

- [ ] **Step 8: Commit**

```bash
git add services/house-price-collector/drop_index.go \
        services/house-price-collector/drop_index_test.go \
        services/house-price-collector/main.go
git commit -m "feat(housing): -mode drop-index computes and stores daily snapshots"
```

---

### Task 4: Proto — the read contract

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/housing.proto`
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto`

- [ ] **Step 1: Add the rpc and messages to housing.proto**

Add to `service HousingService` (after `ListAgencyPriceStats`):

```protobuf
  rpc GetDropIndexSeries (GetDropIndexSeriesRequest) returns (GetDropIndexSeriesResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
  }
```

And at the end of the file:

```protobuf
// DropIndexPoint is one day of the discounting index.
//
// panel_suburbs, coverage_ratio and is_gap cross the wire deliberately: the
// client needs them to caption the chart and to draw a crawl outage as a break
// rather than a collapse in discounting. Computing that twice would let the two
// sides disagree.
message DropIndexPoint {
  string snapshot_date   = 1;  // RFC3339 date, 'YYYY-MM-DD'
  double drop_rate       = 2;  // 0..1 fraction, equal-weighted mean of per-suburb rates
  double median_drop_pct = 3;  // 0..1 fraction, depth of the typical cut
  int32  panel_suburbs   = 4;  // suburbs contributing to this point
  double coverage_ratio  = 5;  // share of the panel swept in the prior 48h
  bool   is_gap          = 6;  // coverage too low to be a fair reading
  int32  active_addresses  = 7;
  int32  dropped_addresses = 8;
}

message GetDropIndexSeriesRequest {
  string grain     = 1;  // 'national' | 'state' | 'suburb'
  string grain_key = 2;  // 'AU' | state code | sal_code
  string from      = 3;  // 'YYYY-MM-DD', inclusive; clamped to 2026-08-03
  string to        = 4;  // 'YYYY-MM-DD', inclusive; defaults to today
}

message GetDropIndexSeriesResponse {
  repeated DropIndexPoint points = 1;
  string tracking_since = 2;  // 'YYYY-MM-DD' — earliest date the index exists for
}
```

- [ ] **Step 2: Dual-add to the legacy service**

Add the same rpc to `service ShortedStocksService` in `proto/shortedapi/shorts/v1alpha1/shorts.proto`, with the identical `VISIBILITY_PUBLIC` annotation. `proto_parity_test.go` fails if this is skipped.

- [ ] **Step 3: Generate**

```bash
cd proto && buf generate
```

- [ ] **Step 4: Verify parity**

Run: `cd services && GOWORK=off go test ./shorts/... -run TestProtoParity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proto/ web/src/gen/ services/gen/ sdks/
git commit -m "feat(housing): GetDropIndexSeries rpc"
```

Commit all generated output including the `sdks/java` churn — the committed SDK tracks the protos.

---

### Task 5: Store method

**Files:**
- Modify: `services/shorts/internal/store/shorts/store.go`
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices.go`

- [ ] **Step 1: Add the row type and interface method**

In `store.go`, beside the other housing row types:

```go
// DropIndexPointRow is one day of the discounting index.
type DropIndexPointRow struct {
	SnapshotDate     string
	DropRate         float64
	MedianDropPct    float64
	PanelSuburbs     int32
	CoverageRatio    float64
	IsGap            bool
	ActiveAddresses  int32
	DroppedAddresses int32
}
```

And on the `Store` interface, beside `ListSuburbPriceDrops` (line 218):

```go
	GetDropIndexSeries(grain, grainKey, from, to string) ([]*DropIndexPointRow, error)
```

- [ ] **Step 2: Implement in postgres_house_prices.go**

```go
// GetDropIndexSeries reads a stored index series. It never computes on the fly:
// these are published numbers and must not change under a reader.
func (s *PostgresStore) GetDropIndexSeries(grain, grainKey, from, to string) ([]*DropIndexPointRow, error) {
	const q = `
SELECT to_char(snapshot_date, 'YYYY-MM-DD'),
       drop_rate, median_drop_pct, panel_suburbs, coverage_ratio, is_gap,
       active_addresses, dropped_addresses
FROM housing_drop_index_daily
WHERE grain = $1 AND grain_key = $2
  AND snapshot_date >= $3::date AND snapshot_date <= $4::date
ORDER BY snapshot_date`

	rows, err := s.db.Query(context.Background(), q, grain, grainKey, from, to)
	if err != nil {
		return nil, fmt.Errorf("GetDropIndexSeries: %w", err)
	}
	defer rows.Close()

	var out []*DropIndexPointRow
	for rows.Next() {
		r := &DropIndexPointRow{}
		if err := rows.Scan(&r.SnapshotDate, &r.DropRate, &r.MedianDropPct,
			&r.PanelSuburbs, &r.CoverageRatio, &r.IsGap,
			&r.ActiveAddresses, &r.DroppedAddresses); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
```

- [ ] **Step 3: Build**

Run: `cd services && GOWORK=off go build ./shorts/...`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add services/shorts/internal/store/shorts/
git commit -m "feat(housing): store read for the drop index series"
```

---

### Task 6: Handler, cache key and mocks

**Files:**
- Modify: `services/shorts/internal/services/shorts/interfaces.go`
- Modify: `services/shorts/internal/services/shorts/cache.go:269`
- Modify: `services/shorts/internal/services/shorts/house_prices.go`
- Modify: `services/shorts/internal/services/shorts/adapters.go`
- Test: `services/shorts/internal/services/shorts/house_prices_test.go`

- [ ] **Step 1: Write the failing handler test**

Append to `house_prices_test.go`:

```go
func TestGetDropIndexSeriesClampsFromDate(t *testing.T) {
	store := &mockStore{}
	srv := newTestServer(store)

	_, err := srv.GetDropIndexSeries(context.Background(),
		connect.NewRequest(&pb.GetDropIndexSeriesRequest{
			Grain: "national", GrainKey: "AU", From: "2026-07-01", To: "2026-08-16",
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Before 2026-08-03 the catalog was still growing 115 -> 500 suburbs, so no
	// like-for-like reading exists. The handler must not ask the store for it.
	if store.lastFrom != "2026-08-03" {
		t.Fatalf("store queried from %q, want clamped to 2026-08-03", store.lastFrom)
	}
}
```

Add the field and method to `mockStore` in the same file:

```go
// on the mockStore struct
	lastFrom string

func (m *mockStore) GetDropIndexSeries(grain, grainKey, from, to string) ([]*shortsstore.DropIndexPointRow, error) {
	m.lastFrom = from
	return []*shortsstore.DropIndexPointRow{}, nil
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services && GOWORK=off go test ./shorts/internal/services/shorts/ -run TestGetDropIndexSeriesClamps`
Expected: FAIL — method not defined on the server.

- [ ] **Step 3: Add the cache key**

In `cache.go`, after `GetAgencyPriceStatsKey` (line 272):

```go
// GetDropIndexSeriesKey builds a cache key for GetDropIndexSeries responses.
func (c *MemoryCache) GetDropIndexSeriesKey(grain, grainKey, from, to string) string {
	return c.generateKey("drop_index_series", grain, grainKey, from, to)
}
```

Add the matching signature to the cache interface in `interfaces.go` beside `GetPriceDropsOverviewKey` (line 227), and the store method beside line 129.

- [ ] **Step 4: Implement the handler**

In `house_prices.go`:

```go
// dropIndexTrackingSince is the first date with a stable crawl panel. Earlier
// dates are not thin data — they are a different catalog (115 suburbs vs 500),
// so serving them would publish catalog growth as a market move.
const dropIndexTrackingSince = "2026-08-03"

func (s *ShortsServer) GetDropIndexSeries(
	ctx context.Context,
	req *connect.Request[pb.GetDropIndexSeriesRequest],
) (*connect.Response[pb.GetDropIndexSeriesResponse], error) {
	grain := req.Msg.Grain
	if grain == "" {
		grain = "national"
	}
	key := req.Msg.GrainKey
	if key == "" {
		key = "AU"
	}
	from := req.Msg.From
	if from == "" || from < dropIndexTrackingSince {
		from = dropIndexTrackingSince
	}
	to := req.Msg.To
	if to == "" {
		to = time.Now().UTC().Format("2006-01-02")
	}

	rows, err := s.store.GetDropIndexSeries(grain, key, from, to)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	points := make([]*pb.DropIndexPoint, 0, len(rows))
	for _, r := range rows {
		points = append(points, &pb.DropIndexPoint{
			SnapshotDate:     r.SnapshotDate,
			DropRate:         r.DropRate,
			MedianDropPct:    r.MedianDropPct,
			PanelSuburbs:     r.PanelSuburbs,
			CoverageRatio:    r.CoverageRatio,
			IsGap:            r.IsGap,
			ActiveAddresses:  r.ActiveAddresses,
			DroppedAddresses: r.DroppedAddresses,
		})
	}

	return connect.NewResponse(&pb.GetDropIndexSeriesResponse{
		Points:        points,
		TrackingSince: dropIndexTrackingSince,
	}), nil
}
```

- [ ] **Step 5: Regenerate mocks and run tests**

```bash
cd services && make generate-mocks
GOWORK=off go test ./shorts/internal/services/shorts/ -run TestGetDropIndexSeries -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/shorts/internal/services/shorts/
git commit -m "feat(housing): GetDropIndexSeries handler, clamped to the stable panel"
```

---

### Task 7: Server action and the hero component

**Files:**
- Modify: `web/src/app/actions/getHousing.ts`
- Create: `web/src/@/components/housing/price-drops/drop-index-hero.tsx`
- Create: `web/src/@/components/housing/price-drops/drop-index-hero-loader.tsx`
- Test: `web/src/@/components/housing/price-drops/drop-index-hero.test.tsx`

- [ ] **Step 1: Add the server action**

In `getHousing.ts`, following the existing housing action pattern (keep the `next: { revalidate }` tag on the transport — it is load-bearing for ISR):

```ts
export async function getDropIndexSeries(grain = "national", grainKey = "AU") {
  const client = createClient(HousingService, housingTransport);
  try {
    const res = await client.getDropIndexSeries({ grain, grainKey, from: "", to: "" });
    return { points: res.points, trackingSince: res.trackingSince };
  } catch {
    return { points: [], trackingSince: "" };
  }
}
```

- [ ] **Step 2: Write the failing component test**

```tsx
// web/src/@/components/housing/price-drops/drop-index-hero.test.tsx
import { render, screen } from "@testing-library/react";
import { DropIndexHero } from "./drop-index-hero";

const pts = (over: Partial<Record<string, unknown>>[] = []) => [
  { snapshotDate: "2026-08-03", dropRate: 0.10, medianDropPct: 0.05, panelSuburbs: 491, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0 },
  { snapshotDate: "2026-08-14", dropRate: 0.00, medianDropPct: 0, panelSuburbs: 491, coverageRatio: 0.1, isGap: true, activeAddresses: 0, droppedAddresses: 0 },
  { snapshotDate: "2026-08-16", dropRate: 0.12, medianDropPct: 0.05, panelSuburbs: 499, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0 },
  ...over,
];

test("captions the panel so the number is quotable", () => {
  render(<DropIndexHero points={pts()} trackingSince="2026-08-03" />);
  expect(screen.getByText(/tracking since 3 Aug/i)).toBeInTheDocument();
  expect(screen.getByText(/499 suburbs/i)).toBeInTheDocument();
});

// The 2026-08-13..15 outage must not read as discounting collapsing to zero.
test("gap days are excluded from the rendered series", () => {
  render(<DropIndexHero points={pts()} trackingSince="2026-08-03" />);
  const plotted = screen.getByTestId("drop-index-plotted-count");
  expect(plotted).toHaveTextContent("2");
});

test("renders nothing rather than a misleading empty chart", () => {
  const { container } = render(<DropIndexHero points={[]} trackingSince="" />);
  expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx jest src/@/components/housing/price-drops/drop-index-hero.test.tsx`
Expected: FAIL — cannot resolve `./drop-index-hero`.

- [ ] **Step 4: Implement the component**

```tsx
// web/src/@/components/housing/price-drops/drop-index-hero.tsx
"use client";

import { cn } from "@/lib/utils";
import { sectionTitle, eyebrow } from "@/lib/typography";

export interface DropIndexPointView {
  snapshotDate: string;
  dropRate: number;
  medianDropPct: number;
  panelSuburbs: number;
  coverageRatio: number;
  isGap: boolean;
  activeAddresses: number;
  droppedAddresses: number;
}

interface DropIndexHeroProps {
  points: DropIndexPointView[];
  trackingSince: string;
  /** Serializable format key. Never pass a formatter — functions cannot cross
   *  the RSC boundary. */
  format?: "percent";
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function DropIndexHero({ points, trackingSince }: DropIndexHeroProps) {
  // Gap days are days we did not observe, not days without discounting.
  // Plotting them as zero would render the 2026-08-13..15 crawl outage as a
  // market crash.
  const plotted = points.filter((p) => !p.isGap);
  if (plotted.length === 0) return null;

  const latest = plotted[plotted.length - 1]!;
  const earliest = plotted[0]!;
  const change = latest.dropRate - earliest.dropRate;
  const direction = change > 0.002 ? "rising" : change < -0.002 ? "falling" : "flat";

  return (
    <section className="rounded-lg border bg-card p-6">
      <p className={cn(eyebrow)}>Discounting index</p>
      <h2 className={cn(sectionTitle, "mt-1")}>
        {(latest.dropRate * 100).toFixed(1)}% of listings have cut their price
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Discounting is <strong>{direction}</strong> since {formatShortDate(earliest.snapshotDate)}.
      </p>
      <p className="mt-4 text-xs text-muted-foreground">
        Tracking since {formatShortDate(trackingSince)} · {latest.panelSuburbs} suburbs ·
        equal-weighted across suburbs
      </p>
      <span data-testid="drop-index-plotted-count" className="sr-only">
        {plotted.length}
      </span>
    </section>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx jest src/@/components/housing/price-drops/drop-index-hero.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 6: Add the ssr:false loader**

```tsx
// web/src/@/components/housing/price-drops/drop-index-hero-loader.tsx
"use client";

import dynamic from "next/dynamic";

// Charts cannot server-render in this app. Loading through next/dynamic with
// ssr:false from a "use client" module is the established pattern; importing
// the chart directly from a server component takes the route down.
export const DropIndexHero = dynamic(
  () => import("./drop-index-hero").then((m) => m.DropIndexHero),
  { ssr: false, loading: () => <div className="h-40 animate-pulse rounded-lg bg-muted" /> },
);
```

- [ ] **Step 7: Commit**

```bash
git add web/src/@/components/housing/price-drops/ web/src/app/actions/getHousing.ts
git commit -m "feat(price-drops): discounting index hero with an honest gap break"
```

---

### Task 8: Mount on the page

**Files:**
- Modify: `web/src/app/price-drops/page.tsx`

- [ ] **Step 1: Fetch and render**

Add to the imports:

```tsx
import { DropIndexHero } from "@/components/housing/price-drops/drop-index-hero-loader";
import { getDropIndexSeries } from "~/app/actions/getHousing";
```

Add `getDropIndexSeries()` to the existing parallel fetch, and render it above `NationalPulse` (line 158), inside a real Suspense boundary:

```tsx
<Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-muted" />}>
  <DropIndexHero points={dropIndex.points} trackingSince={dropIndex.trackingSince} />
</Suspense>
```

Do **not** read `searchParams` in this page. Doing so silently downgrades the route from ISR to dynamic and loses the 40–58ms cached render; `export const revalidate = 3600` on line 38 stops working.

- [ ] **Step 2: Verify ISR is intact**

```bash
cd web && npm run build 2>&1 | grep -A3 "price-drops"
```

Expected: `/price-drops` listed as `●` (SSG/ISR), **not** `ƒ` (dynamic). If it flipped to dynamic, a `searchParams` read crept in.

- [ ] **Step 3: Verify in the running app**

```bash
cd web && npm run dev
```

Open `http://localhost:3020/price-drops`. Confirm the hero renders above the national pulse, the caption names the tracking-since date and suburb count, and no console errors. Confirm the LISTEN pid is the server you just started before trusting the result:

```bash
lsof -nP -iTCP:3020 -sTCP:LISTEN
```

- [ ] **Step 4: Commit**

```bash
git add web/src/app/price-drops/page.tsx
git commit -m "feat(price-drops): lead with the discounting index"
```

---

### Task 9: Capitulation panel

The index is two weeks deep; this panel has five and carries the page meanwhile.

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices.go`
- Create: `web/src/@/components/housing/price-drops/capitulation-board.tsx`

- [ ] **Step 1: Extend the snapshot writer to populate the counters**

In `drop_index.go`, `querySuburbDays` currently leaves `RelistedLower` and `DelistedCount` at zero. Add to `runDropIndex`, before `writeIndexPoint`:

```go
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
```

- [ ] **Step 2: Verify the counters populate**

```bash
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts \
  DROP_INDEX_FROM=2026-08-03 /tmp/hpc -mode drop-index
psql postgresql://admin:password@localhost:5438/shorts \
  -c "select snapshot_date, relisted_lower, delisted_count from housing_drop_index_daily order by snapshot_date desc limit 5;"
```

Expected: non-zero `relisted_lower` and `delisted_count` on recent days.

- [ ] **Step 3: Expose the counters on the wire**

Add to `DropIndexPoint` in `housing.proto` (and the legacy copy), then `buf generate`:

```protobuf
  int32 relisted_lower = 9;
  int32 delisted_count = 10;
```

Add the matching fields to `DropIndexPointRow`, the store `SELECT`, and the
handler's point mapping — the same five places Task 5 and Task 6 touched.

- [ ] **Step 4: Render the panel**

```tsx
// web/src/@/components/housing/price-drops/capitulation-board.tsx
"use client";

import { cn } from "@/lib/utils";
import { sectionTitle, eyebrow } from "@/lib/typography";
import type { DropIndexPointView } from "./drop-index-hero";

export function CapitulationBoard({ points }: { points: DropIndexPointView[] }) {
  const usable = points.filter((p) => !p.isGap);
  if (usable.length === 0) return null;
  const latest = usable[usable.length - 1]!;

  return (
    <section className="rounded-lg border bg-card p-6">
      <p className={cn(eyebrow)}>Capitulation</p>
      <h2 className={cn(sectionTitle, "mt-1")}>Vendors pulling and re-cutting</h2>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-sm text-muted-foreground">Relisted lower (30d)</dt>
          <dd className="text-2xl font-semibold tabular-nums">{latest.relistedLower.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Withdrawn (30d)</dt>
          <dd className="text-2xl font-semibold tabular-nums">{latest.delistedCount.toLocaleString()}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Counted from listings we observed, so these are far less sensitive to crawl coverage
        than the index above.
      </p>
    </section>
  );
}
```

Add `relistedLower: number` and `delistedCount: number` to `DropIndexPointView`
in `drop-index-hero.tsx`, and mount `<CapitulationBoard points={dropIndex.points} />`
beneath the suburb leaderboard in `page.tsx`. No new rpc — it reads the series
already fetched for the hero.

Adding these as required fields breaks the `pts()` fixture written in Task 7,
which predates them. Update that fixture to include `relistedLower: 0,
delistedCount: 0` on each object and re-run
`npx jest src/@/components/housing/price-drops/` before committing.

- [ ] **Step 4: Commit**

```bash
git add services/house-price-collector/drop_index.go \
        web/src/@/components/housing/price-drops/capitulation-board.tsx \
        web/src/app/price-drops/page.tsx
git commit -m "feat(price-drops): surface relist-lower and delist capitulation"
```

---

### Task 10: Daily Cloud Run scheduler

**Files:**
- Modify: `terraform/modules/house-price-collector/main.tf`

- [ ] **Step 1: Add the scheduler**

Following the existing monthly scheduler resource in the same file, add a daily one invoking the job with `DROP_INDEX_FROM` unset (so it computes yesterday and today):

```hcl
resource "google_cloud_scheduler_job" "drop_index_daily" {
  name             = "house-price-collector-drop-index"
  description      = "Daily discounting index snapshot for /price-drops"
  schedule         = "30 18 * * *" # 04:30 AEST, after the overnight crawl settles
  time_zone        = "Etc/UTC"
  attempt_deadline = "1800s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/house-price-collector:run"
    oauth_token { service_account_email = var.service_account_email }

    body = base64encode(jsonencode({
      overrides = {
        containerOverrides = [{ args = ["-mode", "drop-index"] }]
      }
    }))
  }
}
```

- [ ] **Step 2: Plan**

```bash
cd terraform/environments/dev && terraform plan -target=module.house_price_collector
```

Expected: one resource to add, no changes to the existing monthly scheduler.

- [ ] **Step 3: Commit**

```bash
git add terraform/modules/house-price-collector/main.tf
git commit -m "feat(housing): daily scheduler for the drop index"
```

---

### Task 11: Production rollout

Order matters. The prod deploy applies a hardcoded migration allowlist containing **no housing migrations**, so DDL is manual and must land before the read path.

- [ ] **Step 1: Apply the migration by hand**

Use the Supabase **session pooler on 5432**, not the transaction pooler on 6543:

```bash
PGOPTIONS="-c statement_timeout=0" psql "$PROD_SESSION_POOLER_URL" \
  -f services/migrations/000110_add_housing_drop_index.up.sql
```

- [ ] **Step 2: Verify the table exists in prod**

```bash
psql "$PROD_SESSION_POOLER_URL" -c "\d housing_drop_index_daily"
```

Expected: the table, primary key and check constraint.

- [ ] **Step 3: Backfill once**

```bash
gcloud run jobs execute house-price-collector \
  --region australia-southeast2 \
  --args="-mode,drop-index" \
  --update-env-vars DROP_INDEX_FROM=2026-08-03
```

- [ ] **Step 4: Verify the series before shipping the UI**

```bash
psql "$PROD_SESSION_POOLER_URL" -c \
 "select snapshot_date, round(drop_rate::numeric,4) rate, panel_suburbs, round(coverage_ratio::numeric,2) cov, is_gap
  from housing_drop_index_daily where grain='national' order by snapshot_date;"
```

Expected: one row per day from 2026-08-03. Sanity checks before trusting it:
- `panel_suburbs` should sit near 490–500 throughout, **not** climb from 115.
- 2026-08-13, 08-14 and 08-15 should be `is_gap = true` — that was the crawl outage.
- `drop_rate` should not swing by more than a few points day to day. A cliff means the coverage guard is not working and the index is measuring the crawl again.

- [ ] **Step 5: Deploy the API and frontend, then revalidate**

After merge, run the revalidation sweep — a promote resets ISR pages to placeholders. The secret is in GCP Secret Manager as `REVALIDATION_SECRET`, and a browser UA is required.

- [ ] **Step 6: Confirm in the live app**

Load `https://shorted.com.au/price-drops` and confirm the hero renders with the caption, the chart shows a break across 13–15 Aug, and the response is a cache HIT on second load.

---

## Notes for the implementer

- Every Go command needs `GOWORK=off` to match CI.
- Store tests require `-tags=integration`.
- Do not add visual baselines — they are linux-only in this repo and fail locally.
- `golangci-lint` needs `--concurrency 1 --timeout 120s` or it OOMs.
- The pre-push hook runs testcontainers and needs Docker plus the `postgres:15-alpine` image present.
