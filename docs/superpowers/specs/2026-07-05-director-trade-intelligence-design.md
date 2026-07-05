# Director Trade Intelligence - Buyer/Seller Rollups

**Date:** 2026-07-05
**Status:** Design - pending review
**Scope:** Enhance ASX Appendix 3Y director trade extraction, API responses, stock page presentation, and chat/tool reuse.

---

## 1. Goal

Turn Shorted's existing director trade feed into a clearer insider activity product surface. For each stock, users should quickly understand whether directors have recently been net buyers or sellers, how much activity is backed by extracted Appendix 3Y details, and which filings support the numbers.

The feature will deliver:

- a stock-level director activity rollup: buy value, sell value, net value, buyer/seller counts, latest activity, option/exercise count, and extraction coverage;
- per-director grouping so users can focus on one director's behavior over time;
- drilldown rows with source-backed filing details: direct/indirect interest, registered holder, securities class, nature of change, acquired/disposed quantities, consideration, extraction confidence, and source PDF;
- enriched API data that also improves chat answers and timeline context.

This intentionally does not promise true market counterparties. ASX Appendix 3Y notices usually disclose the director, holder/beneficial interest, securities changed, and consideration, but not the person or institution on the other side of the trade.

---

## 2. Current State

Shorted already has the foundations:

- `services/asx-announcement-crawler` stores Appendix 3Y announcement rows into `director_trades` using headline-level parsing.
- `services/report-extractor/extract_director_trades.py` fetches Appendix 3Y PDFs and asks Gemini to extract richer structured data.
- `director_trades` currently stores only `director_name`, `trade_type`, `shares_traded`, `price_per_share`, `total_value`, `trade_date`, and `announcement_url`.
- `GetDirectorTrades` returns a flat list of trades.
- `web/src/@/components/company/director-trades-table.tsx` renders a simple table on the stock page.
- `chat-service` exposes a `get_director_trades` tool, so API improvements are reusable by AI answers.
- `GetEventTimeline` already merges director trades into the per-stock timeline.

The gap is that the extractor already sees richer fields such as `securities_class`, `number_acquired`, `number_disposed`, `nature_of_change`, `interest_type`, and `confidence`, but `derive_trade()` discards most of them before updating Postgres. The UI also makes users read row-by-row instead of showing the net director buying/selling story.

---

## 3. Product Behavior

### Summary

The Directors tab should start with a compact rollup for the selected stock:

- **Net director activity:** buy value minus sell value over the selected window.
- **Buyers vs sellers:** number of distinct directors with at least one buy or sell.
- **Buy/sell volume:** total buy value, total sell value, acquired shares, disposed shares.
- **Latest activity:** latest filing/trade date and the director involved.
- **Options/exercises:** count and value where applicable, kept separate from open-market buys/sells.
- **Coverage:** extracted rows vs total rows, plus low-confidence count.

Default window should be 12 months, with controls for 90 days, 12 months, and all available history. The backend should accept the window so chat/API clients get the same rollup semantics as the UI.

### Drilldown

Below the summary, users can inspect details in two ways:

- **Director groups:** each director row shows their buy value, sell value, net value, latest activity, and trade count. Expanding the group shows the individual filings.
- **Trade rows:** each filing shows date, direction, securities, acquired/disposed quantity, consideration, price per share, nature of change, direct/indirect interest, registered holder, confidence, and the source PDF link.

Filters:

- direction: all, buys, sells, options/exercises, unknown;
- confidence: all, extracted only, low confidence;
- director: select one director from the available groups.

The UI should avoid presenting inferred numbers as exact when the filing did not disclose enough data. Missing consideration or quantity should be visibly shown as unknown and excluded from value totals.

Summary and grouping always aggregate the full selected filter set before row limiting. `limit` controls only the number of individual trade rows returned for display.

---

## 4. Data Model

Add additive migrations `services/migrations/000071_enhance_director_trades.up.sql` and `services/migrations/000071_enhance_director_trades.down.sql`, extending `director_trades`. `000070_add_short_campaigns_mv` already exists, so `000071` is the next available migration number.

```sql
ALTER TABLE director_trades
  ADD COLUMN IF NOT EXISTS direction TEXT,
  ADD COLUMN IF NOT EXISTS securities_class TEXT,
  ADD COLUMN IF NOT EXISTS number_acquired BIGINT,
  ADD COLUMN IF NOT EXISTS number_disposed BIGINT,
  ADD COLUMN IF NOT EXISTS consideration_aud NUMERIC(18, 2),
  ADD COLUMN IF NOT EXISTS nature_of_change TEXT,
  ADD COLUMN IF NOT EXISTS interest_type TEXT,
  ADD COLUMN IF NOT EXISTS registered_holder TEXT,
  ADD COLUMN IF NOT EXISTS extraction_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_model TEXT;
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_director_trades_stock_direction_date
  ON director_trades (stock_code, direction, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_director_trades_stock_director_date
  ON director_trades (stock_code, director_name, trade_date DESC);
```

Down migration:

```sql
DROP INDEX IF EXISTS idx_director_trades_stock_director_date;
DROP INDEX IF EXISTS idx_director_trades_stock_direction_date;

ALTER TABLE director_trades
  DROP COLUMN IF EXISTS extraction_model,
  DROP COLUMN IF EXISTS extracted_at,
  DROP COLUMN IF EXISTS extraction_confidence,
  DROP COLUMN IF EXISTS registered_holder,
  DROP COLUMN IF EXISTS interest_type,
  DROP COLUMN IF EXISTS nature_of_change,
  DROP COLUMN IF EXISTS consideration_aud,
  DROP COLUMN IF EXISTS number_disposed,
  DROP COLUMN IF EXISTS number_acquired,
  DROP COLUMN IF EXISTS securities_class,
  DROP COLUMN IF EXISTS direction;
```

Field rules:

| Field | Meaning |
|---|---|
| `direction` | Canonical activity direction: `buy`, `sell`, `exercise_options`, `other`, or `unknown`. Existing `trade_type` remains for compatibility and mirrors this value where possible. |
| `number_acquired` / `number_disposed` | Raw Appendix 3Y quantities. These are kept even when a transaction is classified as an option exercise. |
| `consideration_aud` | Raw total consideration disclosed by the filing. Existing `total_value` mirrors this where possible. |
| `interest_type` | `direct`, `indirect`, or `unknown`. |
| `registered_holder` | Holder or beneficial owner named in the Appendix 3Y form when disclosed. |
| `extraction_confidence` | Model confidence for the extracted director name and transaction figures. |
| `extracted_at` / `extraction_model` | Provenance for extraction freshness and model identity. |

Existing rows remain valid. Backfilled rows can be progressively enriched by rerunning the extractor.

Successful extraction must fill text fields with explicit sentinel values when a fact is not disclosed, rather than leaving them null:

- `registered_holder = 'Not disclosed'` when the form does not name a holder;
- `securities_class = 'Unknown'` when the class cannot be identified;
- `nature_of_change = 'Unknown'` when the nature cannot be identified;
- `interest_type = 'unknown'` when direct/indirect status cannot be identified.

Null in these columns means "not enriched yet" or "legacy row", not "the filing omitted this fact".

Old-row fallback rules:

- effective direction is `COALESCE(direction, trade_type, 'unknown')`;
- effective consideration is `COALESCE(consideration_aud, total_value)`;
- effective acquired quantity falls back to `shares_traded` when effective direction is `buy`;
- effective disposed quantity falls back to `shares_traded` when effective direction is `sell`;
- option/exercise rows keep raw acquired/disposed quantities when present and otherwise fall back to `shares_traded` only for display, not for buy/sell net share totals.

---

## 5. Extraction Design

Update `services/report-extractor/extract_director_trades.py` to preserve the structured facts it already extracts.

Prompt changes:

- keep current fields;
- add `registered_holder`;
- require `direction` as one of `buy`, `sell`, `exercise_options`, `other`, or `unknown`;
- require a short `extraction_notes` field only for internal logging or dry-run output, not persisted in the first implementation.

Derivation rules:

- If `number_acquired > number_disposed` and the nature of change is not option/right exercise, classify as `buy`.
- If `number_disposed > number_acquired`, classify as `sell`.
- If nature contains option exercise, conversion, vesting, performance right, or rights issue, classify as `exercise_options` unless the filing clearly reports an on-market sale.
- If quantities are missing but the nature contains purchase/acquisition/sale/disposal, classify from the nature text and mark confidence accordingly.
- If classification is unclear, set `direction = unknown` and leave existing totals untouched unless the new extraction is higher confidence than prior data.

Update policy:

- Update all rows matching `announcement_url` because the current dedup model keys enrichment by URL.
- Preserve existing non-null values when the new extraction is missing or lower confidence.
- Set `extracted_at = NOW()` and `extraction_model = EXTRACT_MODEL` when any enrichment succeeds.
- Record failures in `director_extract_attempts` as today.

Backfill candidate selection must change from the current narrow condition:

```sql
director_name = 'Unknown Director' OR total_value IS NULL
```

to a richer missing-enrichment condition:

```sql
director_name = 'Unknown Director'
OR total_value IS NULL
OR direction IS NULL
OR securities_class IS NULL
OR nature_of_change IS NULL
OR interest_type IS NULL
OR registered_holder IS NULL
OR extraction_confidence IS NULL
```

This lets already-valued rows be revisited for the new detail fields. To avoid repeatedly selecting successfully extracted rows where the filing omitted a fact, the extractor writes the sentinel values from Section 4 for legitimate non-disclosure or unidentifiable text fields. The existing `--priority recent`, `--priority unknown`, and `--priority top-shorted` modes remain, but each mode applies the richer missing-enrichment predicate.

The headline crawler can stay lightweight. It should continue seeding candidate rows from announcements; PDF extraction remains the source of rich trade detail.

---

## 6. API Design

Extend `DirectorTrade` without breaking existing clients. Existing scalar fields remain for compatibility. New numeric fields use proto3 `optional` so generated clients can distinguish unknown from zero.

```proto
message DirectorTrade {
  string id = 1;
  string stock_code = 2;
  string director_name = 3;
  string trade_type = 4;
  int64 shares_traded = 5;
  double price_per_share = 6;
  double total_value = 7;
  string trade_date = 8;
  string announcement_url = 9;

  string direction = 10;
  string securities_class = 11;
  optional int64 number_acquired = 12;
  optional int64 number_disposed = 13;
  optional double consideration_aud = 14;
  string nature_of_change = 15;
  string interest_type = 16;
  string registered_holder = 17;
  optional double extraction_confidence = 18;
  string extracted_at = 19;
  string extraction_model = 20;
}
```

Add summary messages:

```proto
message DirectorActivitySummary {
  string stock_code = 1;
  string window = 2;
  int32 total_trades = 3;
  int32 extracted_trades = 4;
  int32 low_confidence_trades = 5;
  int32 buyer_count = 6;
  int32 seller_count = 7;
  int32 option_exercise_count = 8;
  double option_exercise_value = 9;
  double total_buy_value = 10;
  double total_sell_value = 11;
  double net_value = 12;
  int64 total_acquired = 13;
  int64 total_disposed = 14;
  string latest_trade_date = 15;
  string latest_director_name = 16;
  int32 missing_value_trades = 17;
  int32 unknown_direction_trades = 18;
}

message DirectorActivityByDirector {
  string director_name = 1;
  int32 trade_count = 2;
  double buy_value = 3;
  double sell_value = 4;
  double net_value = 5;
  int64 acquired = 6;
  int64 disposed = 7;
  string latest_trade_date = 8;
  int32 missing_value_trades = 9;
}
```

Summary semantics:

| Field | Rule |
|---|---|
| `total_trades` | Count of all rows matching stock, window, direction, confidence, and director filters before `limit`. |
| `extracted_trades` | Rows with `extracted_at IS NOT NULL`, `extraction_confidence >= 0.50`, and at least one enriched field beyond the legacy columns. Sentinel text values such as `Not disclosed` count as enriched because they distinguish a completed extraction from a legacy null. |
| `low_confidence_trades` | Rows with `extraction_confidence > 0` and `< 0.70`. |
| `missing_value_trades` | Rows whose effective direction is buy/sell/exercise but whose effective consideration is unknown. |
| `unknown_direction_trades` | Rows whose effective direction is `unknown`, empty, or not one of `buy`, `sell`, `exercise_options`, or `other`. |
| `buyer_count` / `seller_count` | Distinct director names with at least one effective buy/sell row in the filtered set. |
| `option_exercise_value` | Sum of effective consideration for `exercise_options` rows only. Missing values are excluded. |
| `net_value` | `total_buy_value - total_sell_value`; option/exercise value is reported separately and does not affect net buy/sell value. |
| `total_acquired` / `total_disposed` | Sum of effective acquired/disposed quantities for buy/sell rows. Option/exercise quantities are excluded from these net share totals. |

Per-director semantics mirror the stock-level summary for each director group.

Extend the response:

```proto
message GetDirectorTradesResponse {
  repeated DirectorTrade trades = 1;
  int32 total_count = 2;
  DirectorActivitySummary summary = 3;
  repeated DirectorActivityByDirector by_director = 4;
}
```

`total_count` is the count of matching rows before `limit`, aligned with `summary.total_trades`.

Extend request with optional filters:

```proto
message GetDirectorTradesRequest {
  string stock_code = 1;
  int32 limit = 2;
  string window = 3;             // "90d", "12m", "all"; default "12m"
  string direction = 4;          // "all", "buy", "sell", "exercise_options", "unknown"
  string confidence_filter = 5;  // "all", "extracted", "low_confidence"; default "all"
  string director_name = 6;      // exact director group focus; empty means all directors
}
```

Filter semantics:

- `window`, `direction`, `confidence_filter`, and `director_name` apply to `trades`, `summary`, and `total_count`.
- `by_director` applies `window`, `direction`, and `confidence_filter`; when `director_name` is set, it returns that director group only.
- `limit` applies only to `trades`; summary and by-director aggregation must be computed over the full matching set.
- `confidence_filter = "extracted"` applies the same predicate as `extracted_trades`.
- `confidence_filter = "low_confidence"` returns rows with `extraction_confidence > 0` and `< 0.70`.
- `direction = "unknown"` returns rows counted by `unknown_direction_trades`.

Generated-code steps:

1. Update `proto/shortedapi/shorts/v1alpha1/shorts.proto`.
2. Run `buf generate` from `proto/` so Go, TypeScript, connect-query, and Java SDK outputs stay in sync with `proto/buf.gen.yaml`.
3. Update service mocks generated from interfaces after the Go interface changes.

Aggregation should happen in the Go store/service layer from the filtered row set. This keeps the database schema simple, avoids a rollup table, and lets tests validate the business rules directly.

Cache key must include `stock_code`, `limit`, `window`, `direction`, `confidence_filter`, and `director_name`.

---

## 7. Backend Read Model

Add a small internal model boundary:

- `DirectorTrade`: enriched row facts from Postgres.
- `DirectorActivitySummary`: stock-level aggregate.
- `DirectorActivityByDirector`: per-director aggregate.

Store responsibilities:

- query enriched rows by stock, window, direction, confidence filter, and director name, newest first;
- handle null columns from old rows;
- compute aggregate counts and sums over the full filtered set before applying `limit` to individual trade rows;
- return limited trade rows plus full-window `summary` and `by_director` aggregates.

Service responsibilities:

- validate request defaults and accepted filter values;
- map store models to proto;
- compute or forward summary and grouped aggregates;
- preserve existing error behavior for invalid stock codes and database failures.

Compute summary directly in Go for this implementation. A materialized view remains a compatible performance optimization because the public API shape is independent of the read-model internals.

---

## 8. Frontend Design

Replace the current simple `DirectorTradesTable` body with a richer `DirectorActivityPanel` while keeping the component local to the company stock page. Also update the existing `/insider-trading` hub and `/insider-trading/[stockCode]` detail route so they use the same enriched API fields and do not drift from the Directors tab.

Layout:

- top summary band with four compact metrics: net activity, buyers/sellers, total disclosed value, coverage;
- segmented controls for window and direction;
- per-director grouped list/table;
- expandable detail rows for filings;
- source PDF link remains visible in detail rows.

States:

- loading skeleton for summary and rows;
- empty state: "No director activity found";
- partial data state: show coverage and avoid hiding rows with missing values;
- low-confidence rows: visible confidence indicator and source link, not excluded by default.

Accessibility:

- expansions use buttons with `aria-expanded`;
- filter controls have accessible labels;
- numeric values use text alternatives, not color alone, to distinguish net buy/sell.

Visual constraints:

- keep the Directors tab operational and data-dense, consistent with the existing company page;
- avoid nested cards;
- keep mobile usable by stacking summary metrics and turning row details into expandable blocks.

---

## 9. Chat And Timeline Reuse

Chat tool:

- Update `get_director_trades` description to mention net buyer/seller rollups and source-backed detail.
- Add optional `window` and `direction` tool parameters so chat can answer non-default rollup questions.
- The tool executor can continue calling `GetDirectorTrades`; richer response fields will automatically improve answers.

Timeline:

- Update `GetEventTimeline` director trade detail text to use richer direction and value where available.
- Keep timeline lightweight; it should link to the same source PDF and not duplicate the full Directors tab.

---

## 10. Rollout Plan

1. Add migration and generated types.
2. Update extractor to persist enriched fields.
3. Add backend store/service aggregation and tests.
4. Update frontend panel and component tests.
5. Update `/insider-trading` routes and chat tool parameters.
6. Run extractor dry-run on a small recent/top-shorted sample.
7. Run extractor for priority `top-shorted` first, then recent rows.
8. Validate a known stock page manually and with Playwright.

The feature is backwards compatible. Old rows will render with partial coverage until enrichment runs.

---

## 11. Error Handling And Data Quality

- Missing PDF text: leave existing row unchanged and record `no_pdf`.
- Model JSON failure: leave existing row unchanged and record `no_extract`.
- Low confidence: persist confidence only if core extracted facts are usable; otherwise keep existing values.
- Missing value/quantity: include row in trade count but exclude missing amounts from value/share totals.
- Multiple changes in one notice: preserve summed acquired/disposed/consideration, and keep `nature_of_change` as a concise combined phrase.
- Conflicting existing/new values: prefer higher-confidence extracted values; otherwise keep existing non-null values.
- Unknown direction: rows whose effective direction is `unknown`, empty, or non-canonical count separately in total trades and coverage, but are excluded from buy/sell/net totals.
- Old rows without `direction`: derive effective direction from `trade_type` for summary/filter compatibility.
- Low confidence threshold: `< 0.70`; minimum persistence threshold for core facts: `>= 0.50`.
- Extracted coverage threshold: count as extracted only when `extracted_at` is present, `extraction_confidence >= 0.50`, and at least one enriched field beyond legacy columns is present. Sentinel text values from Section 4 count as enriched.

Data displayed to users should distinguish disclosed facts from inferred classifications. Source PDF links remain the final audit path.

---

## 12. Testing And Validation

Backend:

- migration applies and rolls back cleanly on a local/dev database;
- generated proto outputs are updated from `buf generate`;
- extractor unit tests for `derive_trade()` covering buy, sell, option exercise, missing consideration, registered holder, and low confidence;
- Go store tests for null enriched fields, legacy fallback fields, filtered windows, and aggregation-before-limit semantics;
- service tests for summary aggregation, by-director aggregation, and cache key changes;
- timeline test for enriched director trade detail formatting.

Frontend:

- component tests for summary metrics, filters, grouped director drilldown, missing values, and low-confidence rows;
- runtime test for `/shorts/[stockCode]` Directors tab rendering with generated API data;
- regression test coverage for `/insider-trading` and `/insider-trading/[stockCode]` using the enriched response shape;
- Playwright e2e covering open stock page, switch to Directors tab, change window/direction, expand a director, and verify source PDF link exists.

Operational validation:

- `extract_director_trades.py --dry-run --priority top-shorted --limit 20` before writing data;
- sample SQL check for extraction coverage before/after backfill;
- inspect one known Appendix 3Y source PDF against rendered row details.

---

## 13. Non-Goals

- Do not infer undisclosed external counterparties.
- Do not add a separate materialized rollup table in the first implementation.
- Do not replace the existing announcement crawler with full PDF parsing.
- Do not redesign the whole stock page; this is scoped to the Directors tab and reusable API data.
