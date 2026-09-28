# Fundamentals coverage: every ticker, parsed filings you can trust, visible everywhere

Status: design contract (binding for the implementation). Date: 2026-09-28.
Predecessor: `docs/plans/stock-picker.md` (the picker, `stock_fundamentals`,
migrations 000129/000130). This plan extends that data layer; it does not
replace it.

The ask: "extend the coverage of fundamentals, so we have parsed financial
reports, all data collected for stock tickers, and all of this made visible
within the platform across the stock detail page and picker".

## 0. What is wrong today (measured 2026-09-28, evidence in the PR)

1. **Throughput is capped by count, not by Yahoo.** `shorted picks` takes at
   most 400 codes a night at a 4 s pace (26 min), against a ~2,300-code
   universe. Prod already sustains a full 2,325-request Yahoo pass at 4 s from
   Cloud Run with 0 failures (the price sweep, 2 h 35 m). Selection makes it
   worse: any "Annual Report" headline counts as a filing, filers are re-pulled
   daily for 14 days, and never-attempted codes go alphabetically. The first
   night spent ~338 of 400 slots on recent filers and reached 14D..ABG; BHP,
   CSL, WES, FMG got nothing. Coverage: 142 of 2,146 growth figures.
2. **Parsed filings publish fabricated numbers.** Both report extractors keep
   extractions that never align to the document (langextract keeps them;
   `extract.py` throws the alignment away), so the prompt's own few-shot
   example (revenue $5,142m, NPAT $1,823m, EPS 94.2c, "H1 FY2025") is stored as
   real data for BHP, CBA, DRO, EDV and MSB and reaches the picker (EDV EPS
   growth -85.4% instead of about -17%). Comparatives mislabelled as the
   current period (CBA), segment/channel figures (EDV online sales as revenue,
   GYG/DMP network sales, FLT TTV), another company's report (LFT carrying
   Winsome Resources), "Profit from operations" as NPAT (BHP 19.5bn) and
   June-dated December filers (DRO) all pass. 104 of 124 filing codes have no
   vendor rows, so no cross-check ever runs; with vendor rows the bands
   (1/50-10x revenue, 5x EPS) are too loose to catch the echo.
3. **Only 7 statement lines are collected.** Yahoo returns the full income
   statement, balance sheet and cash-flow statement (about 4 annual periods,
   latest TTM, 1-4 balance snapshots) in the SAME single GET the job already
   makes; the job asks for 12 types. Operating cash flow is published for 0 of
   30 random ASX codes but equals FreeCashFlow - CapitalExpenditure exactly
   (8/8 BHP/JHX periods). Markit's fresher annual revenue/NPAT is merged only
   after Yahoo's latest annual row, so a Yahoo year with EPS only blocks it
   (MAQ). One mixed-currency series drops a whole row (XRO FY23/FY24).
4. **The stock page contradicts itself.** Six Financials cards, three
   per-period sources: raw LLM extraction tiles (echo values shown for CBA),
   `stock_fundamentals` (annual only, 4 lines), and a manual one-off
   `company-metadata.financial_statements` snapshot (FY25-latest, ~22% of
   codes, no currency, USD printed as `$`). "Key metrics" prefers that stale
   snapshot over the daily `key_metrics` (BHP A$220bn vs A$331bn on Peers).
   Nothing in the tab is in the SSR HTML.
5. **The picker shows two numbers.** Only revenue YoY and EPS YoY reach a pick,
   without basis, period, currency or source. The coverage line counts growth
   figures, not stocks with data. Loss-makers read "unknown" on EPS growth
   although the data decides "fail". Revenue growth ignores a fresher TTM.

## 1. Principles (unchanged from the picker, restated because they bind)

- Unknown is never zero and never a pass. Every nullable number carries a
  `has_*` flag on the wire; the web resolves it once in its mapper.
- Values stay in the company's REPORTING currency; ratios are computed only
  within one row and one currency. Price-based ratios need AUD statements
  (price is AUD) and read unknown otherwise.
- Withhold rather than guess: a filing value that cannot be grounded,
  cross-checked and dated is not written.
- Provenance travels with the data: per ROW (`source`) and per FIELD when a
  field came from somewhere else (`field_sources`).
- Prod does not run `migrate up`: 000132 is allowlisted, replay-safe, and the
  API tolerates it being absent.

## 2. Data model: migration 000132 (`000132_extend_fundamentals`)

One `BEGIN ... COMMIT` file with `SET LOCAL statement_timeout = 0;` and
`SET LOCAL lock_timeout = '60s';`. Allowlisted in
`.github/workflows/terraform-deploy.yml` AFTER the 000131 line, run with
`run_psql_session` (session pooler, like 000131). Replayed every deploy, so
every step is catalog-guarded and a no-op once applied.

### 2.1 New `stock_fundamentals` columns

Added inside ONE `DO` block that checks `information_schema.columns` per column
and runs `EXECUTE format('ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS %I %s', ...)`
only when absent (a bare `ADD COLUMN IF NOT EXISTS` queues for ACCESS EXCLUSIVE
on every replay). All `DOUBLE PRECISION` unless noted. Sign convention is
Yahoo's: outflows (capex, dividends paid, buybacks) are NEGATIVE.

| Column | Yahoo series (annual / trailing / quarterly*) | Notes |
|---|---|---|
| `gross_profit` | GrossProfit | |
| `operating_income` | OperatingIncome | absent for banks/insurers |
| `ebitda` | EBITDA | absent for banks/insurers |
| `ebit` | EBIT | |
| `interest_expense` | InterestExpense | positive expense |
| `pretax_income` | PretaxIncome | |
| `tax_provision` | TaxProvision | |
| `net_interest_income` | NetInterestIncome | banks |
| `capital_expenditure` | CapitalExpenditure | negative |
| `dividends_paid` | CashDividendsPaid | negative |
| `share_buybacks` | RepurchaseOfCapitalStock | negative |
| `total_assets` | TotalAssets | balance: annual + quarterly* only |
| `total_liabilities` | TotalLiabilitiesNetMinorityInterest | balance |
| `total_equity` | StockholdersEquity | balance |
| `cash_and_equivalents` | CashAndCashEquivalents | balance |
| `total_debt` | TotalDebt | balance |
| `net_debt` | NetDebt | balance; Yahoo omits it for net-cash companies |
| `current_assets` | CurrentAssets | balance |
| `current_liabilities` | CurrentLiabilities | balance |
| `field_sources` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | see 2.2 |

Existing columns keep their meaning. `operating_cash_flow` may now be derived
(2.2). `eps_basic` is newly requested on TTM rows (`trailingBasicEPS`).

A second finite/plausibility CHECK, `stock_fundamentals_finite_check_v2`,
covers the new numeric columns with the same form as 000129
(`x IS NULL OR x = 0 OR abs(x) BETWEEN 1e-12 AND 1e18`), added only when
`pg_constraint` lacks it (000123 pattern). `picks/rows.go storable` applies the
identical range to every new column before writing.

### 2.2 `field_sources`: per-field provenance

A JSONB object that records ONLY the exceptions: fields whose value did not
come from the row's `source`. Keys are column names; values are one of
`"markit-key-statistics"`, `"asx-filing-extraction"`, `"yahoo-timeseries"`,
`"derived:fcf-minus-capex"`, `"derived:ttm-eps-at-fye"`. Example: a Yahoo
annual row whose revenue was filled from Markit and whose OCF was derived is
`{"revenue":"markit-key-statistics","operating_cash_flow":"derived:fcf-minus-capex"}`.
Rules:
- A vendor write that supplies a field REMOVES that key (vendor wins).
- A filing write fills only NULL fields of a vendor row and records
  `"asx-filing-extraction"`; the row's `source` stays the vendor's.
- The deterministic filings rebuild (4.3) nulls any field recorded as
  `"asx-filing-extraction"` that the current run did not reproduce, so the
  cleanup can finally find filing values stored under a vendor label.

### 2.3 `stock_fundamentals_sync.last_outcome`

`VARCHAR(16)` (guarded add), one of `loaded`, `empty`, `failed`. `empty` means
every source answered with no data. Drives selection (3.6) and the stock-page
coverage status (5.4).

### 2.4 `financial_report_extractions.document_meta`

`JSONB` (guarded add, nullable). Written by the extractor (6.2), read by the
filings ingest (4). Document-level facts found deterministically in the raw
text, every key optional:
```json
{"currency":"USD","currency_evidence":"presented in US dollars",
 "units":"millions","units_evidence":"US$ Million",
 "entity":"BHP Group Limited","abn":"49 004 028 077",
 "period_end":"2026-06-30","period_type":"annual",
 "report_kind":"appendix_4e"}
```
`report_kind` is one of `appendix_4e`, `appendix_4d`, `annual_report`,
`half_year_report`, `results_announcement`, `other`. Kept out of `metrics` on
purpose: the weekly-report collector unmarshals `metrics` into
`map[string][]map[string]string`, and the web iterates its keys.

### 2.5 `mv_fundamentals_growth`: guarded rebuild with appended columns

Keep every existing column (name, type, position, meaning), then APPEND:
`revenue_basis_source` and `eps_basis_source` (`'vendor'` | `'filing'`, the
source of the rows the chosen basis used; `'vendor'` when any vendor row is in
the pair).

One behaviour change: revenue growth prefers a fresher TTM. When the latest TTM
revenue point is newer than the latest annual revenue, and a revenue point
(annual or TTM) 10-14 months earlier exists in the same currency with a value
above zero, `revenue_yoy_pct` is computed on that pair and
`revenue_basis_period_type = 'ttm'`. The half basis still wins when the half is
newer than both (000129 rule). `revenue_latest`/`revenue_prior` follow the
chosen basis.

Rebuild mechanics (proven on a scratch PG16 at prod scale, 0.2-3.3 s): a `DO`
block that, when `to_regclass('mv_fundamentals_growth')` exists AND
`pg_attribute` lacks `eps_basis_source`, runs
`EXECUTE format('DROP %s %I', 'MATERIALIZED VIEW', 'mv_fundamentals_growth')`
(000131 precedent; the migration-drift guard rejects the literal text). Then the
static `CREATE MATERIALIZED VIEW IF NOT EXISTS ... WITH DATA`, the unique index
`idx_mv_fundamentals_growth_stock_code`, and the COMMENT. 000129's replayed
`CREATE ... IF NOT EXISTS` is then a no-op. Copy `relacl` grants across the
rebuild as 000131 does. The guard key MUST be a column the new CREATE emits and
the old one lacks; the node test pins that.

### 2.6 New `mv_fundamentals_quality`

`CREATE MATERIALIZED VIEW IF NOT EXISTS` (new name, so no drop), reading
`stock_fundamentals` only (no price dependency, so a future rebuild of
`mv_price_features` is not blocked). One row per stock with any fundamentals
row. Unique index on `stock_code`.

Basis selection:
- **Flow basis** (income + cash flow): the latest TTM row if it has revenue and
  net income and is newer than the latest annual row with both; else the
  latest annual row with both. `basis_period_type` `'ttm'`|`'annual'`,
  `basis_period_end`, `currency` from that row. Every flow ratio uses that ONE
  row.
- **Balance basis**: the latest row (annual or half) with `total_equity`,
  `balance_period_end`, and the equity one year earlier (10-14 months, same
  currency) when present.

Columns: `stock_code, basis_period_type, basis_period_end, currency, source,
fetched_at, revenue, gross_profit, operating_income, ebitda, net_income,
operating_cash_flow, operating_cash_flow_derived (bool), free_cash_flow,
capital_expenditure, dividends_paid, interest_expense, shares_outstanding,
eps_ttm, balance_period_end, balance_currency, total_assets, total_liabilities,
total_equity, total_equity_prior, cash_and_equivalents, total_debt, net_debt,
current_assets, current_liabilities, gross_margin_pct, operating_margin_pct,
net_margin_pct, fcf_margin_pct, fcf_conversion, roe_pct, roa_pct,
net_debt_to_ebitda, net_debt_to_equity, current_ratio, interest_cover,
payout_ratio_pct, is_financial`.

Definitions (every division guarded `CASE WHEN denominator > 0`, ratios NULL
when an input is NULL or balance currency differs from flow currency):
- `net_debt` = stored `net_debt`, else `total_debt - cash_and_equivalents` when
  both exist (negative = net cash).
- margins = line / revenue (revenue > 0). `fcf_conversion` = FCF / net income
  (net income > 0). `roe_pct` = net income / average(equity, equity_prior)
  (or equity alone), NULL when equity <= 0. `roa_pct` likewise on assets.
- `net_debt_to_ebitda` NULL when EBITDA <= 0; `net_debt_to_equity` NULL when
  equity <= 0; `current_ratio` = current assets / current liabilities;
  `interest_cover` = EBIT / interest expense (interest > 0);
  `payout_ratio_pct` = -dividends_paid / net income (net income > 0).
- `is_financial` = operating_income AND ebitda are NULL on the flow row AND
  (`net_interest_income` is not NULL OR the company's industry matches banks /
  insurance / diversified financials). The API treats financials' leverage and
  cash-conversion as not meaningful (unknown), never as a pass.

### 2.7 `refresh_strategy_views()` re-issued

000132 re-issues the function (it must come after 000130 in the allowlist, whose
replay otherwise reverts it) with the same guard pattern and order
`mv_market_regime`, `mv_fundamentals_growth`, `mv_fundamentals_quality`,
`mv_price_features`, then `ALTER FUNCTION refresh_strategy_views() SET
statement_timeout TO '0'` (CREATE OR REPLACE resets proconfig).

### 2.8 Tests

- `services/migrations/fundamentals_extended.test.mjs` (node builtins only):
  single BEGIN/COMMIT with both timeouts; every column add inside the guarded
  DO block; the growth view's output columns equal the 000129 list as a prefix
  plus the two new ones; the guard key is emitted by the CREATE; every division
  guarded; unique indexes; the function's four guarded refreshes in order and
  the trailing ALTER FUNCTION; allowlist places 000132 after 000131.
- An env-gated real-Postgres Go test (`PICKS_TEST_DATABASE_URL`, refuses
  pooler/supabase DSNs) applying 000002, 000045, 000117, 000129, 000130, 000131,
  000132 on a fresh schema, then replaying 000129..000132 twice: the growth view
  OID is unchanged across replays, new columns exist, seeded rows yield the
  expected ratios and NULL guards (bank, net cash, negative equity, currency
  mismatch, TTM-fresher revenue basis).
- `scripts/tests/migration-drift.test.mjs` stays green.

## 3. Vendor ingestion (`services/jobs/internal/jobs/picks`)

### 3.1 One GET, the full statements

Still ONE Yahoo fundamentals-timeseries GET per code (probe: a 191-type GET
returns the same bytes as smaller grouped ones, 20-135 KB, 0.1-0.4 s). Request
the annual AND trailing flavours of every income-statement and cash-flow
series in 2.1 plus the existing ones, the annual AND quarterly flavours of the
balance-sheet series (trailing balance types do not exist), plus
`trailingBasicEPS`, `annualCashFlowsfromusedinOperatingActivitiesDirect` and
`trailingCashFlowsfromusedinOperatingActivitiesDirect`. Do NOT request
valuation series or quarterly income/cash-flow series (irregular, US filers
only).

### 3.2 Operating cash flow

Order: reported `OperatingCashFlow`; else the direct-method series; else
`FreeCashFlow - CapitalExpenditure` when both exist on the same period, with
`field_sources.operating_cash_flow = "derived:fcf-minus-capex"`. Never
overwrite a reported value with a derived one.

### 3.3 Balance snapshots

`quarterly*` balance points (period "3M") are stored only when their date is a
fiscal half-year end for that company (balance month from its annual rows):
as balance fields on the `half` row for that date (vendor source). A
`quarterly*` point dated at a fiscal year end fills NULL balance fields of the
annual row. Anything else is ignored.

### 3.4 Currency, per field

- Share counts and EPS ignore `currencyCode` for the row-level check (their
  tags are unreliable); monetary lines must agree with the row's currency.
- A conflicting monetary line nulls THAT field (logged, counted), never the
  whole row (XRO keeps FY23/FY24).
- FX-converted detection: a monetary raw value with a fractional part beyond
  `|frac| > 0.001` of a unit on a line that is normally integral marks the
  series converted; its fields are dropped and counted (`fx_converted`).

### 3.5 Sanity gates (count and log every rejection)

`total_assets <= 0` nulls the balance fields of that period; basic and diluted
EPS of opposite signs null both; TTM points dated earlier than the latest
annual end minus 18 months are dropped (stray 2020/2022 points).

### 3.6 Markit, per field

For each annual `period_end`, Markit revenue/net income fill a Yahoo row's
NULL revenue/net income when currencies match, recorded in `field_sources`.
Years Yahoo lacks are added as Markit rows (as today). When a TTM row's
`period_end` equals the company's fiscal year end and the annual row for that
year lacks EPS, copy TTM EPS into it with `"derived:ttm-eps-at-fye"`.

### 3.7 Selection and throughput

- **Budget-driven.** Default `PICKS_FUNDAMENTALS_MAX_CODES=0` (no count cap);
  `PICKS_FUNDAMENTALS_BUDGET_MIN=150`. Pace stays 4 s (the only rate with prod
  evidence). The 25-consecutive-failure breaker stays.
- **Order:** (1) due filers: codes with an `appendix_4de` or `period_results`
  headline (NOT `annual_report`) in the last 14 days whose `last_success_at` is
  before the filing, plus one follow-up re-pull 7+ days after the filing
  (Yahoo lags); (2) never attempted, by market cap descending (then 20-day
  dollar volume, then code); (3) last attempt failed (retry next run);
  (4) successes older than 14 days (was 6), oldest first.
- **Skips:** successes 14 days; `empty` outcomes 45 days after two
  consecutive empties; failures are NOT skipped.
- Record `last_outcome` on every attempt.
- **Revalidation:** after a successful refresh (`-mode refresh` or the refresh
  step of `-mode all`), best effort `platform.PingRevalidate` with tag
  `fundamentals` and paths `/picks` plus `/picks/<id>` for every strategy.
  Needs `REVALIDATION_SECRET` (and the URL env the shortdatasync job uses) on
  the picks job.

### 3.8 Terraform (`module "shorted_job_picks"`)

`timeout_seconds = 10800`, `max_retries = 1`, env
`PICKS_FUNDAMENTALS_BUDGET_MIN = "150"`, the revalidation secret/env. The
15:00 UTC `-mode all` stays; a full pass ends about 17:40 UTC, clear of the
10:00 price sweep and the 13:30 refresh.

## 4. Parsed filings (`-mode filings`), fail-closed

### 4.1 Gates, in order (each counted in the run summary)

1. **Document**: skip the extraction when `digest_confidence < 0.3` (NULL
   passes); when the title matches `pillar\s*3|basel|items impacting|20-F|
   presentation|webcast|transcript|investor day`; when
   `document_meta.entity` is present and does not match the code's company name
   (normalised token overlap); when `document_meta.report_kind = 'other'`.
2. **Grounding**: an entry carrying `alignment` that is empty or `unaligned`
   is skipped. Legacy entries without `alignment` go on to gate 3.
3. **Few-shot denylist**: normalised `source_text` (lowercased, whitespace
   collapsed) equal to any extraction text of the OLD or NEW prompt examples is
   skipped. One Go list, exported from `reportextract`, imported by picks;
   never deny by value (CBA's real 1H25 NPAT is also $5,142m).
4. **Own period**: the metric's resolved period must equal the document's own
   period: the latest half or annual end on or before `report_date` on the
   company's balance date, within 5 months of `report_date`
   (`document_meta.period_end` wins when present). Comparatives are taken only
   from the document that reports them first-hand.
5. **Statutory**: extend `nonStatutoryRe` with `profit from operations`,
   `operating profit`, `profit before tax`, `cash (npat|earnings)`,
   `total comprehensive income`, `underlying`, `pro forma`, `network sales`,
   `online sales`, `total transaction value|TTV`, `segment`, `division`.
6. **Vendor context required**: a code with no vendor annual row writes no
   filing row (counted `skipped_no_vendor`). Balance month and currency come
   from vendor rows; the June/AUD defaults are gone.
7. **Currency**: an explicit marker in the quote or `document_meta.currency`
   must equal the vendor currency.
8. **Magnitude** (vendor references in the same currency):
   half revenue in [0.25, 0.75] of vendor TTM revenue at the same end, else of
   the containing FY's vendor annual revenue, else in [0.15, 1.5] of the prior
   FY's; annual revenue in [0.7, 1.4] of the same-FY vendor annual when it
   exists (vendor wins anyway), else [0.5, 2.5] of the prior FY's;
   `|net income| <= 1.5 x revenue` (same row or vendor reference);
   EPS in [0.5, 2] of net income / vendor shares, and EPS is written only when
   that check can run.
9. **TTM-EPS identity** (halves, when all inputs exist): H1(this) - H1(prior)
   must be within 10% (floor 0.01) of TTM EPS at the half end minus prior FY
   EPS.

### 4.2 Units from the document

When `document_meta.units` is present, a bare table figure whose digits appear
in the quote is scaled by it (fixes the largest skip bucket: 4D/4E summary
tables state "US$ Million" once in a header). Without it the in-quote scale
rule stands.

### 4.3 Deterministic rebuild (the data repair)

`-mode filings` already re-reads every extraction. It now also, in one
transaction at the end: deletes `asx-filing-extraction` rows whose key the run
did not produce, nulls vendor-row fields recorded as filing-origin that the run
did not reproduce (and drops their `field_sources` keys), then upserts the
accepted rows under 2.2's rules. It refuses the purge (exit 10 DEGRADED) when
it read zero extractions, or when it accepted zero rows while more than 20
filing rows exist. The first run after deploy therefore removes the echo rows,
the mislabelled comparatives, the segment figures, LFT's Winsome rows and DRO's
misdated rows with no hand-run SQL.

### 4.4 Tests

Stop pinning the example text as valid input (`filings_ingest_test.go`). Add
regression fixtures for: the five echo documents, CBA's comparative mislabels,
EDV's channel sales, BHP "Profit from operations", LFT's foreign document,
DRO's December year end, a bare 4E table line with `document_meta.units`, and
the rebuild's purge and refusal paths.

## 5. API (`services/shorts`) and proto

Proto changes land first (one commit with `buf generate` outputs). Every new rpc
is on its domain service AND the legacy `ShortedStocksService`, same
visibility (`TestLegacyDomainServiceParity`).

### 5.1 `stock.proto`

`FundamentalsPeriod` (next free 21), pairs of `double x = N; bool has_x = N+1;`:
21 gross_profit, 23 operating_income, 25 ebitda, 27 ebit, 29 interest_expense,
31 pretax_income, 33 tax_provision, 35 capital_expenditure, 37 dividends_paid,
39 share_buybacks, 41 total_assets, 43 total_liabilities, 45 total_equity,
47 cash_and_equivalents, 49 total_debt, 51 net_debt, 53 current_assets,
55 current_liabilities, 57 net_interest_income; then
`map<string, string> field_sources = 59;`.

`FundamentalsGrowth` (next free 25): `string revenue_basis_source = 25;`
`string eps_basis_source = 26;` `string fetched_at = 27;`.

New `FundamentalsQuality`:
```
string basis_period_type = 1; string basis_period_end = 2; string currency = 3;
string balance_period_end = 4;
double gross_margin_pct = 5;  bool has_gross_margin_pct = 6;
double operating_margin_pct = 7; bool has_operating_margin_pct = 8;
double net_margin_pct = 9;    bool has_net_margin_pct = 10;
double fcf_margin_pct = 11;   bool has_fcf_margin_pct = 12;
double fcf_conversion = 13;   bool has_fcf_conversion = 14;
double roe_pct = 15;          bool has_roe_pct = 16;
double roa_pct = 17;          bool has_roa_pct = 18;
double net_debt = 19;         bool has_net_debt = 20;
double net_debt_to_ebitda = 21; bool has_net_debt_to_ebitda = 22;
double net_debt_to_equity = 23; bool has_net_debt_to_equity = 24;
double current_ratio = 25;    bool has_current_ratio = 26;
double interest_cover = 27;   bool has_interest_cover = 28;
double payout_ratio_pct = 29; bool has_payout_ratio_pct = 30;
bool is_financial = 31; string source = 32; bool operating_cash_flow_derived = 33;
double market_cap = 34;       bool has_market_cap = 35;   // AUD, latest close x shares
double pe_ratio = 36;         bool has_pe_ratio = 37;     // AUD reporters only: close / TTM EPS (> 0)
double price_to_book = 38;    bool has_price_to_book = 39; // AUD reporters only
string price_as_of = 40;
```
New `FundamentalsCoverage`: `string status = 1;` (`covered` | `empty` |
`pending` | `failed`), `string last_attempt_at = 2;`,
`string last_success_at = 3;`, `repeated string sources = 4;`.

`GetStockFundamentalsResponse`: `FundamentalsQuality quality = 5;`
`bool has_quality = 6;` `FundamentalsCoverage coverage = 7;`.
`GetStockFundamentalsRequest.limit` max stays 40.

### 5.2 `strategies.proto`

New `PickFundamentals`:
```
string revenue_basis_period_type = 1; string revenue_period_end = 2;
string eps_basis_period_type = 3;     string eps_period_end = 4;
string currency = 5; string fetched_at = 6;
string revenue_basis_source = 7; string eps_basis_source = 8;
double net_margin_pct = 9;  bool has_net_margin_pct = 10;
double roe_pct = 11;        bool has_roe_pct = 12;
double fcf_margin_pct = 13; bool has_fcf_margin_pct = 14;
double net_debt_to_ebitda = 15; bool has_net_debt_to_ebitda = 16;
double pe_ratio = 17;       bool has_pe_ratio = 18;
bool is_financial = 19; bool net_income_positive = 20;
```
`StrategyPick.fundamentals = 27` (absent when the stock has no fundamentals
row).

`GetStrategyPicksRequest`: `string sort_by = 5;` closed set `score` (default),
`revenue_yoy`, `eps_yoy`, `roe`, `net_margin`, `fcf_margin`, `pe` (ascending),
`market_cap`; everything else descending; unknown values always last; `rank`
stays the evaluator's rank. `bool require_fundamentals = 6;`.
`GetStrategyPicksResponse.fundamentals_rows_count = 8;` (candidates with any
fundamentals row; `fundamentals_coverage_count` keeps its growth meaning).

New rpc `GetStockStrategyFit(GetStockStrategyFitRequest) returns
(GetStockStrategyFitResponse)`, VISIBILITY_PUBLIC:
```
message GetStockStrategyFitRequest { string stock_code = 1; }
message StrategyFit {
  string strategy_id = 1; string strategy_name = 2; string status = 3;
  double score = 4; int32 rank = 5; int32 total_count = 6;
  repeated RuleResult rules = 7;
}
message GetStockStrategyFitResponse {
  string stock_code = 1; string as_of = 2; MarketRegime regime = 3;
  repeated StrategyFit fits = 4;   // every strategy; empty when the stock is outside the universe
  bool in_universe = 5;
}
```
Served from the cached per-strategy evaluations (no re-evaluation per call).

### 5.3 Store and handlers

- `GetStockFundamentals` reads every new column and `field_sources`, the
  quality row (a SEPARATE query; 42P01 on the view and 42703 on new columns
  degrade to "no quality" / old columns, never a 500), the sync row for
  `coverage`, and the latest close for valuation (market cap = close x
  shares_outstanding from the latest vendor row; P/E and P/B only when the
  flow/balance currency is AUD).
- The strategy universe reads `mv_fundamentals_quality` through a separate
  query as well (a missing view must not blank every strategy).
- `GetStockDetails`: `key_metrics` now wins over the stale
  `financial_statements.info` snapshot for market_cap, pe_ratio, eps,
  dividend_yield, beta and the 52-week fields
  (`mergeKeyMetricsToInfo`; update `key_metrics_merge_test.go`).

### 5.4 Evaluator changes (`services/shorts/internal/strategies`)

- **New strategy `quality-compounders`** ("Quality compounders", house
  strategy, `RegimeGates: false`). Core rules: `roe` (pass >= 15%; fail below,
  or equity <= 0), `net_margin` (pass >= 10%), `cash_conversion` (pass FCF > 0
  and FCF / net income >= 0.8; fail otherwise; unknown for financials),
  `leverage` (pass net debt / EBITDA <= 2.5 or net cash; fail above, or net
  debt > 0 with EBITDA <= 0; unknown for financials), `liquidity` (existing),
  and trigger rule `uptrend` (close above the 200-day average). Non-core
  `revenue_not_shrinking` (revenue YoY >= 0). Weights sum to 1. Prose states
  every threshold (the registry prose test), says banks and insurers can reach
  "setup" at most, and that ratios use the reporting currency.
- **EPS growth:** latest EPS <= 0 without a turnaround is `fail` ("still
  loss-making"), not `unknown`. "Accelerating" only when the prior growth is
  positive.
- `FundamentalsRows(cands)` counts candidates with any fundamentals row;
  `GetStrategyPicksResponse.fundamentals_rows_count` carries it; the coverage
  caveat is generalised per strategy (growth rules vs quality rules).
- Sorting per 5.2, over the cached ranked list.
- `StrategyPick.fundamentals` filled from `Candidate.Growth` +
  `Candidate.Quality` + valuation.

## 6. Report extraction (the parser itself)

### 6.1 Prod (Python, `services/report-extractor`)

- **Grounding.** Keep langextract's alignment: drop extractions with no
  `char_interval`; for numeric classes also require the value's digits inside
  the aligned span of the document text. Store, per metric entry, the STRING
  attributes `alignment` (e.g. `match_exact`, `match_fuzzy`, `match_lesser`),
  `char_start`, `char_end`. Existing consumers read attributes as strings.
- **Synthetic few-shot.** Replace the example with an obviously fictional
  document ("Quokka Minerals Limited", period "H1 FY2031", values that cannot
  collide with a real filing's own period). Keep the Go port byte-identical.
- **`document_meta`.** Deterministic regexes over the raw text for currency
  ("presented in US dollars", "US$m", "A$'000"), units, entity + ABN, period
  end, report kind; written to the new column (checked for existence once at
  start, omitted when absent).
- **Targeting.** Statutory first: from `company-metadata.financial_reports`,
  keep titles that look like Appendix 4D/4E, half-year/annual reports,
  preliminary final or results announcements; drop presentations, Form 20-F,
  Pillar 3, webcasts and transcripts. Order: report_date within 45 days (newest
  first), then companies with no metric-bearing extraction by market cap, then
  the rest by market cap. One document per company per run; drop
  `--top-shorted-first`.
- **Pages / thinking / logging.** `--max-pages 8`; the model's thinking budget
  capped (0 or the lowest supported) for extraction calls; per-run token usage
  logged.

### 6.2 Throughput (Terraform `module.report_extractor`)

`reports_limit = 120`, schedule daily `0 14 * * *`, workers 4 (and
`GEMINI_MAX_RUN_WORKERS` / `GEMINI_MAX_RUN_ITEMS` in step), max pages 8. About
840 documents a week clears the ~2,146-company backlog in about three weeks and
then keeps up with ~83 new statutory filings a week, at roughly US$0.01-0.06 per
report. `terraform/modules/report-extractor/cost-guardrails.test.mjs` is updated
deliberately, with this justification in the file.

### 6.3 Go port (`services/jobs/internal/jobs/reportextract`)

Not deployed (its PDF engine splits digits). Keep parity: same synthetic
example, drop unaligned extractions, export the denylist texts (old + new) for
picks (4.1 gate 3).

## 7. Web

### 7.1 Stock page Financials tab (`/shorts/[stockCode]`)

One typed, currency-aware source for every per-period number:
`getStockFundamentals.ts` requests every period type (limit 40), maps every
field including `source`, `fetchedAt`, `fieldSources`, quality and coverage;
cache key bumped (`v3`), tags gain `fundamentals`.

Cards, in order (a `financials-tab.tsx` composition, props-only server cards
except the named islands):
1. **Latest result**: the newest filed period (half or annual) with revenue,
   NPAT and EPS (basic when diluted is absent) vs the prior corresponding
   period, source and as-at per figure, a link to the filing when the period
   came from one, and the extraction digest prose only when
   `digest_confidence >= 0.6` and the report is a results document. The raw
   extraction metric tiles are gone.
2. **Key ratios**: margins, ROE, ROA, FCF conversion, net debt (or net cash),
   net debt / EBITDA, current ratio, interest cover, payout ratio, market cap,
   P/E, P/B; basis and as-at; financials' not-meaningful ratios read
   "n/a for banks and insurers"; never `$` on non-AUD values.
3. **Financial statements** (client island, props-only, no `~/gen`): Income |
   Balance sheet | Cash flow tabs, Annual | Half | TTM toggle, up to 4 columns,
   reporting currency stated once, `n/a` for missing, per-column source and
   as-at, a marker on derived and filing-sourced cells (`fieldSources`).
   Replaces the JSONB-driven `FinancialStatementsSection`, which is removed
   from the page.
4. **Strategy fit**: pass/fail/unknown per strategy for this stock from
   `GetStockStrategyFit`, linking to `/picks/<id>`; hidden when the stock is
   outside the universe.
5. Company tax card and the reports list (sorted newest first, future-dated
   rows dropped, design-token pills, the Latest result's filing marked).
6. **Empty state** when coverage is not `covered`: "Fundamentals not yet
   collected for <code>" with the last attempt date, or "No published financial
   statements for <code>" for `empty`.

Plus: a crawlable one-paragraph fundamentals summary rendered server-side on
the Overview (omitted, never guessed, without coverage); highlights cache
fixed (errors not cached, tagged); the em dash fixed in the financial cards
(`n/a`), and their tests; a transitive client-boundary test for
`web/src/@/components/stocks/**`; shared formatters in
`web/src/@/lib/fundamentals/format.ts` used by the page and the picker.
DESIGN.md's currency rule amended: compact amounts in the reporting currency,
`$` only for AUD.

### 7.2 Picker (`/picks`, `/picks/[strategy]`)

- `PickRow.fundamentals` (nullable, mapped once from `PickFundamentals`). Growth
  cells show the basis (`TTM`, `FY`, `H1`) and a filing marker; header
  tooltips on Rev YoY / EPS YoY; an expandable row detail with the key ratios,
  provenance and a "Full financials" link to `/shorts/<code>?tab=financials`.
  Every stock link from the picker goes to the Financials tab.
- A sort control (client island outside the props-only picks kit) that fetches
  `GetStrategyPicks` with `sort_by` through the existing rewrite with plain
  JSON `fetch` (no `~/gen`, no `@connectrpc` in the browser), mapped by a
  dependency-free JSON mapper in `web/src/@/lib/strategies/`. The ISR page stays
  static (no `searchParams`).
- Coverage copy: "fundamentals for N of M stocks (growth figures for K)",
  thousands separators.
- The `quality-compounders` strategy: web registry entry (SEO, related lists),
  `config/isr-pages.json`, tests. Cache keys bumped (`strategy-picks-*-v2`).

## 8. MCP (`services/shorts/internal/mcp`)

Budgets bind (per call 16,384 B; tools/list 90,112 B with ~3.7 KB spare).
- `get_stock_fundamentals`: add a `quality` object and `coverage` status; add
  four per-period fields (`operating_income`, `total_equity`, `net_debt`,
  `capital_expenditure`); lower the period ceiling from 40 to 24 so the
  ceiling-case payload still fits.
- `get_strategy_picks`: `sort_by` param; `quality-compounders` in the id list;
  per pick `roe_pct`, `net_margin_pct`, `fundamentals_source`; lower the pick
  ceiling if the budget test demands it.
- No new tool (the tools/list headroom cannot take one).
- Admin `run_picks_job`: the next-step text stops promising coverage "near the
  universe" (about a quarter of codes publish nothing); it points at
  `fundamentals_rows_count`.
- `content/coverage.md`, `web/public/llms*.txt`, `web/public/docs/mcp-markdown.md`
  updated.

## 9. Rollout

1. Merge: the deploy applies 000132 (session pooler) before the image swap; a
   migration failure blocks the API swap while Vercel still deploys, so the web
   tolerates absent fields.
2. The next 15:00 UTC `-mode all` covers the universe (about 2 h 35 m) and the
   filings rebuild purges the bad rows. An admin can start it early with
   `run_picks_job {mode: "all"}`.
3. The extractor's daily runs refill statutory extractions over about three
   weeks; each filings run picks them up.
4. Verify: `fundamentals_rows_count` near the vendor-publishable universe
   (~75% of codes), BHP/CSL/WES/FMG with full statements, no row with revenue
   5,142,000,000 and NPAT 1,823,000,000, EDV EPS growth near -17%.

## 10. Out of scope (recorded, not done)

- The frozen `key_metrics` writer (`SyncKeyMetrics` forks python on a
  scale-to-zero API; nothing written since ~2026-08-21). The precedence flip
  stops the stale snapshot winning; the writer needs its own fix.
- Dividend history and franking into `stock_fundamentals` (the Dividends tab
  has its own table; Markit carries franking).
- Analyst consensus (quoteSummary needs a crumb; licence and fragility
  questions).
- A dedicated `/shorts/[code]/financials` route.
- FX conversion for non-AUD valuation ratios (only RBA AUD/USD exists).

## 11. Workstreams and file ownership

| Stream | Owns |
|---|---|
| contract | `proto/**`, generated outputs (landed first) |
| data | `services/migrations/000132_*`, its node test, the real-PG Go test file, the allowlist, `services/migrations/PROD_APPLIED.md` |
| vendor | `picks/{yahoo,rows,markit,fetcher,fundamentals,selection,job,refresh,store}.go` + tests/testdata, `module "shorted_job_picks"`, README "picks" |
| filings | `picks/filings*.go` (+ new `filings_store.go` for filing SQL), `reportextract/**` |
| extractor | `services/report-extractor/**`, `terraform/modules/report-extractor/**`, `module "report_extractor"` |
| api | `services/shorts/internal/{strategies,store/shorts,services/shorts}/**` (not mcp) |
| mcp | `services/shorts/internal/mcp/**`, MCP docs |
| web-stock | stock page, `components/{stocks,company}`, `lib/fundamentals`, stock actions |
| web-picks | `app/picks`, `components/picks`, `lib/strategies`, picks actions, `config/isr-pages.json` |
