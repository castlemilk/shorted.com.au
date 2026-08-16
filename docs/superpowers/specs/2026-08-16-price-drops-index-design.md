# Price-drops discounting index — design

Date: 2026-08-16
Surface: `/price-drops`
Status: approved, not yet implemented

## Goal

`/price-drops` should let a reader say, within ten seconds, **whether discounting
is rising or falling**. Today it cannot: every figure on the page is a single
"last 30 days" snapshot, so the page shows *that* vendors are cutting prices and
never whether the cutting is accelerating.

The surface is a market-signal and editorial one, not a bargain-hunting tool.
That choice drives everything below: the index has to be quotable.

## The constraint that shapes the design

Existing history cannot support a national trend line. Suburbs with listing data
per week:

| week | suburbs |
|---|---|
| 2026-07-13 | 115 |
| 2026-07-20 | 124 |
| 2026-07-27 | 88 |
| 2026-08-03 | 491 |
| 2026-08-10 | 499 |

**Zero suburbs appear in every week.** The crawl catalog grew from ~115 to 500
over this period, so a naive `sum(drops) / sum(active)` series measures catalog
growth, not the market. Reconstructing it directly produces an active-listing
denominator of 1,246 → 19,977 → 27,301 → 60,934 → 36,397; the final fall is the
2026-08-13→15 crawl outage, not vendor behaviour. Published as a market index,
that line would show a crash that did not happen.

A like-for-like panel is therefore only stable from **2026-08-03** (~491
suburbs). Two weeks of history, deepening from here.

Rejected alternative: fixing the panel to the ~88–124 suburbs present in July to
buy five weeks of chart. The early catalog skews SA/VIC, so a "national" index
would really be an 88-suburb SA/VIC index — precisely the kind of number that
gets quoted and then retracted.

## Data model

Migration `000110`, table `housing_drop_index_daily`, primary key
`(snapshot_date, grain, grain_key)` where `grain` is `national` | `state` |
`suburb` and `grain_key` is `AU`, a state code, or a `sal_code`.

| column | purpose |
|---|---|
| `active_addresses` | deduped physical addresses active that day |
| `dropped_addresses` | addresses with a `price_drop` in the trailing 30 days, still active |
| `drop_rate` | the index (see below) |
| `median_drop_pct` | depth of cut, for the secondary read |
| `relisted_lower`, `delisted_count` | capitulation counters |
| `panel_suburbs` | how many suburbs contributed |
| `coverage_ratio` | share of panel suburbs swept in the prior 48h |
| `is_gap` | `coverage_ratio < 0.6` |

The last three are honesty columns and are not optional — they are what let a
reader tell a market move from a crawl artefact.

## The metric

For each suburb *s* on date *d*:

```
rate(s, d) = dropped_addresses(s, d) / active_addresses(s, d)
```

The national and state index is the **equal-weighted mean of per-suburb rates**,
not the pooled ratio. This is the core decision. Adding a suburb to the catalog
moves an equal-weighted mean by `1/N`; it moves the pooled ratio by however many
listings that suburb brought. Equal weighting turns the 115→500 expansion from a
fake signal into a composition footnote.

The median of per-suburb rates is stored alongside as a robustness check. A
sharp divergence between mean and median means the distribution has skewed and
is worth investigating.

At `grain = 'suburb'` there is nothing to aggregate: `drop_rate` is that
suburb's own `rate(s, d)`, `panel_suburbs` is 1, and `coverage_ratio` is 1 if
that suburb was swept in the prior 48h and 0 otherwise. The ≥20-active floor
does **not** apply at suburb grain — it exists to stop small suburbs distorting
an aggregate, and a suburb's own rate is not distorted by being small. It does
mean a small suburb can appear on its own page while being excluded from the
national panel, which is correct and should not be treated as an inconsistency.

Two guards:

- A suburb enters the panel only with **≥20 active addresses**. Without this a
  three-listing suburb reports a 33% drop rate and drags the mean.
- `coverage_ratio < 0.6` sets `is_gap`, and the chart draws a discontinuity
  rather than a point. The 2026-08-13→15 outage renders as missing data, which
  is what it is.

The 30-day trailing window matches the existing boards deliberately, so the
headline and the suburb leaderboard cannot disagree.

## Write path

New collector mode `-mode drop-index`, append-only, idempotent per
`(snapshot_date, grain, grain_key)` so a re-run repairs rather than duplicates.
A backfill flag walks 2026-08-03 → today, reconstructing active-on-date via
`first_seen_at <= d <= last_seen_at`. Dates before 2026-08-03 are deliberately
absent.

**It runs on Cloud Run, not the residential rig.** The rig is the fragile
component — a driver deletion stopped it for two days in August 2026 — and an
index that freezes at a stale number whenever Chrome breaks is worse than no
index. This computation is pure SQL over prod and needs no browser, so it goes
on the existing `house-price-collector` job with its own **daily** scheduler
alongside the current monthly one.

A table rather than a materialized view: active-on-date is reconstructable, so a
view would work today, but this is a number that gets published. Derived live, a
listings purge or a late backfill silently rewrites a figure quoted last week.
Snapshots make published history immutable.

## API

One new rpc on `HousingService`:

```
GetDropIndexSeries(grain, grain_key, from, to) -> repeated DropIndexPoint
```

Each point carries `drop_rate`, `median_drop_pct`, `panel_suburbs`,
`coverage_ratio`, `is_gap`. The last three cross the wire deliberately: the
client needs them to draw the break and the caption, and that logic should not
exist twice.

Per the repo's dual-add contract the rpc is also added to the legacy
`ShortedStocksService` in `shorts.proto` (enforced by `proto_parity_test.go`),
annotated `VISIBILITY_PUBLIC`, mounted in `serve.go` with the shared
interceptors, and given a rewrite rule in `web/next.config.mjs`.

## Frontend

`DropIndexHero` sits above the existing `NationalPulse`: current index,
direction against four weeks ago, sparkline, and the caption
"tracking since 3 Aug · 491 suburbs".

Three housing landmines bind here:

- Imported `dynamic(..., { ssr: false })` from a `"use client"` module — charts
  cannot SSR.
- Receives a serializable `format="percent"` key, never a formatter. Functions
  cannot cross the RSC boundary.
- Must not read `searchParams`. Doing so silently downgrades `/price-drops` from
  ISR to dynamic rendering and loses the 40–58ms cached render. State selection
  is client-side via `useSearchParams` under a real `<Suspense>` boundary; the
  `next/dynamic` fallback does not satisfy it.

Panel two is a capitulation board over the 14,221 `relisted` and 6,091
`delisted` events that are currently invisible on the page. These rates are
conditioned on listings actually observed, so they are far less
coverage-sensitive than the index and have real depth today — they carry the
page while the index accumulates.

## Testing

The load-bearing test feeds the metric a synthetic panel expanding 115 → 500
suburbs with per-suburb rates held constant, and asserts the index **does not
move**. A pooled ratio fails this test; the equal-weighted mean passes it. This
single test is the design's justification and should read that way.

Alongside it: the ≥20-active floor, the `coverage_ratio` → `is_gap` threshold,
and backfill idempotency (running twice changes nothing).

Store tests require `-tags=integration`. No visual baselines — they are
linux-only in this repo and fail locally.

## Rollout

The prod deploy does **not** run `migrate up`; it applies a hardcoded allowlist
containing no housing migrations. `000110` must be applied by hand on the
Supabase **session pooler (5432)** with `PGOPTIONS="-c statement_timeout=0"`
*before* the read path ships, or every `/price-drops` route 500s.

Order: apply DDL → deploy collector with `-mode drop-index` → run backfill once
→ verify the series → ship the API and frontend.

## Out of scope

Alerts on new drops, saved searches, per-user watchlists, and programmatic
per-suburb drop pages. This spec covers the market-signal read only.
