# Stock picker: strategy-driven picks over fundamentals + price structure

Status: design fixed 2026-09-27, implemented on `claude/upbeat-feynman-d7i92k`
(all four streams landed the same day; §8 lists the follow-ups). This document is the contract between the
four implementation streams; column names, proto names and strategy ids here
are binding. Update it when something changes.

## 1. What we are building

A `/picks` hub and one `/picks/[strategy]` page per named strategy. A user picks
a strategy (Dan Zanger's breakout method first), sees the current market regime,
a ranked table of ASX stocks with a per-rule pass / fail / unknown breakdown, and
a full description of the strategy: who it comes from, the rules, exactly how we
evaluate each rule against our data, what the data cannot tell us, and the
holding / risk posture. The same picks and the underlying fundamentals are
exposed on the public API and the MCP server.

Everything below is derived from data we already hold plus ONE new ingest
(typed, per-period company fundamentals). No LLM is in the evaluation path.

### The seven Zanger rules and what each one maps to

| # | Zanger's rule | What we evaluate | Data |
|---|---|---|---|
| 1 | Explosive earnings and revenue growth | Latest-period revenue YoY growth and EPS YoY growth vs the same period a year earlier; acceleration = latest YoY > prior YoY | NEW `stock_fundamentals` (per-period, typed) |
| 2 | A recognisable base (cup-and-handle, flat base, flag, pennant, ascending triangle) | A consolidation: `base_length_days` 20-120 trading days, `base_depth_pct` <= 25%, current close within the base or just above it. We do not classify the shape; we detect that a tight base exists and report its depth and length | NEW `mv_price_features` from `stock_prices` |
| 3 | Buy the breakout on heavy volume | `close > base_high` (prior 40-session high excluding today) AND `volume_ratio_50d >= 1.5` within the last 5 sessions | `mv_price_features` |
| 4 | Cut the loss if it fails | Not a screen: we report the invalidation level (`base_high`, the pivot) so the user knows where "back into the base" is | derived from `mv_price_features` |
| 5 | Concentrate | Not a screen: we rank hard and show a short list (top 20), not a long one | ranking |
| 6 | Read the market first | Market regime from XJO: `close > sma50 > sma200` = uptrend, `close > sma200` = neutral, else downtrend. Downtrend does not hide picks, it demotes the strategy verdict to "stand aside" and says so | NEW `mv_market_regime` from `index_prices` |
| 7 | Let winners run | Not a screen: we show relative strength vs XJO over 3m/6m so leaders are visible | `mv_price_features` + `index_prices` |

### Strategies shipped at launch (ids are binding)

| id | Name | Author / lineage | Core inputs |
|---|---|---|---|
| `zanger-breakout` | Zanger Breakout | Dan Zanger (Guinness record, Fortune-verified 29,233% year) | growth + base + breakout on volume + regime + RS |
| `canslim` | CAN SLIM | William O'Neil | EPS growth (current + annual), new highs (within 5% of 52w high), leader (RS top quartile), regime |
| `minervini-trend-template` | Minervini Trend Template | Mark Minervini (US Investing Champion) | pure price: close > sma150 > sma200, sma200 rising over 1m, close >= 1.3 x 52w low, within 25% of 52w high, RS top quartile |
| `crowded-short-breakout` | Crowded-Short Breakout | Shorted house strategy | short interest >= 5%, days-to-cover >= 5, breakout on volume, regime. Ties the picker to the site's own dataset |

Every rule returns one of `pass`, `fail`, `unknown`. Unknown means the data is
missing (no fundamentals for the stock yet, not enough price history). Unknown
never counts as pass, and a stock cannot reach status `triggered` with an unknown
core rule. Statuses:

- `triggered`: every core rule passes (for Zanger: growth, base, breakout, regime not downtrend).
- `setup`: base + growth pass, breakout has not happened. This is the watchlist.
- `watch`: some rules pass, ranked lower. Shown only when the table would otherwise be short.

Score is a weighted sum of rule components (pattern from `verdict.go`), 0-100,
used only to order rows within a status. Ranking is status first, then score.

## 2. Data layer (stream A)

### 2.1 `stock_fundamentals` — migration `000129_add_stock_fundamentals`

Typed, per-period statement lines. One row per (stock, period_type, period_end).

```sql
CREATE TABLE IF NOT EXISTS stock_fundamentals (
    stock_code          VARCHAR(10)      NOT NULL,
    period_type         VARCHAR(8)       NOT NULL,  -- 'annual' | 'half' | 'quarter' | 'ttm'
    period_end          DATE             NOT NULL,
    fiscal_year         SMALLINT,                   -- FY the period belongs to (ASX FY ends 30 June)
    currency            VARCHAR(8)       NOT NULL DEFAULT 'AUD',
    revenue             DOUBLE PRECISION,           -- total revenue, whole currency units
    net_income          DOUBLE PRECISION,           -- NPAT (NetIncomeCommonStockholders)
    eps_basic           DOUBLE PRECISION,
    eps_diluted         DOUBLE PRECISION,
    operating_cash_flow DOUBLE PRECISION,
    free_cash_flow      DOUBLE PRECISION,
    shares_outstanding  DOUBLE PRECISION,
    source              VARCHAR(32)      NOT NULL,  -- 'yahoo-timeseries' etc
    source_fetched_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT stock_fundamentals_pk PRIMARY KEY (stock_code, period_type, period_end),
    CONSTRAINT stock_fundamentals_period_type_check CHECK (period_type IN ('annual','half','quarter','ttm'))
);
CREATE INDEX IF NOT EXISTS idx_stock_fundamentals_code_end ON stock_fundamentals (stock_code, period_end DESC);

CREATE TABLE IF NOT EXISTS stock_fundamentals_sync (
    stock_code       VARCHAR(10) PRIMARY KEY,
    last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_success_at  TIMESTAMPTZ,
    last_error       TEXT,
    periods_loaded   INTEGER NOT NULL DEFAULT 0
);
```

Values are stored EXACTLY as the source reports them; non-finite values are
rejected at the write funnel (same rule as `key_metrics_finite.go`). No LLM runs
in the write path. Filing rows (source `asx-filing-extraction`, §2.6
`-mode filings`) are parsed from the report-extractor's stored Gemini output,
but only values that can be found in the extraction's own quoted sentence, in
an unambiguous unit, are accepted, and a filing never overwrites a vendor
value.

### 2.2 `mv_fundamentals_growth` — same migration

One row per stock. Growth is computed against the SAME series one year earlier,
never across series (annual vs annual, TTM vs the TTM point ~12 months earlier).
Yahoo carries no half-year TOTALS for ASX companies (probe 2026-09-27: the
"quarterly" series are empty), so the bases are:

- revenue / net income / operating cash flow: `annual` vs prior `annual`.
- EPS: `ttm` vs the `ttm` point 10-14 months earlier when both exist (TTM EPS
  arrives every half-year, so it is the freshest series), else `annual`.
  `basis_period_type` records which one was used for EPS.
- Half-year delta (exact identity, no half-year totals needed): latest TTM minus
  the latest full year equals the latest half minus the same half a year
  earlier. Exposed as `revenue_half_delta` / `net_income_half_delta` (absolute,
  reporting currency) when both a TTM point AFTER the latest annual period_end
  and that annual row exist; else NULL. The evaluator uses it only as a sign
  (is the latest half better than the same half last year), never as a %.

**Half-year growth from filings (added 2026-09-27).** Company filings carry the
half-year totals Yahoo lacks; `-mode filings` stores them as `half` rows. The
view adds `revenue_half_yoy_pct`, `net_income_half_yoy_pct`,
`eps_half_yoy_pct` (latest half vs the half 10-14 months earlier, same guards:
NULL unless the prior is > 0 and both share a currency; EPS compares diluted
with diluted when both halves carry it, else basic with basic),
`half_latest_period_end`, and `revenue_basis_period_type`. As originally
intended, **half is preferred when it is fresher**, per series: when a half
growth exists and the half ends strictly AFTER that series' vendor basis
(`a1` for revenue; `e1` on the ttm basis / `ae1` on the annual for EPS), the
series' `*_latest`, `*_prior`, `*_yoy_pct` and `*_yoy_prior_pct` are the half
values, `basis_period_type = 'half'` (EPS) / `revenue_basis_period_type =
'half'` (revenue) and, for EPS, `latest_period_end` is the half's end. A TTM
point on the same date as the half keeps the ttm basis (as fresh, smoother).
The columns are appended after `fetched_at`; every earlier column keeps its
name and position.

```
stock_code, basis_period_type, latest_period_end,
latest_annual_period_end,
revenue_latest, revenue_prior, revenue_yoy_pct,
revenue_yoy_prior_pct,            -- growth of the period before, for acceleration
eps_latest, eps_prior, eps_yoy_pct,
eps_yoy_prior_pct,
net_income_latest, net_income_prior, net_income_positive (bool),
operating_cash_flow_latest,
revenue_ttm, net_income_ttm, eps_ttm,          -- latest TTM points, NULL when absent
revenue_half_delta, net_income_half_delta,     -- see above
currency,
periods_available (int), fetched_at,
revenue_half_yoy_pct, net_income_half_yoy_pct, eps_half_yoy_pct,   -- half vs same half a year earlier
half_latest_period_end,
revenue_basis_period_type                      -- 'half' | 'annual'
```

`*_yoy_pct` is NULL (not 0) when either side is missing or the prior is <= 0
(growth from a loss to a profit is reported via `net_income_positive` turning
true with `net_income_prior <= 0`, and the evaluator treats "prior loss, now
profit" as a pass for the growth rule; `eps_yoy_pct` stays NULL). Unique index
on `stock_code`. A `CASE WHEN prior > 0` guard, never a division that can
produce Inf; the `key_metrics` incident (`docs/superpowers/handover-2026-08-29-mcp-oauth.md`)
is why.

### 2.3 `mv_price_features` — migration `000130_add_price_features`

One row per `stock_code` in `stock_prices` with at least 60 sessions in the last
400 calendar days. Computed over the trailing 260 sessions. Columns:

```
stock_code, as_of (last price date), close, prev_close,
sma10, sma20, sma50, sma150, sma200, sma200_1m_ago,
high_52w, low_52w, pct_off_52w_high (negative or 0), pct_above_52w_low,
volume, avg_volume_50d, volume_ratio_50d, dollar_volume_20d,
base_high   -- max(high) over sessions [t-40, t-1]  (the pivot)
base_low    -- min(low)  over the same window
base_depth_pct  -- (base_high - base_low) / base_high * 100
base_length_days -- sessions since the base_high was set (>=1)
breakout_recent (bool) -- any of the last 5 sessions closed above the prior-40 high with volume_ratio_50d >= 1.5
breakout_date (date or null),
ret_1m_pct, ret_3m_pct, ret_6m_pct, ret_12m_pct,
rs_3m_pct, rs_6m_pct     -- stock return minus XJO return over the same window
sessions_available (int)
```

Prices were `DECIMAL(10,2)` until migration 000131 widened them to four
decimals; sub-cent stocks are noisy and are excluded by the
liquidity floor (`dollar_volume_20d >= 250000` AUD) applied in the evaluator,
not in the view.

### 2.4 `mv_market_regime` — same migration

One row per index in `index_metadata` (XJO is the one used):
`index_code, as_of, close, sma50, sma200, pct_off_52w_high, ret_1m_pct, ret_3m_pct, regime`
where `regime` is `'uptrend' | 'neutral' | 'downtrend'` per the rule in §1.

### 2.5 Refresh: `refresh_strategy_views()`

A NEW function, not an addition to `refresh_all_materialized_views()`, because
that one runs at 10:00 UTC before the price sweep lands (measured: the sweep
starts 10:00 UTC weekdays and runs ~2.5h). Same guard pattern as 000095
(try CONCURRENTLY, fall back to plain, catch `query_canceled`, WARNING and
continue). Called by the new job after the sweep.

Both migrations are REPLAY-SAFE (`IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
no row rewrites) and go into the deploy allowlist in
`.github/workflows/terraform-deploy.yml` AFTER `000095`. Down migrations drop
what they create. Each gets a `services/migrations/<name>.test.mjs` asserting
replay safety and the guarded refresh, mirroring `mv_refresh_hardening.test.mjs`.

### 2.6 Job: `shorted picks` (services/jobs/internal/jobs/picks)

Modes:
- `-mode fundamentals`: pull per-period fundamentals for the universe (codes in
  `stock_prices` with a price in the last 90 days, plus everything in
  `mv_screener_data`), stalest-first by `stock_fundamentals_sync.last_attempt_at`,
  skipping codes attempted in the last 6 days, capped by `PICKS_FUNDAMENTALS_MAX_CODES`
  (default 400). Upsert into `stock_fundamentals`; record every attempt in
  `stock_fundamentals_sync`. Pace via `pkg/stealthhttp` at the same cadence the
  price sweep uses. Exit 0 if >= 50% of attempted codes succeeded, exit 10
  (DEGRADED, economy's convention) otherwise.
- `-mode filings`: parse `financial_report_extractions.metrics` (revenue, net
  profit, EPS from the report-extractor's Gemini reading of 4D/4E and other
  results documents) into typed `half` / `annual` rows, source
  `asx-filing-extraction`. DB-only, a deterministic rebuild each run. The rules
  (value must be found in its own quote; EPS unit read next to its number,
  cents -> dollars, ambiguous = skipped; statutory NPAT only; magnitude and
  NPAT/shares cross-checks; currency from an explicit marker, else the vendor's
  reporting currency, else AUD) and the period parser (headline gate rejecting
  notices, webinars, AGM results, dividend admin and quarterlies; quarter /
  forecast / comparative periods rejected; half words beat annual words; an
  explicit date beats an FY label placed on the company's balance date; H1 of a
  June year ends 31 December of the prior calendar year; the period must end
  within 7 days after and 15 months before the report date) are documented in
  `services/jobs/README.md` "picks" and pinned by `filings_period_test.go` /
  `filings_ingest_test.go`.
  **Conflict policy**, in the SQL (`filingUpsertSQL`): a vendor row's non-null
  value is never overwritten; a filing fills only its NULL columns, and only in
  the same currency; a filing row is replaced whole; periods the vendor lacks
  (every half) are inserted whole; a filing row the run no longer produces for
  that code is pruned (never a vendor row). When Yahoo later publishes a period
  a filing wrote first, `upsertSQL` makes the row the vendor's (its values win,
  the filing's survive only where it has none).
- `-mode refresh`: `SET LOCAL statement_timeout = 0; SELECT refresh_strategy_views()`.
- `-mode all`: fundamentals, then filings, then refresh (each step runs even
  after an earlier one degraded; the worst verdict decides the exit code).
- `-dry-run` honoured (fetch/read + parse + log, write nothing).

Source and endpoint: see §2.7. Terraform: `module "shorted_job_picks"` on the
`shorted-job` module, `name = "shorted-picks"`, primary schedule
`30 13 * * 1-5` UTC with `args = ["picks", "-mode", "refresh"]` (after the
sweep), plus one extra schedule `0 15 * * *` UTC with `args_override =
["picks", "-mode", "all"]` (fundamentals, then filings, then the refresh, so
each pull reaches the views the same night; was `-mode fundamentals` until
2026-09-27). `secret_env = { DATABASE_URL }`.
Register in `cmd/shorted/main.go`, document in `services/jobs/README.md`.

### 2.7 Upstream fundamentals source (probe 2026-09-27, report in the session scratchpad `fundamentals-sources.md`)

Primary: **Yahoo fundamentals-timeseries**, the same host and the same
`pkg/stealthhttp` client the price sweep already uses (plain curl is 429'd on
every Yahoo endpoint; the stealth client gets 200 everywhere; this endpoint needs
no cookie or crumb). One GET per code:

```
GET https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{CODE}.AX
  ?type=annualTotalRevenue,annualNetIncomeCommonStockholders,annualDilutedEPS,annualBasicEPS,
        annualOperatingCashFlow,annualFreeCashFlow,annualOrdinarySharesNumber,
        trailingTotalRevenue,trailingNetIncomeCommonStockholders,trailingDilutedEPS,
        trailingOperatingCashFlow,trailingFreeCashFlow
  &period1=1262304000&period2=<now + 1 year, unix seconds>
```

What it holds for ASX: 4 fiscal years of annual rows (revenue, net income, EPS,
OCF, FCF, shares), TTM EPS at every half-year, TTM revenue / profit / cash flow
as the latest one or two points. Quarterly series are EMPTY for ASX. Values are
in the REPORTING currency (BHP is USD) and each point carries `currencyCode`:
store it, compute growth only within a series. Annual rows lag 4-8+ weeks for
small caps after a filing. Pace: 4s between requests like the sweep (a full
2,300-code pass is ~2.6h, hence the per-run cap and stalest-first order).

Fallback: **ASX / Markit key statistics**
(`https://asx.api.markitdigital.com/asx-research/1.0/companies/{CODE}/key-statistics`,
plain HTTPS works, no bot wall observed): 4 annual revenue / profit rows, TTM EPS,
share count, TTM cash flow; fresher than Yahoo for small caps. Parsing quirks:
period-end dates are Excel serial numbers, missing values are `-32768`, ratios
use `-99999.99` for "not meaningful"; treat both sentinels as NULL. Use it when
Yahoo fails for a code or its latest annual `period_end` is older than Markit's.

Ruled out: legacy `www.asx.com.au/asx/1/...` (retired, 404), Alpha Vantage
fundamentals (US only), paid vendors (EODHD A$/US$60/mo personal, FMP US$99,
Twelve Data ~US$229; none free for ASX). Licensing posture is the one already
accepted for prices and `key_metrics`: unofficial endpoints, we publish derived
growth figures, not statements. The clean upgrade path later is EODHD with a
commercial licence or the existing `report-extractor` reading Appendix 4D/4E
PDFs, and the fetcher interface exists so either can slot in.

**Filings (built 2026-09-27).** The report-extractor path is now wired, as a
separate mode rather than a Fetcher (it reads stored extractions, it does not
fetch per code): `financial-report-extractor` (Gemini over 4D/4E PDFs) ->
`financial_report_extractions.metrics` -> `shorted picks -mode filings` ->
`stock_fundamentals` (`half` rows, and `annual` rows Yahoo lags on). The
extractor's run was raised from 10 reports on Sundays to 40 on Wednesdays and
Sundays 14:00 UTC (`module.report_extractor` in prod `main.tf`), because it is
the only path to half-year totals. Its selection now targets statutory
filings in the Go port (`reportextract/select.go`: presentations, webinars,
notices, AGM results, dividend admin and quarterlies excluded; Appendix 4D/4E
and results releases sort first), BUT prod still runs the Python extractor
image, whose `--top-shorted-first` order spends the 40 slots until the Go port
is cut over (`services/jobs/README.md` "Phase 3 port notes": a
`modules/shorted-job` pair running `report-extract concurrent -recent 2 -limit
<reports_limit> -workers 2 -max-pages 6 -top-shorted-first` with the same
Gemini env, `scheduler_paused = true` on the old module, after the PDF-text
parity run). Not done here.

Re-pull trigger: `asx_announcements` headlines classified by the regexes in
`scripts/take-writer/src/results-watch.ts` (`classifyResultsFiling`; never
`announcement_type`). A code with a 4D/4E in the last 14 days is pulled first
regardless of its `last_attempt_at`.

## 3. API layer (stream B)

### 3.1 Proto: `proto/shortedapi/shorts/v1alpha1/strategies.proto`

New domain file, `service StrategyService`, both rpcs `VISIBILITY_PUBLIC`, and
the SAME two rpcs added to the legacy `ShortedStocksService` in `shorts.proto`.

```protobuf
rpc ListStrategies (ListStrategiesRequest) returns (ListStrategiesResponse);
rpc GetStrategyPicks (GetStrategyPicksRequest) returns (GetStrategyPicksResponse);

message Strategy {
  string id = 1;                 // 'zanger-breakout'
  string name = 2;
  string author = 3;             // 'Dan Zanger'
  string tagline = 4;            // one sentence
  repeated string description_paragraphs = 5;   // 2-4 paragraphs, plain text
  repeated StrategyRule rules = 6;
  StrategyMetadata metadata = 7;
  repeated string caveats = 8;   // what our data cannot see
  repeated string sources = 9;   // attribution lines (Fortune 2000 profile etc.)
}
message StrategyRule {
  string id = 1;                 // 'growth', 'base', 'breakout', 'regime', 'rs', 'liquidity', 'short_interest'
  string title = 2;
  string rule_text = 3;          // the rule in the author's terms
  string evaluation = 4;         // exactly how we test it, with thresholds
  bool core = 5;                 // must pass for status TRIGGERED
  string data_source = 6;        // 'stock_fundamentals', 'stock_prices', 'index_prices', 'asic_shorts'
}
message StrategyMetadata {
  string style = 1;              // 'momentum-breakout', 'trend-following'
  string holding_period = 2;     // 'weeks to months'
  string risk_posture = 3;       // 'cut on failed breakout (back inside base)'
  string universe = 4;           // 'ASX equities with >= A$250k daily turnover'
  string refresh_cadence = 5;    // 'daily after the price sweep'
  int32 rule_count = 6;
}
message MarketRegime {
  string index_code = 1; string as_of = 2; string regime = 3; // uptrend|neutral|downtrend
  double close = 4; double sma50 = 5; double sma200 = 6; double pct_off_52w_high = 7;
  string verdict = 8;            // strategy-specific sentence, e.g. 'Stand aside: XJO below its 200-day'
}
message RuleResult { string rule_id = 1; string status = 2; /* pass|fail|unknown */ string detail = 3; /* 'Revenue +41% YoY (H1 FY26 vs H1 FY25)' */ double value = 4; bool has_value = 5; }
message StrategyPick {
  int32 rank = 1; string stock_code = 2; string company_name = 3; string industry = 4;
  string status = 5;             // triggered|setup|watch
  double score = 6;              // 0-100
  repeated RuleResult rules = 7;
  // headline numbers for the table
  double close = 8; string as_of = 9; double pct_off_52w_high = 10; double volume_ratio_50d = 11;
  double base_depth_pct = 12; int32 base_length_days = 13; double pivot = 14; /* base_high, the invalidation level */
  double revenue_yoy_pct = 15; bool has_revenue_yoy = 16; double eps_yoy_pct = 17; bool has_eps_yoy = 18;
  double rs_3m_pct = 19; double short_pct = 20; double market_cap = 21; string logo_url = 22;
}
message GetStrategyPicksRequest { string strategy_id = 1; int32 limit = 2; /* default 20, max 100 */ int32 offset = 3; string status = 4; /* optional filter */ }
message GetStrategyPicksResponse { Strategy strategy = 1; MarketRegime regime = 2; repeated StrategyPick picks = 3; int32 total_count = 4; int32 universe_count = 5; /* rows evaluated */ int32 fundamentals_coverage_count = 6; /* rows with growth data */ string as_of = 7; }
message ListStrategiesRequest {}
message ListStrategiesResponse { repeated Strategy strategies = 1; MarketRegime regime = 2; }
```

Also on `StockService` (stock.proto) AND legacy `ShortedStocksService`:

```protobuf
rpc GetStockFundamentals (GetStockFundamentalsRequest) returns (GetStockFundamentalsResponse) { VISIBILITY_PUBLIC }
message GetStockFundamentalsRequest { string stock_code = 1; string period_type = 2; /* optional annual|half|quarter */ int32 limit = 3; /* default 12, max 40 */ }
message FundamentalsPeriod { string period_type = 1; string period_end = 2; int32 fiscal_year = 3; string currency = 4;
  double revenue = 5; bool has_revenue = 6; double net_income = 7; bool has_net_income = 8;
  double eps_basic = 9; bool has_eps_basic = 10; double eps_diluted = 11; bool has_eps_diluted = 12;
  double operating_cash_flow = 13; bool has_operating_cash_flow = 14; double shares_outstanding = 15; bool has_shares_outstanding = 16;
  string source = 17; string fetched_at = 18; }
message FundamentalsGrowth { string basis_period_type = 1; string latest_period_end = 2;
  double revenue_yoy_pct = 3; bool has_revenue_yoy = 4; double revenue_yoy_prior_pct = 5; bool has_revenue_yoy_prior = 6;
  double eps_yoy_pct = 7; bool has_eps_yoy = 8; double eps_yoy_prior_pct = 9; bool has_eps_yoy_prior = 10;
  bool net_income_positive = 11; int32 periods_available = 12; }
message GetStockFundamentalsResponse { string stock_code = 1; repeated FundamentalsPeriod periods = 2; FundamentalsGrowth growth = 3; bool has_growth = 4; }
```

`has_*` flags because proto3 doubles cannot distinguish 0 from missing, and the
screener's "0 means unknown" defect is exactly what this feature must not repeat.

`cd proto && buf generate` and commit ALL outputs (web/src/gen, sdks/java churn,
api/schema, web/public/openapi.*).

### 3.2 Go

- `services/shorts/internal/strategies/` (new package, no DB): `Registry()`
  returning the four `Strategy` definitions (all prose lives HERE, once), the
  evaluator `Evaluate(strategy, candidates []Candidate, regime Regime) []Pick`
  with one function per rule, table-driven tests covering pass/fail/unknown for
  every rule and the status ladder. Weights per strategy in one map, like
  `verdict.go`.
- Store: `store/shorts/postgres_strategies.go` with
  `ListStrategyCandidates(ctx) ([]Candidate, error)` (one query joining
  `mv_price_features` LEFT JOIN `mv_fundamentals_growth` LEFT JOIN
  `mv_screener_data` for short_pct / days_to_cover / market_cap / company_name /
  industry / logo_url; fall back to `"company-metadata"` for names when the
  screener row is absent since unshorted stocks are missing from that MV),
  `GetMarketRegime(ctx, indexCode)`, `GetStockFundamentals(ctx, code, periodType, limit)`,
  `GetFundamentalsGrowth(ctx, code)`. Same conventions as `postgres_screener.go`
  (contiguous `$n`, 10s timeout). Interfaces in `store.go`, `interfaces.go`,
  `adapters.go`; regenerate gomock.
- Handlers in `services/shorts/internal/services/shorts/strategies.go` and
  `fundamentals.go`; picks cached in the in-memory cache for 15 minutes keyed
  by strategy id (candidates are evaluated once per cache fill, then paged).
- Mount `StrategyService` in `serve.go` with the shared interceptors + CORS;
  add the rewrite in `web/next.config.mjs`.
- Missing MVs (dev without migrations) return an empty universe with
  `universe_count = 0`, never a 500.

## 4. Web (stream C)

- `web/src/@/lib/strategies/registry.ts`: serialisable, slug -> SEO only
  (`title`, `description`, `keywords`, `h1`, `related`). The prose comes from
  `ListStrategies` / `GetStrategyPicks`. `registry.test.ts` structural rules.
- `web/src/app/actions/getStrategyPicks.ts` + `getStrategies.ts`: the
  `getScanResults.ts` pattern (`unstable_cache` 1h, tags `strategy-picks`,
  `strategy-<id>`, `serverFetchOutsideNextCache`, `skipForBuild`, throw on a
  data-less result so it is a cache miss).
- `/picks` (hub, ISR 3600): regime banner, one card per strategy (name, author,
  tagline, counts by status, top 3 triggered codes with logos), link to each.
- `/picks/[strategy]` (ISR 3600, `generateStaticParams` from the registry,
  `bailOnEmptyRender`): strategy switcher (links, not tabs, so each is a URL),
  regime banner with the strategy verdict, ranked table (server-rendered; rule
  dots pass/fail/unknown with `title` text, pivot, growth, RS, volume ratio,
  short %), a status filter as a small client island reading `?status=` via
  `useSearchParams` under a real `<Suspense>`; then the strategy panel: rules
  (author's rule text + our evaluation + data source), metadata grid, caveats,
  sources, provenance line ("prices to <date>, fundamentals for N of M stocks,
  ASIC shorts to <date>, not financial advice").
- Design: DESIGN.md "Melbourne Terminal" rules; `pageTitle` / `eyebrow` / `lede`
  tokens; tabular numerals; red/green only for direction; one amber bloom max.
- Nav: `site-header.tsx` (non-primary, under More), `sitemap-sections.ts`,
  `robots.txt` allowlist. Bundle budget baseline entry for the new routes; import
  only `strategies_pb` / `stock_pb`, never `shorts_pb`.
- Tests: registry test, page render test (themes pattern), client-boundary test
  for the panel component.

## 5. MCP (stream D)

Three new public tools, domain `discovery` for the two strategy tools and
`stock` for fundamentals:

- `list_strategies` (no input) -> strategies with rule summaries + regime.
- `get_strategy_picks` (`strategy_id`, `limit` <= 25, `status`) -> picks with
  rule results, kept under the 16KB payload budget (trim `rules[].detail` to the
  failing/unknown ones plus pass ids if needed).
- `get_stock_fundamentals` (`code`, `period_type`, `limit` <= 12).

Follow the checklist in the MCP report: `datasource.go`, `fake_test.go`,
`toolCallFixtures`, `realisticSource`, `registry.go`, per-tool tests. The
tools/list budget (76KB) will be exceeded by ~9KB: FIRST trim redundant field
descriptions in the new tools, THEN raise the constant with a justifying comment
as was done 64->76. Update every tool-count mention (25 -> 28): CLAUDE.md,
`web/src/app/api/mcp/[transport]/route.ts`, `mcp-server-card/route.ts`,
`serve.go:224`, `web/public/llms.txt`, `content/coverage.md`,
`web/public/docs/mcp-markdown.md`. Add the strategies to the `market_wrap`
prompt only if the prompts/list budget allows.

Connector defects found while probing the live server (fix in this stream):
1. `screen_stocks` and `get_peer_comparison` emit `pe_ratio: 0`,
   `dividend_yield: 0`, `market_cap: 0`, `latest_price: 0` for unknown values (a
   model reads that as a P/E of zero). Use `omitempty` / pointer fields so
   unknown is absent, and say so in the description.
2. The session's attached connector is the ADMIN server (2 tools); the public
   server is what a stock-research client needs. Documentation only: note in
   `docs/mcp-admin.md` that the admin connector is not a superset.

## 6. Verification before push

- `cd services && GOWORK=off go build ./... && GOWORK=off go test ./shorts/... ./jobs/... ./pkg/...` (unit; no DB here).
- `node --test services/migrations/*.test.mjs`.
- `cd web && npx tsc --noEmit && npx jest <new tests> && npm run bundle:budget` if a build is feasible.
- `cd proto && buf lint && buf generate` with no diff after commit.

## 7. Prod rollout notes (for the operator, not CI)

1. Apply `000129` and `000130` by hand BEFORE merging the API
   (`task db:prod:apply FILE=… CONFIRM=prod`, session pooler 5432) — the deploy
   allowlist also replays them, but the API must not ship reading columns prod
   lacks.
2. First fundamentals run is on demand, not scheduled: through the admin MCP connector (`run_picks_job {mode: "fundamentals"}` a few times, cap 400/run, then `filings`, then `refresh`; `docs/mcp-admin.md`) or `gcloud run jobs execute shorted-picks --args="picks,-mode,fundamentals"` a few times, then `--args="picks,-mode,filings,-dry-run"` (read the `skipped={...}` reasons), `--args="picks,-mode,filings"`, then `--args="picks,-mode,refresh"`. After that the daily 15:00 UTC `-mode all` keeps all three current.
3. Revalidate `/picks` and `/picks/*` after the first refresh.

## 8. Follow-ups found during implementation

- DONE: `StrategyPick` now carries `has_rs_3m_pct`, `has_short_pct`,
  `has_market_cap` and `has_close` (fields 23-26). The handler sets them from
  the evaluator's `Candidate` pointers (`has_close` is `close > 0`, since
  `Candidate.Close` is not nullable and `mv_price_features` only admits a
  positive close). The web mapper (`web/src/@/lib/strategies/map.ts`) and the
  MCP `get_strategy_picks` projection read the flags, so a measured zero (RS
  exactly in line with XJO, an ASIC row reporting no position) survives and an
  unflagged value is absent. The pivot / base fields still have no flag and
  still read 0 as unknown.
- OPEN: `mv_price_features` bounds a base at the 40-session window; a longer
  flat base reads as 40. Widen the window if a strategy needs longer bases.
- DONE: `/shorts/[code]` renders a fundamentals block on the Financials tab
  (`web/src/@/components/stocks/fundamentals-block.tsx`, fed by
  `web/src/app/actions/getStockFundamentals.ts`, `stock_pb` only): the last
  four annual periods (revenue, NPAT, diluted EPS, operating cash flow) in the
  reporting currency, a growth line (revenue YoY, EPS YoY with its basis,
  "prior loss, now profit" on a turnaround) and a provenance line. It renders
  nothing for a stock without coverage.
- DONE: `shorted-picks` is in `local.admin_runnable_jobs` and has a jobmonitor
  catalog entry (`services/shorts/internal/jobmonitor/catalog.go`, "Market
  data"). "Run now" executes the deployed `-mode refresh`.
- DONE (2026-09-27): every mode is runnable on demand from an agent. The admin
  MCP server (`/mcp/admin`) gained `run_picks_job {mode}` / `picks_job_status`
  under a new `jobs:run` scope, backed by `jobmonitor.RunPicks` (argv
  `picks -mode <mode>` built from the closed enum, already-running guard) and a
  `run.developer` grant on that one job (`shorts_api_picks_overrides`). Admin
  scopes are now checked per tool, so the existing publish-only connector keeps
  working and is told to reconnect for the new scope.
- OPEN (operational): no environment has run the fundamentals job yet, so
  `fundamentals_coverage_count` starts at 0 and the Zanger / CAN SLIM growth
  rules read unknown until the first sweeps complete (plan §7).
- DONE (data layer, 2026-09-27): filings -> half-year growth. `shorted picks
  -mode filings` (§2.6), `mv_fundamentals_growth` half columns and the
  half-preferred basis (§2.2), the daily 15:00 UTC schedule now runs `-mode
  all`, the report-extractor runs 40 reports twice weekly, and its Go port
  targets statutory filings first (§2.7). Verified on a scratch Postgres 16:
  000117 + 000129 applied (and replayed), the view's half columns and basis
  switch checked against eight synthetic companies (fresher half, TTM on the
  same date, loss / zero priors, mixed currencies, older half, filing-only,
  basic vs diluted, an 18-month gap), the conflict policy exercised by
  `TestFilingUpsertPolicyAgainstPostgres`, and the real binary run over
  synthetic extraction rows (it caught a balance-date bug: 31 December + 6
  months via AddDate is 1 July).
- OPEN (enablement, manual): the first `gcloud run jobs execute shorted-picks
  --args="picks,-mode,filings,-dry-run"` against prod, reading the logged
  `skipped={...}` reasons before the first real run; until then the half
  columns are NULL and every basis is ttm/annual as before. Half rows only
  accumulate as the extractor processes 4D/4Es, and in prod that is still the
  Python selection (above) until the Go cut-over.
- OPEN (API, not done here, `services/shorts` is another stream): the API's
  labels assume revenue growth is annual and EPS growth is ttm/annual.
  `strategies/rules.go` `annualLabel` must read the new
  `revenue_basis_period_type` (say "H1 to 31 Dec 2025 vs a year earlier" when
  it is `half`, using `half_latest_period_end`), `epsLabel` needs a `"half"`
  case (it returns "" today), `postgres_strategies.go` `growthColumns` /
  `Growth` need the five new columns if the UI or MCP are to show them, and
  the MCP `basis_period_type` description ("ttm or annual") gains `half`.
  On the web, `fundamentals-block.tsx` hard-codes revenue as "YoY (annual)"
  and `basisLabel` passes `half` through raw. Until then a half-basis figure
  is correct but labelled with the FY end.
