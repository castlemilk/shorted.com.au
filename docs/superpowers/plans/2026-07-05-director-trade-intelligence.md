# Director Trade Intelligence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build richer source-backed director buy/sell intelligence with stock-level rollups, per-director drilldown, enriched Appendix 3Y extraction, and shared stock-page/insider-page UI.

**Architecture:** Keep the database as the source of truth by enriching `director_trades`, then compute full-window rollups in the Go store/service layer before applying row limits. Split frontend into a query/container component plus a presentational view so the stock Directors tab and `/insider-trading/[stockCode]` can share the same drilldown surface.

**Tech Stack:** Postgres migrations, Go + Connect RPC + buf-generated clients, Python `pytest` extractor tests, Next.js/React + TanStack Query + shadcn-style UI primitives, Jest/Testing Library, Playwright.

---

## Source Documents

- Spec: `docs/superpowers/specs/2026-07-05-director-trade-intelligence-design.md`
- Project instructions: `AGENTS.md`
- Use during implementation: `@superpowers:test-driven-development`, `@superpowers:subagent-driven-development`, `@superpowers:verification-before-completion`

## File Structure

### Backend Schema And API

- Create: `services/migrations/000071_enhance_director_trades.up.sql`
- Create: `services/migrations/000071_enhance_director_trades.down.sql`
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto`
- Generated: `services/gen/proto/go/shorts/v1alpha1/shorts.pb.go`
- Generated: `services/gen/proto/go/shorts/v1alpha1/shorts.connect.go`
- Generated: `web/src/gen/shorts/v1alpha1/shorts_pb.ts`
- Generated: `web/src/gen/shorts/v1alpha1/shorts-ShortedStocksService_connectquery.ts`
- Generated: `sdks/java/src/main/java/com/shorts/v1alpha1/*.java`

### Backend Domain, Store, Service

- Modify: `services/shorts/internal/store/shorts/store.go`
- Modify: `services/shorts/internal/store/shorts/postgres_directors.go`
- Create: `services/shorts/internal/store/shorts/director_activity.go`
- Create: `services/shorts/internal/store/shorts/director_activity_test.go`
- Create or modify: `services/shorts/internal/store/shorts/postgres_directors_test.go`
- Modify: `services/shorts/internal/services/shorts/interfaces.go`
- Generated: `services/shorts/internal/services/shorts/mocks/mock_interfaces.go`
- Modify: `services/shorts/internal/services/shorts/cache.go`
- Modify: `services/shorts/internal/services/shorts/validation.go`
- Modify: `services/shorts/internal/services/shorts/validation_test.go`
- Modify: `services/shorts/internal/services/shorts/director_trades.go`
- Create: `services/shorts/internal/services/shorts/director_trades_test.go`
- Modify: `services/shorts/internal/store/shorts/postgres_timeline.go`
- Modify or create: `services/shorts/internal/services/shorts/event_timeline_test.go`

### Extractor And Chat

- Modify: `services/report-extractor/extract_director_trades.py`
- Create: `services/report-extractor/test_extract_director_trades.py`
- Modify: `services/chat-service/tools.go`
- Modify: `services/chat-service/tool_executor.go`
- Create or modify: `services/chat-service/tool_executor_test.go`

### Frontend

- Create: `web/src/@/components/company/director-activity-types.ts`
- Create: `web/src/@/components/company/director-activity-utils.ts`
- Create: `web/src/@/components/company/director-activity-view.tsx`
- Create: `web/src/@/components/company/director-activity-panel.tsx`
- Modify: `web/src/@/components/company/director-trades-table.tsx` or replace usages and delete it after no imports remain
- Modify: `web/src/@/components/company/stock-tabs.tsx`
- Create: `web/src/@/components/company/__tests__/director-activity-utils.test.ts`
- Create: `web/src/@/components/company/__tests__/director-activity-view.test.tsx`
- Create: `web/src/@/components/company/__tests__/director-activity-panel.test.tsx`
- Modify: `web/src/app/actions/getDirectorTrades.ts`
- Modify: `web/src/app/insider-trading/page.tsx`
- Modify: `web/src/app/insider-trading/[stockCode]/page.tsx`
- Create: `web/src/app/insider-trading/[stockCode]/__tests__/page-runtime.test.tsx`
- Modify: `web/e2e/helpers/api-mock.ts`
- Create: `web/e2e/director-activity.spec.ts`

---

## Chunk 1: Schema, Proto, And Generated Surface

### Task 1: Add Director Trade Enrichment Migration

**Files:**
- Create: `services/migrations/000071_enhance_director_trades.up.sql`
- Create: `services/migrations/000071_enhance_director_trades.down.sql`

- [ ] **Step 1: Verify migration number is still available**

Run:

```bash
rtk ls services/migrations | rtk tail -20
```

Expected: `000070_add_short_campaigns_mv.*.sql` exists and no `000071_*` file exists.

- [ ] **Step 2: Create the up migration**

Add this file:

```sql
-- services/migrations/000071_enhance_director_trades.up.sql
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

CREATE INDEX IF NOT EXISTS idx_director_trades_stock_direction_date
  ON director_trades (stock_code, direction, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_director_trades_stock_director_date
  ON director_trades (stock_code, director_name, trade_date DESC);
```

- [ ] **Step 3: Create the down migration**

Add this file:

```sql
-- services/migrations/000071_enhance_director_trades.down.sql
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

- [ ] **Step 4: Validate the migration against a real local database**

Preferred path when `DATABASE_URL` is already configured for a disposable local database:

```bash
cd services
rtk make migrate-install
rtk test -n "$DATABASE_URL"
rtk make migrate-up
rtk make migrate-version
rtk make migrate-down
rtk make migrate-up
```

Expected: the new migration applies, `migrate-version` reports version `71`, the one-step rollback succeeds, and re-applying succeeds.

If `DATABASE_URL` is not configured, start the repo's Docker test database and run the same up/down/up cycle against it:

```bash
cd services
rtk make test-stack-up
rtk make migrate-install
export DATABASE_URL="postgresql://test_user:test_password@localhost:5433/shorts_test?sslmode=disable"
rtk make migrate-up
rtk make migrate-version
rtk make migrate-down
rtk make migrate-up
```

Expected: every command exits successfully. Do not commit this task until one of these two validation paths has passed.

- [ ] **Step 5: Commit migration**

```bash
rtk git add services/migrations/000071_enhance_director_trades.up.sql services/migrations/000071_enhance_director_trades.down.sql
rtk git commit -m "feat(directors): add director trade enrichment columns"
```

### Task 2: Extend The Director Trades Proto Contract

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto`
- Generated: `services/gen/proto/go/shorts/v1alpha1/shorts.pb.go`
- Generated: `services/gen/proto/go/shorts/v1alpha1/shorts.connect.go`
- Generated: `web/src/gen/shorts/v1alpha1/shorts_pb.ts`
- Generated: `web/src/gen/shorts/v1alpha1/shorts-ShortedStocksService_connectquery.ts`
- Generated: `sdks/java/src/main/java/com/shorts/v1alpha1/*.java`

- [ ] **Step 1: Update proto messages**

In `proto/shortedapi/shorts/v1alpha1/shorts.proto`, replace the Director Trades message block with:

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

message GetDirectorTradesRequest {
  string stock_code = 1;
  int32 limit = 2;
  string window = 3;
  string direction = 4;
  string confidence_filter = 5;
  string director_name = 6;
}

message GetDirectorTradesResponse {
  repeated DirectorTrade trades = 1;
  int32 total_count = 2;
  DirectorActivitySummary summary = 3;
  repeated DirectorActivityByDirector by_director = 4;
}
```

- [ ] **Step 2: Generate all proto outputs**

Run:

```bash
cd proto
rtk buf generate
```

Expected: Go, TypeScript, connect-query, and Java generated files update without generation errors.

- [ ] **Step 3: Verify generated optional fields exist**

Run:

```bash
cd /Users/benebsworth/projects/shorted
rtk rg -n "NumberAcquired|numberAcquired|DirectorActivitySummary|ConfidenceFilter" services/gen/proto/go web/src/gen sdks/java/src/main/java/com/shorts/v1alpha1
```

Expected: matches in Go, TypeScript, and Java outputs.

- [ ] **Step 4: Commit proto and generated outputs**

```bash
rtk git add proto/shortedapi/shorts/v1alpha1/shorts.proto services/gen/proto/go/shorts/v1alpha1 web/src/gen/shorts/v1alpha1 sdks/java/src/main/java/com/shorts/v1alpha1
rtk git commit -m "feat(directors): extend director trades API contract"
```

---

## Chunk 2: Backend Store, Service, Cache, Timeline

### Task 3: Add Store Domain Types And Aggregation Tests

**Files:**
- Modify: `services/shorts/internal/store/shorts/store.go`
- Create: `services/shorts/internal/store/shorts/director_activity.go`
- Create: `services/shorts/internal/store/shorts/director_activity_test.go`

- [ ] **Step 1: Add failing aggregation tests**

Create `services/shorts/internal/store/shorts/director_activity_test.go` with tests named:

```go
func TestBuildDirectorActivityResult_AggregatesBeforeLimit(t *testing.T)
func TestBuildDirectorActivityResult_UsesLegacyFallbacks(t *testing.T)
func TestBuildDirectorActivityResult_DistinguishesUnknownFromZero(t *testing.T)
func TestBuildDirectorActivityResult_FiltersByDirectionConfidenceAndDirector(t *testing.T)
```

Use fixtures like:

```go
func f64(v float64) *float64 { return &v }
func i64(v int64) *int64 { return &v }

rows := []*DirectorTrade{
  {
    ID: "buy-1", StockCode: "CBA", DirectorName: "Jane Buyer",
    TradeType: "buy", Direction: strPtr("buy"), SharesTraded: 1000,
    TotalValue: f64(10000), ConsiderationAUD: f64(10000),
    NumberAcquired: i64(1000), TradeDate: "2026-06-10",
    ExtractedAt: strPtr("2026-06-11T00:00:00Z"), ExtractionConfidence: f64(0.92),
  },
  {
    ID: "sell-1", StockCode: "CBA", DirectorName: "Sam Seller",
    TradeType: "sell", Direction: strPtr("sell"), SharesTraded: 250,
    TotalValue: f64(3000), ConsiderationAUD: f64(3000),
    NumberDisposed: i64(250), TradeDate: "2026-05-01",
    ExtractedAt: strPtr("2026-05-02T00:00:00Z"), ExtractionConfidence: f64(0.68),
  },
  {
    ID: "unknown-1", StockCode: "CBA", DirectorName: "Uma Unknown",
    TradeType: "", Direction: strPtr("unknown"), TradeDate: "2026-04-01",
  },
}
```

Assert:

```go
assert.Equal(t, 3, result.TotalCount)
assert.Len(t, result.Trades, 1) // when Limit is 1
assert.Equal(t, int32(3), result.Summary.TotalTrades)
assert.Equal(t, 10000.0, result.Summary.TotalBuyValue)
assert.Equal(t, 3000.0, result.Summary.TotalSellValue)
assert.Equal(t, 7000.0, result.Summary.NetValue)
assert.Equal(t, int32(1), result.Summary.LowConfidenceTrades)
assert.Equal(t, int32(1), result.Summary.UnknownDirectionTrades)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd services
rtk go test ./shorts/internal/store/shorts -run 'TestBuildDirectorActivityResult' -v
```

Expected: FAIL because `BuildDirectorActivityResult` and new types do not exist.

- [ ] **Step 3: Add store types**

In `store.go`, extend `DirectorTrade`:

```go
type DirectorTrade struct {
  ID                   string
  StockCode            string
  DirectorName         string
  TradeType            string
  SharesTraded         int64
  PricePerShare        *float64
  TotalValue           *float64
  TradeDate            string
  AnnouncementURL      *string
  Direction            *string
  SecuritiesClass      *string
  NumberAcquired       *int64
  NumberDisposed       *int64
  ConsiderationAUD     *float64
  NatureOfChange       *string
  InterestType         *string
  RegisteredHolder     *string
  ExtractionConfidence *float64
  ExtractedAt          *string
  ExtractionModel      *string
}

type DirectorTradeFilter struct {
  StockCode         string
  Limit             int32
  Window            string
  Direction         string
  ConfidenceFilter  string
  DirectorName      string
}

type DirectorTradeResult struct {
  Trades     []*DirectorTrade
  TotalCount int
  Summary    *DirectorActivitySummary
  ByDirector []*DirectorActivityByDirector
}

type DirectorActivitySummary struct {
  StockCode               string
  Window                  string
  TotalTrades             int32
  ExtractedTrades         int32
  LowConfidenceTrades     int32
  BuyerCount              int32
  SellerCount             int32
  OptionExerciseCount     int32
  OptionExerciseValue     float64
  TotalBuyValue           float64
  TotalSellValue          float64
  NetValue                float64
  TotalAcquired           int64
  TotalDisposed           int64
  LatestTradeDate         string
  LatestDirectorName      string
  MissingValueTrades      int32
  UnknownDirectionTrades  int32
}

type DirectorActivityByDirector struct {
  DirectorName        string
  TradeCount          int32
  BuyValue            float64
  SellValue           float64
  NetValue            float64
  Acquired            int64
  Disposed            int64
  LatestTradeDate     string
  MissingValueTrades  int32
}
```

- [ ] **Step 4: Implement aggregation helper**

Create `director_activity.go` with:

```go
const (
  DirectorDirectionAll             = "all"
  DirectorDirectionBuy             = "buy"
  DirectorDirectionSell            = "sell"
  DirectorDirectionExerciseOptions = "exercise_options"
  DirectorDirectionOther           = "other"
  DirectorDirectionUnknown         = "unknown"
  ConfidenceFilterAll              = "all"
  ConfidenceFilterExtracted        = "extracted"
  ConfidenceFilterLowConfidence    = "low_confidence"
)

func BuildDirectorActivityResult(rows []*DirectorTrade, filter DirectorTradeFilter) *DirectorTradeResult
```

Rules:

- sort `rows` by `TradeDate` descending before limiting;
- apply `Window`, `Direction`, `ConfidenceFilter`, and `DirectorName` before aggregation;
- aggregate summary and by-director from all filtered rows;
- apply `Limit` only to `result.Trades`;
- `EffectiveDirection` is `direction`, then `trade_type`, then `unknown`;
- unknown count includes effective direction `unknown`, empty, or non-canonical;
- extracted count uses `ExtractedAt != nil`, confidence `>= 0.50`, and at least one enriched field beyond legacy columns;
- low-confidence count uses confidence `> 0 && < 0.70`;
- missing value count uses buy/sell/exercise rows with nil effective consideration.

- [ ] **Step 5: Run aggregation tests**

```bash
cd services
rtk go test ./shorts/internal/store/shorts -run 'TestBuildDirectorActivityResult' -v
```

Expected: PASS.

### Task 4: Update Postgres Director Store Query

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_directors.go`
- Create or modify: `services/shorts/internal/store/shorts/postgres_directors_test.go`
- Modify: `services/shorts/internal/store/shorts/store.go`
- Modify: `services/shorts/internal/services/shorts/adapters.go`

- [ ] **Step 1: Add query-builder tests**

Create `postgres_directors_test.go` tests:

```go
func TestBuildDirectorTradesQuery_DefaultsUseFullWindowForSummary(t *testing.T)
func TestBuildDirectorTradesQuery_AddsWindowDirectionConfidenceAndDirectorFilters(t *testing.T)
```

Assert the query selects all enriched columns:

```go
assert.Contains(t, query, "direction")
assert.Contains(t, query, "securities_class")
assert.Contains(t, query, "number_acquired")
assert.Contains(t, query, "extraction_confidence")
assert.Contains(t, query, "ORDER BY trade_date DESC")
```

Also assert arguments include stock code, window cutoff when applicable, direction filter, confidence filter, and director name.

- [ ] **Step 2: Run query-builder tests to verify they fail**

```bash
cd services
rtk go test ./shorts/internal/store/shorts -run 'TestBuildDirectorTradesQuery' -v
```

Expected: FAIL because query builder does not exist.

- [ ] **Step 3: Change store interface shape**

Update both store interfaces:

```go
GetDirectorTrades(filter DirectorTradeFilter) (*DirectorTradeResult, error)
```

Files:

- `services/shorts/internal/store/shorts/store.go`
- `services/shorts/internal/services/shorts/interfaces.go`
- `services/shorts/internal/services/shorts/adapters.go`

- [ ] **Step 4: Implement query and scan**

In `postgres_directors.go`:

- add `buildDirectorTradesQuery(filter DirectorTradeFilter) (string, []interface{})`;
- select legacy and enriched columns;
- use effective-direction SQL only for filters:

```sql
COALESCE(NULLIF(direction, ''), NULLIF(trade_type, ''), 'unknown')
```

- filter windows:
  - `90d`: `trade_date >= CURRENT_DATE - INTERVAL '90 days'`
  - `12m`: `trade_date >= CURRENT_DATE - INTERVAL '12 months'`
  - `all`: no date predicate
- scan nullable columns into pointers;
- call `BuildDirectorActivityResult(rows, filter)`.

- [ ] **Step 5: Run store tests**

```bash
cd services
rtk go test ./shorts/internal/store/shorts -run 'TestBuildDirectorActivityResult|TestBuildDirectorTradesQuery' -v
```

Expected: PASS.

### Task 5: Update Service Validation, Cache, Mapping, And Mocks

**Files:**
- Modify: `services/shorts/internal/services/shorts/validation.go`
- Modify: `services/shorts/internal/services/shorts/validation_test.go`
- Modify: `services/shorts/internal/services/shorts/cache.go`
- Modify: `services/shorts/internal/services/shorts/interfaces.go`
- Generated: `services/shorts/internal/services/shorts/mocks/mock_interfaces.go`
- Modify: `services/shorts/internal/services/shorts/director_trades.go`
- Create: `services/shorts/internal/services/shorts/director_trades_test.go`

- [ ] **Step 1: Write validation tests**

Add tests to `validation_test.go`:

```go
func TestValidateGetDirectorTradesRequest_Filters(t *testing.T)
func TestSetDefaultValues_GetDirectorTradesRequest(t *testing.T)
```

Cases:

- empty window defaults to `12m`;
- empty direction defaults to `all`;
- empty confidence defaults to `all`;
- lowercase stock code normalizes to uppercase;
- valid windows: `90d`, `12m`, `all`;
- invalid window returns `connect.CodeInvalidArgument`;
- valid directions: `all`, `buy`, `sell`, `exercise_options`, `unknown`;
- invalid direction returns `connect.CodeInvalidArgument`;
- valid confidence filters: `all`, `extracted`, `low_confidence`;
- invalid confidence returns `connect.CodeInvalidArgument`;
- limit > 200 still fails.

- [ ] **Step 2: Run validation tests to verify they fail**

```bash
cd services
rtk go test ./shorts/internal/services/shorts -run 'TestValidateGetDirectorTradesRequest|TestSetDefaultValues_GetDirectorTradesRequest' -v
```

Expected: FAIL because new defaults and validation do not exist.

- [ ] **Step 3: Implement validation and cache key signature**

Update:

```go
func (c *MemoryCache) GetDirectorTradesKey(stockCode string, limit int32, window, direction, confidenceFilter, directorName string) string
```

Update `Cache` interface in `interfaces.go` to the same signature.

- [ ] **Step 4: Regenerate service mocks**

Run:

```bash
cd services/shorts/internal/services/shorts
rtk go generate ./...
```

Expected: `mocks/mock_interfaces.go` updates for `GetDirectorTrades` and `GetDirectorTradesKey`.

- [ ] **Step 5: Write service mapping tests**

Create `director_trades_test.go` with:

```go
func TestGetDirectorTrades_ReturnsSummaryGroupsAndOptionalFields(t *testing.T)
func TestGetDirectorTrades_AggregatesBeforeLimit(t *testing.T)
func TestGetDirectorTrades_CacheKeyIncludesFilters(t *testing.T)
func TestGetDirectorTrades_StoreErrorReturnsInternal(t *testing.T)
```

Use `newTestServer(t, mockStore)`. Mock store expectation:

```go
f64 := func(v float64) *float64 { return &v }
i64 := func(v int64) *int64 { return &v }
str := func(v string) *string { return &v }

storeResult := &shortsstore.DirectorTradeResult{
  Trades: []*shortsstore.DirectorTrade{
    {
      ID: "buy-1", StockCode: "CBA", DirectorName: "Jane Buyer",
      TradeType: "buy", Direction: str("buy"), SharesTraded: 1000,
      PricePerShare: f64(10), TotalValue: f64(10000), ConsiderationAUD: f64(10000),
      NumberAcquired: i64(1000), TradeDate: "2026-06-10",
      AnnouncementURL: str("https://example.test/cba-3y.pdf"),
      SecuritiesClass: str("Ordinary fully paid shares"),
      NatureOfChange: str("On-market purchase"),
      RegisteredHolder: str("Jane Buyer"),
      ExtractionConfidence: f64(0.92),
      ExtractedAt: str("2026-06-11T00:00:00Z"),
      ExtractionModel: str("appendix-3y-v2"),
    },
  },
  TotalCount: 3,
  Summary: &shortsstore.DirectorActivitySummary{
    StockCode: "CBA", Window: "90d", TotalTrades: 3,
    ExtractedTrades: 2, BuyerCount: 1, SellerCount: 1,
    TotalBuyValue: 10000, TotalSellValue: 3000, NetValue: 7000,
    TotalAcquired: 1000, TotalDisposed: 250,
    LatestTradeDate: "2026-06-10", LatestDirectorName: "Jane Buyer",
    LowConfidenceTrades: 1, UnknownDirectionTrades: 1,
  },
  ByDirector: []*shortsstore.DirectorActivityByDirector{
    {
      DirectorName: "Jane Buyer", TradeCount: 1,
      BuyValue: 10000, NetValue: 10000, Acquired: 1000,
      LatestTradeDate: "2026-06-10",
    },
    {
      DirectorName: "Sam Seller", TradeCount: 1,
      SellValue: 3000, NetValue: -3000, Disposed: 250,
      LatestTradeDate: "2026-05-01",
    },
  },
}

mockStore.EXPECT().
  GetDirectorTrades(shortsstore.DirectorTradeFilter{
    StockCode: "CBA",
    Limit: int32(1),
    Window: "90d",
    Direction: "buy",
    ConfidenceFilter: "extracted",
    DirectorName: "Jane Buyer",
  }).
  Return(storeResult, nil)
```

Assert response:

```go
require.NotNil(t, resp.Msg.Summary)
assert.Equal(t, int32(3), resp.Msg.Summary.TotalTrades)
require.Len(t, resp.Msg.Trades, 1)
assert.NotNil(t, resp.Msg.Trades[0].NumberAcquired)
assert.Equal(t, int64(1000), *resp.Msg.Trades[0].NumberAcquired)
```

- [ ] **Step 6: Implement service mapping**

In `director_trades.go`:

- build `shortsstore.DirectorTradeFilter` from request;
- use expanded cache key;
- map `DirectorTradeResult.Summary` and `.ByDirector`;
- set proto optional numeric fields only when source pointers are non-nil;
- keep legacy fields populated for old clients.

- [ ] **Step 7: Run focused backend service tests**

```bash
cd services
rtk go test ./shorts/internal/services/shorts -run 'TestGetDirectorTrades|TestValidateGetDirectorTradesRequest|TestSetDefaultValues_GetDirectorTradesRequest' -v
```

Expected: PASS.

- [ ] **Step 8: Commit backend store/service chunk**

```bash
rtk git add services/shorts/internal/store/shorts services/shorts/internal/services/shorts
rtk git commit -m "feat(directors): aggregate director activity"
```

### Task 6: Update Timeline Director Trade Detail

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_timeline.go`
- Create: `services/shorts/internal/store/shorts/postgres_timeline_test.go`

- [ ] **Step 1: Write failing store-level timeline test**

Create `postgres_timeline_test.go` with:

```go
func TestGetEventTimeline_DirectorTradeUsesEnrichedDirectionAndConsideration(t *testing.T)
```

Use the existing `getTestDatabaseURL()` and `createTestPool(t, dbURL)` helpers from `postgres_getstockdetails_test.go`; skip when `testing.Short()` or no database URL is configured. Insert a unique director trade row:

```sql
INSERT INTO director_trades (
  id, stock_code, director_name, trade_type, shares_traded,
  total_value, trade_date, announcement_url, direction, consideration_aud
) VALUES (
  '00000000-0000-0000-0000-000000071001', 'ZZT', 'Sam Seller', '',
  0, NULL, CURRENT_DATE, 'https://example.test/zzt-3y.pdf', 'sell', 3000
)
ON CONFLICT (id) DO UPDATE SET
  stock_code = EXCLUDED.stock_code,
  director_name = EXCLUDED.director_name,
  trade_type = EXCLUDED.trade_type,
  total_value = EXCLUDED.total_value,
  trade_date = EXCLUDED.trade_date,
  direction = EXCLUDED.direction,
  consideration_aud = EXCLUDED.consideration_aud;
```

Create the store directly in the same package with `store := &postgresStore{db: pool}`, call `store.GetEventTimeline("ZZT", 30, 20)`, then assert the returned `director_trade` event has:

```go
assert.Equal(t, "Sam Seller sell", event.Title)
assert.Equal(t, "$3.0K", event.Detail)
assert.Equal(t, "https://example.test/zzt-3y.pdf", event.URL)
```

- [ ] **Step 2: Run timeline tests**

```bash
cd services
rtk go test ./shorts/internal/store/shorts -run 'TestGetEventTimeline_DirectorTradeUsesEnrichedDirectionAndConsideration' -v
```

Expected: FAIL until query/detail formatting uses enriched direction fallback.

- [ ] **Step 3: Update timeline SQL**

In `postgres_timeline.go`, select:

```sql
COALESCE(NULLIF(direction, ''), NULLIF(trade_type, ''), 'unknown')
```

and effective value:

```sql
COALESCE(consideration_aud, total_value, 0)
```

- [ ] **Step 4: Run timeline tests**

```bash
cd services
rtk go test ./shorts/internal/store/shorts -run 'TestGetEventTimeline_DirectorTradeUsesEnrichedDirectionAndConsideration' -v
```

Expected: PASS.

---

## Chunk 3: PDF Extractor And Chat Tooling

### Task 7: Preserve Rich Appendix 3Y Extraction Fields

**Files:**
- Modify: `services/report-extractor/extract_director_trades.py`
- Create: `services/report-extractor/test_extract_director_trades.py`

- [ ] **Step 1: Write extractor unit tests**

At the top of `test_extract_director_trades.py`, copy/adapt `_stub_missing_deps()` from `test_extract.py` before importing `extract_director_trades`. Include minimal stubs for `fitz`, `psycopg2`, `psycopg2.extras`, `requests`, and `langextract` so the unit tests run even when heavy extractor dependencies are not installed locally.

Create tests for:

```python
def test_derive_trade_buy_with_registered_holder_and_sentinels()
def test_derive_trade_sell_keeps_disposed_quantity()
def test_derive_trade_option_exercise_separate_from_buy()
def test_derive_trade_low_confidence_returns_none()
def test_missing_enrichment_predicate_includes_new_columns()
def test_update_trade_sets_enriched_columns_and_model(monkeypatch)
def test_update_trade_preserves_higher_confidence_existing_values(monkeypatch)
```

Use input:

```python
buy = {
    "director_name": "Jane Buyer",
    "date_of_change": "2026-06-10",
    "securities_class": "Ordinary fully paid shares",
    "number_acquired": 1000,
    "number_disposed": None,
    "consideration_aud": 10000,
    "nature_of_change": "On-market purchase",
    "interest_type": None,
    "registered_holder": None,
    "confidence": 0.92,
}
```

Assert:

```python
assert d["direction"] == "buy"
assert d["registered_holder"] == "Not disclosed"
assert d["interest_type"] == "unknown"
assert d["securities_class"] == "Ordinary fully paid shares"
assert d["number_acquired"] == 1000
```

For `test_derive_trade_sell_keeps_disposed_quantity`, use:

```python
sell = {
    "director_name": "Sam Seller",
    "date_of_change": "2026-05-01",
    "securities_class": "Ordinary shares",
    "number_acquired": None,
    "number_disposed": 250,
    "consideration_aud": 3000,
    "nature_of_change": "On-market sale",
    "interest_type": "indirect",
    "registered_holder": "Seller Family Trust",
    "confidence": 0.88,
}
```

Assert `direction == "sell"`, `trade_type == "sell"`, `shares_traded == 250`, `number_disposed == 250`, `number_acquired is None`, `total_value == 3000`, and `registered_holder == "Seller Family Trust"`.

For `test_derive_trade_option_exercise_separate_from_buy`, use `number_acquired: 1000`, `number_disposed: None`, `consideration_aud: 0`, and `nature_of_change: "Exercise of options"`. Assert `direction == "exercise_options"`, `trade_type == "exercise_options"`, `shares_traded == 1000`, and `number_acquired == 1000`.

For `test_derive_trade_low_confidence_returns_none`, use a valid director name with `confidence: 0.49`; assert `derive_trade(parsed) is None`.

For `test_missing_enrichment_predicate_includes_new_columns`, assert:

```python
predicate = missing_enrichment_predicate("dt")
assert "dt.direction IS NULL" in predicate
assert "dt.securities_class IS NULL" in predicate
assert "dt.nature_of_change IS NULL" in predicate
assert "dt.extraction_confidence IS NULL" in predicate
```

For the two `update_trade()` tests, monkeypatch `extract_director_trades._conn` to return a fake connection whose cursor records executed SQL and params. The fake cursor should return an existing row for the initial row-locking `SELECT` statement containing `FOR UPDATE` and capture the final `UPDATE` params.

In `test_update_trade_sets_enriched_columns_and_model`, make the existing row have null enriched fields and `extraction_confidence = None`; pass an incoming derived trade with `direction: "buy"`, `securities_class: "Ordinary shares"`, `number_acquired: 1000`, `consideration_aud: 10000`, `registered_holder: "Jane Buyer"`, and `confidence: 0.92`. Assert the captured final params include, in order, `"buy"`, `"Ordinary shares"`, `1000`, `None`, `10000`, `"On-market purchase"`, `"unknown"`, `"Jane Buyer"`, `0.92`, and `extract_director_trades.EXTRACT_MODEL`.

In `test_update_trade_preserves_higher_confidence_existing_values`, make the existing row have `direction: "sell"`, `registered_holder: "Existing Holder"`, `extraction_confidence: 0.95`, and populated enriched values. Pass an incoming lower-confidence trade with `confidence: 0.60`, `direction: "buy"`, and null holder/class/nature values. Assert the captured final params keep `"sell"`, `"Existing Holder"`, and `0.95` rather than downgrading them.

- [ ] **Step 2: Run extractor tests to verify failure**

```bash
cd services/report-extractor
rtk python3 -m pytest test_extract_director_trades.py -q
```

Expected: FAIL because rich fields and predicate helper do not exist.

- [ ] **Step 3: Update prompt and derivation**

In `extract_director_trades.py`:

- add `registered_holder`, `direction`, and `extraction_notes` to `EXTRACT_PROMPT`;
- update `derive_trade(parsed)` to return:

```python
{
  "director_name": name,
  "trade_type": direction,
  "direction": direction,
  "shares_traded": int(shares),
  "total_value": consideration,
  "consideration_aud": consideration,
  "price_per_share": price,
  "trade_date": parsed.get("date_of_change"),
  "securities_class": sentinel(parsed.get("securities_class"), "Unknown"),
  "number_acquired": int(acquired) if acquired else None,
  "number_disposed": int(disposed) if disposed else None,
  "nature_of_change": sentinel(parsed.get("nature_of_change"), "Unknown"),
  "interest_type": normalize_interest_type(parsed.get("interest_type")),
  "registered_holder": sentinel(parsed.get("registered_holder"), "Not disclosed"),
  "confidence": conf,
}
```

- add helpers `sentinel`, `normalize_interest_type`, and `derive_direction`.

- [ ] **Step 4: Update candidate predicate and SQL update**

Add helper:

```python
def missing_enrichment_predicate(table_alias: str = "") -> str:
    prefix = f"{table_alias}." if table_alias else ""
    return f"""(
      {prefix}director_name = 'Unknown Director'
      OR {prefix}total_value IS NULL
      OR {prefix}direction IS NULL
      OR {prefix}securities_class IS NULL
      OR {prefix}nature_of_change IS NULL
      OR {prefix}interest_type IS NULL
      OR {prefix}registered_holder IS NULL
      OR {prefix}extraction_confidence IS NULL
    )"""
```

Update `select_urls()` to use this predicate for all priorities.

Update `update_trade()` to avoid overwriting better existing enrichment:

1. `SELECT` the existing row by `announcement_url FOR UPDATE`.
2. Treat the incoming extraction as allowed to replace an existing enriched value only when `d["confidence"] >= COALESCE(existing.extraction_confidence, 0)` or the existing field is null/legacy-empty.
3. For each enriched field, keep the existing non-null value when the incoming value is null or the incoming confidence is lower than the existing `extraction_confidence`.
4. Always source the model name from the module constant `EXTRACT_MODEL`.

The final `UPDATE` must set both legacy and enriched columns with this parameter order:

```sql
UPDATE director_trades
SET director_name = %s,
    trade_type = %s,
    shares_traded = %s,
    total_value = %s,
    price_per_share = %s,
    trade_date = COALESCE(%s::date, trade_date),
    direction = %s,
    securities_class = %s,
    number_acquired = %s,
    number_disposed = %s,
    consideration_aud = %s,
    nature_of_change = %s,
    interest_type = %s,
    registered_holder = %s,
    extraction_confidence = %s,
    extracted_at = NOW(),
    extraction_model = %s
WHERE announcement_url = %s
```

Map parameters from the merged dictionary in this exact order:

```python
(
    merged["director_name"],
    merged["trade_type"],
    merged["shares_traded"],
    merged["total_value"],
    merged["price_per_share"],
    merged["trade_date"],
    merged["direction"],
    merged["securities_class"],
    merged["number_acquired"],
    merged["number_disposed"],
    merged["consideration_aud"],
    merged["nature_of_change"],
    merged["interest_type"],
    merged["registered_holder"],
    merged["confidence"],
    EXTRACT_MODEL,
    url,
)
```

- [ ] **Step 5: Run extractor tests**

```bash
cd services/report-extractor
rtk python3 -m pytest test_extract_director_trades.py test_extract.py -q
```

Expected: PASS.

- [ ] **Step 6: Dry-run extractor against small sample if credentials exist**

Run only when `DATABASE_URL` and `GEMINI_API_KEY` or `LANGEXTRACT_API_KEY` are already set:

```bash
cd services/report-extractor
rtk python3 extract_director_trades.py --dry-run --priority top-shorted --limit 20 --workers 2
```

Expected: logs show `Director-trade extraction: N PDFs` and dry-run rows without database writes.

### Task 8: Update Chat Tool Parameters

**Files:**
- Modify: `services/chat-service/tools.go`
- Modify: `services/chat-service/tool_executor.go`
- Create or modify: `services/chat-service/tool_executor_test.go`

- [ ] **Step 1: Add tool executor tests**

Create `TestMapArgsToRequest_GetDirectorTradesFilters` that calls `mapArgsToRequest("GetDirectorTrades", args)` with:

```go
args := map[string]interface{}{
  "stock_code": "CBA",
  "limit": float64(5),
  "window": "90d",
  "direction": "buy",
}
```

Assert request contains:

```go
assert.Equal(t, "CBA", req["stockCode"])
assert.Equal(t, "90d", req["window"])
assert.Equal(t, "buy", req["direction"])
```

Create `TestMapArgsToRequest_GetDirectorTradesDefaults` with:

```go
args := map[string]interface{}{
  "stock_code": "CBA",
  "limit": float64(5),
}
```

Assert:

```go
assert.Equal(t, "12m", req["window"])
assert.Equal(t, "all", req["direction"])
```

- [ ] **Step 2: Run chat tests to verify failure**

```bash
cd services/chat-service
rtk go test ./... -run 'TestMapArgsToRequest.*Director' -v
```

Expected: FAIL because `window` and `direction` are not mapped.

- [ ] **Step 3: Update tool definition and mapper**

In `tools.go`, update the `GetDirectorTrades` description to mention net buyer/seller rollups, per-director aggregates, and source-backed announcement details. Add parameters:

```go
"window": {Type: "string", Description: "Rollup window", Enum: []string{"90d", "12m", "all"}},
"direction": {Type: "string", Description: "Direction filter", Enum: []string{"all", "buy", "sell", "exercise_options", "unknown"}},
```

In `tool_executor.go`, pass `window` and `direction` through for `GetDirectorTrades`, with defaults:

```go
req["window"] = "12m"
req["direction"] = "all"
```

- [ ] **Step 4: Run chat tests**

```bash
cd services/chat-service
rtk go test ./... -run 'TestMapArgsToRequest.*Director' -v
```

Expected: PASS.

- [ ] **Step 5: Commit extractor and chat chunk**

```bash
rtk git add services/report-extractor/extract_director_trades.py services/report-extractor/test_extract_director_trades.py services/chat-service/tools.go services/chat-service/tool_executor.go services/chat-service/tool_executor_test.go
rtk git commit -m "feat(directors): enrich appendix 3y extraction"
```

---

## Chunk 4: Frontend Director Activity UI

### Task 9: Add Shared Director Activity Utilities And View

**Files:**
- Create: `web/src/@/components/company/director-activity-types.ts`
- Create: `web/src/@/components/company/director-activity-utils.ts`
- Create: `web/src/@/components/company/director-activity-view.tsx`
- Create: `web/src/@/components/company/__tests__/director-activity-utils.test.ts`
- Create: `web/src/@/components/company/__tests__/director-activity-view.test.tsx`

- [ ] **Step 1: Write utility tests**

Create tests for:

```ts
it("formats missing values as unknown")
it("uses summary net value sign and currency")
it("groups drilldown rows by director")
it("returns explicit labels for buy, sell, exercise_options, and unknown")
```

Example assertion:

```ts
expect(formatMaybeMoney(undefined)).toBe("Unknown");
expect(formatMaybeQuantity(undefined)).toBe("Unknown");
expect(directionLabel("exercise_options")).toBe("Exercise");
```

- [ ] **Step 2: Write view tests**

Render a fixture response with:

- `summary.netValue = 7000`;
- two director groups;
- one low-confidence trade;
- one source PDF URL.

Assert:

```ts
expect(screen.getByText(/Net buying/i)).toBeInTheDocument();
expect(screen.getByText(/\$7,000/)).toBeInTheDocument();
expect(screen.getByRole("button", { name: /Jane Buyer/i })).toHaveAttribute("aria-expanded", "false");
await user.click(screen.getByRole("button", { name: /Jane Buyer/i }));
expect(screen.getByText(/Ordinary fully paid shares/i)).toBeInTheDocument();
expect(screen.getByRole("link", { name: /source filing/i })).toHaveAttribute("href", "https://example.com/3y.pdf");
```

- [ ] **Step 3: Run frontend tests to verify failure**

```bash
cd web
rtk npm test -- director-activity-utils.test.ts director-activity-view.test.tsx
```

Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement types and utilities**

In `director-activity-types.ts`, export aliases around generated response types:

```ts
import type {
  DirectorTrade,
  DirectorActivitySummary,
  DirectorActivityByDirector,
  GetDirectorTradesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";

export type DirectorTradeRow = DirectorTrade;
export type DirectorSummary = DirectorActivitySummary;
export type DirectorGroup = DirectorActivityByDirector;
export type DirectorActivityResponse = GetDirectorTradesResponse;
export type DirectionFilter = "all" | "buy" | "sell" | "exercise_options" | "unknown";
export type WindowFilter = "90d" | "12m" | "all";
export type ConfidenceFilter = "all" | "extracted" | "low_confidence";
```

In `director-activity-utils.ts`, add:

- `formatMaybeMoney(value?: number): string`;
- `formatMaybeQuantity(value?: bigint | number): string`;
- `formatConfidence(value?: number): string`;
- `directionLabel(direction?: string): string`;
- `directionTone(direction?: string): string`;
- `netActivityLabel(netValue: number): string`.

- [ ] **Step 5: Implement presentational view**

`director-activity-view.tsx` props:

```ts
interface DirectorActivityViewProps {
  data: DirectorActivityResponse;
  stockCode: string;
  window: WindowFilter;
  direction: DirectionFilter;
  confidenceFilter: ConfidenceFilter;
  directorName?: string;
  onWindowChange?: (value: WindowFilter) => void;
  onDirectionChange?: (value: DirectionFilter) => void;
  onConfidenceFilterChange?: (value: ConfidenceFilter) => void;
  onDirectorNameChange?: (value: string) => void;
}
```

Use existing primitives:

- `Card`, `CardContent`, `CardHeader`, `CardTitle`;
- `Button`;
- `Select`;
- `Badge`;
- `Collapsible`;
- `Table`.

Keep page sections un-nested: one outer tool surface with summary band and grouped drilldown. Use `aria-expanded` on director group buttons.

- [ ] **Step 6: Run view tests**

```bash
cd web
rtk npm test -- director-activity-utils.test.ts director-activity-view.test.tsx
```

Expected: PASS.

### Task 10: Add Query Container And Wire Stock Directors Tab

**Files:**
- Create: `web/src/@/components/company/director-activity-panel.tsx`
- Modify: `web/src/@/components/company/stock-tabs.tsx`
- Modify or delete: `web/src/@/components/company/director-trades-table.tsx`
- Create: `web/src/@/components/company/__tests__/director-activity-panel.test.tsx`

- [ ] **Step 1: Write panel test**

Mock `@connectrpc/connect` and `@connectrpc/connect-web`. Assert:

- default request uses `stockCode`, `limit: 20`, `window: "12m"`, `direction: "all"`, `confidenceFilter: "all"`;
- changing direction filter calls refetch with `direction: "sell"`;
- loading state renders skeleton;
- empty response renders "No director activity found".

Wrap every render in a fresh React Query provider, matching the existing component-test pattern:

```tsx
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

render(
  <QueryClientProvider client={queryClient}>
    <DirectorActivityPanel stockCode="CBA" />
  </QueryClientProvider>,
);
```

- [ ] **Step 2: Run panel test to verify failure**

```bash
cd web
rtk npm test -- director-activity-panel.test.tsx
```

Expected: FAIL because panel does not exist.

- [ ] **Step 3: Implement panel**

`DirectorActivityPanel` should:

- own filter state;
- call `client.getDirectorTrades({ stockCode, limit, window, direction, confidenceFilter, directorName })`;
- pass response to `DirectorActivityView`;
- keep React Query key as:

```ts
["director-activity", stockCode, limit, window, direction, confidenceFilter, directorName]
```

- [ ] **Step 4: Wire tab**

In `stock-tabs.tsx`, replace:

```tsx
<DirectorTradesTable stockCode={stockCode} />
```

with:

```tsx
<DirectorActivityPanel stockCode={stockCode} />
```

Remove `director-trades-table.tsx` only after `rtk rg "DirectorTradesTable"` returns no references.

- [ ] **Step 5: Run frontend component tests**

```bash
cd web
rtk npm test -- director-activity
```

Expected: PASS for utility, view, and panel tests.

### Task 11: Update Server Action And Insider Trading Pages

**Files:**
- Modify: `web/src/app/actions/getDirectorTrades.ts`
- Modify: `web/src/app/insider-trading/page.tsx`
- Modify: `web/src/app/insider-trading/[stockCode]/page.tsx`
- Create: `web/src/app/insider-trading/[stockCode]/__tests__/page-runtime.test.tsx`

- [ ] **Step 1: Update action signature**

Change `getDirectorTrades` to accept:

```ts
interface GetDirectorTradesOptions {
  window?: "90d" | "12m" | "all";
  direction?: "all" | "buy" | "sell" | "exercise_options" | "unknown";
  confidenceFilter?: "all" | "extracted" | "low_confidence";
  directorName?: string;
}
```

and call:

```ts
client.getDirectorTrades({
  stockCode,
  limit,
  window: options.window ?? "12m",
  direction: options.direction ?? "all",
  confidenceFilter: options.confidenceFilter ?? "all",
  directorName: options.directorName ?? "",
})
```

- [ ] **Step 2: Write insider page runtime test**

Create a server-component runtime test that imports `../page`, mocks `getDirectorTrades`, mocks `getStockOrNotFound`, and mocks `DirectorActivityView` to render a deterministic marker from its props:

```tsx
jest.mock("~/@/components/company/director-activity-view", () => ({
  DirectorActivityView: jest.fn(({ data, stockCode }) => (
    <section data-testid="director-activity-view">
      <span>{stockCode}</span>
      <span>{data.summary?.netValue}</span>
      <span>{data.byDirector?.[0]?.directorName}</span>
      <a href={data.trades?.[0]?.announcementUrl}>Source filing</a>
    </section>
  )),
}));
```

Mock `getDirectorTrades` to return enriched summary, by-director, and trade data:

```ts
{
  trades: [{
    id: "buy-1",
    stockCode: "CBA",
    directorName: "Jane Buyer",
    direction: "buy",
    tradeType: "buy",
    numberAcquired: 1000n,
    totalValue: 10000,
    announcementUrl: "https://example.com/3y.pdf",
    tradeDate: "2026-06-10",
  }],
  totalCount: 1,
  summary: { stockCode: "CBA", window: "all", totalTrades: 1, totalBuyValue: 10000, netValue: 10000 },
  byDirector: [{ directorName: "Jane Buyer", tradeCount: 1, buyValue: 10000, netValue: 10000 }],
}
```

Render the async page with:

```tsx
const ui = await Page({ params: Promise.resolve({ stockCode: "cba" }) });
render(ui);
```

Assert:

```ts
expect(getDirectorTrades).toHaveBeenCalledWith("CBA", 100, { window: "all", direction: "all" });
expect(screen.getByTestId("director-activity-view")).toHaveTextContent("CBA");
expect(screen.getByTestId("director-activity-view")).toHaveTextContent("10000");
expect(screen.getByText("Jane Buyer")).toBeInTheDocument();
expect(screen.getByRole("link", { name: /source filing/i })).toHaveAttribute("href", "https://example.com/3y.pdf");
```

- [ ] **Step 3: Refactor insider detail page**

In `/insider-trading/[stockCode]/page.tsx`:

- call `getDirectorTrades(code, 100, { window: "all", direction: "all" })`;
- remove local legacy aggregation;
- render `DirectorActivityView` with fetched data;
- keep structured data using enriched fields where present;
- keep the methodology/source disclosure.

- [ ] **Step 4: Update hub copy**

In `/insider-trading/page.tsx`, update copy to mention net buyer/seller rollups and source-backed drilldowns without changing route semantics.

- [ ] **Step 5: Run page tests**

```bash
cd web
rtk npm test -- page-runtime.test.tsx director-activity
```

Expected: PASS.

- [ ] **Step 6: Commit frontend component chunk**

```bash
rtk git add web/src/@/components/company web/src/app/actions/getDirectorTrades.ts web/src/app/insider-trading
rtk git commit -m "feat(directors): add director activity drilldown UI"
```

---

## Chunk 5: E2E, Final Verification, And Backfill Readiness

### Task 12: Add Playwright Coverage For Directors Drilldown

**Files:**
- Modify: `web/e2e/helpers/api-mock.ts`
- Create: `web/e2e/director-activity.spec.ts`

- [ ] **Step 1: Add API mock helper**

In `APIMockHelper`, add:

```ts
async mockDirectorTrades(stockCode: string = "CBA") {
  await this.page.route("**/shorts.v1alpha1.ShortedStocksService/GetDirectorTrades", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        trades: [
          {
            id: "buy-1",
            stockCode,
            directorName: "Jane Buyer",
            tradeType: "buy",
            sharesTraded: "1000",
            pricePerShare: 10,
            totalValue: 10000,
            tradeDate: "2026-06-10",
            announcementUrl: "https://example.com/3y.pdf",
            direction: "buy",
            securitiesClass: "Ordinary fully paid shares",
            numberAcquired: "1000",
            considerationAud: 10000,
            natureOfChange: "On-market purchase",
            interestType: "direct",
            registeredHolder: "Jane Buyer",
            extractionConfidence: 0.92,
            extractedAt: "2026-06-11T00:00:00Z",
            extractionModel: "gemini-2.5-flash"
          },
          {
            id: "unknown-1",
            stockCode,
            directorName: "Uma Unknown",
            tradeType: "unknown",
            sharesTraded: "0",
            totalValue: 0,
            tradeDate: "2026-04-01",
            announcementUrl: "https://example.com/unknown-3y.pdf",
            direction: "unknown"
          }
        ],
        totalCount: 3,
        summary: {
          stockCode,
          window: "12m",
          totalTrades: 3,
          extractedTrades: 2,
          lowConfidenceTrades: 1,
          buyerCount: 1,
          sellerCount: 1,
          optionExerciseCount: 1,
          optionExerciseValue: 2500,
          totalBuyValue: 10000,
          totalSellValue: 3000,
          netValue: 7000,
          totalAcquired: "1000",
          totalDisposed: "250",
          latestTradeDate: "2026-06-10",
          latestDirectorName: "Jane Buyer",
          missingValueTrades: 0,
          unknownDirectionTrades: 0
        },
        byDirector: [
          {
            directorName: "Jane Buyer",
            tradeCount: 1,
            buyValue: 10000,
            sellValue: 0,
            netValue: 10000,
            acquired: "1000",
            disposed: "0",
            latestTradeDate: "2026-06-10",
            missingValueTrades: 0
          },
          {
            directorName: "Uma Unknown",
            tradeCount: 1,
            buyValue: 0,
            sellValue: 0,
            netValue: 0,
            acquired: "0",
            disposed: "0",
            latestTradeDate: "2026-04-01",
            missingValueTrades: 1
          }
        ]
      })
    });
  });
}
```

Call `mockDirectorTrades()` from `mockSuccessfulResponses()`.

- [ ] **Step 2: Write e2e test**

Create `web/e2e/director-activity.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { APIMockHelper } from "./helpers/api-mock";

test("stock Directors tab shows rollup and expandable source-backed details", async ({ page }) => {
  const apiMock = new APIMockHelper(page);
  await apiMock.mockSuccessfulResponses();
  await page.goto("/shorts/CBA?tab=directors");
  await expect(page.getByText(/Net buying/i)).toBeVisible();
  await expect(page.getByText(/\$7,000/)).toBeVisible();
  await page.getByRole("button", { name: /Jane Buyer/i }).click();
  await expect(page.getByText(/Ordinary fully paid shares/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /source filing/i })).toHaveAttribute("href", "https://example.com/3y.pdf");
});
```

- [ ] **Step 3: Start the local web server before Playwright**

`web/playwright.config.ts` does not auto-start a server. Start Next.js in a separate terminal and keep it running:

```bash
cd web
rtk npm run dev
```

Expected: Next.js listens on `http://localhost:3020`.

- [ ] **Step 4: Wait for the server**

In the implementation terminal:

```bash
rtk curl -f http://localhost:3020
```

Expected: HTTP 200 or 30x response. If the port is occupied by another valid local web server, set `BASE_URL` to that server URL in the next step.

- [ ] **Step 5: Run e2e test**

```bash
cd web
rtk env BASE_URL=http://localhost:3020 npm run test:e2e -- --project=chromium director-activity.spec.ts
```

Expected: PASS.

### Task 13: Run Focused Full-Stack Verification

**Files:** No new files unless fixes are needed.

- [ ] **Step 1: Run backend focused tests**

```bash
cd services
rtk go test ./shorts/internal/store/shorts ./shorts/internal/services/shorts -run 'Director|Timeline|ValidateGetDirectorTrades|SetDefaultValues' -v
```

Expected: PASS.

- [ ] **Step 2: Run extractor tests**

```bash
cd services/report-extractor
rtk python3 -m pytest test_extract_director_trades.py test_extract.py -q
```

Expected: PASS.

- [ ] **Step 3: Run chat-service tests**

```bash
cd services/chat-service
rtk go test ./... -run 'Director|Tool|MapArgs' -v
```

Expected: PASS.

- [ ] **Step 4: Run frontend tests**

```bash
cd web
rtk npm test -- director-activity page-runtime
```

Expected: PASS.

- [ ] **Step 5: Run Playwright e2e**

Reuse the dev server from Task 12, or start it first with `cd web && rtk npm run dev` in a separate terminal.

```bash
cd web
rtk env BASE_URL=http://localhost:3020 npm run test:e2e -- --project=chromium director-activity.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Run generated-code cleanliness check**

```bash
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors; status shows only intentional feature files.

- [ ] **Step 7: Run broader package tests if time allows**

```bash
cd services
rtk go test ./shorts/... -v
cd ../web
rtk npm test -- --runInBand
```

Expected: PASS. If unrelated pre-existing failures appear, capture exact files and errors in the implementation summary.

### Task 14: Final Manual Product Validation

**Files:** No new files unless fixes are needed.

- [ ] **Step 1: Start the deterministic local validation server**

For deterministic validation, only the web server is required because `director-activity.spec.ts` mocks the Connect API responses.

```bash
cd web
rtk npm run dev
```

Expected: Next.js starts on port `3020` unless already occupied.

- [ ] **Step 2: Run the mocked headed validation flow**

In another terminal:

```bash
cd web
rtk env BASE_URL=http://localhost:3020 npx playwright test e2e/director-activity.spec.ts --project=chromium --headed --debug
```

Expected: Chromium opens with the mocked CBA director activity fixture.

- [ ] **Step 3: Validate stock page inside the headed Playwright session**

The deterministic `Jane Buyer` and `Uma Unknown` fixture exists only in the Playwright route mock from Step 2. Use the Chromium window opened by `--headed --debug`; do not use a separate normal browser window for this deterministic check. In the Playwright window, inspect:

```text
http://localhost:3020/shorts/CBA?tab=directors
```

Check:

- summary rollup is visible;
- rollup shows `Net buying` and `$7,000`;
- window and direction controls work;
- `Jane Buyer` director group expands and shows `Ordinary fully paid shares`;
- `Uma Unknown` director group expands and missing fields render as `Unknown`;
- `Source filing` for Jane Buyer points to `https://example.com/3y.pdf`;
- mobile viewport does not overlap text.

- [ ] **Step 4: Validate insider detail route with mocked or live data**

Open:

```text
http://localhost:3020/insider-trading/CBA
```

If validating with Jest/page mocks, use the `page-runtime.test.tsx` fixture from Task 11. If validating live in-browser, ensure `SHORTS_API_URL` or `NEXT_PUBLIC_API_URL` is configured for the web app, then check the route uses the same summary/drilldown and no longer maintains separate legacy aggregation.

- [ ] **Step 5: Run backfill-readiness SQL checks when a disposable database is available**

Before a real backfill, capture enrichment coverage:

```bash
cd services
rtk psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  COUNT(*) AS total_director_rows,
  COUNT(*) FILTER (WHERE announcement_url ~ '^https?://') AS rows_with_source_url,
  COUNT(*) FILTER (WHERE extraction_confidence IS NOT NULL) AS extracted_rows,
  COUNT(*) FILTER (WHERE direction IS NOT NULL) AS direction_rows,
  COUNT(*) FILTER (WHERE consideration_aud IS NOT NULL OR total_value IS NOT NULL) AS valued_rows
FROM director_trades;"
```

Inspect remaining enrichment candidates:

```bash
cd services
rtk psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT stock_code, director_name, trade_date, announcement_url, direction,
       securities_class, number_acquired, number_disposed, consideration_aud,
       extraction_confidence
FROM director_trades
WHERE announcement_url ~ '^https?://'
  AND (
    director_name = 'Unknown Director'
    OR total_value IS NULL
    OR direction IS NULL
    OR securities_class IS NULL
    OR nature_of_change IS NULL
    OR interest_type IS NULL
    OR registered_holder IS NULL
    OR extraction_confidence IS NULL
  )
ORDER BY trade_date DESC
LIMIT 20;"
```

Expected: queries run without SQL errors and provide before/after counts for a later backfill. If `DATABASE_URL` is unavailable, record this step as skipped with the missing precondition.

- [ ] **Step 6: Inspect one source PDF against rendered details**

After a dry-run or real sample extraction, pick one extracted row:

```bash
cd services
rtk psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT stock_code, director_name, trade_date, announcement_url, direction,
       securities_class, number_acquired, number_disposed, consideration_aud,
       nature_of_change, registered_holder, extraction_confidence
FROM director_trades
WHERE extraction_confidence IS NOT NULL
ORDER BY extracted_at DESC NULLS LAST, trade_date DESC
LIMIT 1;"
```

Open the `announcement_url` PDF and the matching `/shorts/{stock_code}?tab=directors` row. Confirm director name, date, direction, acquired/disposed quantity, consideration, nature of change, registered holder, and source link match the filing. If no extracted row exists, run the Task 7 dry-run command or record that source-PDF inspection is blocked by missing extractor credentials/data.

- [ ] **Step 7: Commit final verification fixes**

If any verification fixes were needed:

```bash
rtk git add <fixed-files>
rtk git commit -m "fix(directors): polish director activity validation"
```

- [ ] **Step 8: Final implementation summary**

Record:

- commits created;
- tests run and pass/fail status;
- any skipped dry-run/backfill steps due missing credentials;
- any unrelated pre-existing lint/test failures.
