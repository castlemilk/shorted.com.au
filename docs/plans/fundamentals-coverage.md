# Fundamentals coverage: every ticker, parsed filings you can trust, visible everywhere

Status: design contract v2.1 (binding for the implementation). Date: 2026-09-28.
v1 was attacked by four critics (financial correctness, prod safety, product and
design rules, feasibility and budgets); 77 findings, every one resolved below.
v2.1 folds in the fixes from the adversarial review of the built code; the
revision log at the end lists what moved and why.
Predecessor: `docs/plans/stock-picker.md` (the picker, `stock_fundamentals`,
migrations 000129/000130). This plan extends that data layer.

The ask: "extend the coverage of fundamentals, so we have parsed financial
reports, all data collected for stock tickers, and all of this made visible
within the platform across the stock detail page and picker".

## 0. What is wrong today (measured 2026-09-28)

1. **Throughput is capped by count, not by Yahoo.** `shorted picks` takes at
   most 400 codes a night at a 4 s pace (26 min) against a ~2,300-code
   universe. The only prod pace evidence is the price sweep (query1 v8 chart,
   2,325 requests at 4 s, 0 failures); fundamentals-timeseries (query2) has
   seen ~400 a day, so the full pass is new load watched through
   `primary_failed`. Selection spends the cap on "Annual Report" filers
   re-pulled daily for 14 days, then goes alphabetically. First night: ~338 of
   400 slots on filers, then 14D..ABG. Growth figures: 142 of 2,146.
2. **Parsed filings publish fabricated numbers.** Both extractors keep
   extractions that never align to the document, so the prompt's own few-shot
   example (revenue $5,142m, NPAT $1,823m, EPS 94.2c, "H1 FY2025") is stored
   for BHP, CBA, DRO, EDV and MSB. It reaches the picker (EDV EPS growth
   -85.4%, real about -17%), the stock page's Results summary (CBA), the
   `/reports/weekly` highlight tiles and the weekly-report LLM prompt.
   Comparatives mislabelled as current (CBA), segment/channel figures (EDV,
   GYG, DMP, FLT), another company's report (LFT carrying Winsome), "Profit from
   operations" as NPAT (BHP 19.5bn) and June-dated December filers (DRO) pass
   too. 104 of 124 filing codes have no vendor rows, so no cross-check runs.
3. **Only 7 statement lines are collected.** Yahoo returns the full income
   statement, balance sheet and cash-flow statement in the SAME single GET the
   job makes (it asks for 12 types). Operating cash flow is published for 0 of
   30 random ASX codes but equals FCF - capex exactly. Markit's fresher annuals
   are blocked by EPS-only Yahoo years; one mixed-currency series drops a whole
   row (XRO); corrupt vendor periods pass (IAG FY25 revenue 5.35m vs ~15bn).
4. **The stock page contradicts itself.** Three per-period sources (raw LLM
   tiles, `stock_fundamentals`, a stale manual `financial_statements` JSONB with
   no currency) and a "Key metrics" card that prefers the stale snapshot (BHP
   A$220bn vs A$331bn on Peers). Nothing in the tab is in the SSR HTML.
5. **The picker shows two numbers**, without basis, period, currency or
   source; the coverage line counts growth figures, not stocks with data;
   loss-makers read "unknown"; revenue growth ignores a fresher TTM.

## 1. Principles (binding)

- Unknown is never zero and never a pass. Nullable numbers carry `has_*` on the
  wire; the web resolves them once, in ONE mapper per surface.
- Values stay in the REPORTING currency. Ratios use one flow row and one
  aligned balance row of the same currency. Price-based ratios need AUD
  statements and a one-ordinary-share listing; otherwise unknown.
- Withhold rather than guess, in both directions: a filing value that cannot be
  grounded, cross-checked and dated is not written, and a vendor value that
  fails a sanity gate is actively nulled, not kept from an earlier run.
- Provenance travels with the data: per row (`source`), per field
  (`field_sources`), per document (`source_document_url`).
- Absent is not a status. A field missing from an older API is rendered as
  today, never as "not collected" or "0 of M".
- Prod does not run `migrate up`: 000132 is allowlisted, replay-safe,
  lock-ordered, and the API and jobs tolerate it being absent.

## 2. Data model: migration 000132 (`000132_extend_fundamentals`)

Allowlisted in `.github/workflows/terraform-deploy.yml` AFTER the 000131 line,
run with `run_psql_session` (session pooler). The allowlist comment says: never
remove this line to unblock a deploy (the new jobs image writes these columns);
hand-apply in a quiet window (`task db:prod:apply FILE=... CONFIRM=prod`) and
re-run the deploy, or revert. Replayed every deploy, so every step is
catalog-guarded and a no-op once applied.

### 2.0 Shape and lock order (binding; pinned by the node test)

Exactly TWO transactions:
1. `BEGIN; SET LOCAL statement_timeout = 0;` re-issue
   `refresh_strategy_views()` (2.8) and its `ALTER FUNCTION ... SET
   statement_timeout TO '0'`; `COMMIT;` This commits before any relation lock,
   so a failure inside transaction 2 can never leave 000130's three-view body
   in place. A failure BEFORE transaction 1 can: the deploy replays 000130
   (which re-issues the three-view body) and 000132 in separate `psql` calls,
   so a failure between them (000131 failing, say) leaves the three-view body
   live. The refresh step detects that and fails (3.8).
2. `BEGIN; SET LOCAL statement_timeout = 0; SET LOCAL lock_timeout = '15s';`
   in this order, touching objects in `refresh_strategy_views()` order:
   a. guarded `financial_report_extractions.document_meta` add (2.5), which
      shares no lock with the picker objects;
   b. `CREATE TABLE IF NOT EXISTS picks_run_lease` (3.8);
   c. guarded DROP of `mv_fundamentals_growth` (2.6);
   d. guarded column adds on `stock_fundamentals` and
      `stock_fundamentals_sync`, then the guarded CHECK (added `NOT VALID`,
      then `VALIDATE CONSTRAINT`);
   e. `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_growth`, its
      unique index (created in a DO block only when `pg_indexes` lacks it) and
      COMMENT;
   f. `mv_fundamentals_quality` likewise.
   `COMMIT;`
`scripts/prod-psql-classify.mjs` must classify the file as `session`; adjust
the classifier or its test only if it does not.

### 2.1 New `stock_fundamentals` columns

Added in ONE DO block that checks `information_schema.columns` per column and
runs `EXECUTE format('ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS
%I %s', ...)` only when absent. `DOUBLE PRECISION` unless noted. Sign
convention is Yahoo's: outflows are NEGATIVE, enforced at write (3.5).

| Column | Yahoo series | Notes |
|---|---|---|
| `gross_profit` | GrossProfit | |
| `operating_income` | OperatingIncome | absent for banks/insurers |
| `ebitda` | EBITDA | statutory (impairments, revaluations in) |
| `normalized_ebitda` | NormalizedEBITDA | preferred for leverage |
| `ebit` | EBIT | |
| `interest_expense` | InterestExpense | positive expense |
| `pretax_income` | PretaxIncome | |
| `tax_provision` | TaxProvision | |
| `net_interest_income` | NetInterestIncome | banks; populated as -interest for others, so not a classifier |
| `capital_expenditure` | CapitalExpenditure | must be <= 0 |
| `dividends_paid` | CashDividendsPaid | must be <= 0 |
| `share_buybacks` | RepurchaseOfCapitalStock | must be <= 0 |
| `total_assets` | TotalAssets | balance |
| `total_liabilities` | TotalLiabilitiesNetMinorityInterest | balance |
| `total_equity` | StockholdersEquity | balance |
| `cash_and_equivalents` | CashAndCashEquivalents | balance |
| `total_debt` | TotalDebt | balance; INCLUDES lease liabilities |
| `capital_lease_obligations` | CapitalLeaseObligations | balance |
| `net_debt` | NetDebt | balance; Yahoo's is EXCLUDING leases and omitted when <= 0 |
| `current_assets` | CurrentAssets | balance |
| `current_liabilities` | CurrentLiabilities | balance |
| `field_sources` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | 2.2 |
| `source_document_url` | `TEXT` | 2.2 |
| `source_document_date` | `DATE` | 2.2 |

The reserved `period_type = 'quarter'` now means a **balance snapshot**:
balance columns (and `shares_outstanding`) only, from Yahoo `quarterly*`
series (3.3). Flow columns are always NULL on quarter rows.

A second CHECK, `stock_fundamentals_finite_check_v2`, covers every new numeric
column with 000129's form (`x IS NULL OR x = 0 OR abs(x) BETWEEN 1e-12 AND
1e18`), added only when `pg_constraint` lacks it. `picks/rows.go storable`
applies the identical range to every new column.

### 2.2 Per-field provenance

`field_sources` records ONLY exceptions: fields whose value did not come from
the row's `source`. Values: `"markit-key-statistics"`,
`"asx-filing-extraction"`, `"derived:fcf-minus-capex"`, `"derived:ttm-at-fye"`.
`source_document_url`/`source_document_date` name the filing a row (or its
filing-filled fields) came from; set only by the filings ingest.

Vendor upsert, per field, same currency (the row carries a `Rejected []string`
mask from 3.4/3.5):
1. The vendor supplies x: take it; delete `field_sources[x]`.
2. x is in `Rejected`: write NULL; delete the key.
3. Otherwise keep the stored value only on `ttm` rows (TTM history) or when
   `field_sources[x]` names a non-row source (a filing or Markit fill).
4. Otherwise, on `annual` rows, set x to NULL. This removes pre-000132 filing
   fills stored without a marker in the first full pass.
5. A vendor upsert never changes `source` on an `asx-filing-extraction` row
   unless it supplies revenue or net income for that period; when it takes a
   row over, every flow field it keeps from the filing row is recorded as
   `field_sources[col] = 'asx-filing-extraction'`.
6. A currency change replaces the row and `field_sources` wholesale.

One fiscal year under two dates (52/53-week years: Markit dates LOV's FY26
28 June, Yahoo 30 June). Same-date conflicts stay with rules 1-6; these two
rules govern only different dates within 7 days:
- (a) **Prune.** The upsert's `pruned` CTE deletes a stored Markit annual row
  only when a Yahoo annual row in the same statement, on a different date
  within 7 days, carries revenue or net income after the merge. An EPS-only
  Yahoo row prunes nothing.
- (b) **No Markit duplicate.** A Markit annual row is not written when a
  non-Markit annual row (Yahoo or filing) on a different date within 7 days,
  carrying revenue or net income, is already stored or is in the same
  statement. This covers the Yahoo-failure case, where every Markit year
  arrives under its own date.

Carve-out for both: beside an EPS-only year the Markit row is kept or written,
because it holds the year's only revenue and net income. That fiscal year can
then sit under two dates until a run where both vendors answer folds it in
(the Markit fill completes the Yahoo row and the prune removes the Markit
row). A duplicate is chosen over losing the figures. The pre-000132 statement
has neither rule.

Filing upsert (4.4): fills only NULL vendor-owned fields; REPLACES a field
already marked `asx-filing-extraction`; records the marker and the document.

### 2.3 `stock_fundamentals_sync` columns (guarded adds)

`last_outcome VARCHAR(16)` (`loaded` | `empty` | `failed`),
`consecutive_empty SMALLINT NOT NULL DEFAULT 0` and `median_k DOUBLE
PRECISION` (the identity-gate reference of 3.5, read by valuation in 5.3 and
by `-mode filings` for gate 8's EPS basis in 4.2, through `VendorRows`' LEFT
JOIN of `stock_fundamentals_sync`, NULL before 000132; NULL when fewer than 3
periods allow it), `fx_converted BOOLEAN` (3.4's verdict; NULL until a fetch
has measured it) and `native_currency VARCHAR(8)` (Markit's `curCode` for an
fx_converted code; NULL when unknown). The three measured facts move together,
and only when Yahoo answered without error AND returned at least one row,
counted before the gates and the merge. A Yahoo 404 (mapped to no rows and no
error) or an empty document followed by a Markit load measures nothing and
keeps the stored values, as does any failed attempt. `empty` only when every source
asked returned without error and with no rows; a fallback error with no rows is
`failed`. `recordAttempt` increments `consecutive_empty` on `empty` and resets
it on `loaded`/`failed`.

### 2.4 `picks_run_lease`

`CREATE TABLE IF NOT EXISTS picks_run_lease (name TEXT PRIMARY KEY, holder TEXT
NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`. See 3.8.

### 2.5 `financial_report_extractions.document_meta`

`JSONB` (guarded add, nullable). Written by the extractor (6.1), read by the
filings ingest and the highlights funnel. Closed vocabulary; any other value is
treated as absent:
```json
{"currency":"USD","currency_evidence":"presented in US dollars",
 "units":"millions","units_evidence":"US$ Million",
 "entity":"BHP Group Limited","abn":"49 004 028 077",
 "period_end":"2026-06-30","period_type":"annual",
 "report_kind":"appendix_4e"}
```
`currency`: ISO 4217 upper case. `units`: `units` | `thousands` | `millions` |
`billions`, set only when exactly one distinct unit statement is found in the
pages read. `period_type`: `annual` | `half`. `report_kind`: `appendix_4e` |
`appendix_4d` | `annual_report` | `half_year_report` | `results_announcement`
| `other`. A shared JSON fixture of cases is asserted by both the Python tests
and a Go test; its rules text states the rules below.

`report_kind` rule: the first match anywhere in the pages read, in the order
`appendix_4e`, `appendix_4d`, `annual_report`, `half_year_report`,
`results_announcement` (results / profit announcement, results for
announcement to the market). Then the document's head (its first five
non-empty lines, each starting within the first 400 characters): `other` when
a head line that reads as a heading, not a sentence, NAMES the document an
investor or results presentation, a Pillar 3 disclosure, a transcript or a
webcast; else `results_announcement` for "results release" or "full / half
year results" (never "... results presentation / briefing / webcast / call").
Otherwise absent, and the title decides. "presentation currency", "basis of
presentation" and a sentence announcing a presentation or webcast never make a
document `other`. The head-only results phrases are checked after the `other`
heading test, so a deck headed "FY26 Full Year Results Presentation" is
`other` even with a "Full year results for the year ended ..." subtitle.

### 2.6 `mv_fundamentals_growth`: guarded rebuild, appended columns

Keep every existing column (name, type, position, meaning), then APPEND in this
order: `revenue_basis_source`, `eps_basis_source` (`'vendor'` | `'filing'`),
`revenue_latest_period_end DATE`, `revenue_prior_period_end DATE` (the ends of
the pair `revenue_yoy_pct` used; NULL without a pair). The guard key is the
LAST appended column, `revenue_prior_period_end`.

Behaviour:
- **Laterals filter on the field they read**: annual revenue laterals on
  `revenue IS NOT NULL`, NI laterals on `net_income`, EPS on its column; half
  laterals on `(revenue OR net_income OR eps_basic OR eps_diluted) IS NOT
  NULL`; TTM on `revenue OR net_income`; `quarter` rows are never read;
  `periods_available` counts rows with any flow field. A balance-only or
  EPS-only row can never blank a growth figure.
- **Fresher TTM revenue**: when the latest TTM revenue point is newer than the
  latest annual revenue point, the comparator is the TTM row 12 months
  (+/- 7 days) earlier, else the annual row 12 months (+/- 7 days) earlier,
  same currency, value > 0; then `revenue_basis_period_type = 'ttm'`.
  `revenue_yoy_prior_pct` on that basis is the comparator vs the point 12
  months (+/- 7 days) before it, else NULL (never the two-year-old annual
  acceleration). The half basis still wins when the half is newest (000129).
- **Basis source**: `'filing'` when either row of the chosen pair has
  `source = 'asx-filing-extraction'`, or the field used (revenue, or the EPS
  column the basis used) has `field_sources = 'asx-filing-extraction'` on
  either row; `'vendor'` otherwise.

Rebuild: a DO block that, when `to_regclass('mv_fundamentals_growth')` exists
and `pg_attribute` lacks `revenue_prior_period_end`, first RAISEs EXCEPTION
naming any relation `pg_depend` shows depending on it, then runs
`EXECUTE format('DROP %s %I', 'MATERIALIZED VIEW', 'mv_fundamentals_growth')`
(000131 precedent; the drift guard rejects the literal text). Carry owner,
reloptions and relacl (after revoking default-privilege grants) exactly as
000131:125-148 does. 000129's replayed `CREATE ... IF NOT EXISTS` is then a
no-op.

### 2.7 New `mv_fundamentals_quality`

`CREATE MATERIALIZED VIEW IF NOT EXISTS` (new name, no drop). Reads
`stock_fundamentals` ONLY (no prices, no company metadata), so it never blocks
a rebuild of another table or view. One row per stock with any flow row. Unique
index on `stock_code`.

**Flow basis** (income + cash flow): the latest `ttm` row with revenue and net
income if newer than the latest `annual` row with both; else that annual row.
At equal `period_end` the row with more non-NULL flow fields wins. Every flow
ratio uses that ONE row.

**Balance basis**: the `annual`, `half` or `quarter` row with `total_equity`
NOT NULL and the flow row's currency whose `period_end` equals the flow
`basis_period_end`, else the latest such row dated no more than 6 months
BEFORE it (never after). Priors (`total_equity_prior`, `total_assets_prior`)
come from the balance row 10-14 months before THAT row. Any ratio mixing flow
and balance fields is NULL when no balance row qualifies.
`balance_lag_months` records the gap.

Columns: `stock_code, basis_period_type, basis_period_end, currency, source,
fetched_at, revenue, gross_profit, operating_income, ebitda, normalized_ebitda,
ebit, net_income, operating_cash_flow, operating_cash_flow_derived (bool),
free_cash_flow, capital_expenditure, dividends_paid, interest_expense,
shares_outstanding, balance_period_end, balance_period_type, balance_currency,
balance_lag_months, total_assets, total_assets_prior, total_liabilities,
total_equity, total_equity_prior, cash_and_equivalents, total_debt,
capital_lease_obligations, net_debt, current_assets, current_liabilities,
gross_margin_pct, operating_margin_pct, net_margin_pct, fcf_margin_pct,
fcf_conversion, roe_pct, roa_pct, net_debt_to_ebitda, net_debt_to_equity,
current_ratio, interest_cover, payout_ratio_pct, statement_is_financial`.

Definitions (every division guarded `CASE WHEN denominator > 0`):
- `net_debt` = stored `net_debt`; else `total_debt - capital_lease_obligations
  - cash_and_equivalents` when all three exist on the balance row (negative =
  net cash); else NULL. Never `total_debt - cash`. Labelled "net debt (excl.
  leases)" everywhere.
- margins = line / revenue. `fcf_conversion` = FCF / net income (NI > 0).
- `roe_pct` / `roa_pct`: NULL unless BOTH points exist and are > 0 (no
  single-point fallback); `roe_pct` NULL (not meaningful) when average equity
  < 10% of average assets. This guard applies to companies that are not
  financials. When `is_financial` and the view's `roe_pct` is NULL, Go computes
  `roe_pct` exactly as the view does without the guard: the flow row's
  net_income / ((total_equity + total_equity_prior) / 2) x 100, both equity
  points > 0 (`financialROE` in `fundamentals_quality.go`), before anything
  leaves the API or any rule reads it. A bank's balance sheet is leveraged by
  design (CBA is about 6% equity to assets), so the guard would withhold ROE
  from every major bank with no reason a surface could give. `roe_pct` stays
  outside the NOT-MEANINGFUL set.
- `net_debt_to_ebitda` = net_debt / COALESCE(normalized_ebitda, ebitda), NULL
  when that denominator <= 0. `net_debt_to_equity` NULL when equity <= 0.
- `interest_cover` = operating_income / interest_expense (both present,
  interest > 0). `current_ratio` = current assets / current liabilities.
- `payout_ratio_pct` = -dividends_paid / net income, NULL when dividends_paid
  > 0 or NI <= 0; labelled "cash dividends paid / net profit".
- `statement_is_financial` is decided from a STATEMENT SHAPE row that is
  independent of the flow basis: the newest `annual` or `ttm` row with
  `source = 'yahoo-timeseries'`, `pretax_income IS NOT NULL`, and no
  `field_sources` entry for revenue or net_income (at equal `period_end` the
  annual row). `statement_is_financial` = (that row's operating_income IS NULL
  AND ebitda IS NULL); NULL when no row qualifies. Rationale: legacy
  000129-shaped rows, Markit rows (revenue and NI only), filing rows (revenue,
  NI, EPS) and FX-rejected rows never carry operating income or EBITDA for any
  company, so reading the flow row flagged BHP, CSL and FMG as banks. Yahoo
  publishes PretaxIncome for banks and insurers too (IAG: PretaxIncome and
  EBIT, no OperatingIncome or EBITDA), so real financials are still flagged.
  NULL is COALESCEd to false by the store, so the industry test decides; every
  row written before 000132 therefore reads NULL until the job re-fetches the
  code with its full statements (3.7). Known limitation: the `Rejected` mask
  is not persisted, so a Yahoo row whose operating_income and ebitda alone were
  refused by the per-point currency gate, with pretax_income kept, would still
  read as a financial. The period-wide gates (scale break, identity, FX) refuse
  pretax_income together with them.

The view's COMMENT states the same rule: "statement_is_financial reads the
newest full Yahoo income statement (source yahoo-timeseries, pretax income
present, revenue and net income its own), not the flow row: TRUE when it has
neither operating income nor EBITDA, NULL when no such statement is held
(legacy, Markit, filing and FX-refused rows never decide it)."

**Financials are decided in Go, once** (`services/shorts`,
`fundamentals_quality.go`): `is_financial` = `statement_is_financial` OR
industry in (Banks, Insurance) OR (industry in (Financial Services, Diversified
Financials) AND (total_debt >= 0.5 x total_assets OR net_interest_income >
0.25 x revenue)). When `is_financial`, Go nulls the NOT-MEANINGFUL set
{gross_margin_pct, operating_margin_pct, fcf_margin_pct, fcf_conversion,
net_debt, net_debt_to_ebitda, net_debt_to_equity, current_ratio,
interest_cover} before anything leaves the API, and marks them not meaningful.
The view's 10% equity-to-assets guard on `roe_pct` applies only to companies
that are not financials: for a financial whose view `roe_pct` is NULL, Go
computes it without the guard (`financialROE`, above).
`is_property` = industry in (Equity Real Estate Investment Trusts (REITs), Real
Estate Management & Development). One exported list; page, picker, MCP and
rules all read it.

### 2.8 `refresh_strategy_views()` re-issued

In transaction 1 (2.0), same guard pattern, order `mv_market_regime`,
`mv_fundamentals_growth`, `mv_fundamentals_quality`, `mv_price_features`, then
`ALTER FUNCTION ... SET statement_timeout TO '0'`. Before the quality view
exists the refresh warns `Skipping mv_fundamentals_quality` and the job fails
loudly (existing behaviour for skipped views). A live body that does not name
a picker view at all (000130's three-view body, 2.0) warns nothing; the job's
NOTICE check fails on that too (3.8).

### 2.9 Tests

- `services/migrations/fundamentals_extended.test.mjs` (node builtins only):
  two transactions in the 2.0 order, both timeouts; every column add and index
  inside a guarded DO block; the growth view's output columns equal 000129's as
  a prefix plus the four appended; the guard key is emitted by the CREATE and
  is the last column; every division guarded; the function's four guarded
  refreshes in order and the trailing ALTER FUNCTION; allowlist places 000132
  after 000131 with the "never remove" comment.
- Env-gated real-Postgres Go test `picks/migration132_pg_test.go` (helpers
  prefixed `m132`, `PICKS_TEST_DATABASE_URL`, refuses pooler/supabase DSNs):
  applies 000002, 000045, 000117, 000129, 000130, 000131, 000132 to a fresh
  schema; replays 000129..000132 twice with the growth view OID unchanged;
  seeds and asserts: FMG FY24 net cash (TotalDebt 5,400, leases 815, cash
  4,903, NetDebt absent -> net_debt -318); LOV (TTM flow with a 2-year-old
  balance -> roe NULL); a balance-only row newer than a filing half leaves the
  half growth unchanged; a TTM-fresher revenue basis with its period ends; a
  filing-current/vendor-prior pair and a filing-filled vendor field -> basis
  source 'filing'; negative equity; currency mismatch; and a case that holds a
  refresh open (pg_sleep between two refreshes) while 000132 applies from a
  second connection, asserting no SQLSTATE 40P01. Statement shape (2.7): a
  flow row without pretax_income no longer yields TRUE, so LAG6 expects NULL;
  legacy, Markit-only, FX-refused and revenue-and-NI-only codes read NULL; a
  newer filing row, or a Yahoo row whose revenue or net income Markit or a
  filing filled, never decides; bank fixtures must carry pretax_income to read
  TRUE (BANK, and IAG's insurer statement).
- `scripts/tests/migration-drift.test.mjs` stays green.

## 3. Vendor ingestion (`services/jobs/internal/jobs/picks`)

### 3.1 One GET, the full statements

Still ONE Yahoo fundamentals-timeseries GET per code. Request the annual AND
trailing flavours of every income-statement and cash-flow series in 2.1 plus
the existing ones, the annual AND quarterly flavours of the balance-sheet
series and `OrdinarySharesNumber`, plus `trailingBasicEPS`,
`annualCashFlowsfromusedinOperatingActivitiesDirect` and
`trailingCashFlowsfromusedinOperatingActivitiesDirect`. No valuation series,
no quarterly income/cash-flow series.

### 3.2 Operating cash flow

Reported `OperatingCashFlow`; else the direct-method series; else
`FreeCashFlow - CapitalExpenditure` on the same period with
`field_sources.operating_cash_flow = "derived:fcf-minus-capex"`. Never
overwrite a reported value with a derived one.

### 3.3 Balance snapshots

Every `quarterly*` balance point is stored as a `period_type = 'quarter'` row
carrying ONLY balance columns and shares, `source = 'yahoo-timeseries'`. Never
written to `half` rows. A point dated at a fiscal year end (balance month-end
+/- 7 days) also fills NULL balance fields of the vendor annual row for that
date.

### 3.4 Currency, per field

Share counts and EPS ignore `currencyCode` for the row check. A conflicting
monetary line nulls THAT field (added to `Rejected`, counted), never the row.
FX-converted detection: a monetary raw value with `|frac| > 0.001` on a
normally integral line marks the code `fx_converted`. Yahoo converts EVERY
value of an FX-converted code, per-share figures included, whatever
`currencyCode` a point carries. The XRO fixture proves it: FY25 basic EPS
1.3541 = Yahoo's AUD NI 207.03m / ~153m shares, while Xero's NZD EPS is
~1.49; FY24's 1.0549 is labelled NZD yet equals 160.2m AUD / 152.3m. The
`fx_converted` gate therefore rejects every monetary AND per-share column
(`eps_basic`, `eps_diluted`) on every Yahoo row, named in `Rejected` so a
stored converted value is nulled. Only `shares_outstanding` survives. When
Markit answers, the rows are relabelled to Markit's native currency (the
relabel moves only the share count, the `Rejected` masks and the currency the
Markit fill and the gates compare against) and Markit fills revenue and net
income. The code's EPS stays NULL on every vendor row until a filing supplies
a native-currency figure. For filings gates 6-8 its vendor currency is the
persisted `native_currency`, else a Markit row's currency, else unknown (no
filing rows). The verdict is persisted (2.3); the
filings gates read it, and valuation (5.3) withholds P/E and P/B on the flag
itself, not only on the missing k, because Yahoo's labels for such a code
cannot be trusted. On the read side the API treats an unmeasured verdict as
converted when the stored vendor rows look converted (5.3).

### 3.5 Sanity gates (every rejection counted, logged, added to `Rejected`)

- **Identity**: k = net_income / (eps_basic x shares) per annual/TTM period.
  With >= 3 such periods, a period whose k differs from the code's median k by
  more than 3x has its MONETARY fields rejected (EPS and shares kept):
  `identity_outlier`. The median, not 1, is the reference (CDI listings such as
  RMD have a constant k near 10). The median k is persisted per code in
  `stock_fundamentals_sync.median_k` (2.3) for valuation (5.3).
- **Scale break**: a monetary value below 1/20 of BOTH adjacent periods of the
  same series rejects that period's monetary fields: `scale_break`.
- `total_assets <= 0` rejects that period's balance fields; basic and diluted
  EPS of opposite signs reject both; TTM points older than the latest annual
  end minus 18 months are dropped; capex, dividends paid and buybacks > 0 are
  rejected (`sign_violation`).

### 3.6 Markit and TTM, per field

For each annual `period_end`, Markit revenue/net income fill a Yahoo row's NULL
revenue/net income when currencies match (`field_sources`). Years Yahoo lacks
are added as Markit rows. When a TTM row's `period_end` equals the fiscal year
end, copy EVERY flow field the annual row for that date lacks (revenue, NI,
EPS basic/diluted, gross profit, operating income, EBITDA, normalized EBITDA,
EBIT, interest, pretax, tax, OCF, FCF, capex, dividends, buybacks) when
currencies match, recorded `"derived:ttm-at-fye"`.

### 3.7 Selection

- **Budget-driven.** `defaultMaxCodes` in `selection.go` becomes 0 (no count
  cap). Terraform does NOT set `PICKS_FUNDAMENTALS_MAX_CODES` (envPositiveInt
  ignores 0). `PICKS_FUNDAMENTALS_BUDGET_MIN = 170`. Pace stays 4 s.
- **Order:** (1) due filers: an `appendix_4de` or `period_results` headline
  (NOT `annual_report`) in the last 14 days and `last_success_at` before the
  filing, plus one follow-up 7+ days after it; (2) never attempted, by market
  cap descending, then 20-day dollar volume, then code; (3) last outcome
  `failed`; (4) successes (and single empties) older than 14 days, oldest
  first.
- **Skips:** successes 14 days; `last_outcome='empty' AND consecutive_empty >=
  2` for 45 days; failures never skipped.
- **Pre-000132 rows:** a sync row with `last_outcome` NULL (written before
  000132) is selected with the never-attempted group, by market cap then
  dollar volume, and is never skipped. Its derived outcome no longer earns the
  14/45-day skip, because the code's stored rows are the 000129 seven-column
  shape (no full statements, no quality ratios). The first budget-driven
  nights after the deploy therefore re-fetch the universe, largest first
  (about 155 minutes for ~2,300 codes at 4 s, inside the budget). A due filer
  still goes first. In a database without 000132 no row is treated this way,
  since a re-fetch could not store more. The selection log line gains
  `pre_000132=N`.
- **Breakers:** the 25-consecutive-failure breaker stays; a rate breaker stops
  taking codes when > 30% of the last 100 Yahoo requests failed
  (`stopped_early=error_rate`); Markit is disabled for the rest of the run after
  10 consecutive Markit failures (`fallback_disabled`).
- **Retry budget:** when `CLOUD_RUN_TASK_ATTEMPT > 0`, the fundamentals step
  uses `min(budget, 20)` minutes so a retry finishes filings and refresh
  without a second full pass.

### 3.8 Single flight, revalidation, Terraform

- `-mode fundamentals`, `filings` and `all` claim `picks_run_lease`
  (`INSERT ... ('picks', <execution>, now()+interval '4 hours') ON CONFLICT
  (name) DO UPDATE ... WHERE picks_run_lease.expires_at < now() RETURNING
  holder`), extend it every 100 codes, delete it on exit. No row returned: log
  the holder and exit 0. `-mode refresh` does not take it. Tolerate 42P01
  (lease table absent) by running without the lease.
- **Refresh check:** the refresh command is `BEGIN; SET LOCAL
  statement_timeout = 0; SET LOCAL client_min_messages = notice; SELECT
  refresh_strategy_views(); COMMIT`, so a role default cannot hide the
  function's NOTICEs. The step fails (exit 1) on any `Skipping <view>`
  warning, and also when a picker view (`mv_market_regime`,
  `mv_fundamentals_growth`, `mv_fundamentals_quality`, `mv_price_features`)
  exists in the catalog (`to_regclass`) but the call emitted no `Refreshing
  <view>` NOTICE for it: the live function body is stale (2.0), and the log
  says to re-apply 000132.
- **Revalidation:** after a successful refresh, sleep until 16 minutes have
  passed (the API's 15-minute strategy cache + 1), then best-effort
  `platform.PingRevalidate` with tag `strategy-picks`, and tag `fundamentals`
  only when that execution's fundamentals or filings step wrote rows. No path
  list, no copy of the strategy ids in the jobs module.
- `module "shorted_job_picks"`: `timeout_seconds = 12600`, `max_retries = 1`,
  env `PICKS_FUNDAMENTALS_BUDGET_MIN = "170"`, `REVALIDATION_URL =
  "https://shorted.com.au/api/revalidate"`, `secret_env.REVALIDATION_SECRET =
  "REVALIDATION_SECRET"`.

## 4. Parsed filings (`-mode filings`), fail-closed

### 4.1 One trust funnel (`services/pkg/extractiontrust`)

A new non-internal package in the `services` module (importable by
`services/shorts` and by `services/jobs` through its replace):
- `Grounded(entry)`: false when `alignment` is present and not in
  {`match_exact`, `match_greater`, `match_lesser`, `match_fuzzy`}, or when the
  normalised `source_text` (lowercased, whitespace collapsed) is on the OLD or
  NEW few-shot list. Never deny by value (CBA's real 1H25 NPAT is also $5,142m).
- `IsProvenanceKey(k)`: `alignment`, `char_start`, `char_end`.
- `IsResultsDocument(title, reportKind)`: the statutory-results classifier
  (4D/4E, half-year/annual reports, preliminary final, results announcement;
  never Pillar 3/Basel, "items impacting", 20-F, webcast, transcript,
  investor day; presentations and slides only when the title also names an
  Appendix 4D/4E, which lodges the statutory filing).
- `EntityMatches(entity, companyName)`: ONE entity rule shared by the filings
  ingest (4.2 gate 1) and the stock page's latest filing summary (5.1). It
  matches when the names share a distinctive token (not merely an industry
  word) and the shared tokens are a strict majority of the smaller name's
  tokens; an empty token set or an empty company name withholds. It moved here
  from `picks/filings_vendor.go`.
- The few-shot texts (old and new) live here; `extract.py` and `reportextract`
  copy the new example verbatim; a Go test parses `extract.py`'s
  `EXTRACTION_EXAMPLES` literals and asserts parity.

Applied at EVERY read funnel of `financial_report_extractions.metrics`: picks
filings, `GetStockFinancialHighlights` (shorts store), the live weekly-report
collector (`services/jobs/internal/jobs/weeklyreport`), and the retired
generator when it compiles against `services/pkg`. Failing entries are dropped;
provenance keys are stripped before any API response or LLM prompt (including
`extract.py summarize_report` and `reportextract/digest.go`).

### 4.2 Gates, in order (each counted in the run summary)

1. **Document**: skip when `digest_confidence < 0.3` (NULL passes); when
   `!IsResultsDocument`; when `document_meta.entity` is present and does not
   match the code's company name (`extractiontrust.EntityMatches`, 4.1); when
   `report_kind = 'other'`.
2. **Grounding** + 3. **few-shot denylist**: `extractiontrust.Grounded`.
4. **Own period**: the resolved period must equal the document's own period:
   `document_meta.period_end` when present, else the latest half or annual end
   on or before `report_date` on the company's balance date, within 5 months.
5. **Statutory**: `nonStatutoryRe` gains `profit from operations`, `operating
   profit`, `profit before tax`, `cash (npat|earnings)`, `total comprehensive
   income`, `underlying`, `pro forma`, `network sales`, `online sales`,
   `total transaction value|TTV`, `segment`, `division`.
   A net income or EPS takes its sign from the matched number itself (a
   minus, or parentheses around the digits or the whole money figure:
   `(12.3)`, `($3.2m)`, `(US$12.3m)`, `-$3.2m`); otherwise from the NEAREST
   sign word before the number in its clause (back to a `;` or a sentence
   end). Loss words: loss, deficit, negative, net loss, loss after tax, loss
   per share. Profit words: profit, NPAT, NPATA, earnings, net profit, profit
   after tax, earnings per share, EPS. A sign word counts only at the number's
   own parenthesis level or an enclosing one (a closed parenthetical such as
   `(pcp: loss of $3.1m)` is ignored). It does not count inside a comparison:
   the lead (compared with/to, versus, vs, from as in up/down from, on,
   against, than, over, relative to, pcp, prior/previous corresponding period,
   last/prior/previous year or half) up to its first amount, a comma or
   semicolon, or its closing parenthesis. It does not count in a statement name
   or partial item (statement of profit or loss, profit and loss,
   impairment/credit/FX losses, loss on disposal, retained earnings). A sign
   word immediately after the number (`$12.3 million loss`, `12.3m net loss
   after tax`) and the value attribute's own sign also vote. When the voices
   disagree, or the nearest sign word belongs to an amount tagged as a
   comparative (`a loss of $3.1m in the pcp became $45.2m`), the value is
   withheld: `5_statutory.sign_ambiguous`, counted when the value is read
   (after gate 7). Nothing speaking is a profit.
6. **Vendor context required**: no vendor annual row, no filing row
   (`skipped_no_vendor`). Balance month and currency come from vendor rows; the
   June/AUD defaults are gone. `fx_converted` codes follow 3.4.
7. **Currency**: an explicit marker in the quote or `document_meta.currency`
   must equal the vendor currency.
8. **Magnitude** (same-currency vendor references): half revenue in [0.25,
   0.75] of vendor TTM revenue at the same end, else of the containing FY's
   vendor annual, else in [0.15, 1.5] of the prior FY's; annual revenue in
   [0.7, 1.4] of the same-FY vendor annual when it exists, else [0.5, 2.5] of
   the prior FY's; `|net income| <= 1.5 x revenue` only when NI > 0 and the
   company is not a REIT/property/investment entity; EPS in [0.5, 2] of net
   income / vendor shares, written only when that check can run AND the vendor
   EPS is per ordinary share: the code's `stock_fundamentals_sync.median_k`
   within [0.8, 1.25], or, with no `median_k`, every vendor annual/TTM period
   whose k = NI / (EPS x shares) is computable within [0.8, 1.25]. No
   computable k is no evidence either way, so the EPS is written. Otherwise
   every filing EPS of the
   code is withheld (`8_magnitude.eps_listed_unit_not_one_share`), keeping
   revenue and net income: a CDI listing's vendor EPS is per CDI (RMD, k near
   10), so a filing's per-share EPS would enter the series 10x off while
   passing the ratio. This no-median rule (any computable k out of band
   withholds) is deliberately stricter than valuation's (5.3); the band
   constants are duplicated in `filings_vendor.go` because `services/jobs`
   cannot import `services/shorts`.
9. **TTM-EPS identity** (halves, all inputs present): basic EPS on all four
   terms (diluted on all four only when no basic exists); |(H1 - H1 prior) -
   (TTM at half end - prior FY)| <= max(10% x |TTM - FY|, 2% x |FY EPS|, 0.01).

`document_meta.units`, when present, scales a bare table figure whose digits
appear in the quote (the 4D/4E summary tables' "US$ Million" header case).

### 4.3 Deterministic rebuild (the data repair)

Filing SQL moves to `filings_store.go`. At the end of `-mode filings`, ONE
transaction whose predicates are evaluated at write time:
`DELETE ... WHERE source='asx-filing-extraction' AND key NOT IN (produced
keys)`; per field `UPDATE ... SET col=NULL, field_sources=field_sources-'col'
WHERE field_sources->>'col'='asx-filing-extraction' AND key NOT IN (keys
reproducing col)` (and the document columns with them); then the upserts
(2.2). Refuse the WHOLE write (exit 10: nothing deleted or upserted, per-gate
counts and the would-purge list logged) when the extraction or vendor read
errored, or when it read zero extractions. Filing rows are rebuildable from
`financial_report_extractions`, so a large legitimate purge (the first run
after deploy, or codes that lost vendor context) is allowed and logged with
per-gate counts rather than refused.

### 4.4 Tests

Stop pinning the example text as valid input. Regression fixtures: the five
echo documents; CBA's comparative mislabels; EDV channel sales; BHP "Profit
from operations"; LFT's foreign document; DRO's December year end; a bare 4E
table line with `document_meta.units`; the rebuild's purge and refusal paths; a
vendor takeover of a filing row keeping markers (2.2 rule 5). Sign fixtures
(C3: a loss quote naming a comparative profit, and "statement of profit or
loss"; C6: a profit quote naming a prior loss, and an EPS with "(pcp: loss per
share)"; their mirrors; a gate-8 case where the flipped NI+EPS pair can no
longer pass together); an RMD-shaped CDI fixture (per-CDI vendor EPS,
per-share counts) whose per-share filing EPS is withheld, unit and real
Postgres.

## 5. API (`services/shorts`) and proto

### 5.0 Contract commit

Proto changes land FIRST as ONE commit containing the full `make openapi`
output (with `~/go/bin` on PATH): `services/gen/proto/go`, `web/src/gen`,
`sdks/java`, `api/schema/generated/openapi.yaml`, `web/public/openapi.{json,
yaml}`, `web/public/docs/api-markdown.md`. No comment reachable from a public
service may contain `Admin`, `admin`, `Internal`, `MintToken` or
`ShortedStocksService`. The proto is then frozen; any later change goes back
through the contract step. Every new rpc is on its domain service AND the
legacy service with identical visibility (`TestLegacyDomainServiceParity`).

### 5.1 `stock.proto`

`FundamentalsPeriod` (next free 21), pairs `double x = N; bool has_x = N+1;`:
21 gross_profit, 23 operating_income, 25 ebitda, 27 normalized_ebitda, 29 ebit,
31 interest_expense, 33 pretax_income, 35 tax_provision, 37
net_interest_income, 39 capital_expenditure, 41 dividends_paid, 43
share_buybacks, 45 total_assets, 47 total_liabilities, 49 total_equity, 51
cash_and_equivalents, 53 total_debt, 55 capital_lease_obligations, 57 net_debt,
59 current_assets, 61 current_liabilities; then `map<string, string>
field_sources = 63; string source_document_url = 64; string
source_document_date = 65;`.

`FundamentalsGrowth` (next free 25): `string revenue_basis_source = 25; string
eps_basis_source = 26; string fetched_at = 27; string revenue_latest_period_end
= 28; string revenue_prior_period_end = 29;`.

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
double market_cap = 34;       bool has_market_cap = 35;
double pe_ratio = 36;         bool has_pe_ratio = 37;
double price_to_book = 38;    bool has_price_to_book = 39;
string price_as_of = 40; string balance_currency = 41;
repeated string not_meaningful = 42;   // ratio names nulled because is_financial
bool is_property = 43; int32 balance_lag_months = 44;
string shares_as_of = 45; string pe_eps_period_end = 46; string pe_eps_basis = 47;
string valuation_note = 48;            // why market cap / P/E are absent: "non-aud", "listed-unit", "no-shares", ""
```
New `FundamentalsCoverage`: `string status = 1;` (`covered` | `empty` |
`pending` | `failed`; empty string when unknown), `string last_attempt_at = 2;
string last_success_at = 3; repeated string sources = 4;`.

New `LatestFilingSummary`: `string report_url = 1; string report_title = 2;
string report_date = 3; string period_end = 4; string period_type = 5; string
digest = 6; double digest_confidence = 7;`. Selected server-side: the newest
extraction passing `IsResultsDocument`, `digest_confidence >= 0.6`, no
metrics entry whose `source_text` is a few-shot text
(`extractiontrust.IsFewShotText`; the digest was written from those metrics
and may repeat the example's figures), and, when `document_meta.entity` is
present, `extractiontrust.EntityMatches(entity, company_name)` (4.2 gate 1's
rule: a shared distinctive token and a strict majority of the smaller name's
tokens; an empty token set or an empty company name withholds), whose
resolved period (document_meta.period_end or the 4.2 gate-4 resolver) equals
the newest flow period's end; absent otherwise.

`GetStockFundamentalsResponse`: `FundamentalsQuality quality = 5; bool
has_quality = 6; FundamentalsCoverage coverage = 7; LatestFilingSummary
latest_filing = 8; bool has_latest_filing = 9;`. `limit` max stays 40.

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
repeated string not_meaningful = 21;
```
`StrategyPick.fundamentals = 27` (absent when the stock has no fundamentals
row). `StrategyPick.market_cap` is the resolved market cap (5.3).

`GetStrategyPicksRequest`: `string sort_by = 5;` closed set `score` (default),
`revenue_yoy`, `eps_yoy`, `roe`, `net_margin`, `fcf_margin`, `pe` (ascending),
`market_cap`; others descending; unknown values last; a growth figure above
+500% or below -95% sorts after every measured figure and before unknowns;
`rank` stays the evaluator's rank; sorting copies the status-filtered slice
(`sort.SliceStable`), never mutating the cache. `bool require_fundamentals =
6;`. `GetStrategyPicksResponse.fundamentals_rows_count = 8;`
(candidates with any fundamentals row).

New rpc `GetStockStrategyFit` on `StrategyService` (and legacy), PUBLIC:
```
message GetStockStrategyFitRequest { string stock_code = 1; }
message StrategyFit {
  string strategy_id = 1; string strategy_name = 2;
  string status = 3;            // triggered | setup | watch | none
  double score = 4; int32 rank = 5; int32 total_count = 6;
  repeated RuleResult rules = 7;
}
message GetStockStrategyFitResponse {
  string stock_code = 1; string as_of = 2; MarketRegime regime = 3;
  repeated StrategyFit fits = 4; bool in_universe = 5;
}
```
The strategy cache stores the evaluation env (regime + rs6m quartile) and a
code-to-candidate index. For each strategy: the cached rules, rank and status
when the stock is in the pick list, else `strategies.EvaluateOne(st, cand, env)`
(the Evaluate loop body, extracted) with status `none`, rank 0.

### 5.3 Store and handlers

- `strategyCandidatesQuery` keeps EXACTLY today's column list. The appended
  growth columns and every `mv_fundamentals_quality` column are read by ONE
  separate query keyed by stock_code (`fundamentalsExtras`). It and every new
  read in `GetStockFundamentals` treat SQLSTATE 42P01 and 42703 alike as
  "absent", log once, and degrade (nil provenance, nil quality, coverage status
  ""). Test: against a schema without 000132 the universe and fundamentals
  return with nil extras.
- **Valuation** (one function, used by the page, the picks and sorting):
  shares = `shares_outstanding` from the newest vendor row (annual, ttm or
  quarter) that carries it and is dated <= 12 months before `price_as_of`, and
  only when the code's `median_k` is within [0.8, 1.25] (or absent with a single
  consistent period); market cap = latest close x shares (AUD). P/E = close / E,
  E = the newest 12-month EPS across annual and TTM rows (diluted when present,
  else basic; `pe_eps_basis`), dated <= 12 months before `price_as_of`; NULL
  when E <= 0, the statements are not AUD, or the code is fx_converted. P/B =
  market cap / aligned total equity (AUD, equity > 0). `valuation_note` says
  why a value is absent. `StrategyPick.market_cap` and `sort_by=market_cap`
  use this value, falling back to the screener value only when shares are
  absent.
- `GetStockFundamentals` also fills `coverage` from the sync row and
  `latest_filing` (5.1).
- `GetStockFinancialHighlights` applies `extractiontrust` (4.1).
- `GetStockDetails`: `key_metrics` wins over the stale
  `financial_statements.info` for market_cap, pe_ratio, eps, dividend_yield,
  beta and the 52-week fields (`mergeKeyMetricsToInfo`, its tests).

### 5.4 Evaluator (`services/shorts/internal/strategies`)

- **`quality-compounders`** ("Quality compounders", house strategy,
  `RegimeGates: false`). Core rules:
  - `roe`: pass `roe_pct >= 15`; fail below 15 or when total equity <= 0;
    unknown when `roe_pct` is NULL for any other reason.
  - `net_margin`: pass `>= 10`; fail below; unknown when revenue is NULL or
    <= 0.
  - `cash_conversion`: pass FCF > 0 and FCF / NI >= 0.8; fail when NI <= 0,
    FCF <= 0 or ratio < 0.8; unknown when FCF or NI is NULL, or not meaningful
    (financials).
  - `leverage`: pass when net debt < 0, or net debt / COALESCE(normalized
    EBITDA, EBITDA) <= 2.5; fail above, or net debt > 0 with that EBITDA <= 0;
    unknown when net debt is NULL, EBITDA is NULL with net debt > 0, or not
    meaningful.
  - `liquidity` (existing).
  - trigger `above_sma200`: close above the 200-day average.
  Non-core `revenue_not_shrinking` (revenue YoY >= 0). Weights sum to 1. Prose
  states every threshold, that ratios use the reporting currency, that banks,
  insurers and other financials read unknown on cash conversion and leverage and
  so rank as watch at most, and that property trusts' profit and EBITDA include
  revaluations. A registry test evaluates a financial candidate and asserts its
  maximum status is watch.
- **EPS growth**: "still loss-making" and "turnaround" are judged on the SAME
  basis as the EPS figure (on ttm/half: turnaround = eps_latest > 0 and
  eps_prior <= 0 on that basis; the annual NI turnaround counts only when the
  EPS basis is annual or the latest annual is at least as new). eps_latest <= 0
  on the chosen basis without such a turnaround is `fail`. "Accelerating" only
  when the prior growth is positive.
- `revenueLabel` handles `ttm` as "12 months to <revenue_latest_period_end>";
  `halfYearEvidence` skips the revenue line when the basis is `ttm` or `half`.
- `FundamentalsRows(cands)`; `fundamentals_rows_count`; the coverage caveat is
  per strategy (growth rules vs quality rules).
- Every file that pins four strategies (registry, rules, weights, verdict and
  their tests; MCP id list; `shorts.proto` prose; web registry, tests,
  `isr-pages.json`, `/picks` DESCRIPTION/keywords, the hub OG subtitle, the
  landing picker card copy) is updated.

## 6. Report extraction (the parser)

### 6.1 Prod (Python, `services/report-extractor`)

- Pin `langextract==1.7.0` and `google-genai` at the version the image
  resolves today (recorded in requirements.txt).
- **Grounding**: drop extractions whose `char_interval` is None before storage;
  for numeric classes also require the value's digits inside the aligned span.
  Store per metric entry the STRING attributes `alignment`
  (`alignment_status.value`), `char_start`, `char_end`.
- **Thinking and tokens**: pass `lx.extract(model=BudgetedGemini(...))`, a
  subclass that adds `thinking_config=ThinkingConfig(thinking_budget=0)` to the
  per-prompt call and sums `usage_metadata` (prompt, candidates, thoughts) into
  a run total logged at exit; the digest call sets the same config. A
  stub-model test asserts the config reaches `generate_content`.
- **Synthetic few-shot**: the example becomes an obviously fictional document
  ("Quokka Minerals Limited", period "H1 FY2031", values that cannot collide
  with a real filing's own period), identical in Go (`reportextract`) and in
  `extractiontrust`'s new list.
- **`document_meta`** (2.5), from deterministic regexes over the raw text,
  written to the new column (checked once at start, omitted when absent).
- **Connections**: the selection connection runs with `autocommit = True`; no
  connection holds a transaction across a PDF download or a model call (a test
  asserts idle after selection).
- **Targeting**: statutory first via `IsResultsDocument`'s rules ported to
  Python (a shared fixture of titles asserted by both): drop presentations,
  Form 20-F, Pillar 3, webcasts, transcripts. Order: report_date within 45 days
  newest first, then companies with no metric-bearing extraction by market cap,
  then the rest by market cap. One document per company per run; drop
  `--top-shorted-first`.
- **Budget**: `--budget-min` (default 90): stop submitting new reports once it
  elapses, log the remaining count, exit cleanly. Log per-report wall time.
- `--max-pages 8`.

### 6.2 Throughput (`module.report_extractor`)

`reports_limit = 120`, daily `0 14 * * *`, workers 4 (and
`GEMINI_MAX_RUN_WORKERS` / `GEMINI_MAX_RUN_ITEMS` in step), max pages 8, job
timeout 7200 s, `max_retries = 0`. About 840 documents a week clears the
~2,146-company backlog in about three weeks, then keeps up with ~83 statutory
filings a week. `cost-guardrails.test.mjs` is updated deliberately with this
justification and added to `repo-hygiene.yml`'s `node --test` step. The prod
comment records the first run's measured wall time.

### 6.3 Go port (`services/jobs/internal/jobs/reportextract`)

Not deployed (its PDF engine splits digits). Parity only: the same synthetic
example, drop unaligned extractions, strip provenance keys before the digest
prompt.

## 7. Web

### 7.0 Shared (`web/src/@/lib/fundamentals/format.ts`)

One vocabulary for both surfaces: `n/a` = not held; `n/m` (title "not
meaningful for banks, insurers and other financials") for `not_meaningful`
ratios; `n/a (reports in USD)` for P/E and P/B of non-AUD reporters; `n/m` with
the raw figure in the title for growth above +500% or below -95%. One basis
label function returning `TTM`, `FY`, `HY`. Compact amounts in the reporting
currency, `$` only for AUD; a card mixing currencies prefixes non-AUD amounts
with the ISO code ("USD 4.29B"); prose writes "US$58.8B". DESIGN.md's currency
rule (its three mentions) is amended to match.

### 7.1 Stock page (`/shorts/[stockCode]`)

`getStockFundamentals.ts` requests every period type (limit 40), maps every
field (source, fetchedAt, fieldSources, document, quality, coverage,
latestFiling) in ONE mapper; cache key `v3`; tags gain `fundamentals`.
**Absent-field rule**: an unset `coverage` maps to status `unknown`; a null
result (API failure) renders nothing extra.

Financials tab (`web/src/@/components/stocks/financials-tab.tsx`, a
composition of props-only server cards plus ONE client island; the tax card and
the reports list arrive as ReactNode slots from `page.tsx`):
1. **Latest result**: the newest flow period's revenue, NPAT and EPS (basic when
   diluted is absent) vs the prior corresponding period, source and as-at per
   figure, a filing link only from `source_document_url`; the growth row from
   `FundamentalsGrowth` with the SAME labels and figures as the picker cells
   (a test renders one fixture through both); `latest_filing` prose labelled
   "Summary of <title>, <date>" when present. The raw extraction tiles are gone.
2. **Key ratios**: margins, ROE, ROA, FCF conversion, net debt (excl. leases)
   or net cash, net debt / EBITDA, current ratio, interest cover (">100x" above
   100), cash dividends paid / net profit, market cap, P/E, P/B; basis,
   balance lag and as-at; `n/m`/`n/a` rules from 7.0; the property caveat when
   `is_property`. `CompanyFinancials` ("Key metrics") is REMOVED from the tab
   and from `page.tsx`.
3. **Financial statements** (the client island, props-only, no `~/gen`, row
   definitions and formatters in the client module or `lib/fundamentals`; the
   server passes data only): Income | Balance sheet | Cash flow tabs; a leading
   TTM column only when the latest TTM row is newer than the latest annual and
   has revenue or NPAT; up to 4 FY columns; a Half toggle only when a half row
   has 2+ lines in the selected statement; Balance sheet never shows TTM and
   reads quarter snapshots as the half/year-end columns they fall on. A line
   renders only when a shown column has it; a column only when it has a shown
   line. Lines: Income = revenue, gross profit, operating income, EBITDA, EBIT,
   interest expense, pretax income, tax, NPAT, net interest income, EPS basic,
   EPS diluted, shares; Balance = total assets, total liabilities, equity,
   cash, total debt, lease liabilities, net debt (excl. leases), current assets,
   current liabilities; Cash flow = operating cash flow, capex, FCF, dividends
   paid, buybacks. A provenance glyph with sr-only text and a legend on every
   cell whose `fieldSources` key exists (never colour alone). The server shapes
   the props: at most 9 columns, only rendered lines, nulls omitted; a jest test
   asserts `JSON.stringify(props) <= 8192` bytes for a 40-period fixture.
   Replaces `FinancialStatementsSection` (removed from the page).
4. Reports list (newest first, future-dated rows dropped, token pills, the
   entry whose URL equals the Latest result's `source_document_url` marked
   "figures above come from this filing"), then the tax card LAST.
5. **Empty state** only when `periods` is empty AND `coverage.status` is
   `empty` ("Our data providers hold no financial statements for <code> (last
   checked <date>). The company's own filings are listed below."), `pending`
   ("Fundamentals not yet collected for <code>.") or `failed` ("Fundamentals
   for <code> could not be collected on <date>; the next run retries.").
   Copy never states or implies that a listed company publishes no statements.

Overview:
- **Strategy fit** in the Overview main column (SSR'd, crawlable links): per
  strategy the status pill (triggered/setup/watch, or "not a candidate" for
  `none`), score, "rank N of M", rule dots with the legend, linking to
  `/picks/<id>`; footer "Prices to <date> · Mechanical readings of published
  rules, not recommendations · Not financial advice" linking `/disclaimer`.
  Fetched by `getStockStrategyFit(code)` (unstable_cache key
  `['stock-strategy-fit', code, 'v1']`, revalidate 3600, tags
  `['strategy-picks', ...stockPageCacheTags('strategy-fit', code)]`,
  `serverFetchOutsideNextCache`, 4 s abort), errors thrown inside the cached
  function (never cached) and caught at the call site (card hidden); never in
  the page's critical `Promise.all`; a failure never fails the ISR render.
- A crawlable one-paragraph fundamentals summary, server-rendered, omitted
  (never guessed) without coverage.
- `CompanyInsightsCard` receives only the fields it reads (the 32 KB
  `financial_statements` JSONB leaves the payload).

Also: highlights cache fixed (errors not cached, tagged); the em dash fixed
in the financial, tax and peers cards (`n/a`) and their tests; a transitive
client-boundary test for `web/src/@/components/stocks/**` (the statements
island is the only `use client` file; nothing reaches `~/gen`,
`@bufbuild/protobuf`, `@connectrpc` or `app/actions`, `import type` excepted);
`formatDividendYield`'s `<= 1` heuristic fixed or given a unit.
An old-API jest case renders the page from an old-proto response (no coverage,
no quality, no latest filing, fit rpc rejecting) and asserts no empty state and
no fit card.

### 7.2 Picker (`/picks`, `/picks/[strategy]`)

- ONE mapper: `map.ts` is retyped to a structural, all-optional,
  JSON-compatible input; the server action and the sort island both use it (a
  test feeds one protojson fixture through both). `PickRow.fundamentals` holds
  only rendered fields, nulls omitted; the page test asserts the mapped rows
  stay within +25 KB of today's for a 100-row fixture.
- Growth cells show the basis (`TTM`/`FY`/`HY`) and a filing marker; header
  tooltips; a native `<details>` in the Stock cell (works in ISR HTML, no
  state) lists present ratios (n/m, n/a rules), basis, period end, source,
  fetched_at and "Full financials" (`/shorts/<code>?tab=financials`,
  `rel="nofollow"`, `prefetch={false}`); "No fundamentals held for <code> yet"
  when null. The code/name link and hub leaders stay canonical `/shorts/<code>`.
  colSpan and the pinned n/a count updated.
- **Sort**: `web/src/app/picks/[strategy]/picks-sorted-view.tsx` (`use
  client`) replaces `PicksStatusFilter` as the Suspense child
  (`PicksFilterView` stays the fallback). It reads `?status=` and `?sort=` via
  `useSearchParams`; with no sort (or `score`) it renders the server rows as
  today; with a sort it POSTs JSON `{strategyId, sortBy, status, limit: 100}` to
  `/shorts.v1alpha1.StrategyService/GetStrategyPicks` (the existing rewrite;
  no `~/gen`, no `@connectrpc` in the browser), shows the server rows dimmed
  with `aria-busy` while loading, and keeps them with "Sorting is unavailable
  right now" on a non-200 or a 10 s timeout; if the response is in rank order
  (an old API) it sorts the loaded rows client-side. Chips preserve `?sort=`;
  sorting applies within the selected status; the summary reads "Top 100 of N
  by <metric>"; a sort by a metric that is not a column adds one right-aligned
  "Sorted by" column via a hook-free `sortKey` prop. Fetch and mapper load
  lazily on first interaction. The kit's client-file list and boundary tests
  are updated.
- Coverage copy: "fundamentals for N of M stocks (growth figures for K)" with
  thousands separators, only when `fundamentals_rows_count > 0 &&
  fundamentals_rows_count >= fundamentals_coverage_count`; otherwise today's
  copy ("growth figures for K of M stocks").
- `RuleLegend`: "Unknown (data missing, or not meaningful for this company)";
  the strategy panel and hub sentences match. Cache keys
  `strategy-picks-*-v2`. The `quality-compounders` registry entry and every
  list in 5.4.

## 8. MCP (`services/shorts/internal/mcp`)

Budgets bind (per call 16,384 B; tools/list 90,112 B; about 1.4 KB left after
this section; every description edit must fit).
- `get_stock_fundamentals`: `maxFundamentalsLimit = 24`; add a `quality`
  object (with `balance_currency`, `not_meaningful`), `coverage`, four
  per-period fields (`operating_income`, `total_equity`, `net_debt`,
  `capital_expenditure`) and `field_sources` (omitempty) per period; description
  becomes "valuation ratios use the latest close; no short data".
- `get_strategy_picks`: `sort_by`; `quality-compounders` in the id list; per
  pick `roe_pct`, `net_margin_pct`, `fundamentals_source` ('filing' when either
  basis source is filing); output `fundamentals_rows_count`; the 1-25 range
  stays with `maxPickEvidenceBytes = 1500`.
- The budget fixture (`realisticStrategySource`) sets every new field (a
  two-key `field_sources` per period, a full quality, coverage, and
  `StrategyPick.fundamentals` with both basis sources 'filing').
- No new tool. Admin `run_picks_job`'s next-step text points at
  `fundamentals_rows_count`, not "near the universe".
- `content/coverage.md`, `web/public/llms*.txt`, `web/public/docs/mcp-markdown.md`
  updated.

## 9. Rollout

1. Do not merge while `financial-report-extractor` is executing. The deploy
   applies 000132 (session pooler) before the image swap; a failure blocks the
   API swap while Vercel still deploys, and the web renders old-API responses
   as today.
2. Immediately after the deploy: `run_picks_job {mode: "filings"}` then
   `{mode: "refresh"}` (seconds, no Yahoo): the echo, comparative, segment,
   LFT and DRO rows go the same hour. Early full runs must start before 12:20
   UTC or after the scheduled 15:00 run has finished (the lease also prevents
   overlap).
3. The 15:00 UTC `-mode all` covers the universe when it fits in 170 min at
   4 s; any remainder, lowest priority first, carries to the next night.
4. After the second nightly run: `fundamentals_rows_count` near the
   vendor-publishable universe (about 75% of codes), BHP/CSL/WES/FMG with full
   statements, no row with revenue 5,142,000,000 and NPAT 1,823,000,000, EDV
   EPS growth near -17%; by-eye check of the codes that had both vendor and
   filing rows before deploy.

## 10. Out of scope (recorded)

- The frozen `key_metrics` writer (`SyncKeyMetrics` forks python on a
  scale-to-zero API; nothing written since about 2026-08-21). The precedence
  flip stops the stale snapshot winning; valuation now comes from our own
  close x shares.
- Dividend history and franking in `stock_fundamentals`; analyst consensus
  (quoteSummary crumb); a `/shorts/[code]/financials` route; FX conversion for
  non-AUD valuation.

## 11. Phases and file ownership

Phase 0, sequential, landed before any fan-out:
- (a) **contract**: protos + `make openapi` outputs (5.0).
- (b) **picks-base** (no behaviour change; `columns.go` holds the column
  table every stream iterates, owned by vendor afterwards): move the filing SQL functions from
  `store.go` to `filings_store.go`; add `PeriodRow` fields for every new
  column plus `FieldSources map[string]string`, `Rejected []string`,
  `SourceDocumentURL`, `SourceDocumentDate`; extend `storable()`.
- (c) **trust**: `services/pkg/extractiontrust` with the old and new few-shot
  texts (the new synthetic example fixed here).
- (d) **format**: `web/src/@/lib/fundamentals/format.ts` + tests.

Phase 1, parallel worktrees (merge order as listed):

| Stream | Owns |
|---|---|
| data | `services/migrations/000132_*` + node test, `picks/migration132_pg_test.go`, the allowlist, `PROD_APPLIED.md`, `scripts/prod-psql-classify.mjs` if needed |
| vendor | `picks/{store,rows,yahoo,markit,fetcher,fundamentals,selection,job,refresh}.go` logic + tests/testdata, lease, revalidation, `module "shorted_job_picks"` |
| filings | `picks/filings*.go`, `picks/filings_store.go`, `reportextract/**`, `weeklyreport` collector (+ retired generator if it compiles against `services/pkg`) |
| extractor | `services/report-extractor/**`, `terraform/modules/report-extractor/**`, `module "report_extractor"`, `repo-hygiene.yml` |
| api | `services/shorts/internal/{strategies,store/shorts,services/shorts}/**`, mocks via `go generate` |
| web-stock | stock page, `components/{stocks,company}`, stock actions, `DESIGN.md` |
| web-picks | `app/picks/**`, `components/picks/**`, `lib/strategies/**`, picks actions, `config/isr-pages.json`, landing card copy |

Phase 2: **mcp** (after api's registry lands). Phase 3: **docs** (CLAUDE.md,
`services/jobs/README.md` "picks", `docs/plans/stock-picker.md`, MCP docs).
Only prod `main.tf` is shared (vendor and extractor, disjoint hunks).
