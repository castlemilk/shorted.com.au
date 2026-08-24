# Crawl roadmap — handover

**Written 2026-08-24.** Every number here was measured, not estimated; the
command that produced it is given so you can re-measure rather than trust it.

Two things are being asked for next:

1. **Full per-property reporting**
2. **Stock drops tracked over time, across all suburbs**

> **Interpretation, please correct if wrong.** I have read "stock drops" as
> *listing stock* — how many properties are on market in a suburb, and how that
> level moves over time. *Price*-drop history already exists
> (`housing_drop_index_daily`, §4.1), so I assumed the new ask is the inventory
> series, not another price series. If you meant price drops per suburb over
> time, most of §4 is already built and the real work is only the coverage
> problem in §4.3.

---

## 1. Where it stands

### 1.1 Coverage — the number that governs everything

The crawl catalog is **500 suburbs**, hardcoded in
`services/house-price-collector/crawl_targets.go`. There are **15,345** suburbs
in the corpus. So the crawl reaches **3.3%** of them.

| State | suburbs | priced (VG) | in crawl catalog |
|---|---|---|---|
| NSW | 4,544 | 2,433 | 137 |
| VIC | 2,946 | 766 | 135 |
| QLD | 3,235 | **0** | 97 |
| SA | 1,698 | 426 | 66 |
| WA | 1,701 | **0** | 67 |
| TAS | 778 | **0** | **0** |
| NT | 305 | **0** | **0** |
| ACT | 138 | **0** | **0** |

The catalog covers only the **five mainland capitals**. Greater Hobart, Greater
Darwin, the ACT and all seven `Rest of <State>` regions have **zero** entries —
even though all of them already have trusted ABS baselines in
`mv_housing_headline` (Hobart $740k, Darwin $750k, ACT $1,071,300), so the
validation gate is *not* what is blocking them.

```
# re-measure coverage
curl -s -X POST "$API/shorts.v1alpha1.HousingService/ListStateSuburbs" \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' \
  -d '{"stateCode":"QLD","query":"","limit":5000}' | jq '.suburbs | length'
```

### 1.2 Throughput — why the catalog cannot simply be grown

Measured 2026-08-23: **~5 minutes per suburb** (two sources, REA + Domain).

- Full pass over 500 suburbs ≈ **42 hours** (matches the "full pass runs ~1.5
  days" note in `run-housing-full.sh`).
- Daily delta cap is `CRAWL_DELTA_MAX_SUBURBS=120` → rotation `500/120 = 4.17
  days ≈ 100h`, against a `CRAWL_FRESHNESS_ALARM_HOURS=120h` alarm. That is a
  20% margin, and **the catalog is already sized to it**.

Catalog size, per-run cap and alarm horizon are **one decision**. That is now
enforced mechanically by `crawl_rotation_invariant_test.go` (PR #476) rather
than by prose in two comments — grow the catalog without raising the cap and the
test fails and tells you both fixes and their costs. This exists because the old
60/72h pairing implied an 8.3-day rotation against a 3-day alarm, so the alarm
fired on the designed steady state and stopped meaning anything.

### 1.3 Sweep completeness — the accuracy ceiling

A sweep is `complete` or `partial`. Partial means the portal truncated the
result set before we saw every listing.

| | sweeps | complete | partial |
|---|---|---|---|
| 2026-08-23 (34 sweeps, mostly small SA suburbs) | rea 14 / domain 20 | 13 / 17 | **7% / 15%** |
| retained scheduler log (all time) | rea 2,772 / domain 1,718 | 1,397 / 1,029 | **50% / 40%** |

Partial correlates with suburb size against the page cap: `maxPages=5` × ~25
listings ≈ 125. Small suburbs (Paralowie 45, Craigmore 25) come back complete;
Parramatta (187 listings) truncates. **This is the single most important
constraint for both tracks below** — see §3.2 and §4.2.

```
grep -hE "event\(s\) from .* \((complete|partial)\)" \
  ~/Library/Logs/shorted-housing-scheduler.log | grep -c partial
```

### 1.4 Operational state, after 2026-08-23

The crawl had been silently dead for ~18 days (oldest suburb 433h, median 242h,
**500/500 stale**). Three separate faults, all now understood:

| Fault | Status |
|---|---|
| Rig binary drifted, then staged **unstamped** (`vcs.revision=unknown`) | **Fixed** — PR #478 |
| BrandBrain agent token expired; diag port re-minted 19179 → 58315 | **Fixed** — owner signed in; auto-refresh works |
| `CRAWL_ALERT_WEBHOOK` unset — every alert reached only a desktop notification | **STILL OPEN** |

The third is why an 18-day outage went unnoticed. **It is the highest-value
single change on this page** and it is a one-line edit to
`~/.shorted-housing-crawl.env`.

---

## 2. Land these first

Merged 2026-08-23/24, already in production:

| PR | What |
|---|---|
| #473 | `SuburbListingStats` on `GetSuburbProfileResponse` — crawl medians on unpriced suburbs |
| #476 | Rotation/alarm invariant made mechanical |
| #478 | `stage-rig.sh` builds from a real clean clone and refuses to install an unstamped binary |

Still open, in priority order:

1. **Set `CRAWL_ALERT_WEBHOOK`** (or `CRAWL_FRESHNESS_WEBHOOK`). Nothing else on
   this page matters if failures stay invisible.
2. **Let the daily delta run unattended for ~4 days** and confirm the backlog
   drains. 120/day against 500 stale suburbs is four cycles. Do this *before*
   building anything below — a roadmap built on a crawl that is not actually
   running is a roadmap built on nothing.
3. **Rotate the BrandBrain agent token deliberately**, or document its lifetime.
   It expired silently once; it will again.

---

## 3. Track A — full per-property reporting

### 3.1 What already exists

More than you might expect. `GetPropertyHistory(address_key)` returns:

- `display_address`, `suburb`, `state_code`, `postcode`
- `current` — the most recent listing snapshot
- `events[]` — the **full timeline across all listings at that address**, each
  with `event_type` (`first_seen|price_drop|price_rise|relisted|status_change|
  delisted`), `source`, `price`, `prev_price`, `drop_abs`, `drop_pct`,
  `listing_status`, `prev_status`
- `num_listings`, `first_price`, `current_price`
- `distinct_dwellings` — a blend warning (see §3.3)
- `valuation` — property.com.au AVM, gated by `HOUSING_VALUATIONS_ENABLED`

Surfaced at `/housing/property/[addressKey]` via `PropertyHistoryView`.

So "full per-property reporting" is **not a greenfield build**. It is closing
four specific gaps.

### 3.2 Gap 1 — delisting is unreliable on truncated sweeps (the big one)

Delisting is inferred by absence: a listing seen last run and not this run is
delisted. **That inference is only valid on a `complete` sweep.** On a partial
sweep the listing may simply be past the truncation boundary.

The code correctly refuses to infer delisting from a partial sweep — which is
why REA delisting has historically barely fired (19 events vs Domain's 2,574).
With REA partial at 50% over the retained log, **half of all REA sweeps can
never produce a delisted event**, so per-property timelines silently end rather
than closing out.

This is not a display bug. A property page that shows a listing as still active
when it sold three weeks ago is *wrong*, and no amount of front-end work fixes
it. **Fix truncation before promising "full" per-property reporting.**

Options, roughly in order of cost:
- **Raise `maxPages`** for large suburbs. Cheap, directly reduces partial rate,
  costs run time (~linear) which pushes against §1.2.
- **Paginate by price band** — split a large suburb's search into several
  narrower queries each under the truncation boundary. More requests but each
  one complete; this is the standard answer to a capped search
  (see `enumerating-capped-search` skill).
- **Accept and mark it**: expose sweep completeness per suburb so the UI can say
  "listing status may be stale in this suburb". Honest, but a much weaker
  product.

### 3.3 Gap 2 — address blending

`distinct_dwellings > 1` means the portal listed several differently-sized units
of one building with no unit number, so the timeline may merge more than one
physical dwelling. A search-results crawl cannot recover the missing unit
number. Today the view warns. Full per-property reporting either needs a
detail-page fetch to recover the unit, or must keep the warning permanently and
never claim the timeline is one dwelling.

### 3.4 Gap 3 — `address_key` backfill coverage

The proto says `address_key` is "empty until backfilled". **Measure the current
backfill rate before scoping anything** — an address-level product over a
partially-keyed corpus will silently under-report:

```sql
SELECT count(*) FILTER (WHERE address_key IS NULL OR address_key = '') AS unkeyed,
       count(*) AS total
FROM property_listings;
```

There is a `-mode backfill-address` for this.

### 3.5 Gap 4 — valuation coverage

`PropertyValuation` is unset when there is no row, `fetch_status != 'ok'`, or the
kill switch is off. Quantify the ok-rate before treating AVM as a headline
number on a property page.

### 3.6 Licence constraint (non-negotiable)

REA/Domain rows carry `source_licence='proprietary-tos-restricted'`. Per-address
*facts we derived* (our own observed price events) are a different thing from
republishing portal content, but a per-property page is the closest this product
gets to that line. Re-read `docs/feature/housing/data-sources.md` before
expanding what is displayed, and keep `HOUSING_DROP_LISTINGS_ENABLED` working as
a real kill switch — it is honoured on read, not inside the cache, so a takedown
takes effect on the next request.

---

## 4. Track B — stock over time, across all suburbs

### 4.1 What exists: the pattern to copy

`housing_drop_index_daily` (migration 000110) is a **daily snapshot table**:

```
snapshot_date  date NOT NULL
...
computed_at    timestamptz NOT NULL DEFAULT now()
```

served by `GetDropIndexSeries(grain, grain_key)` at `national | state | suburb`.
It already gives price-drop intensity over time and powers the `/price-drops`
chart ("Tracking since 13 Aug · 498 suburbs").

**This is exactly the shape Track B needs.** Copy it.

### 4.2 The gap: stock is point-in-time only

`mv_suburb_listing_stats` (migration 000077) is a **materialized view**:

```sql
CREATE MATERIALIZED VIEW mv_suburb_listing_stats AS
  SELECT ... FROM property_listings
  WHERE is_active AND listing_status IN ('for_sale','under_offer')
  GROUP BY region_code
```

`for_sale_count`, `median_asking`, `sold_count`, `median_sold` are **recomputed
on every refresh and the previous values are lost**. There is no stock history
anywhere in the schema.

**Work item:** add `housing_suburb_stock_daily`, mirroring
`housing_drop_index_daily` — `(snapshot_date, region_code, for_sale_count,
median_asking, sold_count, median_sold, computed_at)`, written by the same
finalizer that refreshes the MV, plus a `GetSuburbStockSeries` rpc.

Two accuracy caveats that must be carried into the schema, not bolted on later:

- **A truncated sweep undercounts stock.** `for_sale_count` from a `partial`
  sweep is a floor, not a count. Store sweep completeness alongside the number
  (e.g. `is_complete bool` or `pages_truncated int`) or the series will show
  phantom stock drops that are really truncation artefacts. **This is the single
  most likely way to ship a wrong chart.**
- **Stock is only meaningful if the suburb was actually crawled that day.** With
  a 4.2-day rotation, a daily snapshot per suburb is mostly carry-forward.
  Either store only on crawl days and let the reader interpolate, or store
  `last_crawled_at` next to the value. Do not emit a daily row that implies a
  daily observation.

### 4.3 "Across all suburbs" is the coverage problem

This is the hard part, and it is not a schema question. Stock over time for
**all** suburbs means crawling far more than 500. From §1.1 and §1.2:

| Catalog | Rotation at 120/run | Rotation at 240/run | Verdict |
|---|---|---|---|
| 500 (today) | 100h | 50h | fits the 120h alarm |
| 1,000 | 200h | 100h | needs cap ≥ 240 |
| 3,000 | 600h (25 days) | 300h | needs a fundamentally different approach |
| 15,345 (all) | 3,069h (128 days) | 1,534h | **not reachable this way** |

At ~5 min/suburb, crawling every suburb once takes **~53 days of continuous
crawling on one rig**. So "all suburbs" cannot mean "all suburbs at daily
granularity" on the current architecture. Realistic framings, pick one:

- **Tiered cadence.** Metro/high-churn suburbs daily; the long tail monthly or
  quarterly. The delta selector already scores by staleness and churn
  (`113 stale, 7 churny` in the 2026-08-23 run) — extend it to tiers rather than
  one flat cap.
- **More rigs.** The distributed-agent design exists (brandbrain ships
  `cmd/agent/`, and jobs are already claimed from a queue, so a second Mac is
  additive with no code change). Throughput scales roughly linearly with rigs.
  Note the block is fingerprint-scoped, so separate machines genuinely help
  where proxies would not.
- **Narrow the definition.** "All suburbs *we price*" (3,625) or "all suburbs in
  the five capitals" is a far cheaper promise and probably covers the actual
  product need.

### 4.4 Do not skip: the block ceiling

Measured 2026-08-23: `blockedSweeps=13` of 60 pages (**22%**) on the direct
`-mode listings` batch; ~8% on the queued delta run. There are **no proxies** by
deliberate decision — the block is fingerprint-scoped, so proxies do not help
and a block risks the rig's access outright. Any throughput increase must be
ramped and watched, not stepped.

---

## 5. Suggested order

1. `CRAWL_ALERT_WEBHOOK`. One line. Everything else depends on knowing when the
   crawl breaks.
2. Let the delta drain the backlog (~4 days) and confirm steady state.
3. **Fix truncation** (§3.2). It gates per-property accuracy *and* stock
   accuracy — one fix, both tracks. Do it before either feature.
4. `housing_suburb_stock_daily` + `GetSuburbStockSeries` (§4.2), with
   completeness stored alongside the counts.
5. Measure `address_key` backfill and AVM ok-rate (§3.4, §3.5), then close the
   per-property gaps.
6. Only then decide the coverage question (§4.3) — it is a capacity and product
   decision, not an engineering one.

---

## 6. Decisions needed from the owner

- **Is "stock drops" inventory or price?** (top of this doc)
- **What does "all suburbs" mean in practice?** 15,345 is ~53 days of crawling
  on one rig; tiered cadence or more rigs both work, but they are different
  projects.
- **Second rig?** The queue architecture already supports it and it is the only
  lever that moves throughput without raising block risk.
- **Truncation approach** (§3.2) — raise page caps, price-band pagination, or
  accept and label.
