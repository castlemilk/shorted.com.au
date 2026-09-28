# Stock picker: strategy-driven picks over fundamentals + price structure

Status: design fixed 2026-09-27, implemented on `claude/upbeat-feynman-d7i92k`
(all four streams landed the same day; §8 lists the follow-ups). This document is the contract between the
four implementation streams; column names, proto names and strategy ids here
are binding. Update it when something changes.

**Extended 2026-09-28 by `docs/plans/fundamentals-coverage.md` (v2)**, which is
binding for everything it covers and supersedes this document where they
differ: the full income statement, balance sheet and cash flow (migration
000132), per-field provenance, budget-driven collection, fail-closed parsed
filings, `mv_fundamentals_quality`, valuation, the fifth strategy
(`quality-compounders`), `sort_by`, `GetStockStrategyFit`, and the stock page's
Financials tab. The sections below are kept as the original design and marked
where that plan replaced them.

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
| `quality-compounders` | Quality compounders | Shorted house strategy (added 2026-09-28, fundamentals-coverage §5.4) | core: ROE >= 15%, net margin >= 10%, cash conversion (FCF > 0 and >= 0.8x NPAT), leverage (net cash, or net debt / EBITDA <= 2.5), liquidity; trigger: close above the 200-day average; non-core: revenue not shrinking. No regime gate. Banks, insurers and other financials read unknown on cash conversion and leverage (not meaningful), so they rank watch at most |

Every rule returns one of `pass`, `fail`, `unknown`. Unknown means the data is
missing (no fundamentals for the stock yet, not enough price history) or, for
the quality ratios, not meaningful for the company (a bank's leverage). Unknown
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

**Widened by migration 000132** (fundamentals-coverage §2): 21 more statement
lines (gross profit, operating income, EBITDA, normalised EBITDA, EBIT,
interest expense, pretax income, tax, net interest income, capex, dividends
paid, buybacks, total assets / liabilities / equity, cash, total debt, lease
obligations, net debt, current assets / liabilities; outflows negative),
`field_sources` (the fields NOT from the row's `source`), `source_document_url`
/ `_date`, `period_type = 'quarter'` redefined as a balance snapshot, and on
`stock_fundamentals_sync`: `last_outcome`, `consecutive_empty`, `median_k`,
`fx_converted`, `native_currency`.

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

**Rebuilt once by migration 000132** (fundamentals-coverage §2.6; a
catalog-guarded drop, then the new definition): every column above keeps its
name, type, position and meaning, and four are appended: `revenue_basis_source`
and `eps_basis_source` (`'vendor'` | `'filing'`: `'filing'` when either row of
the pair is a filing row or the field used is filing-filled),
`revenue_latest_period_end` and `revenue_prior_period_end`. Each lateral now
filters on the field it reads, so a balance-only or EPS-only row can never
blank a growth figure; `quarter` rows are never read. When the latest TTM
revenue point is newer than the latest annual one, revenue growth uses it
against the point 12 months earlier (`revenue_basis_period_type = 'ttm'`); the
half basis still wins when the half is newest.

**New `mv_fundamentals_quality`** (000132, fundamentals-coverage §2.7): one row
per stock of margins, ROE / ROA, FCF conversion, net debt (excl. leases),
leverage, current ratio, interest cover and cash payout, each on ONE flow row
(the latest TTM with revenue and net income if newer than the latest such
annual, else that annual) and ONE balance row of the same currency dated on it
or up to 6 months before it. It reads `stock_fundamentals` only. The API
decides which ratios are not meaningful for financials
(`strategies/fundamentals_quality.go`).

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
continue). Called by the new job after the sweep. Migration 000132 re-issues it
with four views, in this order: `mv_market_regime`, `mv_fundamentals_growth`,
`mv_fundamentals_quality`, `mv_price_features`.

Both migrations are REPLAY-SAFE (`IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
no row rewrites) and go into the deploy allowlist in
`.github/workflows/terraform-deploy.yml` AFTER `000095`. 000132 follows 000131
in the same step, on the session pooler (`run_psql_session`), as two
catalog-guarded transactions. Down migrations drop
what they create. Each gets a `services/migrations/<name>.test.mjs` asserting
replay safety and the guarded refresh, mirroring `mv_refresh_hardening.test.mjs`.

### 2.6 Job: `shorted picks` (services/jobs/internal/jobs/picks)

Modes (as extended by fundamentals-coverage §3-4; the operating detail lives
in `services/jobs/README.md` "picks"):
- `-mode fundamentals`: the universe is codes in `stock_prices` with a price in
  the last 90 days plus everything in `mv_screener_data`. ONE Yahoo GET per code
  asks for the full statements (annual and trailing income statement and cash
  flow, annual and quarterly balance sheet, shares); sanity gates null bad
  values (currency conflicts, FX-converted statements, identity outliers
  against the code's median k, scale breaks, sign violations); Markit key
  statistics is the per-field fallback. Pace via `pkg/stealthhttp` at the
  price sweep's 4s. **Budget-driven, no count cap** (the original 400-code cap
  is gone): codes are taken in priority order (due filers; never attempted by
  market cap, with sync rows written before 000132, which are never skipped;
  last outcome failed; successes older than 14 days and repeat empties older
  than 45) until `PICKS_FUNDAMENTALS_BUDGET_MIN` (170 minutes)
  elapses, and the rest carries to the next night. Breakers: 25 consecutive
  failures, more than 30% of the last 100 Yahoo requests failed, Markit off
  after 10 consecutive failures; a Cloud Run task retry gets 20 minutes.
  Every attempt is recorded in `stock_fundamentals_sync`. Exit 0 if >= 50% of
  attempted codes loaded or answered empty, exit 10 (DEGRADED, economy's
  convention) otherwise.
- `-mode filings`: parse `financial_report_extractions.metrics` (revenue, net
  profit, EPS from the report-extractor's reading of statutory results
  documents) into typed `half` / `annual` rows, source `asx-filing-extraction`.
  DB-only. Every value passes the `services/pkg/extractiontrust` funnel
  (grounded, not a few-shot echo, a statutory results document) and nine gates
  (document, grounding, few-shot, own period, statutory, vendor context,
  currency, magnitude, TTM-EPS identity); the June and AUD defaults are gone
  (no vendor context, no filing row). **Fail-closed deterministic rebuild** in
  ONE transaction: filing rows and filing-filled vendor fields the run no
  longer produces are removed, the rest upserted. Exit 10 = REFUSED (a read
  errored or zero extractions were read: nothing written); exit 1 = the
  transaction rolled back. The value-reading rules and the period parser are
  pinned by `filings_period_test.go`, `filings_ingest_test.go` and
  `filings_regression_test.go` (the five echo documents, CBA's comparatives,
  EDV's channel sales, BHP's "Profit from operations", LFT's foreign document,
  DRO's December year end).
  **Conflict policy** (fundamentals-coverage §2.2): a filing FILLS a NULL
  vendor field or REPLACES a field already marked `field_sources =
  'asx-filing-extraction'`, in the same currency, recording the marker and the
  document; a vendor's own value is never touched. A stored filing row is
  replaced; periods the vendor lacks (every half) are inserted whole. When the
  vendor later publishes a period a filing wrote first, it takes the row over
  only when it supplies revenue or net income, and every value it keeps from
  the filing row stays marked.
- `-mode refresh`: `SET LOCAL statement_timeout = 0; SET LOCAL
  client_min_messages = notice; SELECT refresh_strategy_views()`, failing on a
  skipped view or on a picker view the live function body never names;
  after a successful refresh it waits 16 minutes (the API's strategy cache) and
  revalidates the web tags `strategy-picks` (and `fundamentals` when this
  execution changed rows).
- `-mode all`: fundamentals, then filings, then refresh (each step runs even
  after an earlier one degraded; the worst verdict decides the exit code).
- `-dry-run` honoured (fetch/read + parse + log, write nothing, take no lease).
- `fundamentals`, `filings` and `all` hold the `picks_run_lease` row, so two
  executions never write at once; a run that finds it held exits 0.

Source and endpoint: see §2.7. Terraform: `module "shorted_job_picks"` on the
`shorted-job` module, `name = "shorted-picks"`, primary schedule
`30 13 * * 1-5` UTC with `args = ["picks", "-mode", "refresh"]` (after the
sweep), plus one extra schedule `0 15 * * *` UTC with `args_override =
["picks", "-mode", "all"]` (fundamentals, then filings, then the refresh, so
each pull reaches the views the same night; was `-mode fundamentals` until
2026-09-27). `timeout_seconds = 12600`, `max_retries = 1`, env
`PICKS_FUNDAMENTALS_BUDGET_MIN = "170"` and `REVALIDATION_URL`, `secret_env =
{ DATABASE_URL, REVALIDATION_SECRET }`.
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
2,300-code pass is ~2.6h; the nightly run is budget-driven at 170 minutes,
fundamentals-coverage §3.7). Since 000132 the same single GET also asks for the
rest of the income statement and cash flow (annual and trailing), the balance
sheet (annual and quarterly) and the direct-method operating cash flow
(fundamentals-coverage §3.1). Quarterly balance-sheet points, when Yahoo has
them, are stored as `quarter` balance snapshots; the quarterly income and
cash-flow series are still not asked.

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

**Filings (built 2026-09-27, made fail-closed 2026-09-28).** The
report-extractor path is wired as a separate mode rather than a Fetcher (it
reads stored extractions, it does not fetch per code):
`financial-report-extractor` (Gemini over statutory results PDFs) ->
`financial_report_extractions.metrics` + `document_meta` -> `shorted picks
-mode filings` -> `stock_fundamentals` (`half` rows, and `annual` rows the
vendor lags on). It is the only path to half-year totals. The extractor in prod
is the Python image (`services/report-extractor`, `module "report_extractor"`),
reworked by fundamentals-coverage §6.1-6.2: daily at 14:00 UTC, 120 reports
(`--recent 2 --limit 120 --workers 4 --max-pages 8 --budget-min 90`, 7200 s, no
retries; it was 40 on Wednesdays and Sundays, and 10 on Sundays before that);
statutory results documents only (the `extractiontrust.IsResultsDocument`
rules ported to Python: no presentations, Form 20-F, Pillar 3, webcasts or
transcripts), ONE per company per run, filed within 45 days first (newest
first), then companies with no metric-bearing extraction by market cap, then
the rest; extractions langextract cannot align to the document, or whose
value's digits are not in the aligned span, are dropped; the few-shot example
is a synthetic "Quokka Minerals Limited" H1 FY2031 document that no real filing
can echo; thinking is off and every run logs its Gemini token totals;
`document_meta` (currency, units, entity, ABN, period end and type, report
kind) comes from deterministic regexes over the text. The Go port
(`reportextract`) is not deployed and is parity-only (the few-shot example,
grounding, provenance stripping).

Re-pull trigger: `asx_announcements` headlines classified by the regexes in
`scripts/take-writer/src/results-watch.ts` (`classifyResultsFiling`; never
`announcement_type`). A code with a 4D/4E in the last 14 days is pulled first
regardless of its `last_attempt_at` (fundamentals-coverage §3.7: an Appendix
4D/4E or period-results headline, not an annual report, that the code has not
had a successful pull since, plus one follow-up 7 days later).

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

**Added 2026-09-28** (fundamentals-coverage §5, binding; public on the domain
service and the legacy one alike): `rpc GetStockStrategyFit` on
`StrategyService` (per strategy: status `triggered` | `setup` | `watch` |
`none`, score, rank of total, rule results; `in_universe`);
`GetStrategyPicksRequest.sort_by` (`score` default, `revenue_yoy`, `eps_yoy`,
`roe`, `net_margin`, `fcf_margin`, `pe` ascending, `market_cap`; unknowns last;
`rank` stays the evaluator's) and `require_fundamentals`;
`GetStrategyPicksResponse.fundamentals_rows_count`; `StrategyPick.fundamentals`
(`PickFundamentals`: bases, period ends, basis sources, net margin, ROE, FCF
margin, net debt / EBITDA, P/E, `not_meaningful`); on `FundamentalsPeriod` the
21 statement lines with `has_*`, `field_sources`, `source_document_url` /
`_date`; on `FundamentalsGrowth` the basis sources, `fetched_at` and the
revenue pair's period ends; and on `GetStockFundamentalsResponse` the new
`FundamentalsQuality` (ratios, `is_financial`, `not_meaningful`, market cap,
P/E, P/B, `valuation_note`), `FundamentalsCoverage` (`covered` | `empty` |
`pending` | `failed`) and `LatestFilingSummary`.

`cd proto && buf generate` and commit ALL outputs (web/src/gen, sdks/java churn,
api/schema, web/public/openapi.*).

### 3.2 Go

- `services/shorts/internal/strategies/` (new package, no DB): `Registry()`
  returning the `Strategy` definitions (four at launch, five since
  `quality-compounders`; all prose lives HERE, once), the
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
  `universe_count = 0`, never a 500. Since 000132 the appended growth columns
  and the quality view are read by one separate query (`fundamentalsExtras`),
  and a schema without them (42P01 / 42703) degrades to nil quality, provenance
  and coverage, never a 500.
- Valuation (`strategies/valuation.go`, one function for the page, the picks
  and sorting): market cap = latest close x the newest vendor share count
  within 12 months, only for a one-ordinary-share listing (`median_k` in
  [0.8, 1.25], or without one every computable k in that band; `listed-unit`
  only on positive evidence, otherwise `no-shares` and the picker falls back
  to the screener market cap); P/E and P/B only for AUD statements, and never
  for an `fx_converted` code; `valuation_note` says why a value is absent.

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

**Added 2026-09-28** (fundamentals-coverage §7): the picker's growth cells show
their basis (`TTM` / `FY` / `HY`) and a filing marker; a native `<details>` in
the Stock cell lists the held ratios (`n/m` for a financial's not-meaningful
ones, `n/a` when not held), basis, period end, source and a nofollow "Full
financials" link (`/shorts/<code>?tab=financials`); `?sort=` is served by the
`picks-sorted-view.tsx` client island (it POSTs `{strategyId, sortBy, status,
limit: 100}` through the existing rewrite and keeps the server rows, with
"Sorting is unavailable right now.", on a failure or a 10 s timeout); the
coverage line reads "fundamentals for N of M stocks (growth figures for K)"
when `fundamentals_rows_count` is reported. The stock page's Financials tab
(Latest result, Key ratios, the statements island, the reports list, the tax
card last) replaces `fundamentals-block.tsx`, and the Overview gains a Strategy
fit card and a crawlable fundamentals summary.

## 5. MCP (stream D)

Three new public tools, domain `discovery` for the two strategy tools and
`stock` for fundamentals:

- `list_strategies` (no input) -> strategies with rule summaries + regime.
- `get_strategy_picks` (`strategy_id`, `limit` <= 25, `status`) -> picks with
  rule results, kept under the 16KB payload budget (trim `rules[].detail` to the
  failing/unknown ones plus pass ids if needed).
- `get_stock_fundamentals` (`code`, `period_type`, `limit` <= 12; 24 since
  fundamentals-coverage §8, which also adds `quality`, `coverage` and four
  statement lines per period, and `sort_by` plus `fundamentals_rows_count` on
  `get_strategy_picks`; no new tool, still 28).

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

The launch steps (000129 and 000130 hand-applied before the API merged, then
repeated `-mode fundamentals` runs under a 400-code cap) are history. As of
fundamentals-coverage §9:

1. 000129, 000130 and 000132 are all in the terraform-deploy allowlist and
   replay-safe, so the deploy applies them before the image swap (000132 on
   the session pooler, two transactions under `lock_timeout = '15s'`). Do not
   merge while `financial-report-extractor` or a picks run is executing. If
   the step fails, hand-apply 000132 in a quiet window (`task db:prod:apply
   FILE=services/migrations/000132_extend_fundamentals.up.sql CONFIRM=prod`)
   and re-run the deploy, or revert; never remove its allowlist line (the
   jobs image the same deploy ships writes the new columns). The API and the
   job tolerate 000132 being absent.
2. Straight after the deploy: `run_picks_job {mode: "filings"}`, then `{mode:
   "refresh"}` (seconds, no Yahoo; `docs/mcp-admin.md`), or `gcloud run jobs
   execute shorted-picks --args="picks,-mode,filings"` (read the `gates={...}`
   and would-purge lines first with `-dry-run`), then `-mode,refresh`. The
   echo, comparative, segment, LFT and DRO rows go the same hour.
3. The nightly 15:00 UTC `-mode all` covers the universe within its 170-minute
   budget; any remainder, lowest priority first, carries to the next night. A
   manual full run starts before 12:20 UTC or after the scheduled run has
   finished (the lease makes an overlapping run exit 0).
4. Pages revalidate on their own 16 minutes after each successful refresh.
   Coverage is built when `fundamentals_rows_count` is near the codes the
   vendors publish statements for (about three quarters of `universe_count`).

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
  nothing for a stock without coverage. SUPERSEDED 2026-09-28: the block is
  deleted; the Financials tab is now Latest result, Key ratios, the statements
  island, the reports list and the tax card (fundamentals-coverage §7.1).
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
- SUPERSEDED (operational; coverage is now built by the budget-driven nightly
  run, §7): no environment had run the fundamentals job yet, so
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
  months via AddDate is 1 July). Since 2026-09-28 the extractor runs 120
  reports a day, statutory-first in the Python itself (§2.7), and the conflict
  policy test is `TestFilingRebuildAgainstPostgres` and its siblings.
- SUPERSEDED (enablement; `-mode filings` is now fail-closed and runs straight
  after the deploy, §2.6 and §7): the first `gcloud run jobs execute shorted-picks
  --args="picks,-mode,filings,-dry-run"` against prod, reading the logged
  `skipped={...}` reasons before the first real run; until then the half
  columns are NULL and every basis is ttm/annual as before. Half rows only
  accumulate as the extractor processes 4D/4Es, and in prod that is still the
  Python selection (above) until the Go cut-over.
- DONE (2026-09-28): `strategies/rules.go` `revenueLabel` / `epsLabel` handle
  `half` and `ttm`, the store reads the half and basis columns, the MCP basis
  descriptions include `half`, the web's `basisLabel` returns `TTM` / `FY` /
  `HY`, and `fundamentals-block.tsx` is gone. The original item: the API's
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
