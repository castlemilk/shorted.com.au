# Stock picker: strategy-driven picks over fundamentals + price structure

Status: design fixed 2026-09-27, implementation in flight on
`claude/upbeat-feynman-d7i92k`. This document is the contract between the
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
    period_type         VARCHAR(8)       NOT NULL,  -- 'annual' | 'half' | 'quarter'
    period_end          DATE             NOT NULL,
    fiscal_year         SMALLINT,                   -- FY the period belongs to (ASX FY ends 30 June)
    currency            VARCHAR(8)       NOT NULL DEFAULT 'AUD',
    revenue             DOUBLE PRECISION,           -- total revenue, whole currency units
    net_income          DOUBLE PRECISION,           -- NPAT
    eps_basic           DOUBLE PRECISION,
    eps_diluted         DOUBLE PRECISION,
    operating_cash_flow DOUBLE PRECISION,
    shares_outstanding  DOUBLE PRECISION,
    source              VARCHAR(32)      NOT NULL,  -- 'yahoo-timeseries' etc
    source_fetched_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT stock_fundamentals_pk PRIMARY KEY (stock_code, period_type, period_end),
    CONSTRAINT stock_fundamentals_period_type_check CHECK (period_type IN ('annual','half','quarter'))
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
rejected at the write funnel (same rule as `key_metrics_finite.go`). No LLM
extraction writes here.

### 2.2 `mv_fundamentals_growth` — same migration

One row per stock. Growth is computed against the SAME period type one year
earlier (annual vs prior annual; half vs the half ending ~12 months earlier),
never half vs annual. The row uses the most recent period of the type with the
most history for that stock, preferring `half` when both exist with >= 3 rows
(ASX reports semi-annually, and a half-year row is fresher than the annual).

```
stock_code, basis_period_type, latest_period_end,
revenue_latest, revenue_prior, revenue_yoy_pct,
revenue_yoy_prior_pct,            -- growth of the period before, for acceleration
eps_latest, eps_prior, eps_yoy_pct,
eps_yoy_prior_pct,
net_income_latest, net_income_positive (bool),
operating_cash_flow_latest,
periods_available (int), fetched_at
```

`*_yoy_pct` is NULL (not 0) when either side is missing or the prior is <= 0
(growth from a loss to a profit is reported via `net_income_positive` turning
true and `eps_yoy_pct` NULL, with the evaluator treating "prior loss, now
profit" as a pass for the EPS rule). Unique index on `stock_code`.

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

Prices are `DECIMAL(10,2)`; sub-cent stocks are noisy and are excluded by the
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
- `-mode refresh`: `SET LOCAL statement_timeout = 0; SELECT refresh_strategy_views()`.
- `-mode all`: fundamentals then refresh.
- `-dry-run` honoured (fetch + parse + log, write nothing).

Source and endpoint: see §2.7. Terraform: `module "shorted_job_picks"` on the
`shorted-job` module, `name = "shorted-picks"`, primary schedule
`30 13 * * 1-5` UTC with `args = ["picks", "-mode", "refresh"]` (after the
sweep), plus one extra schedule `0 15 * * *` UTC with `args_override =
["picks", "-mode", "fundamentals"]`. `secret_env = { DATABASE_URL }`.
Register in `cmd/shorted/main.go`, document in `services/jobs/README.md`.

### 2.7 Upstream fundamentals source

Filled from the data-source probe (scratchpad `fundamentals-sources.md`), see
§7 for the outcome. The job's fetcher is behind a small interface
(`Fetcher.Fundamentals(ctx, code) ([]PeriodRow, error)`) so the provider can be
swapped; the first provider is the one the probe validated.

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
message GetStockFundamentalsRequest { string stock_code = 1; string period_type = 2; /* optional annual|half|quarter */ int32 limit = 3; /* default 12 */ }
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
2. First fundamentals run is manual: `gcloud run jobs execute shorted-picks --args="picks,-mode,fundamentals"` a few times (cap 400/run) to reach coverage, then `--args="picks,-mode,refresh"`.
3. Revalidate `/picks` and `/picks/*` after the first refresh.
