# Economy Phase-3 Round 3 — Design Spec (analytics + platform)

Roadmap items 4.3, 4.5, 4.6, 5.8, 6.5 + the round-1 accepted perf follow-ups
(state-page eager fetch → solved at the right altitude by 4.6; markets double
scan; chat RPC limit param). Probed 2026-07-24: **Weekly Payroll Jobs no
longer exists in the ABS API** (publication discontinued; only biannual AWE
remains, superseded by WPI) — roadmap 1.4's payrolls half is dead, recorded
here. Migrations: next free number is **000090** (check origin/main again at
PR time — parallel sessions are consuming numbers).

## A. Exposure-weighted state price-return index (roadmap 4.5)

- New derived family inside `-mode markets` (per-family resilience):
  `markets.price_return_index.{state}` — monthly, unit `index`, base 100 at
  the first month with data, source `derived-shorted-markets`,
  current-constituent caveat (same `basis` dimensions as short-interest).
- Derivation: monthly-last close per stock from `stock_prices` (DISTINCT ON
  (stock_code, month) ORDER BY date DESC); stock monthly return =
  close/prev-close − 1 (consecutive months only — a gap breaks the chain for
  that stock-month, skip); state monthly return = Σ(weight × market_cap ×
  return) / Σ(weight × market_cap) over `mv_company_state_exposure`
  (region ≠ international); index = cumulative product × 100.
- ≥5 constituent stocks per state-month floor (markets convention).
- Magnitude guard: monthly state return within ±25% (else drift).

## B. Per-capita variants (roadmap 4.3)

New `-mode derived` families (source `derived-shorted-economy`):
- `gdp.state_final_demand_per_capita.total.{state}.seasadj` — quarterly SFD ÷
  same-quarter erp; unit `aud`.
- `spending.household_per_capita.total.{state}.seasadj` — monthly spending ÷
  the latest erp observation at-or-before that month (forward-fill quarterly
  erp; skip months before the first erp obs); unit `aud`.
- `approvals.dwelling_units_per_100k.total.{state}` — monthly approvals ÷
  forward-filled erp × 100,000; unit `rate_per_100k`.
- All 8 states (+aus where both inputs exist — SFD/approvals are state-only;
  spending has aus). Fail-loud per family. `dimensions.denominator=erp`.

## C. Correlation matrix (roadmap 4.6) — the centerpiece

- **Migration 000090** `economic_correlations`: `base_series_key text`,
  `overlay_series_key text`, `window_months int`, `r double precision`,
  `n int`, `last_period date`, `computed_at timestamptz`,
  `PRIMARY KEY (base_series_key, overlay_series_key, window_months)` +
  index on (base_series_key, window_months, abs(r) DESC) — expression index
  or store `abs_r` generated column (pick the simpler portable option).
- **Collector `-mode correlations`** (runs LAST in `all`, after derived):
  Go port of the web's rolling-Pearson (correlation.ts — quarterly→monthly
  forward-fill alignment, window 24 months, min n 12; port the MATH testably
  and add a golden-vector test whose expected values are generated from the
  TS implementation to prevent drift). Pairs: bases = every `markets.*`
  series; overlays = every non-markets series that is (same region) OR
  (national) — monthly/quarterly only (annual excluded). Delete-and-replace
  per base key in one tx. Cap: skip pairs with insufficient overlap; expect
  ~40 bases × ~40 eligible overlays ≈ low thousands of rows.
- **RPC**: `ListSeriesCorrelations(base_series_key, window_months=24,
  min_abs_r=0.0, limit≤100)` → rows + overlay series metadata (join catalog
  for name/unit/frequency). Add to `EconomyService` (economy.proto) AND the
  legacy `ShortedStocksService` (shorts.proto) per the dual-add contract,
  `VISIBILITY_PUBLIC` on both. `buf generate` — commit ALL outputs incl. Java
  SDK churn. Handler + store per the 4-layer pattern; normalized cache key.
- **Web consumes precomputed correlations** (kills the round-1 ~100KB eager
  fetch): `SeriesCorrelation` gets a `precomputed` mode — chips from
  `ListSeriesCorrelations` (client action w/ session cache), series data
  fetched ONLY for anchor + active overlay (2 series instead of ~17/state
  page); overlay switch fetches on demand (react-query per-key caching).
  State pages and the industry strip both switch to precomputed mode. The
  overlay candidate REGISTRY stays as the display-name/format lookup — chips
  render only overlays present in the registry (unknown keys skipped).
  Fallback: if the RPC returns empty (prod before first correlations run),
  fall back to the current client-side computation path (keep it — this is
  the deploy-order-free degradation, same pattern as round 1 P5).

## D. Map metrics: chip overflow + approvals/construction (roadmap 5.8)

- `economy-map-explorer.tsx` chip row: show first N (current count) chips +
  a "More" disclosure (shadcn DropdownMenu or Popover per repo UI
  conventions) for the rest; selected metric always visible (swap into the
  visible row when chosen from overflow).
- Add map metrics: `approvals.dwelling_units.total.{state}` (number) and
  `construction.work_done.total.{state}.seasadj` (aud) — both were parked
  for capacity in rounds 1–2.

## E. Perf follow-ups (round-1 accepted findings)

- **markets.go single scan**: the `monthly_last` CTE over ~2.1M-row `shorts`
  runs twice (state + industry queries). Combine into ONE query returning a
  family discriminator column (UNION ALL of the two aggregations over a
  shared CTE), or a session temp table — one scan per run. Keep the two
  assembly paths + tests unchanged.
- **Chat/GetEconomicSeries limit**: add `int32 max_observations = 3` (or
  next free field number) to `GetEconomicSeriesRequest` in economy.proto +
  the legacy message in shorts.proto (they share message definitions? — NO:
  legacy service is message-less and reuses the domain messages; verify and
  add once in the owning file). 0 = current default 600. Store threads it to
  the LIMIT. chat tool_executor passes its limit through instead of
  trimming client-side. Backward compatible.

## F. Exposure-MV staleness guard (roadmap 6.5)

- **Migration 000091**: recreate `mv_company_state_exposure` with an
  additional `refreshed_at timestamptz` column = `now()` (captures refresh
  time at REFRESH). Preserve existing indexes/uniques exactly (read the
  original migration 000083 first). Prod note: apply via session pooler 5432.
- markets mode: before deriving, `SELECT max(refreshed_at)`; if older than
  45 days emit a loud WARNING (not an error — the derivation still runs;
  current-constituent basis tolerates drift, the guard is for honesty).

## Out of scope

- Payrolls (dead upstream), AWE (biannual, superseded by WPI).
- REQ forecasts / AEMO / state budgets (own workstreams).
- LLM state insights (5.1), OG images (5.3), weekly-report economy section
  (5.5), alerts (5.6), export page (5.7) — next rounds.
