# Stock page tab routes + Strategy levels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `/shorts/[stockCode]` into seven on-demand ISR routes under one shared layout (header, summary, chart, tab bar), add a Strategy tab that draws the picker's levels over price, and expose those levels through a new `PriceFeatures` field on the strategy-fit RPC.

**Architecture:** A server `layout.tsx` under the stock segment fetches the stock through the existing `unstable_cache` actions and renders the chrome once; each tab is a `page.tsx` beneath it that reads only its own data and exports the ISR trio (`revalidate`, `dynamicParams`, empty `generateStaticParams`). Tab links prefetch on intent only, old `?tab=` links redirect at Vercel's routing layer, and the sync's revalidation expires the whole segment with one `layout`-typed call. The Go handler maps the candidate it already loads into the new message; the web action maps it to nulls-for-unknowns and the chart island draws level lines, bands and markers through three new props on the shared `StockChart`.

**Tech Stack:** Next.js 14.2.13 App Router (ISR, `next/dynamic` with `ssr:false` from server pages), React 18, TanStack Query, visx, Jest + ts-jest + Testing Library, Playwright, `node:test` for repo scripts, Go 1.26 + connect-go + testify + gomock, buf.

**Spec:** `docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md`

## Global Constraints

- Every tab `page.tsx` exports `export const revalidate = 3600` (news keeps `600`), `export const dynamicParams = true`, and `export function generateStaticParams() { return []; }`. No page or layout reads `searchParams`, `cookies()` or `headers()`.
- Server files never import `@connectrpc/connect` directly; client widgets that do are imported with `nextDynamic(() => import(...), { ssr: false })` exactly as the current `page.tsx` imports `StockChartPanel`.
- Every nullable number from the API travels with a `has_` boolean on the wire and becomes `null` in TypeScript. Never coalesce an unknown to zero.
- Cache keys: the fit entry moves from `["stock-strategy-fit", code, "v1"]` to `"v2"`. Tags stay `["strategy-picks", ...stockPageCacheTags("strategy-fit", code)]`.
- Route names are exactly `/shorts/{CODE}`, `/short-interest`, `/strategy`, `/financials`, `/company`, `/news`, `/community`. Tab labels: Overview, Short interest, Strategy, Financials, Company, News, Community.
- Tab titles (the layout template appends `| Shorted`): `{CODE} Short Interest History & FAQ | {Company}`, `{CODE} Strategy Fit: Breakout, CANSLIM & Trend Rules | {Company}`, `{CODE} Financials: Results, Ratios & Statements | {Company}`, `{CODE} Company Profile: Directors, Insiders & Operations | {Company}`, `{CODE} Community Discussion | {Company}`. Overview and News titles are unchanged.
- Robots: every tab inherits `isStockIndexable`; Strategy adds `noindex, follow` when `inUniverse` is false; Community is always `noindex, follow`.
- Prefetch: `<Link prefetch={false}>` plus `router.prefetch(href)` on `pointerenter`, `touchstart` and `focus`, at most once per href per mount.
- Go commands run with `GOWORK=off` from `services/`. Web commands run from `web/`. Never run `go clean -cache`.
- Commit after every task with a conventional message and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `stock-news-tab.tsx` is NOT deleted (the spec said so, but `stock-news-feed.tsx` and `related-news-rail.tsx` import from it). Only `stock-tabs.tsx` is deleted.

## Review Focus

1. **A stock code that exists but has no price features** (a new listing, under 40 sessions): the Strategy page must render the explanation and `noindex`, never a chart with empty levels. Pinned in Task 16 (`renders the out-of-universe explanation`).
2. **A fit response from an API that predates the field** (`priceFeatures` absent): panels render, the chart draws price only with the note. Pinned in Task 3 (mapper → `null`) and Task 15 (`price-only when features are null`).
3. **A `?tab=` value nobody mapped** (`?tab=foo`): no redirect fires and the Overview renders; a redirect must never loop. Pinned in Task 4.
4. **A base whose span starts before the loaded window** (`base_length_days` 40 on a 1-month chart): the band clips to the plot and never draws a negative width. Pinned in Task 14 (`clips a band that starts before the domain`).
5. **A tab visited with the chart already zoomed** (brush applied): the layout keeps the chart mounted, so the brush must survive navigation. Pinned in Task 19 (same SVG node assertion) rather than a unit test, because it is a router behaviour.

---

## File structure

**PR 1 — backend**

| File | Responsibility |
|---|---|
| `proto/shortedapi/shorts/v1alpha1/strategies.proto` | `PriceFeatures` message, field 6 on `GetStockStrategyFitResponse` |
| `services/gen/...`, `web/src/gen/...`, `sdks/java/...`, `api/schema/generated/...` | `buf generate` outputs, committed |
| `services/shorts/internal/services/shorts/strategy_fit.go` | `priceFeaturesProto` mapping, called from the handler |
| `services/shorts/internal/services/shorts/strategy_fit_test.go` | mapping + handler tests |

**PR 2 — web**

| File | Responsibility |
|---|---|
| `web/src/app/actions/getStockStrategyFit.ts` | maps `priceFeatures` and `regime`; cache key v2 |
| `web/src/config/stock-tab-redirects.json` + `web/next.config.mjs` | the `?tab=` → route map and the redirect entries built from it |
| `web/src/app/api/revalidate/route.ts` | `layout`-typed revalidation for `/shorts/[stockCode]` |
| `web/src/@/lib/stocks/stock-tabs.ts` | the single list of tabs: ids, segments, labels, href + active-tab helpers |
| `web/src/@/components/company/stock-tab-nav.tsx` | client tab bar with intent prefetch |
| `web/src/@/components/company/stock-breadcrumbs.tsx` | client breadcrumbs that know the active tab |
| `web/src/@/lib/seo/stock-tab-metadata.ts` | `stockTabMetadata()` — title, canonical, robots gate shared by every tab |
| `web/src/app/shorts/[stockCode]/layout.tsx`, `loading.tsx` | the shared chrome |
| `web/src/app/shorts/[stockCode]/page.tsx` | Overview digest |
| `web/src/@/components/stocks/strategy-fit-strip.tsx` | Overview strategy strip |
| `web/src/app/shorts/[stockCode]/{short-interest,financials,company,community,strategy}/{page,loading}.tsx` | the tabs |
| `web/src/app/shorts/[stockCode]/news/page.tsx` | re-homed under the layout, timeline appended |
| `web/src/app/shorts/[stockCode]/community/[threadId]/page.tsx` | drops its own chrome |
| `web/src/@/components/charts/types.ts`, `chart-levels.ts`, `StockChart.tsx` | `levels`, `bands`, `markers` props and their geometry |
| `web/src/@/components/strategy/strategy-levels.ts`, `strategy-levels-chart.tsx`, `strategy-fit-panel.tsx` | level sets, the chart island, the per-strategy panel |
| `web/src/@/lib/seo/sitemap-sections.ts` | three more per-stock URLs |
| `web/scripts/route-kinds.mjs` + `scripts/tests/route-kinds.test.mjs` | the ISR build gate |
| `web/scripts/bundle-budget.mjs`, `docs/perf/bundle-baseline.json` | per-tab budgets, refreshed baseline |
| `web/e2e/stock-tabs.spec.ts` | tab navigation, redirect, chart persistence |

Deleted: `web/src/@/components/company/stock-tabs.tsx`.

---

## PR 1 — backend

### Task 1: `PriceFeatures` on the fit response

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/strategies.proto` (after `message StrategyFit`, before `GetStockStrategyFitResponse`)
- Generated (commit all): `services/gen/proto/go/shorts/v1alpha1/strategies.pb.go`, `web/src/gen/shorts/v1alpha1/strategies_pb.ts`, `sdks/java/src/main/java/**`, `api/schema/generated/**`

**Interfaces:**
- Produces: Go `*shortsv1alpha1.PriceFeatures` with fields `AsOf, Close, Sma50/HasSma50, Sma150/HasSma150, Sma200/HasSma200, Sma200PriorMonth/HasSma200PriorMonth, High52w/HasHigh52w, Low52w/HasLow52w, BaseHigh/HasBaseHigh, BaseLow/HasBaseLow, BaseDepthPct/HasBaseDepthPct, BaseLengthDays/HasBaseLengthDays, BreakoutRecent, BreakoutDate, Rs3mPct/HasRs3mPct, Rs6mPct/HasRs6mPct, VolumeRatio50d/HasVolumeRatio50d, SessionsAvailable` and `GetStockStrategyFitResponse.PriceFeatures`. TS: the same in lowerCamel (`sma200PriorMonth`, `high52w`, `rs3mPct`, `volumeRatio50d`, `hasSma50`, ...). Field names deliberately avoid an underscore before a digit so the Go names stay clean.

- [ ] **Step 1: Add the message and the field**

Insert after the `StrategyFit` message:

```protobuf
// The price features the evaluator read for one stock (mv_price_features),
// so a chart can draw the levels the rules tested. Every nullable number
// travels with a has_ flag; read the value only when its flag is true.
message PriceFeatures {
  string as_of = 1;                      // YYYY-MM-DD of the last close.
  double close = 2;
  double sma50 = 3;                      bool has_sma50 = 4;
  double sma150 = 5;                     bool has_sma150 = 6;
  double sma200 = 7;                     bool has_sma200 = 8;
  double sma200_prior_month = 9;         bool has_sma200_prior_month = 10;
  double high52w = 11;                   bool has_high52w = 12;
  double low52w = 13;                    bool has_low52w = 14;
  double base_high = 15;                 bool has_base_high = 16;   // The pivot: the breakout and invalidation level.
  double base_low = 17;                  bool has_base_low = 18;
  double base_depth_pct = 19;            bool has_base_depth_pct = 20;
  int32 base_length_days = 21;           bool has_base_length_days = 22;
  bool breakout_recent = 23;
  string breakout_date = 24;             // YYYY-MM-DD; empty when there was no breakout.
  double rs3m_pct = 25;                  bool has_rs3m_pct = 26;
  double rs6m_pct = 27;                  bool has_rs6m_pct = 28;
  double volume_ratio50d = 29;           bool has_volume_ratio50d = 30;
  int32 sessions_available = 31;
}
```

Then add to `GetStockStrategyFitResponse`:

```protobuf
  PriceFeatures price_features = 6;  // Set only when in_universe is true.
```

- [ ] **Step 2: Lint and check for breaking changes**

Run from `proto/`:
```bash
buf lint && buf breaking --against '.git#branch=main,subdir=proto'
```
Expected: no output (additive change).

- [ ] **Step 3: Generate and confirm the Go field names**

```bash
cd proto && buf generate
grep -nE "^\s+(High52w|Rs3mPct|VolumeRatio50d|Sma200PriorMonth|HasSma50|PriceFeatures) " ../services/gen/proto/go/shorts/v1alpha1/strategies.pb.go
```
Expected: one line per name. If a name differs (for example `High52W`), use the generated spelling in Task 2 and in this plan's Task 3 wire names (`web/src/gen/.../strategies_pb.ts` is the source for the TS spelling).

- [ ] **Step 4: Build the Go module**

```bash
cd services && GOWORK=off go build ./...
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add proto/shortedapi/shorts/v1alpha1/strategies.proto services/gen web/src/gen sdks/java api/schema/generated
git commit -m "feat(proto): PriceFeatures on GetStockStrategyFitResponse

The levels the picker tested for one stock, so the stock page can draw them.
Additive; every nullable number carries a has_ flag.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Map the candidate into `PriceFeatures`

**Files:**
- Modify: `services/shorts/internal/services/shorts/strategy_fit.go` (after `resp.InUniverse = true`, line 42)
- Create: `services/shorts/internal/services/shorts/strategy_fit_test.go`

**Interfaces:**
- Consumes: `strategies.Candidate` (pointer fields `SMA50, SMA150, SMA200, SMA200_1mAgo, High52w, Low52w, BaseHigh, BaseLow, BaseDepthPct *float64`, `BaseLengthDays *int32`, `BreakoutRecent *bool`, `BreakoutDate *time.Time`, `RS3mPct, RS6mPct, VolumeRatio50d *float64`, `SessionsAvailable int32`, `AsOf time.Time`, `Close float64`); test helpers in the package: `spUniverse()`, `spReady(code)`, `spUptrend()`, `f64`, `spInt32`, `spBool`, `spDate`, `newTestServer`, `mocks.NewMockShortsStore`.
- Produces: `func priceFeaturesProto(c *strategies.Candidate) *shortsv1alpha1.PriceFeatures`.

- [ ] **Step 1: Write the failing tests**

`services/shorts/internal/services/shorts/strategy_fit_test.go`:

```go
package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

func TestPriceFeaturesProto_MapsPresentFieldsAndFlagsAbsentOnes(t *testing.T) {
	c := spReady("RDY") // base 8..9.5 over 30 sessions, breakout 2026-09-24, no SMAs
	c.SMA200 = f64(7.25)
	c.High52w = f64(10.4)

	pf := priceFeaturesProto(&c)
	require.NotNil(t, pf)
	assert.Equal(t, "2026-09-25", pf.AsOf)
	assert.Equal(t, 10.0, pf.Close)
	assert.True(t, pf.HasSma200)
	assert.Equal(t, 7.25, pf.Sma200)
	assert.False(t, pf.HasSma50, "an absent SMA 50 is flagged, never zero-filled")
	assert.Equal(t, 0.0, pf.Sma50)
	assert.False(t, pf.HasSma150)
	assert.False(t, pf.HasSma200PriorMonth)
	assert.True(t, pf.HasHigh52w)
	assert.Equal(t, 10.4, pf.High52w)
	assert.False(t, pf.HasLow52w)
	assert.True(t, pf.HasBaseHigh)
	assert.Equal(t, 9.5, pf.BaseHigh)
	assert.True(t, pf.HasBaseLow)
	assert.Equal(t, 8.0, pf.BaseLow)
	assert.True(t, pf.HasBaseDepthPct)
	assert.Equal(t, 15.8, pf.BaseDepthPct)
	assert.True(t, pf.HasBaseLengthDays)
	assert.Equal(t, int32(30), pf.BaseLengthDays)
	assert.True(t, pf.BreakoutRecent)
	assert.Equal(t, "2026-09-24", pf.BreakoutDate)
	assert.True(t, pf.HasRs3mPct)
	assert.Equal(t, 10.0, pf.Rs3mPct)
	assert.False(t, pf.HasRs6mPct)
	assert.True(t, pf.HasVolumeRatio50d)
	assert.Equal(t, 2.1, pf.VolumeRatio50d)
}

func TestPriceFeaturesProto_NilCandidateAndEmptyDatesAreSafe(t *testing.T) {
	assert.Nil(t, priceFeaturesProto(nil))

	c := strategies.Candidate{StockCode: "NEW", Close: 1.5, SessionsAvailable: 12}
	pf := priceFeaturesProto(&c)
	require.NotNil(t, pf)
	assert.Equal(t, "", pf.AsOf, "a zero AsOf is empty, not 0001-01-01")
	assert.Equal(t, "", pf.BreakoutDate)
	assert.False(t, pf.BreakoutRecent)
	assert.Equal(t, int32(12), pf.SessionsAvailable)
	assert.False(t, pf.HasBaseHigh)
}

func TestGetStockStrategyFit_CarriesPriceFeaturesForUniverseStocks(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "rdy"}))
	require.NoError(t, err)
	require.True(t, resp.Msg.InUniverse)
	require.NotNil(t, resp.Msg.PriceFeatures)
	assert.Equal(t, 9.5, resp.Msg.PriceFeatures.BaseHigh)
	assert.True(t, resp.Msg.PriceFeatures.HasBaseHigh)
	assert.Equal(t, "2026-09-24", resp.Msg.PriceFeatures.BreakoutDate)
}

func TestGetStockStrategyFit_OutsideTheUniverseHasNoPriceFeatures(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "ZZZZ"}))
	require.NoError(t, err)
	assert.False(t, resp.Msg.InUniverse)
	assert.Nil(t, resp.Msg.PriceFeatures)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services && GOWORK=off go test ./shorts/internal/services/shorts/ -run 'PriceFeatures|GetStockStrategyFit_' -count=1
```
Expected: compile error `undefined: priceFeaturesProto`.

- [ ] **Step 3: Implement the mapping and wire it**

Append to `strategy_fit.go`:

```go
const isoDay = "2006-01-02"

// priceFeaturesProto is the candidate's mv_price_features row as the fit
// response's PriceFeatures: every nullable number with its has_ flag, dates
// as ISO days, nothing coalesced to zero. nil for a nil candidate.
func priceFeaturesProto(c *strategies.Candidate) *shortsv1alpha1.PriceFeatures {
	if c == nil {
		return nil
	}
	pf := &shortsv1alpha1.PriceFeatures{
		Close:             c.Close,
		SessionsAvailable: c.SessionsAvailable,
	}
	if !c.AsOf.IsZero() {
		pf.AsOf = c.AsOf.Format(isoDay)
	}
	set := func(dst *float64, has *bool, v *float64) {
		if v != nil {
			*dst, *has = *v, true
		}
	}
	set(&pf.Sma50, &pf.HasSma50, c.SMA50)
	set(&pf.Sma150, &pf.HasSma150, c.SMA150)
	set(&pf.Sma200, &pf.HasSma200, c.SMA200)
	set(&pf.Sma200PriorMonth, &pf.HasSma200PriorMonth, c.SMA200_1mAgo)
	set(&pf.High52w, &pf.HasHigh52w, c.High52w)
	set(&pf.Low52w, &pf.HasLow52w, c.Low52w)
	set(&pf.BaseHigh, &pf.HasBaseHigh, c.BaseHigh)
	set(&pf.BaseLow, &pf.HasBaseLow, c.BaseLow)
	set(&pf.BaseDepthPct, &pf.HasBaseDepthPct, c.BaseDepthPct)
	set(&pf.Rs3mPct, &pf.HasRs3mPct, c.RS3mPct)
	set(&pf.Rs6mPct, &pf.HasRs6mPct, c.RS6mPct)
	set(&pf.VolumeRatio50d, &pf.HasVolumeRatio50d, c.VolumeRatio50d)
	if c.BaseLengthDays != nil {
		pf.BaseLengthDays, pf.HasBaseLengthDays = *c.BaseLengthDays, true
	}
	if c.BreakoutRecent != nil {
		pf.BreakoutRecent = *c.BreakoutRecent
	}
	if c.BreakoutDate != nil && !c.BreakoutDate.IsZero() {
		pf.BreakoutDate = c.BreakoutDate.Format(isoDay)
	}
	return pf
}
```

In the handler, replace

```go
	resp.InUniverse = true
```

with

```go
	resp.InUniverse = true
	resp.PriceFeatures = priceFeaturesProto(&u.candidates[u.index[code]])
```

- [ ] **Step 4: Run the package tests**

```bash
cd services && GOWORK=off go test ./shorts/internal/services/shorts/ -count=1
```
Expected: PASS, including the four new tests and the existing `TestGetStockStrategyFit_*`.

- [ ] **Step 5: Lint and run the MCP tests (the fit RPC is not an MCP tool, this proves it stayed that way)**

```bash
cd services && GOWORK=off go vet ./shorts/... && GOWORK=off go test ./shorts/internal/mcp/ -count=1
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/shorts/internal/services/shorts/strategy_fit.go services/shorts/internal/services/shorts/strategy_fit_test.go
git commit -m "feat(shorts): return the stock's price features with its strategy fit

Pure mapping from the candidate the handler already loads; nil pointers
become has_=false, dates ISO days, nothing coalesced to zero.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**PR 1 ends here.** Open it against `main` titled `feat(api): PriceFeatures on GetStockStrategyFit`; the body notes that deploys currently run through Cuttlefish, not the disabled GitHub workflow, and that the web ignores the field until PR 2.

---

## PR 2 — web

### Task 3: Web action maps `priceFeatures` and `regime`

**Files:**
- Modify: `web/src/app/actions/getStockStrategyFit.ts`
- Modify: `web/src/app/actions/__tests__/getStockStrategyFit.test.ts`

**Interfaces:**
- Consumes: `mapRegime(input: MarketRegimeInput | null | undefined): MarketRegimeView | null` from `~/@/lib/strategies/map`; `MarketRegimeView` from `~/@/lib/strategies/types`.
- Produces (read by Tasks 9, 15, 16):

```ts
export interface StockPriceFeatures {
  asOf: string;                     // "" when unknown
  close: number | null;
  sma50: number | null; sma150: number | null; sma200: number | null;
  sma200PriorMonth: number | null;
  high52w: number | null; low52w: number | null;
  baseHigh: number | null; baseLow: number | null;
  baseDepthPct: number | null; baseLengthDays: number | null;
  breakoutRecent: boolean;
  breakoutDate: string | null;      // YYYY-MM-DD
  rs3mPct: number | null; rs6mPct: number | null;
  volumeRatio50d: number | null;
  sessionsAvailable: number;
}
export interface StockStrategyFit {
  stockCode: string; asOf: string; inUniverse: boolean;
  fits: StockStrategyFitRow[];
  priceFeatures: StockPriceFeatures | null;   // null when absent or not in universe
  regime: MarketRegimeView | null;
}
export const STRATEGY_FIT_CACHE_VERSION = "v2";
```

- [ ] **Step 1: Write the failing tests**

Append to `getStockStrategyFit.test.ts` inside the existing top-level `describe` (or as a new `describe("price features and regime")` block at the end of the file):

```ts
describe("price features and regime", () => {
  it("maps present features, nulls flagged-absent ones, and keeps the regime", () => {
    const fit = mapStockStrategyFit("BHP", {
      ...fitResponse(),
      regime: { indexCode: "XJO", asOf: "2026-09-25", regime: "uptrend", close: 8800, sma50: 8600, sma200: 8200, pctOff52wHigh: -1.5, verdict: "Uptrend: XJO above its averages." },
      priceFeatures: {
        asOf: "2026-09-25", close: 42.1,
        sma50: 40, hasSma50: true, sma150: 0, hasSma150: false, sma200: 38.5, hasSma200: true,
        sma200PriorMonth: 38.1, hasSma200PriorMonth: true,
        high52w: 45, hasHigh52w: true, low52w: 0, hasLow52w: false,
        baseHigh: 43, hasBaseHigh: true, baseLow: 39, hasBaseLow: true,
        baseDepthPct: 9.3, hasBaseDepthPct: true, baseLengthDays: 22, hasBaseLengthDays: true,
        breakoutRecent: true, breakoutDate: "2026-09-19",
        rs3mPct: 4.2, hasRs3mPct: true, rs6mPct: 0, hasRs6mPct: false,
        volumeRatio50d: 1.8, hasVolumeRatio50d: true, sessionsAvailable: 260,
      },
    });
    expect(fit.priceFeatures).toEqual({
      asOf: "2026-09-25", close: 42.1,
      sma50: 40, sma150: null, sma200: 38.5, sma200PriorMonth: 38.1,
      high52w: 45, low52w: null,
      baseHigh: 43, baseLow: 39, baseDepthPct: 9.3, baseLengthDays: 22,
      breakoutRecent: true, breakoutDate: "2026-09-19",
      rs3mPct: 4.2, rs6mPct: null, volumeRatio50d: 1.8, sessionsAvailable: 260,
    });
    expect(fit.regime?.regime).toBe("uptrend");
    expect(fit.regime?.sma200).toBe(8200);
  });

  it("is null for an API that predates the field, and for an empty breakout date", () => {
    expect(mapStockStrategyFit("BHP", fitResponse()).priceFeatures).toBeNull();
    const fit = mapStockStrategyFit("BHP", {
      ...fitResponse(),
      priceFeatures: { asOf: "2026-09-25", close: 1, breakoutRecent: false, breakoutDate: "", sessionsAvailable: 30 },
    });
    expect(fit.priceFeatures?.breakoutDate).toBeNull();
    expect(fit.priceFeatures?.sma50).toBeNull();
    expect(fit.regime).toBeNull();
  });

  it("caches the fit under the v2 key", async () => {
    cacheCalls.length = 0;
    mockGetStockStrategyFit.mockResolvedValue(fitResponse());
    mockListStrategies.mockResolvedValue({ strategies: [] });
    await getStockStrategyFit("BHP");
    expect(cacheCalls[0]![1]).toEqual(["stock-strategy-fit", "BHP", "v2"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd web && npx jest src/app/actions/__tests__/getStockStrategyFit.test.ts
```
Expected: FAIL — `priceFeatures` undefined, key `v1`.

- [ ] **Step 3: Implement**

In `getStockStrategyFit.ts`:

1. Change `export const STRATEGY_FIT_CACHE_VERSION = "v1";` to `"v2"`.
2. Add the import `import { mapRegime, type MarketRegimeInput } from "~/@/lib/strategies/map";` and `import type { MarketRegimeView } from "~/@/lib/strategies/types";`.
3. Add the `StockPriceFeatures` interface (above) and extend `StockStrategyFit` with `priceFeatures: StockPriceFeatures | null; regime: MarketRegimeView | null;`.
4. Extend `StockStrategyFitResponseLike` with:

```ts
  regime?: MarketRegimeInput | null;
  priceFeatures?: PriceFeaturesLike | null;
```
and add:

```ts
/** The PriceFeatures fields the mapper reads (the message satisfies it). */
export interface PriceFeaturesLike {
  asOf?: string; close?: number;
  sma50?: number; hasSma50?: boolean; sma150?: number; hasSma150?: boolean;
  sma200?: number; hasSma200?: boolean; sma200PriorMonth?: number; hasSma200PriorMonth?: boolean;
  high52w?: number; hasHigh52w?: boolean; low52w?: number; hasLow52w?: boolean;
  baseHigh?: number; hasBaseHigh?: boolean; baseLow?: number; hasBaseLow?: boolean;
  baseDepthPct?: number; hasBaseDepthPct?: boolean; baseLengthDays?: number; hasBaseLengthDays?: boolean;
  breakoutRecent?: boolean; breakoutDate?: string;
  rs3mPct?: number; hasRs3mPct?: boolean; rs6mPct?: number; hasRs6mPct?: boolean;
  volumeRatio50d?: number; hasVolumeRatio50d?: boolean; sessionsAvailable?: number;
}

function flagged(value: number | undefined, has: boolean | undefined): number | null {
  return has === true && typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function mapPriceFeatures(
  pf: PriceFeaturesLike | null | undefined,
): StockPriceFeatures | null {
  if (!pf) return null;
  return {
    asOf: text(pf.asOf),
    close: typeof pf.close === "number" && Number.isFinite(pf.close) ? pf.close : null,
    sma50: flagged(pf.sma50, pf.hasSma50),
    sma150: flagged(pf.sma150, pf.hasSma150),
    sma200: flagged(pf.sma200, pf.hasSma200),
    sma200PriorMonth: flagged(pf.sma200PriorMonth, pf.hasSma200PriorMonth),
    high52w: flagged(pf.high52w, pf.hasHigh52w),
    low52w: flagged(pf.low52w, pf.hasLow52w),
    baseHigh: flagged(pf.baseHigh, pf.hasBaseHigh),
    baseLow: flagged(pf.baseLow, pf.hasBaseLow),
    baseDepthPct: flagged(pf.baseDepthPct, pf.hasBaseDepthPct),
    baseLengthDays:
      pf.hasBaseLengthDays === true && typeof pf.baseLengthDays === "number"
        ? Math.round(pf.baseLengthDays)
        : null,
    breakoutRecent: pf.breakoutRecent === true,
    breakoutDate: text(pf.breakoutDate) || null,
    rs3mPct: flagged(pf.rs3mPct, pf.hasRs3mPct),
    rs6mPct: flagged(pf.rs6mPct, pf.hasRs6mPct),
    volumeRatio50d: flagged(pf.volumeRatio50d, pf.hasVolumeRatio50d),
    sessionsAvailable:
      typeof pf.sessionsAvailable === "number" ? Math.round(pf.sessionsAvailable) : 0,
  };
}
```
5. In `mapStockStrategyFit`'s return, add `priceFeatures: mapPriceFeatures(response.priceFeatures)` and `regime: mapRegime(response.regime)`.
6. `applyRuleTitles` spreads `...fit`, so the new fields survive; no change there.

If `MarketRegimeInput` is not exported from `map.ts`, export it (it is declared `export interface MarketRegimeInput` at line 65 — confirm).

- [ ] **Step 4: Run the action tests and the strategies map tests**

```bash
cd web && npx jest src/app/actions/__tests__/getStockStrategyFit.test.ts src/@/lib/strategies
```
Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd web && npx tsc --noEmit -p tsconfig.json
```
Expected: clean. (The current page passes `fit` into `StrategyFitCard`, whose prop type is `StockStrategyFit`; the added fields are additive.)

- [ ] **Step 6: Commit**

```bash
git add web/src/app/actions/getStockStrategyFit.ts web/src/app/actions/__tests__/getStockStrategyFit.test.ts
git commit -m "feat(web): map the fit's price features and regime, cache v2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `?tab=` redirects at the routing layer

**Files:**
- Create: `web/src/config/stock-tab-redirects.json`
- Modify: `web/next.config.mjs` (`redirects()` at line 285)
- Create: `scripts/tests/stock-tab-redirects.test.mjs`

**Interfaces:**
- Produces: `web/src/config/stock-tab-redirects.json` = `{ "<legacy tab value>": "<segment or empty string>" }`; `next.config.mjs` builds one redirect per key.

- [ ] **Step 1: Write the failing test**

`scripts/tests/stock-tab-redirects.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.SKIP_ENV_VALIDATION = "1";
const configUrl = new URL("../../web/next.config.mjs", import.meta.url);
const mapUrl = new URL("../../web/src/config/stock-tab-redirects.json", import.meta.url);

const EXPECTED = {
  overview: "",
  news: "news",
  timeline: "news",
  financials: "financials",
  dividends: "financials",
  directors: "company",
  peers: "short-interest",
  community: "community",
};

test("the legacy ?tab= map names every old tab exactly once", () => {
  const map = JSON.parse(readFileSync(mapUrl, "utf8"));
  assert.deepEqual(map, EXPECTED);
});

test("next.config emits one permanent, query-matched redirect per legacy tab", async () => {
  const { default: config } = await import(configUrl.href);
  const redirects = await config.redirects();
  for (const [tab, segment] of Object.entries(EXPECTED)) {
    const entry = redirects.find(
      (r) => r.source === "/shorts/:code" && r.has?.some((h) => h.type === "query" && h.key === "tab" && h.value === tab),
    );
    assert.ok(entry, `missing redirect for ?tab=${tab}`);
    assert.equal(entry.permanent, true);
    assert.equal(entry.destination, segment ? `/shorts/:code/${segment}` : "/shorts/:code");
    assert.equal(entry.has.length, 1, "exactly one query condition, so ?tab=foo never matches");
  }
});

test("an unmapped tab value has no redirect, so it cannot loop", async () => {
  const { default: config } = await import(configUrl.href);
  const redirects = await config.redirects();
  assert.equal(
    redirects.some((r) => r.has?.some((h) => h.key === "tab" && h.value === "foo")),
    false,
  );
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test scripts/tests/stock-tab-redirects.test.mjs
```
Expected: FAIL — the JSON file does not exist.

- [ ] **Step 3: Implement**

`web/src/config/stock-tab-redirects.json`:

```json
{
  "overview": "",
  "news": "news",
  "timeline": "news",
  "financials": "financials",
  "dividends": "financials",
  "directors": "company",
  "peers": "short-interest",
  "community": "community"
}
```

In `web/next.config.mjs`, next to the `packageJson` import add:

```js
import stockTabRedirects from "./src/config/stock-tab-redirects.json" with { type: "json" };
```

and replace the `redirects()` body with:

```js
  async redirects() {
    // Legacy `/shorts/BHP?tab=financials` deep links → the tab's own route.
    // Query-matched at Vercel's routing layer: no function runs, and an
    // unmapped value falls through to the Overview (never a loop).
    const legacyTabRedirects = Object.entries(stockTabRedirects).map(
      ([tab, segment]) => ({
        source: "/shorts/:code",
        has: [{ type: "query", key: "tab", value: tab }],
        destination: segment ? `/shorts/:code/${segment}` : "/shorts/:code",
        permanent: true,
      }),
    );
    return [
      ...legacyTabRedirects,
      { source: "/housing/suburbs", destination: "/housing", permanent: true },
      {
        source: "/short-squeeze",
        destination: "/battlegrounds",
        permanent: true,
      },
    ];
  },
```

- [ ] **Step 4: Run the test**

```bash
node --test scripts/tests/stock-tab-redirects.test.mjs
```
Expected: PASS (3 tests).

- [ ] **Step 5: Register the test where the others run**

In `.github/workflows/repo-hygiene.yml` the `node --test` invocation at line 113 lists tests explicitly: append ` scripts/tests/stock-tab-redirects.test.mjs` to that command. (`npm run test:workflow` already globs `scripts/tests/*.test.mjs`.)

- [ ] **Step 6: Commit**

```bash
git add web/src/config/stock-tab-redirects.json web/next.config.mjs scripts/tests/stock-tab-redirects.test.mjs .github/workflows/repo-hygiene.yml
git commit -m "feat(web): redirect legacy ?tab= stock links at the routing layer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Revalidate the whole stock segment after a sync

**Files:**
- Modify: `web/src/app/api/revalidate/route.ts` (the `for (const path of paths)` loop, lines ~124-129)
- Modify: `web/src/app/api/revalidate/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("POST /api/revalidate")`, using the file's existing `request()` helper and mocks:

```ts
  it("expires every tab under a stock with one layout-typed call", async () => {
    const res = await POST(
      request(
        "http://localhost/api/revalidate?path=/shorts/[stockCode],/market/[date]",
        "test-revalidation-secret",
      ),
    );
    expect(res.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/shorts/[stockCode]", "layout");
    expect(revalidatePathMock).toHaveBeenCalledWith("/market/[date]", "page");
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest src/app/api/revalidate/__tests__/route.test.ts -t "layout-typed"
```
Expected: FAIL — called with `("/shorts/[stockCode]", "page")`.

- [ ] **Step 3: Implement**

Replace the loop body:

```ts
  for (const path of paths) {
    // A path containing "[" is a dynamic route pattern (e.g. /shorts/[stockCode]).
    // The stock segment is a LAYOUT with seven tab pages beneath it, so it is
    // expired as a layout: one call covers every tab for every code.
    if (path === "/shorts/[stockCode]") revalidatePath(path, "layout");
    else if (path.includes("[")) revalidatePath(path, "page");
    else revalidatePath(path);
  }
```

- [ ] **Step 4: Run the route tests**

```bash
cd web && npx jest src/app/api/revalidate
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/revalidate/route.ts web/src/app/api/revalidate/__tests__/route.test.ts
git commit -m "fix(web): revalidate the stock segment as a layout so every tab expires

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The tab list, the tab bar and the breadcrumbs

**Files:**
- Create: `web/src/@/lib/stocks/stock-tabs.ts`
- Create: `web/src/@/lib/stocks/__tests__/stock-tabs.test.ts`
- Create: `web/src/@/components/company/stock-tab-nav.tsx`
- Create: `web/src/@/components/company/__tests__/stock-tab-nav.test.tsx`
- Create: `web/src/@/components/company/stock-breadcrumbs.tsx`

**Interfaces:**
- Produces:

```ts
// web/src/@/lib/stocks/stock-tabs.ts  (pure, serialisable, no React)
export type StockTabId = "overview" | "short-interest" | "strategy" | "financials" | "company" | "news" | "community";
export interface StockTab { id: StockTabId; label: string; segment: string /* "" for overview */ }
export const STOCK_TABS: readonly StockTab[];
export function stockTabHref(code: string, id: StockTabId): string;   // "/shorts/BHP/strategy", "/shorts/BHP"
export function activeStockTab(pathname: string): StockTabId;         // "/shorts/BHP/community/abc" → "community"; unknown → "overview"
export function stockTabLabel(id: StockTabId): string;
```
```tsx
// web/src/@/components/company/stock-tab-nav.tsx ("use client")
export function StockTabNav({ stockCode }: { stockCode: string }): JSX.Element;
// web/src/@/components/company/stock-breadcrumbs.tsx ("use client")
export function StockBreadcrumbs({ stockCode }: { stockCode: string }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

`web/src/@/lib/stocks/__tests__/stock-tabs.test.ts`:

```ts
import { STOCK_TABS, activeStockTab, stockTabHref, stockTabLabel } from "../stock-tabs";

describe("stock tabs", () => {
  it("lists the seven tabs in display order", () => {
    expect(STOCK_TABS.map((t) => t.id)).toEqual([
      "overview", "short-interest", "strategy", "financials", "company", "news", "community",
    ]);
    expect(STOCK_TABS.map((t) => t.label)).toEqual([
      "Overview", "Short interest", "Strategy", "Financials", "Company", "News", "Community",
    ]);
  });

  it("builds hrefs with the overview at the segment root", () => {
    expect(stockTabHref("BHP", "overview")).toBe("/shorts/BHP");
    expect(stockTabHref("bhp", "strategy")).toBe("/shorts/BHP/strategy");
    expect(stockTabHref("BHP", "short-interest")).toBe("/shorts/BHP/short-interest");
  });

  it("reads the active tab from a pathname, including nested community threads", () => {
    expect(activeStockTab("/shorts/BHP")).toBe("overview");
    expect(activeStockTab("/shorts/BHP/")).toBe("overview");
    expect(activeStockTab("/shorts/BHP/financials")).toBe("financials");
    expect(activeStockTab("/shorts/BHP/community/thread-1")).toBe("community");
    expect(activeStockTab("/shorts/BHP/not-a-tab")).toBe("overview");
    expect(activeStockTab("/stocks")).toBe("overview");
  });

  it("labels", () => {
    expect(stockTabLabel("short-interest")).toBe("Short interest");
  });
});
```

`web/src/@/components/company/__tests__/stock-tab-nav.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";

const prefetch = jest.fn();
let pathname = "/shorts/BHP/strategy";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, push: jest.fn(), replace: jest.fn() }),
  usePathname: () => pathname,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, prefetch: _p, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { StockTabNav } from "../stock-tab-nav";

describe("StockTabNav", () => {
  beforeEach(() => {
    prefetch.mockClear();
    pathname = "/shorts/BHP/strategy";
  });

  it("renders seven links and marks the active one from the pathname", () => {
    render(<StockTabNav stockCode="BHP" />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(7);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/shorts/BHP", "/shorts/BHP/short-interest", "/shorts/BHP/strategy", "/shorts/BHP/financials",
      "/shorts/BHP/company", "/shorts/BHP/news", "/shorts/BHP/community",
    ]);
    expect(screen.getByRole("link", { name: "Strategy" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("prefetches on intent only, once per href", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(prefetch).not.toHaveBeenCalled();
    const financials = screen.getByRole("link", { name: "Financials" });
    fireEvent.pointerEnter(financials);
    fireEvent.focus(financials);
    fireEvent.touchStart(financials);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/shorts/BHP/financials");
    fireEvent.pointerEnter(screen.getByRole("link", { name: "News" }));
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it("never prefetches the active tab", () => {
    render(<StockTabNav stockCode="BHP" />);
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Strategy" }));
    expect(prefetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd web && npx jest src/@/lib/stocks src/@/components/company/__tests__/stock-tab-nav.test.tsx
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the tab list**

`web/src/@/lib/stocks/stock-tabs.ts`:

```ts
// The single list of stock-page tabs. Serialisable (no React, no functions in
// data) so pages, metadata, the sitemap and the client tab bar all read it.
export type StockTabId =
  | "overview"
  | "short-interest"
  | "strategy"
  | "financials"
  | "company"
  | "news"
  | "community";

export interface StockTab {
  id: StockTabId;
  label: string;
  /** URL segment under /shorts/{CODE}; "" for the overview. */
  segment: string;
}

export const STOCK_TABS: readonly StockTab[] = [
  { id: "overview", label: "Overview", segment: "" },
  { id: "short-interest", label: "Short interest", segment: "short-interest" },
  { id: "strategy", label: "Strategy", segment: "strategy" },
  { id: "financials", label: "Financials", segment: "financials" },
  { id: "company", label: "Company", segment: "company" },
  { id: "news", label: "News", segment: "news" },
  { id: "community", label: "Community", segment: "community" },
];

export function stockTabHref(code: string, id: StockTabId): string {
  const upper = code.toUpperCase();
  const tab = STOCK_TABS.find((t) => t.id === id);
  return tab && tab.segment ? `/shorts/${upper}/${tab.segment}` : `/shorts/${upper}`;
}

/** The tab a pathname is on: the first segment after /shorts/{CODE}/, else overview. */
export function activeStockTab(pathname: string): StockTabId {
  const m = /^\/shorts\/[^/]+\/([^/]+)/.exec(pathname);
  if (!m) return "overview";
  const tab = STOCK_TABS.find((t) => t.segment === m[1]);
  return tab ? tab.id : "overview";
}

export function stockTabLabel(id: StockTabId): string {
  return STOCK_TABS.find((t) => t.id === id)?.label ?? "Overview";
}
```

- [ ] **Step 4: Implement the tab bar and the breadcrumbs**

`web/src/@/components/company/stock-tab-nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "~/@/lib/utils";
import {
  STOCK_TABS,
  activeStockTab,
  stockTabHref,
} from "~/@/lib/stocks/stock-tabs";

/**
 * The stock page's tab bar: seven plain links (crawlable, SSR'd by the server
 * layout that renders this). Prefetch is INTENT-driven — pointer enter, touch
 * start or focus, once per href — never on viewport entry: seven viewport
 * prefetches per page view would quietly regenerate seven ISR routes.
 */
export function StockTabNav({ stockCode }: { stockCode: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeStockTab(pathname ?? "");
  const prefetched = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const warm = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive || prefetched.current.has(href)) return;
      prefetched.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  // Seven triggers overflow on a phone: keep the active one in view.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !el) return;
    if (
      el.offsetLeft + el.offsetWidth > list.scrollLeft + list.clientWidth ||
      el.offsetLeft < list.scrollLeft
    ) {
      list.scrollTo({ left: el.offsetLeft - 16 });
    }
  }, [active]);

  return (
    <nav aria-label="Stock sections" className="mb-4">
      <div
        ref={listRef}
        className="flex w-full items-center gap-1 overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground"
      >
        {STOCK_TABS.map((tab) => {
          const href = stockTabHref(stockCode, tab.id);
          const isActive = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={href}
              prefetch={false}
              aria-current={isActive ? "page" : undefined}
              onPointerEnter={() => warm(href, isActive)}
              onTouchStart={() => warm(href, isActive)}
              onFocus={() => warm(href, isActive)}
              className={cn(
                "inline-flex shrink-0 items-center rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
```

`web/src/@/components/company/stock-breadcrumbs.tsx`:

```tsx
"use client";

import { usePathname } from "next/navigation";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  activeStockTab,
  stockTabHref,
  stockTabLabel,
} from "~/@/lib/stocks/stock-tabs";

/** Stocks › CODE › {Tab} — the tab item is omitted on the overview. */
export function StockBreadcrumbs({ stockCode }: { stockCode: string }) {
  const tab = activeStockTab(usePathname() ?? "");
  const items = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: stockTabHref(stockCode, "overview") },
  ];
  if (tab !== "overview") {
    items.push({ label: stockTabLabel(tab), href: stockTabHref(stockCode, tab) });
  }
  return <Breadcrumbs items={items} />;
}
```

- [ ] **Step 5: Run the tests**

```bash
cd web && npx jest src/@/lib/stocks src/@/components/company/__tests__/stock-tab-nav.test.tsx
```
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/@/lib/stocks web/src/@/components/company/stock-tab-nav.tsx web/src/@/components/company/__tests__/stock-tab-nav.test.tsx web/src/@/components/company/stock-breadcrumbs.tsx
git commit -m "feat(web): stock tab list, intent-prefetching tab bar and tab-aware breadcrumbs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Shared tab metadata

**Files:**
- Create: `web/src/@/lib/seo/stock-tab-metadata.ts`
- Create: `web/src/@/lib/seo/__tests__/stock-tab-metadata.test.ts`

**Interfaces:**
- Consumes: `getStock(code)` from `~/app/actions/getStock` (returns `{ name, industry, percentageShorted, ... } | undefined`, throws `NotFoundError` for a missing code), `isStockIndexable({ code, name, industry, percentShorted })`, `formatCompanyName(name, code)` from `~/@/lib/company-name`, `siteConfig` from `~/@/config/site`, `stockTabHref`.
- Produces:

```ts
export interface StockTabMetadataInput {
  code: string;                 // upper-cased by the caller
  tab: StockTabId;
  /** Receives the cleaned company name; returns the title WITHOUT "| Shorted". */
  title: (company: string) => string;
  description: (company: string) => string;
  keywords?: string[];
  /** Extra reason to noindex (Strategy: not in universe; Community: always). */
  forceNoindex?: boolean;
}
export async function stockTabMetadata(input: StockTabMetadataInput): Promise<Metadata>;
```

- [ ] **Step 1: Write the failing test**

```ts
const getStock = jest.fn();
jest.mock("~/app/actions/getStock", () => ({ getStock: (...a: unknown[]) => getStock(...a) }));

import { stockTabMetadata } from "../stock-tab-metadata";

describe("stockTabMetadata", () => {
  beforeEach(() => getStock.mockReset());

  it("builds title, canonical, alternates and cards from the cleaned company name", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({
      code: "BHP", tab: "financials",
      title: (c) => `BHP Financials: Results, Ratios & Statements | ${c}`,
      description: (c) => `${c} results.`,
    });
    expect(md.title).toBe("BHP Financials: Results, Ratios & Statements | BHP Group");
    expect(md.alternates?.canonical).toBe("https://shorted.com.au/shorts/BHP/financials");
    expect(md.openGraph?.url).toBe("https://shorted.com.au/shorts/BHP/financials");
    expect(md.robots).toBeUndefined();
  });

  it("inherits the stock's noindex gate and fails open on a transient read", async () => {
    getStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0 });
    const thin = await stockTabMetadata({ code: "ZZZ", tab: "company", title: (c) => c, description: (c) => c });
    expect(thin.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });

    getStock.mockRejectedValue(new Error("boom"));
    const open = await stockTabMetadata({ code: "BHP", tab: "company", title: (c) => c, description: (c) => c });
    expect(open.robots).toBeUndefined();
    expect(open.title).toBe("BHP");
  });

  it("forceNoindex wins regardless of the stock", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({ code: "BHP", tab: "community", title: (c) => c, description: (c) => c, forceNoindex: true });
    expect(md.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest src/@/lib/seo/__tests__/stock-tab-metadata.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { formatCompanyName } from "~/@/lib/company-name";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { stockTabHref, type StockTabId } from "~/@/lib/stocks/stock-tabs";
import { getStock } from "~/app/actions/getStock";

export interface StockTabMetadataInput {
  code: string;
  tab: StockTabId;
  title: (company: string) => string;
  description: (company: string) => string;
  keywords?: string[];
  forceNoindex?: boolean;
}

const NOINDEX = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
} as const;

/**
 * Metadata for one stock tab. The robots gate is the stock page's own
 * (isStockIndexable) so a thin, noindexed stock never leaks an indexable tab;
 * a transient read fails OPEN, exactly as /news does. The cleaned company
 * name feeds the title; the raw ASIC string would shout.
 */
export async function stockTabMetadata(
  input: StockTabMetadataInput,
): Promise<Metadata> {
  const code = input.code.toUpperCase();
  let company = code;
  let noindex = input.forceNoindex === true;
  try {
    const stock = await getStock(code);
    if (stock) {
      company = formatCompanyName(stock.name ?? "", code) || code;
      if (
        !isStockIndexable({
          code,
          name: stock.name,
          industry: stock.industry,
          percentShorted: stock.percentageShorted,
        })
      ) {
        noindex = true;
      }
    }
  } catch {
    // fail open — keep default robots
  }
  const url = `${siteConfig.url}${stockTabHref(code, input.tab)}`;
  const title = input.title(company);
  const description = input.description(company);
  return {
    title,
    description,
    keywords: input.keywords,
    robots: noindex ? NOINDEX : undefined,
    alternates: {
      canonical: url,
      languages: { "en-AU": url, en: url, "x-default": url },
    },
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: `${title} | ${siteConfig.name}`,
      description,
    },
  };
}
```

If `getStock`'s return type names the fields differently, mirror `news/page.tsx` (which reads `stock.name`, `stock.industry`, `stock.percentageShorted`).

- [ ] **Step 4: Run the test**

```bash
cd web && npx jest src/@/lib/seo/__tests__/stock-tab-metadata.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/lib/seo/stock-tab-metadata.ts web/src/@/lib/seo/__tests__/stock-tab-metadata.test.ts
git commit -m "feat(web): shared metadata builder for stock tabs with the inherited noindex gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The shared layout

**Files:**
- Create: `web/src/app/shorts/[stockCode]/stock-page-shared.ts`
- Create: `web/src/app/shorts/[stockCode]/layout.tsx`
- Create: `web/src/app/shorts/[stockCode]/loading.tsx`
- Create: `web/src/app/shorts/[stockCode]/__tests__/layout.test.tsx`

**Interfaces:**
- Consumes: `getStockOrNotFound(code)` (React-`cache()`d; throws `NotFoundError` for a missing code, resolves `undefined` on a transient error), `getLatestShortDate(code): Promise<Date | null>`, `ShortInterestSummary` + `getShortInterestDeltas(code)` from `./short-interest-summary`, `StockBreadcrumbs`, `StockTabNav` (Task 6), `StockThemeChips({ stockCode, className })`, `CompanyProfile`/`CompanyStats` default exports with placeholders, `LoginPromptBanner`, `SignedOutOnly`, `DashboardLayout`.
- Produces (read by Task 9 and every tab page):

```ts
// stock-page-shared.ts
export const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;
export function cleanCompanyName(name: string, code: string): string;
export function formatAsOfDate(date: Date): string;                 // en-AU, Australia/Sydney
export function asOfClauseFor(date: Date | null): string;           // "as of 2 Oct 2026" | "in the latest ASIC report"
```

The layout renders, in order: breadcrumbs, the login slot, the profile/stats grid, `ShortInterestSummary`, `StockThemeChips`, the chart section, `StockTabNav`, `children`. Until Task 9 lands, the old `page.tsx` still renders its own copy of the header beneath this one; that is expected for one commit and Task 9 removes it.

- [ ] **Step 1: Write the failing test**

`web/src/app/shorts/[stockCode]/__tests__/layout.test.tsx`:

```tsx
/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
jest.mock("next/dynamic", () => () => () => <div data-testid="chart-panel" />);
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
}));
jest.mock("~/app/actions/getLatestShortDate", () => ({
  getLatestShortDate: jest.fn().mockResolvedValue(new Date("2026-10-02T00:00:00Z")),
}));
jest.mock("../short-interest-summary", () => ({
  ShortInterestSummary: ({ asOfClause }: { asOfClause: string }) => (
    <p data-testid="summary">{asOfClause}</p>
  ),
  getShortInterestDeltas: jest.fn().mockResolvedValue({}),
}));
jest.mock("~/@/components/company/stock-tab-nav", () => ({
  StockTabNav: ({ stockCode }: { stockCode: string }) => <nav data-testid="tab-nav">{stockCode}</nav>,
}));
jest.mock("~/@/components/company/stock-breadcrumbs", () => ({
  StockBreadcrumbs: () => <div data-testid="breadcrumbs" />,
}));
jest.mock("~/@/components/themes/theme-chips", () => ({ StockThemeChips: () => <div data-testid="chips" /> }));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("~/@/components/ui/companyProfile", () => ({
  __esModule: true, default: () => <div data-testid="profile" />, CompanyProfilePlaceholder: () => null,
}));
jest.mock("~/@/components/ui/companyStats", () => ({
  __esModule: true, default: () => <div data-testid="stats" />, CompanyStatsPlaceholder: () => null,
}));
jest.mock("~/@/components/ui/login-prompt-banner", () => ({ LoginPromptBanner: () => null }));
jest.mock("~/@/components/ui/session-gates", () => ({ SignedOutOnly: () => null }));

import StockLayout from "../layout";
import { NotFoundError } from "~/app/actions/withRetry";

const stock = { name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58, reportedShortPositions: 80_000_000 };

describe("stock layout", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockNotFound.mockClear();
  });

  it("renders the chrome in order and the page beneath the tab bar", async () => {
    mockGetStockOrNotFound.mockResolvedValue(stock);
    const el = await StockLayout({
      params: Promise.resolve({ stockCode: "bhp" }),
      children: <div data-testid="child" />,
    });
    const { container } = render(el);
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["breadcrumbs", "profile", "stats", "summary", "chips", "chart-panel", "tab-nav", "child"]);
    expect(screen.getByTestId("summary")).toHaveTextContent("as of 2 Oct 2026");
    expect(screen.getByTestId("tab-nav")).toHaveTextContent("BHP");
    expect(mockGetStockOrNotFound).toHaveBeenCalledWith("BHP");
  });

  it("404s a malformed code before any fetch", async () => {
    await expect(
      StockLayout({ params: Promise.resolve({ stockCode: "not-a-code" }), children: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetStockOrNotFound).not.toHaveBeenCalled();
  });

  it("404s a code the API does not know", async () => {
    mockGetStockOrNotFound.mockRejectedValue(new NotFoundError("ZZZZ"));
    await expect(
      StockLayout({ params: Promise.resolve({ stockCode: "ZZZZ" }), children: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails the ISR render on a transient read instead of caching a degraded shell", async () => {
    mockGetStockOrNotFound.mockResolvedValue(undefined);
    await expect(
      StockLayout({ params: Promise.resolve({ stockCode: "BHP" }), children: null }),
    ).rejects.toThrow(/transiently unavailable/);
  });
});
```

If `NotFoundError`'s constructor takes different arguments, construct it the way `withRetry.ts` does (read the class there).

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/__tests__/layout.test.tsx"
```
Expected: FAIL — `../layout` not found.

- [ ] **Step 3: Implement the shared helpers**

`web/src/app/shorts/[stockCode]/stock-page-shared.ts`:

```ts
import { formatCompanyName } from "~/@/lib/company-name";

/** ASX codes are 1-4 alphanumerics. Checked before any fetch. */
export const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;

// Display name for every SEO-critical surface (title, og:title, h1, crawler
// summary, schema). `stock.name` is the raw ASIC PRODUCT string — SHOUTED,
// with a security-type descriptor — so it goes through the shared formatter.
export function cleanCompanyName(name: string, code: string): string {
  return formatCompanyName(name, code) || name;
}

// ASIC report dates are Sydney calendar days — format them in that zone so a
// UTC-hosted render can't show the previous day.
export function formatAsOfDate(date: Date): string {
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}

/** The "as of" clause shared by the summary and the schema. Never `new Date()`. */
export function asOfClauseFor(date: Date | null): string {
  return date ? `as of ${formatAsOfDate(date)}` : "in the latest ASIC report";
}
```

- [ ] **Step 4: Implement the layout and the loading skeleton**

`web/src/app/shorts/[stockCode]/layout.tsx`:

```tsx
import nextDynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CompanyProfile, {
  CompanyProfilePlaceholder,
} from "~/@/components/ui/companyProfile";
import CompanyStats, {
  CompanyStatsPlaceholder,
} from "~/@/components/ui/companyStats";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";
import { SignedOutOnly } from "~/@/components/ui/session-gates";
import { StockThemeChips } from "~/@/components/themes/theme-chips";
import { StockBreadcrumbs } from "~/@/components/company/stock-breadcrumbs";
import { StockTabNav } from "~/@/components/company/stock-tab-nav";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { NotFoundError } from "~/app/actions/withRetry";
import {
  ShortInterestSummary,
  getShortInterestDeltas,
} from "./short-interest-summary";
import {
  STOCK_CODE_PATTERN,
  asOfClauseFor,
  cleanCompanyName,
} from "./stock-page-shared";

// Consolidated per-stock chart (price + short interest, dual-axis, volume,
// brush). Client-only: uses Connect-RPC + market-data hooks. It lives in the
// LAYOUT so switching tabs never remounts or refetches it.
const StockChartPanel = nextDynamic(
  () =>
    import("~/@/components/charts/StockChartPanel").then(
      (m) => m.StockChartPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] animate-pulse rounded-lg bg-muted/40" />
    ),
  },
);

// The segment is ISR; the pages beneath export the trio (revalidate,
// dynamicParams, generateStaticParams). Everything fetched here runs inside
// unstable_cache (getStock, the daily series) — no searchParams, cookies or
// headers, or the whole segment goes dynamic.
export const revalidate = 3600;

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ stockCode: string }>;
}

export default async function StockLayout({ children, params }: LayoutProps) {
  const { stockCode: raw } = await params;
  const stockCode = raw.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(stockCode)) notFound();

  let stock: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  try {
    stock = await getStockOrNotFound(stockCode);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
  }
  // Under ISR a degraded render would be BAKED into the shared cache for up
  // to an hour. Fail the generation instead: nothing is cached, and the next
  // request regenerates.
  if (!stock) {
    throw new Error(
      `stock data transiently unavailable for ${stockCode}; failing ISR render instead of caching a degraded page`,
    );
  }

  const [latestShortDate, deltas] = await Promise.all([
    getLatestShortDate(stockCode).catch((): Date | null => null),
    getShortInterestDeltas(stockCode),
  ]);
  const companyName = cleanCompanyName(stock.name || stockCode, stockCode);

  return (
    <DashboardLayout>
      <div className="mb-4">
        <StockBreadcrumbs stockCode={stockCode} />
      </div>

      {/* Signed-out breadcrumb to login — client-gated; the slot is always in
          the server HTML and critical CSS reserves its height under html.anon
          (see layout.tsx at the root) so it never shifts the page. */}
      <div className="login-slot">
        <SignedOutOnly>
          <div className="overflow-hidden rounded-lg border border-primary/20">
            <LoginPromptBanner />
          </div>
        </SignedOutOnly>
      </div>

      <div className="mb-6 grid grid-cols-1 items-start gap-4 md:grid-cols-3 md:gap-6">
        <div className="md:col-span-2">
          <Suspense fallback={<CompanyProfilePlaceholder />}>
            <CompanyProfile stockCode={stockCode} />
          </Suspense>
        </div>
        <div className="h-full md:col-span-1">
          <Suspense fallback={<CompanyStatsPlaceholder />}>
            <CompanyStats stockCode={stockCode} initialStock={stock} />
          </Suspense>
        </div>
      </div>

      <ShortInterestSummary
        stockCode={stockCode}
        companyName={companyName}
        industry={stock.industry || ""}
        shortPct={stock.percentageShorted ?? 0}
        shortPositions={stock.reportedShortPositions ?? 0}
        asOfClause={asOfClauseFor(latestShortDate)}
        deltas={deltas}
      />

      <StockThemeChips stockCode={stockCode} className="-mt-2 mb-6" />

      <section aria-labelledby="stock-chart-heading" className="mb-6 min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="stock-chart-heading" className="text-lg font-semibold tracking-tight">
            Price &amp; short interest
          </h2>
          <span className="text-xs text-muted-foreground">
            Toggle series, zoom, and compare · ASIC daily, T+4
          </span>
        </div>
        <StockChartPanel stockCode={stockCode} />
      </section>

      <StockTabNav stockCode={stockCode} />

      {children}
    </DashboardLayout>
  );
}
```

`web/src/app/shorts/[stockCode]/loading.tsx` (the Overview's skeleton; each tab adds its own in its folder):

```tsx
/** Overview skeleton: the layout above it is already on screen. */
export default function StockOverviewLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]"
    >
      <div className="flex flex-col gap-4 md:gap-6">
        <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-56 animate-pulse rounded-lg bg-muted/40" />
      </div>
      <div className="flex flex-col gap-4 md:gap-6">
        <div className="h-48 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the layout test**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/__tests__/layout.test.tsx"
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/shorts/[stockCode]/stock-page-shared.ts" "web/src/app/shorts/[stockCode]/layout.tsx" "web/src/app/shorts/[stockCode]/loading.tsx" "web/src/app/shorts/[stockCode]/__tests__/layout.test.tsx"
git commit -m "feat(web): shared stock layout with header, summary, chart and tab bar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The Overview strategy strip

**Files:**
- Create: `web/src/@/components/stocks/strategy-fit-strip.tsx`
- Create: `web/src/@/components/stocks/__tests__/strategy-fit-strip.test.tsx`

**Interfaces:**
- Consumes: `StockStrategyFit`, `StockStrategyFitRow` (Task 3), `StatusPill({ status: PickStatus })` from `~/@/components/picks/picks-table`, `formatDate` from `~/@/lib/fundamentals/format`, `stockTabHref` (Task 6), `Card*` from `~/@/components/ui/card`.
- Produces: `export function StrategyFitStrip({ fit }: { fit: StockStrategyFit }): JSX.Element | null` — a `region` named "Strategy fit"; one row per strategy with the strategy name linking to `/picks/<id>`, the status pill (or "Not a candidate"), score and "rank N of M"; a "Full strategy readings" link to the Strategy tab. Props-only; imports nothing from protobuf or connect.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, within } from "@testing-library/react";
import { StrategyFitStrip } from "../strategy-fit-strip";
import type { StockStrategyFit } from "~/app/actions/getStockStrategyFit";

const fit: StockStrategyFit = {
  stockCode: "BHP",
  asOf: "2026-10-07",
  inUniverse: true,
  priceFeatures: null,
  regime: null,
  fits: [
    { strategyId: "canslim", strategyName: "CAN SLIM", status: "watch", score: 41, rank: 18, totalCount: 40, rules: [], ruleColumns: [] },
    { strategyId: "zanger-breakout", strategyName: "Zanger Breakout", status: "none", score: null, rank: null, totalCount: 37, rules: [], ruleColumns: [] },
  ],
};

describe("StrategyFitStrip", () => {
  it("renders one row per strategy with status, score, rank and the picks link", () => {
    render(<StrategyFitStrip fit={fit} />);
    const region = screen.getByRole("region", { name: "Strategy fit" });
    expect(within(region).getByRole("link", { name: "CAN SLIM" })).toHaveAttribute("href", "/picks/canslim");
    expect(within(region).getByText("rank 18 of 40")).toBeInTheDocument();
    expect(within(region).getByText("41")).toBeInTheDocument();
    expect(within(region).getByText("Not a candidate")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: /Full strategy readings/ })).toHaveAttribute("href", "/shorts/BHP/strategy");
    expect(within(region).getByText(/Prices to 7 Oct 2026/)).toBeInTheDocument();
  });

  it("renders nothing without fits", () => {
    const { container } = render(<StrategyFitStrip fit={{ ...fit, fits: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest src/@/components/stocks/__tests__/strategy-fit-strip.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import Link from "next/link";
import { Crosshair } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { StatusPill } from "~/@/components/picks/picks-table";
import { formatDate } from "~/@/lib/fundamentals/format";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import type {
  StockStrategyFit,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

// The Overview's one-line-per-strategy digest. The full reading (rules,
// evidence, the levels chart) lives on the Strategy tab; this strip exists so
// the most-visited page still carries the crawlable status and the links.
// Props-only, so it imports nothing from protobuf or connect.

export const NOT_A_CANDIDATE = "Not a candidate";

function Row({ fit }: { fit: StockStrategyFitRow }) {
  const candidate = fit.status !== "none";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
      <Link
        href={`/picks/${fit.strategyId}`}
        prefetch={false}
        className="font-medium text-primary hover:underline"
      >
        {fit.strategyName}
      </Link>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {candidate ? (
          <StatusPill status={fit.status} />
        ) : (
          <span className="inline-flex items-center rounded-sm border border-dashed border-border px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none tracking-[0.12em]">
            {NOT_A_CANDIDATE}
          </span>
        )}
        {candidate && fit.score !== null ? (
          <span className="tabular-nums">
            Score <span className="text-foreground">{Math.round(fit.score)}</span>
          </span>
        ) : null}
        {candidate && fit.rank !== null ? (
          <span className="tabular-nums">
            rank {fit.rank}
            {fit.totalCount !== null ? ` of ${fit.totalCount}` : ""}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function StrategyFitStrip({ fit }: { fit: StockStrategyFit }) {
  if (fit.fits.length === 0) return null;
  const pricesTo = formatDate(fit.asOf);
  return (
    <Card role="region" aria-labelledby="strategy-fit-heading">
      <CardHeader className="pb-2">
        <CardTitle id="strategy-fit-heading" className="flex items-center gap-2 text-lg">
          <Crosshair className="h-5 w-5" aria-hidden />
          Strategy fit
        </CardTitle>
        <CardDescription className="text-xs">
          How each stock picker strategy reads {fit.stockCode} today
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y">
          {fit.fits.map((row) => (
            <Row key={row.strategyId} fit={row} />
          ))}
        </ul>
        <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {pricesTo ? `Prices to ${pricesTo} · ` : ""}Mechanical readings of
            published rules, not recommendations
          </span>
          <Link
            href={stockTabHref(fit.stockCode, "strategy")}
            prefetch={false}
            className="text-xs text-primary hover:underline"
          >
            Full strategy readings →
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
```

`StatusPill` is typed on `PickStatus` (no `"none"`); the `candidate` guard narrows `fit.status` — if TypeScript still complains, cast with `fit.status as PickStatus` importing the type from `~/@/lib/strategies/types`.

- [ ] **Step 4: Run the test**

```bash
cd web && npx jest src/@/components/stocks/__tests__/strategy-fit-strip.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/components/stocks/strategy-fit-strip.tsx web/src/@/components/stocks/__tests__/strategy-fit-strip.test.tsx
git commit -m "feat(web): strategy fit strip for the stock overview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The Overview page, and the old tabs shell goes

**Files:**
- Modify: `web/src/app/shorts/[stockCode]/page.tsx` (imports, the data block from line 260, the whole render tree from `<DashboardLayout>` to the end)
- Delete: `web/src/@/components/company/stock-tabs.tsx`
- Modify: `web/src/app/shorts/[stockCode]/__tests__/page-runtime.test.tsx`, `page-old-api.test.tsx`

**Interfaces:**
- Consumes: `StrategyFitStrip` (Task 9), `stockTabHref` (Task 6), `cleanCompanyName`, `formatAsOfDate`, `asOfClauseFor`, `STOCK_CODE_PATTERN` (Task 8), `getStockHeadlines(code, limit): Promise<StockHeadline[]>`, `getRelatedStocks(code)` → `{ stocks, industry, industrySlug }`, `getStockFundamentals(code)`, `getStockStrategyFit(code)`, `getLatestShortDate(code)`, `FundamentalsSummary({ stockCode, companyName, fundamentals })`, `CommunityOverviewTeaser({ stockCode })`, `RelatedStocks`, `CompanyInfo` + placeholder, `LatestWeeklyReportLink({ variant: "inline", label, className })`, `SignedOutOnly`, `LLMMeta`, `StockLLMMeta`, `BreadcrumbStructuredData`.
- Produces: the Overview route body. `generateMetadata`, `revalidate`, `dynamicParams`, `generateStaticParams` are unchanged.

- [ ] **Step 1: Re-point the runtime tests first (they fail until the page changes)**

In `page-runtime.test.tsx`:

1. Test `"keeps per-request session reads out of the ISR render path"`: it reads `../page.tsx`. Keep the two `not.toContain` assertions on `page.tsx`, then add reads of `../layout.tsx` (expect `toContain("SignedOutOnly")`) and `../company/page.tsx` (expect `toContain("StockEvidencePanelClient")`). Remove the two `toContain` assertions on `page.tsx`.
2. Test `"loads state exposure defensively and renders it directly below theme links"`: rename to `"loads state exposure defensively on the Company tab"`, read `../company/page.tsx`, keep `expect(source).toContain("getStateExposureIndex().catch(")`, delete the `toMatch(/<StockThemeChips.../)` assertion, and add a read of `../layout.tsx` with `expect(layoutSource).toContain("<StockThemeChips")`.
3. Add:

```ts
  it("renders no tab shell and no legacy ?tab= reader", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
    expect(source).not.toContain("StockTabs");
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("window.location.search");
  });
```

In `page-old-api.test.tsx`:

1. Delete the `jest.mock("~/@/components/company/stock-tabs", ...)` block.
2. In `"renders an old-proto response as today..."`: delete every assertion that reads `screen.getByTestId("financials")`, `latest`, `reports`, `tax-card`, `Key ratios` (they move to Task 11's Financials test). Keep: `expect(screen.queryByRole("region", { name: "Strategy fit" })).not.toBeInTheDocument()`, the `recorded revenue of US\$51\.3B` assertion (now queried on `screen`, not `within(overview)`), and the `Key metrics` / `Results summary` absence checks.
3. In `"renders the Strategy fit card in the Overview when the fit rpc answers"`: replace `within(screen.getByTestId("overview")).getByRole("region", { name: "Strategy fit" })` with `screen.getByRole("region", { name: "Strategy fit" })`; keep the `CAN SLIM` link and `rank 18 of 40` assertions; delete the `"1. Market direction: pass. XJO uptrend"` assertion; add `expect(within(card).getByRole("link", { name: /Full strategy readings/ })).toHaveAttribute("href", "/shorts/BHP/strategy")`.
4. In `"keeps the fit fetch out of the page's critical Promise.all"`: keep the `critical` extraction and the two `getStockStrategyFit` assertions; change `expect(source).toContain("<FinancialReportsSection")` to read `../financials/page.tsx` instead; keep the `not.toContain` checks on `page.tsx`.
5. In `"renders without any fundamentals when that rpc fails too"`: delete the `financials` / `Latest result` / `tax-card` assertions; keep the `EMPTY_STATE` and `Strategy fit` absence checks.
6. Add the mocks the new page needs that the file lacks: `jest.mock("~/@/components/reports/latest-weekly-report-link", () => ({ LatestWeeklyReportLink: () => null }));` and `jest.mock("~/@/components/seo/related-stocks", () => ({ RelatedStocks: () => null }));` (if `related-stocks` is not already mocked), and remove mocks of modules the page no longer imports if Jest reports them as unused (unused `jest.mock` calls are harmless; leave them).

- [ ] **Step 2: Run the two test files to see the expected failures**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/__tests__/page-runtime.test.tsx" "src/app/shorts/\[stockCode\]/__tests__/page-old-api.test.tsx"
```
Expected: FAIL — `../company/page.tsx` missing, `StockTabs` still in the page.

- [ ] **Step 3: Rewrite the page's imports and data block**

Replace the import list of `page.tsx` with exactly:

```tsx
import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CompanyInfo, {
  CompanyInfoPlaceholder,
} from "~/@/components/ui/companyInfo";
import { FundamentalsSummary } from "~/@/components/stocks/fundamentals-summary";
import { StrategyFitStrip } from "~/@/components/stocks/strategy-fit-strip";
import { CommunityOverviewTeaser } from "~/@/components/company/community/community-overview-teaser";
import { SignedOutOnly } from "~/@/components/ui/session-gates";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { LLMMeta, StockLLMMeta } from "~/@/components/seo/llm-meta";
import { RelatedStocks } from "~/@/components/seo/related-stocks";
import { LatestWeeklyReportLink } from "~/@/components/reports/latest-weekly-report-link";
import { siteConfig } from "~/@/config/site";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { thirtyDayChangeClause } from "~/@/lib/seo/short-change-clause";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStockHeadlines } from "~/app/actions/getStockNews";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { getDailyShortSeries } from "~/app/actions/getDailyShortSeries";
import { getStockFundamentals } from "~/app/actions/getStockFundamentals";
import {
  getStockStrategyFit,
  type StockStrategyFit,
} from "~/app/actions/getStockStrategyFit";
import { NotFoundError } from "~/app/actions/withRetry";
import {
  STOCK_CODE_PATTERN,
  asOfClauseFor,
  cleanCompanyName,
} from "./stock-page-shared";
```

Delete the local `cleanCompanyName` and `formatAsOfDate` functions (they live in `stock-page-shared.ts` now). `generateMetadata` keeps using `cleanCompanyName` and `thirtyDayChangeClause`/`getDailyShortSeries` as before — leave it untouched.

Replace the `Page` function's data block (from `const Page = async` down to `const breadcrumbItems`) with:

```tsx
const Page = async ({ params }: PageProps) => {
  const { stockCode: rawStockCode } = await params;
  const stockCode = rawStockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(stockCode)) notFound();

  // Fundamentals (the crawlable summary paragraph). Cached 24h, tag-busted by
  // the picks job; degrades to null (the paragraph is then omitted).
  const fundamentalsPromise = getStockFundamentals(stockCode).catch(
    (): Awaited<ReturnType<typeof getStockFundamentals>> => null,
  );
  // Strategy fit (the strip). NOT in the critical Promise.all below: the
  // action throws on any failure (4 s abort, never cached) and this catch
  // hides the strip, so a slow or older API can never fail the ISR render.
  const strategyFitPromise = getStockStrategyFit(stockCode).catch(
    (err: unknown): StockStrategyFit | null => {
      console.warn(`[stock page] strategy fit unavailable for ${stockCode}:`, err);
      return null;
    },
  );
  // Three headlines for the digest; the full feed is the News tab.
  const stockNewsPromise = getStockHeadlines(stockCode, 3);
  // Date of the latest ASIC report containing this stock — the schema's
  // "as of". Never `new Date()`: ASIC publishes T+4.
  const latestShortDatePromise = getLatestShortDate(stockCode).catch(
    (): Date | null => null,
  );

  let stock: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  let relatedData: Awaited<ReturnType<typeof getRelatedStocks>>;
  try {
    [stock, relatedData] = await Promise.all([
      getStockOrNotFound(stockCode),
      getRelatedStocks(stockCode),
    ]);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    relatedData = { stocks: [], industry: null, industrySlug: null };
  }
  // The layout already failed the render on a transient read; this is the
  // same contract, kept local so the page never bakes a schema-less shell.
  if (!stock) {
    throw new Error(
      `stock data transiently unavailable for ${stockCode}; failing ISR render instead of caching a degraded page`,
    );
  }

  const fundamentals = await fundamentalsPromise;
  const strategyFit = await strategyFitPromise;
  const newsArticles = await stockNewsPromise;
  const latestShortDate = await latestShortDatePromise;
  const asOfIso = latestShortDate ? latestShortDate.toISOString().slice(0, 10) : null;
  const asOfClause = asOfClauseFor(latestShortDate);
  const companyName = cleanCompanyName(stock.name || stockCode, stockCode);

  const breadcrumbItems = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: `/shorts/${stockCode}` },
  ];
```

- [ ] **Step 4: Rewrite the render tree**

Replace everything from `return (` to the end of the `Page` function with:

```tsx
  return (
    <>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <LLMMeta
        title={`${stockCode} Stock Analysis - Short Position Data`}
        description={`Comprehensive analysis of ${stockCode} short positions on the ASX. View real-time charts, company profile, and short interest data for ${stockCode} shares.`}
        keywords={[
          `${stockCode} short position`,
          `${stockCode} ASX`,
          `${stockCode} stock analysis`,
          `${stockCode} short interest`,
          "short selling data",
          "Australian stocks",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
        requiresAuth={false}
      />
      <StockLLMMeta
        stockCode={stockCode}
        companyName={companyName}
        industry={stock.industry || ""}
        sector={stock.industry || ""}
        shortPercentage={stock.percentageShorted || undefined}
        currentShortPosition={stock.reportedShortPositions || undefined}
      />

      {/* KEEP the existing IIFE unchanged here: the Dataset + Corporation
          JSON-LD scripts and the sr-only h1 crawler summary. It reads
          shortPct / shortPositions / companyName / industry / asOfIso /
          asOfClause, all of which are in scope above. */}

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          {/* Short interest digest: the weekly-report context link (an
              internal link into the ~200 dated reports) and the way in. */}
          <section
            aria-labelledby="overview-short-interest-heading"
            className="rounded-lg border bg-card px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="overview-short-interest-heading" className="text-sm font-medium">
                Short interest
              </h2>
              <Link
                href={stockTabHref(stockCode, "short-interest")}
                prefetch={false}
                className="text-xs text-primary hover:underline"
              >
                History &amp; FAQ →
              </Link>
            </div>
            <Suspense fallback={null}>
              <LatestWeeklyReportLink
                variant="inline"
                label="Weekly context:"
                className="mt-2"
              />
            </Suspense>
          </section>

          {strategyFit ? <StrategyFitStrip fit={strategyFit} /> : null}

          {/* Crawlable fundamentals paragraph; omitted (never guessed) without
              a held result. The full statements live on the Financials tab. */}
          <div className="flex flex-col gap-2">
            <FundamentalsSummary
              stockCode={stockCode}
              companyName={companyName}
              fundamentals={fundamentals}
            />
            <Link
              href={stockTabHref(stockCode, "financials")}
              prefetch={false}
              className="self-end text-xs text-primary hover:underline"
            >
              Full financials →
            </Link>
          </div>

          {newsArticles.length > 0 && (
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-medium">Latest {stockCode} news</h2>
                <Link
                  href={stockTabHref(stockCode, "news")}
                  prefetch={false}
                  className="text-xs text-primary hover:underline"
                >
                  All news
                </Link>
              </div>
              <ul className="divide-y border-t">
                {newsArticles.map((article) => (
                  <li key={article.id || article.url} className="px-4 py-2.5">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm leading-snug hover:text-primary hover:underline"
                    >
                      {article.headline}
                    </a>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {article.source}
                      {article.publishedAtIso
                        ? ` · ${new Date(article.publishedAtIso).toLocaleDateString("en-AU", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}`
                        : null}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          <Suspense fallback={<CompanyInfoPlaceholder />}>
            <CompanyInfo stockCode={stockCode} />
          </Suspense>

          {relatedData.stocks.length > 0 && (
            <RelatedStocks
              stocks={relatedData.stocks}
              currentStock={stockCode}
              industrySlug={relatedData.industrySlug}
              title={`More ${relatedData.industry} Stocks`}
              description="Other shorted stocks in this sector"
            />
          )}

          <nav
            aria-label="Short selling resources"
            className="rounded-lg border bg-card px-4 py-3 text-sm"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Explore
            </p>
            <ul className="mt-2 space-y-1.5">
              <li><Link href="/top" className="text-primary hover:underline">Most shorted ASX stocks</Link></li>
              <li><Link href="/battlegrounds" className="text-primary hover:underline">Short squeeze candidates</Link></li>
              <li><Link href="/statistics" className="text-primary hover:underline">ASX short selling statistics</Link></li>
              <li><Link href="/learn/how-to-short-the-asx" className="text-primary hover:underline">How to short the ASX</Link></li>
            </ul>
          </nav>

          <CommunityOverviewTeaser stockCode={stockCode} />

          {/* The dossier itself is on the Company tab (a signed-in surface);
              the Overview keeps only the way in, and only for the signed out. */}
          <SignedOutOnly>
            <div className="rounded-lg border border-primary/20 bg-card px-4 py-3 text-sm">
              <p className="font-medium">{stockCode} intelligence dossier</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Public-source evidence for this company, with industry drill-up links.
              </p>
              <Link
                href={stockTabHref(stockCode, "company")}
                prefetch={false}
                className="mt-2 inline-block text-xs text-primary hover:underline"
              >
                Sign in to unlock on the Company tab →
              </Link>
            </div>
          </SignedOutOnly>
        </div>
      </div>
    </>
  );
};

export default Page;
```

Then:
- Delete `web/src/@/components/company/stock-tabs.tsx` (`git rm`).
- Delete the now-unused `ShortInterestHistory` import if the linter flags it (it is used by Task 11's Short interest page, not here).
- `getDailyShortSeries` stays imported only if `generateMetadata` still uses it (it does, through `thirtyDayChangeClause`); otherwise remove.

- [ ] **Step 5: Run the tests, the typecheck and the lint**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/__tests__" && npx tsc --noEmit -p tsconfig.json && npx next lint --max-warnings=1000 --dir "src/app/shorts/[stockCode]"
```
Expected: the runtime and old-api tests PASS except the ones that read `../company/page.tsx` / `../financials/page.tsx` (those files arrive in Tasks 11-12; mark the two expectations `it.todo` with a comment naming the task ONLY if the executor is running tasks strictly in order and the reviewer is told, otherwise implement Tasks 11-12 before reporting this task done). `page-all-imports` and `page-component-imports` still pass unchanged (they import modules, not the page's text).

- [ ] **Step 6: Commit**

```bash
git add -A "web/src/app/shorts/[stockCode]" web/src/@/components/company
git commit -m "feat(web): stock overview as a digest under the shared layout; drop the tabs shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Short interest and Financials tabs

**Files:**
- Create: `web/src/app/shorts/[stockCode]/short-interest/page.tsx`, `loading.tsx`, `__tests__/page.test.tsx`
- Create: `web/src/app/shorts/[stockCode]/financials/page.tsx`, `loading.tsx`, `__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `stockTabMetadata` (Task 7), `STOCK_CODE_PATTERN`, `cleanCompanyName` (Task 8), `ShortInterestHistory({ stockCode, companyName })` from `../short-interest-history`, `PeerComparisonTable({ stockCode })`, `StockSignals({ stockCode })`, `StockVerdict({ stockCode })` (client, connect-importing → `ssr:false`), `FinancialsTab({ stockCode, fundamentals, reports, taxCard, filingsNote })`, `FilingsListedNote({ stockCode })`, `FinancialReportsSection({ stockCode, sourceDocumentUrl })`, `CompanyTaxCard({ stockCode })`, `DividendHistory({ stockCode })` (client → `ssr:false`), `latestResultSourceDocument(fundamentals)` from `~/@/components/stocks/fundamentals-model`, `getStockFundamentals(code)`.
- Produces: the two routes. Every tab page in this plan follows the same skeleton; it is written out in full here once and repeated (not referenced) in Tasks 12, 13 and 16.

- [ ] **Step 1: Write the failing tests**

`web/src/app/shorts/[stockCode]/short-interest/__tests__/page.test.tsx`:

```tsx
/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => () => <div data-testid="island" />);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
jest.mock("../../short-interest-history", () => ({
  ShortInterestHistory: ({ stockCode, companyName }: { stockCode: string; companyName: string }) => (
    <div data-testid="history">{stockCode}:{companyName}</div>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ BreadcrumbStructuredData: () => null }));

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";

describe("/shorts/[stockCode]/short-interest", () => {
  beforeEach(() => mockGetStockOrNotFound.mockResolvedValue({ name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 }));

  it("is on-demand ISR", () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("renders the history with the cleaned company name, then the three islands", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP short interest history");
    expect(screen.getByTestId("history")).toHaveTextContent("BHP:BHP Group");
    expect(screen.getAllByTestId("island")).toHaveLength(3);
  });

  it("builds its metadata through the shared builder with the tab's title", async () => {
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    const input = mockMetadata.mock.calls[0]![0] as { code: string; tab: string; title: (c: string) => string };
    expect(input.code).toBe("BHP");
    expect(input.tab).toBe("short-interest");
    expect(input.title("BHP Group")).toBe("BHP Short Interest History & FAQ | BHP Group");
  });
});
```

`web/src/app/shorts/[stockCode]/financials/__tests__/page.test.tsx`:

```tsx
/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockGetStockFundamentals = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => () => <div data-testid="dividends" />);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
jest.mock("~/app/actions/getStockFundamentals", () => ({ getStockFundamentals: (...a: unknown[]) => mockGetStockFundamentals(...a) }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: jest.fn().mockResolvedValue({}) }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ BreadcrumbStructuredData: () => null }));
jest.mock("~/@/components/stocks/financials-tab", () => ({
  FinancialsTab: ({ stockCode, fundamentals, reports, taxCard, filingsNote }: { stockCode: string; fundamentals: unknown; reports: React.ReactNode; taxCard: React.ReactNode; filingsNote: React.ReactNode }) => (
    <div data-testid="financials-tab" data-code={stockCode} data-has-fundamentals={fundamentals ? "yes" : "no"}>
      {filingsNote}{reports}{taxCard}
    </div>
  ),
}));
jest.mock("~/@/components/company/financial-reports-section", () => ({
  FinancialReportsSection: ({ stockCode, sourceDocumentUrl }: { stockCode: string; sourceDocumentUrl: string }) => (
    <div data-testid="reports-section" data-code={stockCode} data-source-document-url={sourceDocumentUrl} />
  ),
  FilingsListedNote: ({ stockCode }: { stockCode: string }) => <span data-testid="filings-note" data-code={stockCode} />,
}));
jest.mock("~/@/components/company/company-tax-card", () => ({ CompanyTaxCard: () => <div data-testid="tax-card" /> }));

import Page from "../page";

describe("/shorts/[stockCode]/financials", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
  });

  it("renders the filings and the tax card even without fundamentals, dividends before tax", async () => {
    mockGetStockFundamentals.mockRejectedValue(new Error("older API"));
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("financials-tab")).toHaveAttribute("data-has-fundamentals", "no");
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-code", "BHP");
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-source-document-url", "");
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order.indexOf("dividends")).toBeLessThan(order.indexOf("tax-card"));
  });

  it("passes the latest filing's url through when fundamentals hold one", async () => {
    mockGetStockFundamentals.mockResolvedValue({
      latestFiling: { sourceDocumentUrl: "https://example.test/fy26.pdf", sourceDocumentDate: "2026-08-19" },
      periods: [], growth: null, quality: null, coverage: null,
    });
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-source-document-url", "https://example.test/fy26.pdf");
  });
});
```

If `latestResultSourceDocument` reads a different field shape, build the fixture the way `web/src/@/components/stocks/__tests__/` fixtures do (read `fundamentals-model.ts` first).

- [ ] **Step 2: Run to verify they fail**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/short-interest" "src/app/shorts/\[stockCode\]/financials"
```
Expected: FAIL — `../page` not found.

- [ ] **Step 3: Implement the Short interest page**

`web/src/app/shorts/[stockCode]/short-interest/page.tsx`:

```tsx
import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";
import { ShortInterestHistory } from "../short-interest-history";
import { STOCK_CODE_PATTERN, cleanCompanyName } from "../stock-page-shared";

// Client islands that import @connectrpc/connect: client-only, as the
// chart is in the layout.
const PeerComparisonTable = nextDynamic(
  () => import("~/@/components/company/peer-comparison-table").then((m) => m.PeerComparisonTable),
  { ssr: false },
);
const StockSignals = nextDynamic(
  () => import("~/@/components/company/stock-signals").then((m) => m.StockSignals),
  { ssr: false },
);
const StockVerdict = nextDynamic(
  () => import("~/@/components/company/stock-verdict").then((m) => m.StockVerdict),
  { ssr: false },
);

// On-demand ISR: the empty generateStaticParams is what makes the segment
// statically optimisable; without it revalidate is inert (see the overview).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  return stockTabMetadata({
    code,
    tab: "short-interest",
    title: (company) => `${code} Short Interest History & FAQ | ${company}`,
    description: (company) =>
      `${company} (ASX:${code}) short interest over time: trend, peak, peer comparison and the questions investors ask. Official ASIC data, T+4.`,
    keywords: [`${code} short interest history`, `${code} short position trend`, `${code} most shorted`, "ASIC short positions"],
  });
}

export default async function ShortInterestPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  let stock: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  try {
    stock = await getStockOrNotFound(code);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
  }
  if (!stock) {
    throw new Error(`stock data transiently unavailable for ${code}; failing ISR render instead of caching a degraded page`);
  }
  const companyName = cleanCompanyName(stock.name || code, code);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: "Short interest", href: stockTabHref(code, "short-interest") },
        ]}
      />
      <h1 className="sr-only">{code} short interest history</h1>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6">
        <section aria-labelledby="si-history-heading" className="rounded-lg border bg-card">
          <h2 id="si-history-heading" className="px-4 py-3 text-sm font-medium">
            Short interest history &amp; FAQ
          </h2>
          <div className="border-t px-4 py-3">
            <Suspense fallback={null}>
              <ShortInterestHistory stockCode={code} companyName={companyName} />
            </Suspense>
          </div>
        </section>
        <StockVerdict stockCode={code} />
        <StockSignals stockCode={code} />
        <section aria-labelledby="peers-heading" className="flex flex-col gap-2">
          <h2 id="peers-heading" className="text-sm font-medium">Peer comparison</h2>
          <PeerComparisonTable stockCode={code} />
        </section>
      </div>
    </>
  );
}
```

`web/src/app/shorts/[stockCode]/short-interest/loading.tsx`:

```tsx
export default function ShortInterestLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4 md:gap-6">
      <div className="h-72 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
```

- [ ] **Step 4: Implement the Financials page**

`web/src/app/shorts/[stockCode]/financials/page.tsx`:

```tsx
import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { CompanyTaxCard } from "~/@/components/company/company-tax-card";
import {
  FilingsListedNote,
  FinancialReportsSection,
} from "~/@/components/company/financial-reports-section";
import { FinancialsTab } from "~/@/components/stocks/financials-tab";
import { latestResultSourceDocument } from "~/@/components/stocks/fundamentals-model";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { getStockFundamentals } from "~/app/actions/getStockFundamentals";
import { NotFoundError } from "~/app/actions/withRetry";
import { STOCK_CODE_PATTERN, cleanCompanyName } from "../stock-page-shared";

const DividendHistory = nextDynamic(
  () => import("~/@/components/company/dividend-history").then((m) => m.DividendHistory),
  { ssr: false },
);

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  return stockTabMetadata({
    code,
    tab: "financials",
    title: (company) => `${code} Financials: Results, Ratios & Statements | ${company}`,
    description: (company) =>
      `${company} (ASX:${code}) latest result, key ratios, income statement, balance sheet, cash flow, dividends and ATO tax transparency data.`,
    keywords: [`${code} financials`, `${code} results`, `${code} revenue`, `${code} dividend history`, `${code} annual report`],
  });
}

export default async function FinancialsPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  // Fundamentals: cached 24h, tag-busted by the picks job; null (the tab then
  // renders its filings and tax card only) on an older API or a failure.
  const fundamentalsPromise = getStockFundamentals(code).catch(
    (): Awaited<ReturnType<typeof getStockFundamentals>> => null,
  );
  let stock: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  try {
    stock = await getStockOrNotFound(code);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
  }
  if (!stock) {
    throw new Error(`stock data transiently unavailable for ${code}; failing ISR render instead of caching a degraded page`);
  }
  const fundamentals = await fundamentalsPromise;
  const sourceDocument = latestResultSourceDocument(fundamentals);
  const companyName = cleanCompanyName(stock.name || code, code);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: "Financials", href: stockTabHref(code, "financials") },
        ]}
      />
      <h1 className="sr-only">{companyName} ({code}) financials</h1>
      {/* Latest result, Key ratios, the statements island, the filings, then
          dividends and the tax card LAST (docs/plans/fundamentals-coverage.md §7.1). */}
      <FinancialsTab
        stockCode={code}
        fundamentals={fundamentals}
        filingsNote={<FilingsListedNote stockCode={code} />}
        reports={
          <FinancialReportsSection
            stockCode={code}
            sourceDocumentUrl={sourceDocument?.url ?? ""}
          />
        }
        taxCard={
          <>
            <section aria-labelledby="dividends-heading" className="flex flex-col gap-2">
              <h2 id="dividends-heading" className="text-sm font-medium">Dividends</h2>
              <DividendHistory stockCode={code} />
            </section>
            <CompanyTaxCard stockCode={code} />
          </>
        }
      />
    </>
  );
}
```

`web/src/app/shorts/[stockCode]/financials/loading.tsx`:

```tsx
export default function FinancialsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4 md:gap-6">
      <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-48 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-96 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/short-interest" "src/app/shorts/\[stockCode\]/financials" "src/app/shorts/\[stockCode\]/__tests__/page-old-api.test.tsx" && npx tsc --noEmit -p tsconfig.json
```
Expected: PASS; the old-api test's `../financials/page.tsx` read now resolves.

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/shorts/[stockCode]/short-interest" "web/src/app/shorts/[stockCode]/financials"
git commit -m "feat(web): short-interest and financials tabs as ISR routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Company tab

**Files:**
- Create: `web/src/app/shorts/[stockCode]/company/page.tsx`, `loading.tsx`, `__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `EnrichedCompanySection({ stockCode })` (server, static import), `StockEvidencePanelClient({ stockCode, industry, industrySlug })` (client, SSR-safe, static import — it was statically imported by the old page), `PoliticianInterestsCard({ stockCode })` (already a `ssr:false` loader), `StockStateExposure({ exposures })`, `getStateExposureIndex()` → `Record<string, StockStateExposureItem[]>`, `getRelatedStocks(code)`, `DirectorTradesTable({ stockCode })` and `StockConnections({ stockCode })` (client, connect-importing → `ssr:false`).

- [ ] **Step 1: Write the failing test**

```tsx
/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
let islands = 0;
jest.mock("next/dynamic", () => () => () => <div data-testid={`island-${++islands}`} />);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
jest.mock("~/app/actions/getRelatedStocks", () => ({ getRelatedStocks: jest.fn().mockResolvedValue({ stocks: [], industry: "Materials", industrySlug: "materials" }) }));
jest.mock("~/app/actions/getEconomy", () => ({ getStateExposureIndex: jest.fn().mockRejectedValue(new Error("down")) }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: jest.fn().mockResolvedValue({}) }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ BreadcrumbStructuredData: () => null }));
jest.mock("~/@/components/company/enriched-company-section", () => ({ EnrichedCompanySection: () => <div data-testid="enriched" /> }));
jest.mock("~/@/components/company/politician-interests-card-loader", () => ({ PoliticianInterestsCard: () => <div data-testid="politicians" /> }));
jest.mock("~/@/components/economy/stock-state-exposure", () => ({ StockStateExposure: ({ exposures }: { exposures: unknown[] }) => <div data-testid="exposure" data-count={exposures.length} /> }));
jest.mock("~/@/components/company/stock-evidence-panel-client", () => ({
  StockEvidencePanelClient: ({ industrySlug }: { industrySlug: string | null }) => <div data-testid="dossier" data-slug={industrySlug ?? ""} />,
}));

import Page from "../page";

describe("/shorts/[stockCode]/company", () => {
  it("renders research, directors, interests, exposure, connections, then the dossier; exposure degrades to empty", async () => {
    mockGetStockOrNotFound.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["enriched", "island-1", "politicians", "exposure", "island-2", "dossier"]);
    expect(container.querySelector("[data-testid=exposure]")).toHaveAttribute("data-count", "0");
    expect(container.querySelector("[data-testid=dossier]")).toHaveAttribute("data-slug", "materials");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/company"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/app/shorts/[stockCode]/company/page.tsx`:

```tsx
import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { EnrichedCompanySection } from "~/@/components/company/enriched-company-section";
import { PoliticianInterestsCard } from "~/@/components/company/politician-interests-card-loader";
import { StockEvidencePanelClient } from "~/@/components/company/stock-evidence-panel-client";
import { StockStateExposure } from "~/@/components/economy/stock-state-exposure";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStateExposureIndex } from "~/app/actions/getEconomy";
import { NotFoundError } from "~/app/actions/withRetry";
import { STOCK_CODE_PATTERN, cleanCompanyName } from "../stock-page-shared";

const DirectorTradesTable = nextDynamic(
  () => import("~/@/components/company/director-trades-table").then((m) => m.DirectorTradesTable),
  { ssr: false },
);
const StockConnections = nextDynamic(
  () => import("~/@/components/company/stock-connections").then((m) => m.StockConnections),
  { ssr: false },
);

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  return stockTabMetadata({
    code,
    tab: "company",
    title: (company) => `${code} Company Profile: Directors, Insiders & Operations | ${company}`,
    description: (company) =>
      `${company} (ASX:${code}) in depth: what the company does, its history and risks, director trades, declared political interests and where it operates.`,
    keywords: [`${code} company profile`, `${code} director trades`, `${code} insider trading`, `${code} key people`],
  });
}

export default async function CompanyPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  // Cross-domain context must never take the page down: degrades to {}.
  const stateExposureIndexPromise = getStateExposureIndex().catch(
    (): Awaited<ReturnType<typeof getStateExposureIndex>> => ({}),
  );
  let stock: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  let relatedData: Awaited<ReturnType<typeof getRelatedStocks>>;
  try {
    [stock, relatedData] = await Promise.all([getStockOrNotFound(code), getRelatedStocks(code)]);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    relatedData = { stocks: [], industry: null, industrySlug: null };
  }
  if (!stock) {
    throw new Error(`stock data transiently unavailable for ${code}; failing ISR render instead of caching a degraded page`);
  }
  const exposures = (await stateExposureIndexPromise)[code] ?? [];
  const companyName = cleanCompanyName(stock.name || code, code);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: "Company", href: stockTabHref(code, "company") },
        ]}
      />
      <h1 className="sr-only">{companyName} ({code}) company profile</h1>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6">
        <EnrichedCompanySection stockCode={code} />
        <section aria-labelledby="directors-heading" className="flex flex-col gap-2">
          <h2 id="directors-heading" className="text-sm font-medium">Directors and insiders</h2>
          <DirectorTradesTable stockCode={code} />
        </section>
        <PoliticianInterestsCard stockCode={code} />
        <StockStateExposure exposures={exposures} />
        <StockConnections stockCode={code} />
        {/* Gated: fetched client-side after the session resolves, never in
            the shared ISR payload. Signed-out visitors see the lock. */}
        <StockEvidencePanelClient
          stockCode={code}
          industry={relatedData.industry}
          industrySlug={relatedData.industrySlug}
        />
      </div>
    </>
  );
}
```

`web/src/app/shorts/[stockCode]/company/loading.tsx`: the same skeleton as `financials/loading.tsx` with the heights `h-64`, `h-48`, `h-40`, exported as `CompanyLoading`.

- [ ] **Step 4: Run the tests**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]"
```
Expected: PASS, including the runtime test's `../company/page.tsx` reads from Task 10.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/shorts/[stockCode]/company"
git commit -m "feat(web): company tab with research, insiders, interests, exposure and the dossier

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: News re-homed, Community as a route, the thread page drops its chrome

**Files:**
- Modify: `web/src/app/shorts/[stockCode]/news/page.tsx`
- Create: `web/src/app/shorts/[stockCode]/news/loading.tsx`
- Create: `web/src/app/shorts/[stockCode]/community/page.tsx`, `loading.tsx`, `__tests__/page.test.tsx`
- Modify: `web/src/app/shorts/[stockCode]/community/[threadId]/page.tsx`

**Interfaces:**
- Consumes: `EventTimeline({ stockCode })` (client, connect → `ssr:false`), `CommunityTab({ stockCode })` (client, `"use client"`, fetches JSON, SSR-safe static import), `CommunityThreadDetail`.

- [ ] **Step 1: Write the failing Community test**

`web/src/app/shorts/[stockCode]/community/__tests__/page.test.tsx`:

```tsx
/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockMetadata = jest.fn().mockResolvedValue({});
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ BreadcrumbStructuredData: () => null }));
jest.mock("~/@/components/company/community/community-tab", () => ({
  CommunityTab: ({ stockCode }: { stockCode: string }) => <div data-testid="community">{stockCode}</div>,
}));

import Page, { generateMetadata, generateStaticParams, revalidate } from "../page";

describe("/shorts/[stockCode]/community", () => {
  it("is ISR, renders the tab, and is never indexed", async () => {
    expect(revalidate).toBe(3600);
    expect(generateStaticParams()).toEqual([]);
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("community")).toHaveTextContent("BHP");
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(mockMetadata.mock.calls[0]![0]).toMatchObject({ code: "BHP", tab: "community", forceNoindex: true });
  });

  it("404s a malformed code", async () => {
    await expect(Page({ params: Promise.resolve({ stockCode: "nope!" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/community/__tests__"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Re-home the News page**

In `news/page.tsx`:

1. Remove the imports of `DashboardLayout`, `Breadcrumbs` (keep `BreadcrumbStructuredData`) and `Link` if nothing else uses it.
2. Add `import nextDynamic from "next/dynamic";` and, after the imports:

```tsx
const EventTimeline = nextDynamic(
  () => import("~/@/components/company/event-timeline").then((m) => m.EventTimeline),
  { ssr: false },
);

export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}
```
(`export const revalidate = 600;` stays.)
3. Replace `<DashboardLayout>` / `</DashboardLayout>` with `<>` / `</>`.
4. Delete the `<Link href={`/shorts/${code}`} ...>← Back to {code}</Link>` element and the `<Breadcrumbs items={breadcrumbItems} />` element (the layout renders breadcrumbs). Keep `breadcrumbItems` for `BreadcrumbStructuredData`, changing its last entry to `{ label: "News", href: `/shorts/${code}/news` }` if it is not already.
5. After the articles grid (just before the closing fragment) add:

```tsx
      <section aria-labelledby="events-heading" className="mt-8 flex flex-col gap-2">
        <h2 id="events-heading" className="text-sm font-medium">Events</h2>
        <EventTimeline stockCode={code} />
      </section>
```

`news/loading.tsx`:

```tsx
export default function NewsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-lg bg-muted/40" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the Community page and strip the thread page**

`community/page.tsx`:

```tsx
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { CommunityTab } from "~/@/components/company/community/community-tab";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { STOCK_CODE_PATTERN } from "../stock-page-shared";

// The list is client-fetched (volatile, session-aware), so the page is a
// static shell: no stock read of its own (the layout already validated the
// code against the API) and noindex (the thread pages beneath carry the
// crawlable text).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  return stockTabMetadata({
    code,
    tab: "community",
    title: (company) => `${code} Community Discussion | ${company}`,
    description: (company) => `Research threads and pulse on ${company} (ASX:${code}) from the Shorted community.`,
    forceNoindex: true,
  });
}

export default async function CommunityPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: "Community", href: stockTabHref(code, "community") },
        ]}
      />
      <h1 className="sr-only">{code} community</h1>
      <CommunityTab stockCode={code} />
    </>
  );
}
```

`community/loading.tsx`: one `h-96` pulse block, exported as `CommunityLoading`.

In `community/[threadId]/page.tsx`: remove the `DashboardLayout` and `Breadcrumbs` imports, replace the returned tree with:

```tsx
  return <CommunityThreadDetail thread={thread} comments={[]} />;
```
(The layout's breadcrumbs already read "Stocks › CODE › Community" for this path.) Keep its rendering config exactly as it is.

- [ ] **Step 5: Run the tests, typecheck, lint**

```bash
cd web && npx jest "src/app/shorts" && npx tsc --noEmit -p tsconfig.json && npx next lint --max-warnings=1000 --dir "src/app/shorts"
```
Expected: PASS / clean. If a news-page test exists under `news/__tests__`, update any assertion that looked for the back link or `Breadcrumbs`.

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/shorts/[stockCode]/news" "web/src/app/shorts/[stockCode]/community"
git commit -m "feat(web): news under the stock layout with events; community and thread routes share the chrome

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: `levels`, `bands` and `markers` on the shared chart

**Files:**
- Modify: `web/src/@/components/charts/types.ts` (append types; add three optional props to `StockChartProps`)
- Create: `web/src/@/components/charts/chart-levels.ts`
- Create: `web/src/@/components/charts/__tests__/chart-levels.test.ts`
- Modify: `web/src/@/components/charts/StockChart.tsx` (props destructure ~line 85-100; the `<Group left={margin.left} top={margin.top}>` block after the `regions` map, ~line 575)
- Modify: `web/src/@/components/charts/__tests__/StockChart.touch.test.tsx` (one added test, reusing its `renderChart` fixture)

**Interfaces:**
- Produces:

```ts
// types.ts
export interface ChartLevel { axis: "left" | "right"; value: number; label: string; color: string; dash?: string; from?: number; to?: number }
export interface ChartBand  { axis: "left" | "right"; low: number; high: number; from: number; to: number; color: string; label?: string }
export interface ChartMarker { t: number; label: string; color: string }
// StockChartProps gains: levels?: ChartLevel[]; bands?: ChartBand[]; markers?: ChartMarker[];

// chart-levels.ts (pure)
export interface LevelGeometry  { x1: number; x2: number; y: number; label: string; color: string; dash?: string }
export interface BandGeometry   { x: number; y: number; width: number; height: number; color: string; label?: string }
export interface MarkerGeometry { x: number; label: string; color: string }
export function layoutLevels(opts: {
  levels: ChartLevel[]; bands: ChartBand[]; markers: ChartMarker[];
  x: (t: number) => number;                               // epoch ms → inner-plot px
  yFor: (axis: "left" | "right") => (v: number) => number; // value → inner-plot px
  innerW: number; innerH: number;
}): { levels: LevelGeometry[]; bands: BandGeometry[]; markers: MarkerGeometry[] };
```
Rules: a level without `from`/`to` spans the full width; `from`/`to` are clamped to `[0, innerW]`; anything with no visible width, or a level whose `y` falls outside `[0, innerH]`, is dropped; a band's rect is `y = min(y(high), y(low))`, `height = |y(low) - y(high)|`, dropped when its clipped width is `<= 0`; a marker outside `[0, innerW]` is dropped. The chart draws bands under the series, levels and markers over them, and the tooltip ignores all three.

- [ ] **Step 1: Write the failing geometry tests**

`web/src/@/components/charts/__tests__/chart-levels.test.ts`:

```ts
import { layoutLevels } from "../chart-levels";

// x: 10 ms per px over a 0..1000 ms domain (0..100 px); y: 100 - value.
const x = (t: number) => t / 10;
const yFor = () => (v: number) => 100 - v;
const base = { x, yFor, innerW: 100, innerH: 100, levels: [], bands: [], markers: [] };

describe("layoutLevels", () => {
  it("spans a level across the plot when it has no range, and clamps a ranged one", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 40, label: "SMA 200 $40", color: "#f00" },
        { axis: "left", value: 60, label: "Pivot $60", color: "#0f0", from: -500, to: 300, dash: "4,3" },
      ],
    });
    expect(levels).toEqual([
      { x1: 0, x2: 100, y: 60, label: "SMA 200 $40", color: "#f00", dash: undefined },
      { x1: 0, x2: 30, y: 40, label: "Pivot $60", color: "#0f0", dash: "4,3" },
    ]);
  });

  it("drops a level outside the plot or with no visible width", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 150, label: "above", color: "#000" },
        { axis: "left", value: 50, label: "before", color: "#000", from: -900, to: -100 },
        { axis: "left", value: 50, label: "after", color: "#000", from: 1200, to: 1400 },
      ],
    });
    expect(levels).toEqual([]);
  });

  it("clips a band that starts before the domain and drops one entirely outside", () => {
    const { bands } = layoutLevels({
      ...base,
      bands: [
        { axis: "left", low: 20, high: 30, from: -400, to: 400, color: "#00f", label: "base" },
        { axis: "left", low: 20, high: 30, from: 2000, to: 3000, color: "#00f" },
      ],
    });
    expect(bands).toEqual([{ x: 0, y: 70, width: 40, height: 10, color: "#00f", label: "base" }]);
  });

  it("keeps markers inside the plot only", () => {
    const { markers } = layoutLevels({
      ...base,
      markers: [
        { t: 250, label: "breakout", color: "#f90" },
        { t: 5000, label: "gone", color: "#f90" },
      ],
    });
    expect(markers).toEqual([{ x: 25, label: "breakout", color: "#f90" }]);
  });

  it("uses the right axis scale for right-axis levels", () => {
    const yRight = (v: number) => 200 - v;
    const { levels } = layoutLevels({
      ...base,
      yFor: (axis) => (axis === "right" ? yRight : (v: number) => 100 - v),
      innerH: 200,
      levels: [{ axis: "right", value: 50, label: "5% short", color: "#000" }],
    });
    expect(levels[0]!.y).toBe(150);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd web && npx jest src/@/components/charts/__tests__/chart-levels.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the types and the geometry**

Append to `types.ts`:

```ts
/** A horizontal reference line on one axis, optionally bounded to a time span. */
export interface ChartLevel {
  axis: "left" | "right";
  value: number;
  label: string;
  color: string;
  dash?: string;
  from?: number; // epoch ms
  to?: number; // epoch ms
}

/** A shaded value band between `low` and `high` over a time span. */
export interface ChartBand {
  axis: "left" | "right";
  low: number;
  high: number;
  from: number;
  to: number;
  color: string;
  label?: string;
}

/** A vertical session marker. */
export interface ChartMarker {
  t: number;
  label: string;
  color: string;
}
```

and to `StockChartProps` (after `regions?: ChartRegion[];`):

```ts
  /** Reference levels drawn over the series (the strategy's pivot, averages, 52-week range). */
  levels?: ChartLevel[];
  /** Shaded value bands drawn under the series (a base). */
  bands?: ChartBand[];
  /** Vertical session markers (a breakout). */
  markers?: ChartMarker[];
```

`chart-levels.ts`:

```ts
import type { ChartBand, ChartLevel, ChartMarker } from "./types";

export interface LevelGeometry {
  x1: number;
  x2: number;
  y: number;
  label: string;
  color: string;
  dash?: string;
}
export interface BandGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  label?: string;
}
export interface MarkerGeometry {
  x: number;
  label: string;
  color: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Pixel geometry for reference levels, bands and markers, clipped to the
 * inner plot. Pure: the chart hands in its scales and gets back only what is
 * visible, so a base that began before the loaded window clips to the left
 * edge and a level above the plot is simply absent.
 */
export function layoutLevels(opts: {
  levels: ChartLevel[];
  bands: ChartBand[];
  markers: ChartMarker[];
  x: (t: number) => number;
  yFor: (axis: "left" | "right") => (v: number) => number;
  innerW: number;
  innerH: number;
}): { levels: LevelGeometry[]; bands: BandGeometry[]; markers: MarkerGeometry[] } {
  const { innerW, innerH } = opts;
  const span = (from?: number, to?: number): [number, number] | null => {
    const x1 = from === undefined ? 0 : clamp(opts.x(from), 0, innerW);
    const x2 = to === undefined ? innerW : clamp(opts.x(to), 0, innerW);
    return x2 - x1 > 0 ? [x1, x2] : null;
  };

  const levels: LevelGeometry[] = [];
  for (const l of opts.levels) {
    const y = opts.yFor(l.axis)(l.value);
    if (!Number.isFinite(y) || y < 0 || y > innerH) continue;
    const s = span(l.from, l.to);
    if (!s) continue;
    levels.push({ x1: s[0], x2: s[1], y, label: l.label, color: l.color, dash: l.dash });
  }

  const bands: BandGeometry[] = [];
  for (const b of opts.bands) {
    const s = span(b.from, b.to);
    if (!s) continue;
    const yScale = opts.yFor(b.axis);
    const yHigh = clamp(yScale(b.high), 0, innerH);
    const yLow = clamp(yScale(b.low), 0, innerH);
    const height = Math.abs(yLow - yHigh);
    if (height <= 0) continue;
    bands.push({ x: s[0], y: Math.min(yHigh, yLow), width: s[1] - s[0], height, color: b.color, label: b.label });
  }

  const markers: MarkerGeometry[] = [];
  for (const m of opts.markers) {
    const x = opts.x(m.t);
    if (!Number.isFinite(x) || x < 0 || x > innerW) continue;
    markers.push({ x, label: m.label, color: m.color });
  }

  return { levels, bands, markers };
}
```

- [ ] **Step 4: Run the geometry tests**

```bash
cd web && npx jest src/@/components/charts/__tests__/chart-levels.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Draw them in `StockChart`**

In `StockChart.tsx`:

1. Import: `import { layoutLevels } from "./chart-levels";` and add `ChartLevel, ChartBand, ChartMarker` to the `import type {...} from "./types"` list if the props type is re-declared locally (it is `StockChartProps & {...}`, so the three new fields arrive through `types.ts`).
2. In `StockChartInner`'s destructuring (the block that sets `variant = "full"`, `decimationTargetPerPx = 2`), add `levels = [], bands = [], markers = [],`.
3. After `volumeScale` is defined and before `useChartPointer`, add:

```tsx
  // Reference geometry (strategy levels): pure, clipped to the plot, recomputed
  // only when the scales or the inputs change. Nothing here is hoverable.
  const reference = useMemo(
    () =>
      layoutLevels({
        levels,
        bands,
        markers,
        x: (t) => dateScale(t) ?? 0,
        yFor: (axis) => (v) => scaleForAxis(axis)(v) ?? 0,
        innerW,
        innerH: mainH,
      }),
    [levels, bands, markers, dateScale, scaleForAxis, innerW, mainH],
  );
```
4. Immediately after the `{regions.map(...)}` block (still under the series), add:

```tsx
          {reference.bands.map((b, i) => (
            <rect
              key={`band-${i}`}
              data-chart-band
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              fill={b.color}
              fillOpacity={0.12}
              pointerEvents="none"
            >
              {b.label ? <title>{b.label}</title> : null}
            </rect>
          ))}
```
5. Immediately after the `{indicators.map(...)}` block (over the series), add:

```tsx
          {reference.levels.map((l, i) => (
            <Group key={`level-${i}`} data-chart-level pointerEvents="none">
              <Line
                from={{ x: l.x1, y: l.y }}
                to={{ x: l.x2, y: l.y }}
                stroke={l.color}
                strokeWidth={1}
                strokeDasharray={l.dash}
              />
              <text
                x={l.x2 - 4}
                y={l.y - 4}
                textAnchor="end"
                fontSize={10}
                fill={l.color}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {l.label}
              </text>
            </Group>
          ))}
          {reference.markers.map((m, i) => (
            <Group key={`marker-${i}`} data-chart-marker pointerEvents="none">
              <Line
                from={{ x: m.x, y: 0 }}
                to={{ x: m.x, y: mainH }}
                stroke={m.color}
                strokeWidth={1}
                strokeDasharray="2,3"
              />
              <text x={m.x + 4} y={10} fontSize={10} fill={m.color}>
                {m.label}
              </text>
            </Group>
          ))}
```
6. Confirm the outer `StockChart` (the `ParentSize` wrapper) spreads every prop into `StockChartInner` (`grep -n "StockChartInner" StockChart.tsx`); if it lists props by name, add the three.

- [ ] **Step 6: Add the render test**

In `StockChart.touch.test.tsx`, after the existing tests, add (it reuses `renderChart`'s constants: `WIDTH`, `HEIGHT`, `SERIES`, `T0`, `DAY`):

```tsx
  it("draws reference bands under the series and levels/markers over it, clipped to the plot", () => {
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        bands={[{ axis: "left", low: 41, high: 44, from: T0 - 5 * DAY, to: T0 + 3 * DAY, color: "#00f", label: "base" }]}
        levels={[
          { axis: "left", value: 45, label: "Pivot $45", color: "#f90" },
          { axis: "left", value: 999, label: "off the plot", color: "#f90" },
        ]}
        markers={[{ t: T0 + 2 * DAY, label: "breakout", color: "#0f0" }, { t: T0 + 40 * DAY, label: "outside", color: "#0f0" }]}
      />,
    );
    expect(container.querySelectorAll("[data-chart-band]")).toHaveLength(1);
    expect(container.querySelector("[data-chart-band]")).toHaveAttribute("x", "0");
    expect(container.querySelectorAll("[data-chart-level]")).toHaveLength(1);
    expect(container.querySelector("[data-chart-level] text")).toHaveTextContent("Pivot $45");
    expect(container.querySelectorAll("[data-chart-marker]")).toHaveLength(1);
  });
```

- [ ] **Step 7: Run the chart tests**

```bash
cd web && npx jest src/@/components/charts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/@/components/charts
git commit -m "feat(charts): reference levels, bands and markers on StockChart

Pure clipped geometry in chart-levels.ts; bands under the series, levels
and markers over it; the tooltip ignores them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Strategy level sets and the levels chart island

**Files:**
- Create: `web/src/@/components/strategy/strategy-levels.ts`
- Create: `web/src/@/components/strategy/__tests__/strategy-levels.test.ts`
- Create: `web/src/@/components/strategy/strategy-levels-chart.tsx`
- Create: `web/src/@/components/strategy/__tests__/strategy-levels-chart.test.tsx`

**Interfaces:**
- Consumes: `StockPriceFeatures`, `StockStrategyFitRow` (Task 3); `ChartLevel`, `ChartBand`, `ChartMarker`, `ChartPoint`, `ChartSeriesSpec`, `SeriesIndicator` (Task 14 / `charts/types`); `calculateSMA(data: number[], period: number): (number | null)[]` from `~/@/lib/technical-indicators`; `useStockChartData(code, period)` → `{ short, price, volume, anyLoading, isError }`; `StockChart`; `priceFmt`, `shortFmt` from `charts/chart-views`; `seriesColor("price" | "short")` from `charts/chart-theme`; `formatPrice` from `~/@/lib/strategies/format`.
- Produces:

```ts
// strategy-levels.ts (pure, no React)
export interface LevelSet {
  levels: ChartLevel[]; bands: ChartBand[]; markers: ChartMarker[];
  /** Lines under the chart, e.g. "Base 9.3% deep over 22 sessions". */
  caption: string[];
  /** Draw the short-interest series on the right axis (crowded-short). */
  showShortSeries: boolean;
  /** Moving-average lines to attempt (drawn only with a full lookback). */
  smaPeriods: number[];
}
export const LEVEL_COLORS: { pivot: string; base: string; sma50: string; sma150: string; sma200: string; range: string; breakout: string };
export function defaultStrategyId(fits: StockStrategyFitRow[]): string | null;  // triggered > setup > watch > none, ties by score desc, then order
export function strategyLevelSet(strategyId: string, pf: StockPriceFeatures | null, opts: { shortRuleDetail?: string }): LevelSet;
export function smaIndicator(points: ChartPoint[], period: number): (number | null)[] | null; // null when points.length < period; warmup entries null
export const PRICE_ONLY_NOTE = "Levels unavailable for this stock right now; showing price only.";
```
```tsx
// strategy-levels-chart.tsx ("use client")
export function StrategyLevelsChart(props: { stockCode: string; fits: StockStrategyFitRow[]; priceFeatures: StockPriceFeatures | null; initialStrategyId?: string | null }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests for the pure module**

`strategy-levels.test.ts`:

```ts
import { defaultStrategyId, smaIndicator, strategyLevelSet, PRICE_ONLY_NOTE } from "../strategy-levels";
import type { StockPriceFeatures, StockStrategyFitRow } from "~/app/actions/getStockStrategyFit";

const row = (strategyId: string, status: StockStrategyFitRow["status"], score: number | null): StockStrategyFitRow => ({
  strategyId, strategyName: strategyId, status, score, rank: null, totalCount: null, rules: [], ruleColumns: [],
});

const pf: StockPriceFeatures = {
  asOf: "2026-10-07", close: 42.1, sma50: 40, sma150: 39, sma200: 38.5, sma200PriorMonth: 38.1,
  high52w: 45, low52w: 30, baseHigh: 43, baseLow: 39, baseDepthPct: 9.3, baseLengthDays: 22,
  breakoutRecent: true, breakoutDate: "2026-09-19", rs3mPct: 4.2, rs6mPct: null, volumeRatio50d: 1.8, sessionsAvailable: 260,
};

describe("defaultStrategyId", () => {
  it("prefers the strongest status, then the higher score, then order", () => {
    expect(defaultStrategyId([row("a", "watch", 90), row("b", "setup", 10), row("c", "triggered", 5)])).toBe("c");
    expect(defaultStrategyId([row("a", "setup", 40), row("b", "setup", 70)])).toBe("b");
    expect(defaultStrategyId([row("a", "none", null), row("b", "none", null)])).toBe("a");
    expect(defaultStrategyId([])).toBeNull();
  });
});

describe("strategyLevelSet", () => {
  it("zanger: base band, pivot across the base, breakout marker, depth/volume caption", () => {
    const set = strategyLevelSet("zanger-breakout", pf, {});
    expect(set.bands).toHaveLength(1);
    expect(set.bands[0]).toMatchObject({ low: 39, high: 43, axis: "left" });
    expect(set.bands[0]!.from).toBeLessThan(set.bands[0]!.to);
    expect(set.levels.map((l) => l.label)).toEqual(["Pivot $43.00"]);
    expect(set.markers.map((m) => m.label)).toEqual(["Breakout 19 Sep"]);
    expect(set.caption).toEqual(["Base 9.3% deep over 22 sessions", "Volume 1.8× the 50-day average"]);
    expect(set.showShortSeries).toBe(false);
  });

  it("minervini: the three averages, the 52-week low and last month's SMA 200 dashed", () => {
    const set = strategyLevelSet("minervini-trend-template", pf, {});
    expect(set.levels.map((l) => l.label)).toEqual(["SMA 50 $40.00", "SMA 150 $39.00", "SMA 200 $38.50", "SMA 200 a month ago $38.10", "52-week low $30.00"]);
    expect(set.levels[3]!.dash).toBe("4,3");
    expect(set.smaPeriods).toEqual([50, 150, 200]);
    expect(set.bands).toEqual([]);
  });

  it("canslim: 52-week high plus the base; crowded-short: base plus the short series and the rule's words", () => {
    expect(strategyLevelSet("canslim", pf, {}).levels.map((l) => l.label)).toEqual(["52-week high $45.00", "Pivot $43.00"]);
    const crowded = strategyLevelSet("crowded-short-breakout", pf, { shortRuleDetail: "Short interest 6.5% ≥ 5%" });
    expect(crowded.showShortSeries).toBe(true);
    expect(crowded.caption).toContain("Short interest 6.5% ≥ 5%");
  });

  it("skips any level whose input is unknown, and is price-only without features", () => {
    const set = strategyLevelSet("minervini-trend-template", { ...pf, sma150: null, low52w: null }, {});
    expect(set.levels.map((l) => l.label)).toEqual(["SMA 50 $40.00", "SMA 200 $38.50", "SMA 200 a month ago $38.10"]);
    const none = strategyLevelSet("zanger-breakout", null, {});
    expect(none).toEqual({ levels: [], bands: [], markers: [], caption: [PRICE_ONLY_NOTE], showShortSeries: false, smaPeriods: [] });
  });
});

describe("smaIndicator", () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ t: i, v: i + 1 }));
  it("refuses a partial window and nulls the warmup", () => {
    expect(smaIndicator(pts, 11)).toBeNull();
    const sma = smaIndicator(pts, 3)!;
    expect(sma.slice(0, 2)).toEqual([null, null]);
    expect(sma[2]).toBeCloseTo(2);
    expect(sma[9]).toBeCloseTo(9);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd web && npx jest src/@/components/strategy/__tests__/strategy-levels.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure module**

```ts
import type { ChartBand, ChartLevel, ChartMarker, ChartPoint } from "~/@/components/charts/types";
import { calculateSMA } from "~/@/lib/technical-indicators";
import { formatPrice } from "~/@/lib/strategies/format";
import type { StockPriceFeatures, StockStrategyFitRow } from "~/app/actions/getStockStrategyFit";

// What each strategy's chart draws, from the levels the evaluator read. Pure,
// so the level sets are unit-tested without a chart. A level whose input is
// unknown is omitted, never drawn at zero.

export interface LevelSet {
  levels: ChartLevel[];
  bands: ChartBand[];
  markers: ChartMarker[];
  caption: string[];
  showShortSeries: boolean;
  smaPeriods: number[];
}

export const LEVEL_COLORS = {
  pivot: "#f59e0b",
  base: "#3b82f6",
  sma50: "#22c55e",
  sma150: "#a855f7",
  sma200: "#ef4444",
  range: "#94a3b8",
  breakout: "#f97316",
} as const;

export const PRICE_ONLY_NOTE =
  "Levels unavailable for this stock right now; showing price only.";

const DAY = 86_400_000;
/** Sessions → calendar days; the chart clips whatever runs off the window. */
const SESSION_DAYS = 7 / 5;

const STATUS_RANK: Record<StockStrategyFitRow["status"], number> = {
  triggered: 3,
  setup: 2,
  watch: 1,
  none: 0,
};

export function defaultStrategyId(fits: StockStrategyFitRow[]): string | null {
  let best: StockStrategyFitRow | null = null;
  for (const fit of fits) {
    if (!best) {
      best = fit;
      continue;
    }
    const rank = STATUS_RANK[fit.status] - STATUS_RANK[best.status];
    if (rank > 0 || (rank === 0 && (fit.score ?? -1) > (best.score ?? -1))) best = fit;
  }
  return best ? best.strategyId : null;
}

function isoMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function level(value: number | null, label: string, color: string, extra: Partial<ChartLevel> = {}): ChartLevel | null {
  if (value === null) return null;
  return { axis: "left", value, label: `${label} ${formatPrice(value)}`, color, ...extra };
}

function present<T>(items: Array<T | null>): T[] {
  return items.filter((i): i is T => i !== null);
}

/** The base band and its pivot, when the base is fully known. */
function baseGeometry(pf: StockPriceFeatures): { band: ChartBand | null; pivot: ChartLevel | null; marker: ChartMarker | null } {
  const asOf = isoMs(pf.asOf);
  const known = pf.baseHigh !== null && pf.baseLow !== null && pf.baseLengthDays !== null && asOf !== null;
  const from = known ? asOf! - pf.baseLengthDays! * SESSION_DAYS * DAY : null;
  const band: ChartBand | null = known
    ? { axis: "left", low: pf.baseLow!, high: pf.baseHigh!, from: from!, to: asOf!, color: LEVEL_COLORS.base, label: "Base" }
    : null;
  const pivot = pf.baseHigh !== null
    ? level(pf.baseHigh, "Pivot", LEVEL_COLORS.pivot, known ? { from: from!, to: asOf! } : {})
    : null;
  const breakout = isoMs(pf.breakoutDate);
  const marker: ChartMarker | null = breakout !== null && pf.breakoutDate
    ? { t: breakout, label: `Breakout ${shortDay(pf.breakoutDate)}`, color: LEVEL_COLORS.breakout }
    : null;
  return { band, pivot, marker };
}

function baseCaption(pf: StockPriceFeatures): string[] {
  const out: string[] = [];
  if (pf.baseDepthPct !== null && pf.baseLengthDays !== null) {
    out.push(`Base ${pf.baseDepthPct.toFixed(1)}% deep over ${pf.baseLengthDays} sessions`);
  }
  if (pf.volumeRatio50d !== null) out.push(`Volume ${pf.volumeRatio50d.toFixed(1)}× the 50-day average`);
  return out;
}

export function strategyLevelSet(
  strategyId: string,
  pf: StockPriceFeatures | null,
  opts: { shortRuleDetail?: string },
): LevelSet {
  if (!pf) {
    return { levels: [], bands: [], markers: [], caption: [PRICE_ONLY_NOTE], showShortSeries: false, smaPeriods: [] };
  }
  const base = baseGeometry(pf);
  const sma50 = level(pf.sma50, "SMA 50", LEVEL_COLORS.sma50);
  const sma150 = level(pf.sma150, "SMA 150", LEVEL_COLORS.sma150);
  const sma200 = level(pf.sma200, "SMA 200", LEVEL_COLORS.sma200);
  const sma200Prior = level(pf.sma200PriorMonth, "SMA 200 a month ago", LEVEL_COLORS.sma200, { dash: "4,3" });
  const high52 = level(pf.high52w, "52-week high", LEVEL_COLORS.range);
  const low52 = level(pf.low52w, "52-week low", LEVEL_COLORS.range);

  switch (strategyId) {
    case "zanger-breakout":
      return {
        levels: present([base.pivot]),
        bands: present([base.band]),
        markers: present([base.marker]),
        caption: baseCaption(pf),
        showShortSeries: false,
        smaPeriods: [],
      };
    case "canslim": {
      const rs = [
        pf.rs3mPct !== null ? `RS 3m ${pf.rs3mPct >= 0 ? "+" : ""}${pf.rs3mPct.toFixed(1)}%` : null,
        pf.rs6mPct !== null ? `RS 6m ${pf.rs6mPct >= 0 ? "+" : ""}${pf.rs6mPct.toFixed(1)}%` : null,
      ];
      return {
        levels: present([high52, base.pivot]),
        bands: present([base.band]),
        markers: present([base.marker]),
        caption: [...present(rs), ...baseCaption(pf)],
        showShortSeries: false,
        smaPeriods: [],
      };
    }
    case "minervini-trend-template":
      return {
        levels: present([sma50, sma150, sma200, sma200Prior, low52]),
        bands: [],
        markers: [],
        caption: pf.high52w !== null && pf.close !== null
          ? [`Close ${formatPrice(pf.close)} vs 52-week high ${formatPrice(pf.high52w)}`]
          : [],
        showShortSeries: false,
        smaPeriods: [50, 150, 200],
      };
    case "crowded-short-breakout":
      return {
        levels: present([base.pivot]),
        bands: present([base.band]),
        markers: present([base.marker]),
        caption: [...present([opts.shortRuleDetail ?? null]), ...baseCaption(pf)],
        showShortSeries: true,
        smaPeriods: [],
      };
    case "quality-compounders":
      return { levels: present([sma200]), bands: [], markers: [], caption: [], showShortSeries: false, smaPeriods: [200] };
    default:
      return { levels: present([sma200, high52, low52]), bands: [], markers: [], caption: [], showShortSeries: false, smaPeriods: [200] };
  }
}

/** SMA values aligned to `points`; null below a full lookback, never partial. */
export function smaIndicator(points: ChartPoint[], period: number): (number | null)[] | null {
  if (period <= 0 || points.length < period) return null;
  const values = calculateSMA(points.map((p) => p.v), period);
  return values.map((v, i) => (i < period - 1 ? null : v));
}
```

- [ ] **Step 4: Run the pure tests**

```bash
cd web && npx jest src/@/components/strategy/__tests__/strategy-levels.test.ts
```
Expected: PASS. (If `formatPrice` renders `$43.00` differently, e.g. `A$43.00`, update the expected labels to match its output rather than the helper.)

- [ ] **Step 5: Write the failing component test**

`strategy-levels-chart.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";

const DAY = 86_400_000;
const points = Array.from({ length: 260 }, (_, i) => ({ t: Date.UTC(2025, 9, 1) + i * DAY, v: 40 + (i % 7) }));
jest.mock("~/@/components/charts/use-stock-chart-data", () => ({
  useStockChartData: () => ({ price: points, short: points.map((p) => ({ t: p.t, v: 5 })), volume: [], anyLoading: false, isError: false, correlation: null }),
}));
jest.mock("~/@/components/charts/StockChart", () => ({
  StockChart: (p: { series: unknown[]; levels?: unknown[]; bands?: unknown[]; indicators?: unknown[] }) => (
    <div data-testid="chart" data-series={p.series.length} data-levels={p.levels?.length ?? 0} data-bands={p.bands?.length ?? 0} data-indicators={p.indicators?.length ?? 0} />
  ),
}));

import { StrategyLevelsChart } from "../strategy-levels-chart";
import type { StockPriceFeatures, StockStrategyFitRow } from "~/app/actions/getStockStrategyFit";

const fits: StockStrategyFitRow[] = [
  { strategyId: "zanger-breakout", strategyName: "Zanger Breakout", status: "watch", score: 30, rank: 9, totalCount: 40, rules: [], ruleColumns: [] },
  { strategyId: "minervini-trend-template", strategyName: "Minervini Trend Template", status: "triggered", score: 68, rank: 2, totalCount: 90, rules: [], ruleColumns: [] },
  { strategyId: "crowded-short-breakout", strategyName: "Crowded-Short Breakout", status: "none", score: null, rank: null, totalCount: 12,
    rules: [{ ruleId: "short_interest", status: "pass", detail: "Short interest 6.5% ≥ 5%" }], ruleColumns: [{ id: "short_interest", title: "Short interest" }] },
];
const pf: StockPriceFeatures = {
  asOf: "2026-10-07", close: 42.1, sma50: 40, sma150: 39, sma200: 38.5, sma200PriorMonth: 38.1, high52w: 45, low52w: 30,
  baseHigh: 43, baseLow: 39, baseDepthPct: 9.3, baseLengthDays: 22, breakoutRecent: true, breakoutDate: "2026-09-19",
  rs3mPct: 4.2, rs6mPct: null, volumeRatio50d: 1.8, sessionsAvailable: 260,
};

describe("StrategyLevelsChart", () => {
  it("defaults to the strongest strategy and draws its full-lookback averages", () => {
    render(<StrategyLevelsChart stockCode="BHP" fits={fits} priceFeatures={pf} />);
    expect(screen.getByRole("button", { name: "Minervini Trend Template" })).toHaveAttribute("aria-pressed", "true");
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-levels", "5");
    expect(chart).toHaveAttribute("data-indicators", "3"); // 260 points ≥ 200: every window is full
    expect(chart).toHaveAttribute("data-series", "1");
  });

  it("switches level sets, adds the short series for the crowded-short strategy, and quotes the rule", () => {
    render(<StrategyLevelsChart stockCode="BHP" fits={fits} priceFeatures={pf} />);
    fireEvent.click(screen.getByRole("button", { name: "Crowded-Short Breakout" }));
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-series", "2");
    expect(chart).toHaveAttribute("data-bands", "1");
    expect(screen.getByText("Short interest 6.5% ≥ 5%")).toBeInTheDocument();
  });

  it("is price-only with a note when features are null", () => {
    render(<StrategyLevelsChart stockCode="BHP" fits={fits} priceFeatures={null} />);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-levels", "0");
    expect(screen.getByText(/showing price only/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Implement the island**

```tsx
"use client";

import { useMemo, useState } from "react";
import { cn } from "~/@/lib/utils";
import { StockChart } from "~/@/components/charts/StockChart";
import { seriesColor } from "~/@/components/charts/chart-theme";
import { priceFmt, shortFmt } from "~/@/components/charts/chart-views";
import { useStockChartData } from "~/@/components/charts/use-stock-chart-data";
import type { ChartSeriesSpec, SeriesIndicator } from "~/@/components/charts/types";
import type { StockPriceFeatures, StockStrategyFitRow } from "~/app/actions/getStockStrategyFit";
import { LEVEL_COLORS, defaultStrategyId, smaIndicator, strategyLevelSet } from "./strategy-levels";

/** Same period as the layout's chart, so TanStack Query serves this from cache. */
const PERIOD = "1y";
const SMA_COLORS: Record<number, string> = { 50: LEVEL_COLORS.sma50, 150: LEVEL_COLORS.sma150, 200: LEVEL_COLORS.sma200 };

export interface StrategyLevelsChartProps {
  stockCode: string;
  fits: StockStrategyFitRow[];
  priceFeatures: StockPriceFeatures | null;
  initialStrategyId?: string | null;
}

export function StrategyLevelsChart({ stockCode, fits, priceFeatures, initialStrategyId }: StrategyLevelsChartProps) {
  const [selected, setSelected] = useState<string | null>(
    () => initialStrategyId ?? defaultStrategyId(fits),
  );
  const { price, short, anyLoading, isError } = useStockChartData(stockCode, PERIOD);

  const fit = fits.find((f) => f.strategyId === selected) ?? null;
  const shortRuleDetail = fit?.rules.find((r) => r.ruleId === "short_interest")?.detail;
  const levelSet = useMemo(
    () => strategyLevelSet(selected ?? "", priceFeatures, { shortRuleDetail }),
    [selected, priceFeatures, shortRuleDetail],
  );

  const series = useMemo<ChartSeriesSpec[]>(() => {
    const out: ChartSeriesSpec[] = [];
    if (price.length) {
      out.push({ id: `${stockCode}:price`, label: "Price", color: seriesColor("price"), axis: "left", kind: "area", points: price });
    }
    if (levelSet.showShortSeries && short.length) {
      out.push({ id: `${stockCode}:short`, label: "Short %", color: seriesColor("short"), axis: "right", kind: "line", points: short });
    }
    return out;
  }, [price, short, levelSet.showShortSeries, stockCode]);

  // Moving-average LINES only where every plotted point has a full lookback.
  const indicators = useMemo<SeriesIndicator[]>(() => {
    const out: SeriesIndicator[] = [];
    for (const period of levelSet.smaPeriods) {
      const values = smaIndicator(price, period);
      if (!values) continue;
      out.push({ id: `sma${period}`, seriesId: `${stockCode}:price`, label: `SMA ${period}`, color: SMA_COLORS[period] ?? LEVEL_COLORS.range, values });
    }
    return out;
  }, [levelSet.smaPeriods, price, stockCode]);

  return (
    <div className="flex flex-col gap-3" data-strategy-chart={selected ?? ""}>
      <div className="flex flex-wrap items-center gap-1 rounded-md border p-0.5" role="group" aria-label="Strategy levels">
        {fits.map((f) => (
          <button
            key={f.strategyId}
            type="button"
            onClick={() => setSelected(f.strategyId)}
            aria-pressed={selected === f.strategyId}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              selected === f.strategyId ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {f.strategyName}
          </button>
        ))}
      </div>

      {isError ? (
        <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          Unable to load price data.
        </div>
      ) : series.length ? (
        <StockChart
          series={series}
          indicators={indicators}
          levels={levelSet.levels}
          bands={levelSet.bands}
          markers={levelSet.markers}
          leftAxis={{ side: "left", format: priceFmt }}
          rightAxis={levelSet.showShortSeries ? { side: "right", format: shortFmt } : undefined}
          height={360}
          showBrush={false}
        />
      ) : anyLoading ? (
        <div className="h-[360px] animate-pulse rounded-lg bg-muted/40" aria-label="Loading chart" />
      ) : (
        <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          No price data for {stockCode}.
        </div>
      )}

      {levelSet.caption.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {levelSet.caption.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default StrategyLevelsChart;
```

- [ ] **Step 7: Run the component tests and the typecheck**

```bash
cd web && npx jest src/@/components/strategy && npx tsc --noEmit -p tsconfig.json
```
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/@/components/strategy
git commit -m "feat(web): strategy level sets and the levels chart island

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: The Strategy tab

**Files:**
- Create: `web/src/@/components/strategy/strategy-fit-panel.tsx`
- Create: `web/src/app/shorts/[stockCode]/strategy/page.tsx`, `loading.tsx`, `__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `getStockStrategyFit(code)` (throws on failure; Task 3 shape), `getStrategies(): Promise<StrategiesResult | null>` (`{ strategies: StrategyDef[], regime }`; `StrategyDef.rules: { id, title, ruleText, evaluation, core, dataSource }[]`), `RegimeBanner({ regime })`, `StatusPill`, `RuleDot({ status })` from `~/@/components/picks/picks-table`, `StrategyLevelsChart` (Task 15, client → `ssr:false`), `stockTabMetadata`, `formatDate` from `~/@/lib/fundamentals/format`.
- Produces:

```tsx
// strategy-fit-panel.tsx (server-safe, props-only)
export function sortFitsByStrength(fits: StockStrategyFitRow[]): StockStrategyFitRow[]; // triggered > setup > watch > none, score desc, stable
export function StrategyFitPanel(props: { fit: StockStrategyFitRow; definition: StrategyDef | null }): JSX.Element;
```

**Deviation from the spec, recorded here:** the chart sits directly under the regime banner and its own segmented control is the only strategy switch. The spec's "selecting a panel's heading switches it too" would couple server-rendered panels to client state for no reader benefit; each panel instead links to its `/picks/<id>` page.

- [ ] **Step 1: Write the failing page test**

`web/src/app/shorts/[stockCode]/strategy/__tests__/page.test.tsx`:

```tsx
/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

const mockFit = jest.fn();
const mockStrategies = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({});
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => (p: { fits: unknown[] }) => <div data-testid="levels-chart" data-fits={p.fits?.length ?? 0} />);
jest.mock("react", () => ({ ...jest.requireActual("react"), cache: (fn: unknown) => fn }));
jest.mock("~/app/actions/getStockStrategyFit", () => ({ getStockStrategyFit: (...a: unknown[]) => mockFit(...a) }));
jest.mock("~/app/actions/getStrategies", () => ({ getStrategies: (...a: unknown[]) => mockStrategies(...a) }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ BreadcrumbStructuredData: () => null }));
jest.mock("~/@/components/picks/regime-banner", () => ({ RegimeBanner: ({ regime }: { regime: { regime: string } | null }) => <div data-testid="regime">{regime?.regime ?? "none"}</div> }));

import Page, { generateMetadata } from "../page";

const fit = {
  stockCode: "BHP", asOf: "2026-10-07", inUniverse: true,
  regime: { indexCode: "XJO", asOf: "2026-10-07", regime: "uptrend", close: 1, sma50: 1, sma200: 1, pctOff52wHigh: 0, verdict: "" },
  priceFeatures: { asOf: "2026-10-07", close: 42, sma50: null, sma150: null, sma200: null, sma200PriorMonth: null, high52w: null, low52w: null, baseHigh: null, baseLow: null, baseDepthPct: null, baseLengthDays: null, breakoutRecent: false, breakoutDate: null, rs3mPct: null, rs6mPct: null, volumeRatio50d: null, sessionsAvailable: 260 },
  fits: [
    { strategyId: "canslim", strategyName: "CAN SLIM", status: "watch", score: 41, rank: 18, totalCount: 40,
      rules: [{ ruleId: "market", status: "pass", detail: "XJO uptrend" }], ruleColumns: [{ id: "market", title: "Market direction" }] },
    { strategyId: "minervini-trend-template", strategyName: "Minervini Trend Template", status: "triggered", score: 68, rank: 2, totalCount: 90,
      rules: [{ ruleId: "stack", status: "pass", detail: "50 > 150 > 200" }], ruleColumns: [{ id: "stack", title: "Average stack" }] },
  ],
};
const strategies = {
  regime: null,
  strategies: [
    { id: "canslim", name: "CAN SLIM", author: "", tagline: "", descriptionParagraphs: [], metadata: null, caveats: [], sources: [],
      rules: [{ id: "market", title: "Market direction", ruleText: "Only buy in a confirmed uptrend.", evaluation: "XJO above its 50 and 200-day averages.", core: true, dataSource: "index_prices" }] },
  ],
};

describe("/shorts/[stockCode]/strategy", () => {
  beforeEach(() => { mockFit.mockReset(); mockStrategies.mockReset(); mockMetadata.mockClear(); });

  it("renders the banner, the chart, then one panel per strategy strongest first, with rule text and evidence", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(strategies);
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("regime")).toHaveTextContent("uptrend");
    expect(screen.getByTestId("levels-chart")).toHaveAttribute("data-fits", "2");
    const panels = screen.getAllByRole("region", { name: /Trend Template|CAN SLIM/ });
    expect(panels[0]).toHaveAccessibleName(/Minervini Trend Template/);
    const canslim = screen.getByRole("region", { name: /CAN SLIM/ });
    expect(within(canslim).getByRole("link", { name: "CAN SLIM" })).toHaveAttribute("href", "/picks/canslim");
    expect(within(canslim).getByText("Only buy in a confirmed uptrend.")).toBeInTheDocument();
    expect(within(canslim).getByText("XJO above its 50 and 200-day averages.")).toBeInTheDocument();
    expect(within(canslim).getByText("XJO uptrend")).toBeInTheDocument();
    expect(within(canslim).getByText("rank 18 of 40")).toBeInTheDocument();
    const order = Array.from(container.querySelectorAll("[data-testid], section[aria-labelledby]")).map((n) => n.getAttribute("data-testid") ?? n.getAttribute("aria-labelledby"));
    expect(order.indexOf("levels-chart")).toBeLessThan(order.indexOf("fit-minervini-trend-template"));
  });

  it("renders the out-of-universe explanation with no chart and asks for noindex", async () => {
    mockFit.mockResolvedValue({ ...fit, inUniverse: false, fits: [], priceFeatures: null });
    mockStrategies.mockResolvedValue(null);
    render(await Page({ params: Promise.resolve({ stockCode: "NEW" }) }));
    expect(screen.queryByTestId("levels-chart")).not.toBeInTheDocument();
    expect(screen.getByText(/needs more price history/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /stock picker/ })).toHaveAttribute("href", "/picks");
    await generateMetadata({ params: Promise.resolve({ stockCode: "NEW" }) });
    expect(mockMetadata.mock.calls[0]![0]).toMatchObject({ tab: "strategy", forceNoindex: true });
  });

  it("fails the render on a fit failure rather than caching an empty page", async () => {
    mockFit.mockRejectedValue(new Error("timeout"));
    mockStrategies.mockResolvedValue(null);
    await expect(Page({ params: Promise.resolve({ stockCode: "BHP" }) })).rejects.toThrow(/strategy fit unavailable/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/strategy"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel**

`web/src/@/components/strategy/strategy-fit-panel.tsx`:

```tsx
import Link from "next/link";
import { RuleDot, StatusPill } from "~/@/components/picks/picks-table";
import type { StrategyDef } from "~/@/lib/strategies/types";
import type { StockStrategyFitRow } from "~/app/actions/getStockStrategyFit";

// One strategy's full reading of one stock: status, score, rank and every
// rule beside the author's words, our test and the evidence the evaluator
// wrote. Props-only (no protobuf, no connect) so a server page renders it
// and it stays crawlable. The strategy's description paragraphs are NOT
// repeated here; the name links to the /picks page that owns them.

const STRENGTH: Record<StockStrategyFitRow["status"], number> = { triggered: 3, setup: 2, watch: 1, none: 0 };
const RESULT_WORD = { pass: "Pass", fail: "Fail", unknown: "Unknown" } as const;

export function sortFitsByStrength(fits: StockStrategyFitRow[]): StockStrategyFitRow[] {
  return fits
    .map((fit, i) => ({ fit, i }))
    .sort((a, b) =>
      STRENGTH[b.fit.status] - STRENGTH[a.fit.status] ||
      (b.fit.score ?? -1) - (a.fit.score ?? -1) ||
      a.i - b.i,
    )
    .map(({ fit }) => fit);
}

export function StrategyFitPanel({ fit, definition }: { fit: StockStrategyFitRow; definition: StrategyDef | null }) {
  const candidate = fit.status !== "none";
  const headingId = `fit-${fit.strategyId}`;
  const defs = new Map((definition?.rules ?? []).map((r) => [r.id, r]));
  return (
    <section aria-labelledby={headingId} className="rounded-lg border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <h2 id={headingId} className="text-base font-semibold">
          <Link href={`/picks/${fit.strategyId}`} prefetch={false} className="text-primary hover:underline">
            {fit.strategyName}
          </Link>
        </h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {candidate ? (
            <StatusPill status={fit.status} />
          ) : (
            <span className="inline-flex items-center rounded-sm border border-dashed border-border px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none tracking-[0.12em]">
              Not a candidate
            </span>
          )}
          {candidate && fit.score !== null ? <span className="tabular-nums">Score <span className="text-foreground">{Math.round(fit.score)}</span></span> : null}
          {candidate && fit.rank !== null ? <span className="tabular-nums">rank {fit.rank}{fit.totalCount !== null ? ` of ${fit.totalCount}` : ""}</span> : null}
        </p>
      </header>
      <div className="overflow-x-auto border-t">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Rule</th>
              <th scope="col" className="px-4 py-2 font-medium">The rule</th>
              <th scope="col" className="px-4 py-2 font-medium">How we test it</th>
              <th scope="col" className="px-4 py-2 font-medium">Result</th>
              <th scope="col" className="px-4 py-2 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody className="divide-y align-top">
            {fit.rules.map((rule) => {
              const def = defs.get(rule.ruleId);
              const title = fit.ruleColumns.find((c) => c.id === rule.ruleId)?.title ?? def?.title ?? rule.ruleId;
              return (
                <tr key={rule.ruleId}>
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    {title}
                    {def?.core ? <span className="ml-1 text-[10px] uppercase tracking-wider text-muted-foreground">core</span> : null}
                  </th>
                  <td className="px-4 py-2 text-muted-foreground">{def?.ruleText ?? ""}</td>
                  <td className="px-4 py-2 text-muted-foreground">{def?.evaluation ?? ""}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <RuleDot status={rule.status} />
                      {RESULT_WORD[rule.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2">{rule.detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implement the page**

`web/src/app/shorts/[stockCode]/strategy/page.tsx`:

```tsx
import nextDynamic from "next/dynamic";
import Link from "next/link";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { RegimeBanner } from "~/@/components/picks/regime-banner";
import { StrategyFitPanel, sortFitsByStrength } from "~/@/components/strategy/strategy-fit-panel";
import { formatDate } from "~/@/lib/fundamentals/format";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { getStockStrategyFit, type StockStrategyFit } from "~/app/actions/getStockStrategyFit";
import { getStrategies } from "~/app/actions/getStrategies";
import { STOCK_CODE_PATTERN } from "../stock-page-shared";

const StrategyLevelsChart = nextDynamic(
  () => import("~/@/components/strategy/strategy-levels-chart").then((m) => m.StrategyLevelsChart),
  { ssr: false, loading: () => <div className="h-[360px] animate-pulse rounded-lg bg-muted/40" /> },
);

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

// One read per request shared by generateMetadata and the page. The action
// THROWS on failure; the page rethrows so a failed fit is never cached as an
// empty tab, and metadata fails open (no noindex) on the same failure.
const loadFit = cache(async (code: string): Promise<StockStrategyFit | null> => {
  try {
    return await getStockStrategyFit(code);
  } catch (err) {
    console.warn(`[strategy tab] strategy fit unavailable for ${code}:`, err);
    return null;
  }
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  const fit = STOCK_CODE_PATTERN.test(code) ? await loadFit(code) : null;
  return stockTabMetadata({
    code,
    tab: "strategy",
    title: (company) => `${code} Strategy Fit: Breakout, CANSLIM & Trend Rules | ${company}`,
    description: (company) =>
      `How ${company} (ASX:${code}) reads against the Zanger breakout, CAN SLIM, Minervini trend, crowded-short and quality-compounder rules today, with the levels drawn on the chart.`,
    keywords: [`${code} breakout`, `${code} CANSLIM`, `${code} trend template`, `${code} stock picker`],
    forceNoindex: fit !== null && !fit.inUniverse,
  });
}

export default async function StrategyPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  const [fit, strategies] = await Promise.all([loadFit(code), getStrategies()]);
  if (!fit) {
    throw new Error(`strategy fit unavailable for ${code}; failing ISR render instead of caching an empty tab`);
  }
  const definitions = new Map((strategies?.strategies ?? []).map((s) => [s.id, s]));
  const ordered = sortFitsByStrength(fit.fits);
  const pricesTo = formatDate(fit.asOf);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: "Strategy", href: stockTabHref(code, "strategy") },
        ]}
      />
      <h1 className="sr-only">{code} strategy fit</h1>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6">
        <RegimeBanner regime={fit.regime} />

        {!fit.inUniverse ? (
          <section aria-labelledby="not-evaluated-heading" className="rounded-lg border bg-card px-4 py-3 text-sm">
            <h2 id="not-evaluated-heading" className="font-medium">Not evaluated yet</h2>
            <p className="mt-1 text-muted-foreground">
              The picker needs more price history for {code} than it holds today
              (about 40 sessions) before it can read any strategy. See what it does read on the{" "}
              <Link href="/picks" prefetch={false} className="text-primary hover:underline">
                stock picker
              </Link>
              .
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="strategy-chart-heading" id="strategy-chart" className="flex flex-col gap-2">
              <h2 id="strategy-chart-heading" className="text-sm font-medium">Levels on the chart</h2>
              <StrategyLevelsChart stockCode={code} fits={ordered} priceFeatures={fit.priceFeatures} />
            </section>
            {ordered.map((row) => (
              <StrategyFitPanel key={row.strategyId} fit={row} definition={definitions.get(row.strategyId) ?? null} />
            ))}
          </>
        )}

        <p className="text-[11px] text-muted-foreground">
          {pricesTo ? `Prices to ${pricesTo} · ` : ""}Mechanical readings of published rules, not recommendations ·{" "}
          <Link href="/disclaimer" prefetch={false} className="underline underline-offset-4 hover:text-foreground">
            Not financial advice
          </Link>
        </p>
      </div>
    </>
  );
}
```

`web/src/app/shorts/[stockCode]/strategy/loading.tsx`: the same skeleton shape as `short-interest/loading.tsx` with heights `h-16`, `h-[360px]`, `h-64`, exported as `StrategyLoading`.

- [ ] **Step 5: Run the tests, typecheck and lint**

```bash
cd web && npx jest "src/app/shorts/\[stockCode\]/strategy" src/@/components/strategy && npx tsc --noEmit -p tsconfig.json && npx next lint --max-warnings=1000 --dir "src/app/shorts/[stockCode]/strategy" --dir src/@/components/strategy
```
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/@/components/strategy/strategy-fit-panel.tsx "web/src/app/shorts/[stockCode]/strategy"
git commit -m "feat(web): strategy tab with per-strategy rule panels and the levels chart

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Sitemap entries for the indexable tabs

**Files:**
- Modify: `web/src/@/lib/seo/sitemap-sections.ts` (`buildShortsSitemap`, ~line 506-528)
- Modify: `web/src/@/lib/seo/__tests__/sitemap-sections.test.ts`

**Interfaces:**
- Consumes: the existing `stockCodes` list (already the qualified, pruned set) and `latestDataDate`.
- Produces: `/shorts/<code>/short-interest`, `/shorts/<code>/financials`, `/shorts/<code>/company` beside the existing `/shorts/<code>/news`, for every qualified code. Strategy and community stay out.

- [ ] **Step 1: Write the failing test**

Add to `sitemap-sections.test.ts`, inside the existing describe that calls `buildAll()` (reuse its mocks; `getAllStockCodes` is already mocked there — find the mock and note which codes it returns, e.g. `["BHP", "CBA"]`):

```ts
  it("lists the indexable stock tabs for every qualified code, and never strategy or community", async () => {
    const shorts = (await buildAll()).find((s) => s.name === "sitemap-shorts.xml")!;
    const urls = shorts.entries.map((e) => e.url);
    for (const tab of ["short-interest", "financials", "company", "news"]) {
      expect(urls).toContain(`https://shorted.com.au/shorts/BHP/${tab}`);
    }
    expect(urls.some((u) => /\/shorts\/[A-Z0-9]+\/strategy$/.test(u))).toBe(false);
    expect(urls.some((u) => /\/shorts\/[A-Z0-9]+\/community$/.test(u))).toBe(false);
  });
```

Replace `BHP` with a code the file's `getAllStockCodes` mock actually returns, and the host with the file's `baseUrl`.

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx jest src/@/lib/seo/__tests__/sitemap-sections.test.ts -t "indexable stock tabs"
```
Expected: FAIL — `/short-interest` missing.

- [ ] **Step 3: Implement**

In `buildShortsSitemap`, replace the `stockNewsRoutes` block with:

```ts
  // Per-stock tab pages share the qualified stockCodes list, so the tab trees
  // mirror the pruned stock list (no thin pages get indexed). Strategy stays
  // out (most stocks read "not a candidate" on every strategy) and Community
  // is noindex; both are reached through the tab bar.
  const STOCK_TAB_SEGMENTS = ["short-interest", "financials", "company", "news"] as const;
  const stockTabRoutes: SitemapEntry[] = stockCodes.flatMap((code) =>
    STOCK_TAB_SEGMENTS.map((segment) => ({
      url: `${baseUrl}/shorts/${code}/${segment}`,
      lastModified: latestDataDate,
    })),
  );
```

and replace `...stockNewsRoutes` in the returned array with `...stockTabRoutes`.

- [ ] **Step 4: Run the sitemap tests**

```bash
cd web && npx jest src/@/lib/seo/__tests__/sitemap-sections.test.ts
```
Expected: PASS (the duplicate-URL test still passes: each URL appears once).

- [ ] **Step 5: Commit**

```bash
git add web/src/@/lib/seo/sitemap-sections.ts web/src/@/lib/seo/__tests__/sitemap-sections.test.ts
git commit -m "feat(seo): sitemap entries for the short-interest, financials and company tabs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: The ISR build gate and the per-tab budgets

**Files:**
- Create: `web/scripts/route-kinds.mjs`
- Create: `scripts/tests/route-kinds.test.mjs`
- Modify: `web/package.json` (scripts), `Taskfile.yml` (`test:bundle`), `.github/workflows/perf-budget.yml` (after the bundle step), `.github/workflows/repo-hygiene.yml` (test list)
- Modify: `web/scripts/bundle-budget.mjs` (`BUDGETS.routes`)
- Modify: `docs/perf/bundle-baseline.json` (refreshed by the script)

**Interfaces:**
- Produces: `node scripts/route-kinds.mjs [--manifest <path>]` exits 1 when any expected stock route is missing from `dynamicRoutes` in `.next/prerender-manifest.json`; `npm run routes:kinds`.

Why the prerender manifest: a route that Next renders dynamically on every request never appears there, while an on-demand ISR dynamic route appears under `dynamicRoutes` with its `fallback`. That absence is the exact failure the cost model cannot survive.

- [ ] **Step 1: Write the failing test**

`scripts/tests/route-kinds.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../web/scripts/route-kinds.mjs", import.meta.url));
const EXPECTED = [
  "/shorts/[stockCode]",
  "/shorts/[stockCode]/short-interest",
  "/shorts/[stockCode]/strategy",
  "/shorts/[stockCode]/financials",
  "/shorts/[stockCode]/company",
  "/shorts/[stockCode]/news",
  "/shorts/[stockCode]/community",
];

function run(t, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-route-kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "prerender-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, "--manifest", path], { encoding: "utf8" });
}

test("passes when every stock route is an ISR dynamic route", (t) => {
  const dynamicRoutes = Object.fromEntries(EXPECTED.map((r) => [r, { fallback: null, routeRegex: "x", dataRoute: "y" }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7 stock routes are ISR/);
});

test("fails and names the route when one has slipped to per-request rendering", (t) => {
  const dynamicRoutes = Object.fromEntries(EXPECTED.filter((r) => !r.endsWith("/strategy")).map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/shorts\/\[stockCode\]\/strategy/);
});

test("the CI workflow and the npm script run it after the bundle budget", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/perf-budget.yml", import.meta.url), "utf8");
  assert.match(workflow, /node scripts\/route-kinds\.mjs/);
  assert.ok(workflow.indexOf("route-kinds.mjs") > workflow.indexOf("bundle-budget.mjs"), "route kinds runs after the bundle budget");
  const pkg = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["routes:kinds"], "node scripts/route-kinds.mjs");
});
```

Add `readFileSync` to the `node:fs` import line.

- [ ] **Step 2: Run to verify it fails**

```bash
node --test scripts/tests/route-kinds.test.mjs
```
Expected: FAIL — script missing.

- [ ] **Step 3: Implement the script**

`web/scripts/route-kinds.mjs`:

```js
#!/usr/bin/env node
// ISR gate for the stock segment.
//
// Every route under /shorts/[stockCode] must be on-demand ISR: generated on
// first request and served from the cache for `revalidate` seconds. A route
// that Next renders dynamically (because a page read searchParams/cookies/
// headers, or lost its generateStaticParams export) runs a function on EVERY
// request — the one regression the stock page's cost model cannot survive.
//
// Dynamic (per-request) routes never appear in .next/prerender-manifest.json;
// ISR dynamic routes appear under `dynamicRoutes`. So presence there is the
// test. Run after `next build`:
//   node scripts/route-kinds.mjs [--manifest .next/prerender-manifest.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const STOCK_ROUTES = [
  "/shorts/[stockCode]",
  "/shorts/[stockCode]/short-interest",
  "/shorts/[stockCode]/strategy",
  "/shorts/[stockCode]/financials",
  "/shorts/[stockCode]/company",
  "/shorts/[stockCode]/news",
  "/shorts/[stockCode]/community",
];

export function missingIsrRoutes(manifest, expected = STOCK_ROUTES) {
  const dynamicRoutes = manifest?.dynamicRoutes ?? {};
  return expected.filter((route) => !(route in dynamicRoutes));
}

function main(argv) {
  const i = argv.indexOf("--manifest");
  const path = resolve(i >= 0 ? argv[i + 1] : ".next/prerender-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`route-kinds: cannot read ${path}: ${err.message}. Run \`next build\` first.`);
    return 2;
  }
  const missing = missingIsrRoutes(manifest);
  if (missing.length) {
    console.error("route-kinds: these stock routes are NOT ISR (absent from prerender-manifest dynamicRoutes):");
    for (const r of missing) console.error(`  ${r}`);
    console.error("A page under /shorts/[stockCode] has lost its generateStaticParams export or reads searchParams/cookies/headers.");
    return 1;
  }
  console.log(`route-kinds: ${STOCK_ROUTES.length} stock routes are ISR.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 4: Wire it up**

- `web/package.json` scripts: add `"routes:kinds": "node scripts/route-kinds.mjs"`.
- `Taskfile.yml` `test:bundle` cmds: `[npm run bundle:budget, npm run routes:kinds]`.
- `.github/workflows/perf-budget.yml`: after the "Bundle budget vs baseline" step add

```yaml
      # ISR gate (blocking): every stock route must be on-demand ISR.
      - name: Stock routes are ISR
        run: node scripts/route-kinds.mjs
```
- `.github/workflows/repo-hygiene.yml`: append ` scripts/tests/route-kinds.test.mjs` to the `node --test` list.

- [ ] **Step 5: Run the test, then the real build and both gates**

```bash
node --test scripts/tests/route-kinds.test.mjs
cd web && SKIP_ENV_VALIDATION=1 npx next build 2>&1 | tee /tmp/stock-tabs-build.log && npm run routes:kinds && node scripts/bundle-budget.mjs --build-log /tmp/stock-tabs-build.log
```
Expected: the node test passes (3); the build's route table shows `●` for every `/shorts/[stockCode]...` route and `routes:kinds` prints `7 stock routes are ISR`. If a route shows `ƒ`, find the `searchParams`/`cookies()`/`headers()` read or the missing export in that page before going on. (Local builds can fail at prerender on the `api.shorted.com.au` TLS mismatch — that is the known env issue from `.claude/skills/perf-optimization/SKILL.md`; the route table is printed before prerender, and `route-kinds` only needs the manifest, which exists once the build completes. If the build cannot complete locally, run the gates in the Cuttlefish/CI build and read its log.)

- [ ] **Step 6: Set the budgets and refresh the baseline**

In `bundle-budget.mjs` `BUDGETS.routes`, add one entry per new route at the measured first-load value plus 10% headroom (round up to 5 kB), and lower `"/shorts/[stockCode]"` to its new measured value plus 10% (it sheds the tab bundles):

```js
    "/shorts/[stockCode]": <measured+10%>,
    "/shorts/[stockCode]/short-interest": <measured+10%>,
    "/shorts/[stockCode]/strategy": <measured+10%>,
    "/shorts/[stockCode]/financials": <measured+10%>,
    "/shorts/[stockCode]/company": <measured+10%>,
    "/shorts/[stockCode]/news": <measured+10%>,
    "/shorts/[stockCode]/community": <measured+10%>,
```
Then `npm run bundle:baseline` (writes `docs/perf/bundle-baseline.json`) and `node scripts/bundle-budget.mjs --build-log /tmp/stock-tabs-build.log --compare ../docs/perf/bundle-baseline.json` must exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/scripts/route-kinds.mjs scripts/tests/route-kinds.test.mjs web/package.json Taskfile.yml .github/workflows/perf-budget.yml .github/workflows/repo-hygiene.yml web/scripts/bundle-budget.mjs docs/perf/bundle-baseline.json
git commit -m "ci(web): route-kinds gate keeps every stock route ISR; per-tab bundle budgets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19: Playwright: tabs, chart persistence, prefetch, redirect, mobile, levels

**Files:**
- Create: `web/e2e/stock-tabs.spec.ts`

**Interfaces:**
- Consumes: the running app (`BASE_URL` or `http://localhost:3020`), `StockTabNav`'s `aria-label="Stock sections"` and `aria-current`, `StockChart`'s `[data-chart-container]`, `StrategyLevelsChart`'s `[data-strategy-chart]`, the chart's `[data-chart-level]`.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, type Page } from "@playwright/test";

const CODE = "BHP";
const TABS = [
  ["Short interest", "short-interest"],
  ["Strategy", "strategy"],
  ["Financials", "financials"],
  ["Company", "company"],
  ["News", "news"],
  ["Community", "community"],
] as const;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("stock page tabs", () => {
  test("every tab is a route; the chart node survives; back returns to the previous tab", async ({ page }) => {
    await page.goto(`/shorts/${CODE}`);
    const nav = page.getByRole("navigation", { name: "Stock sections" });
    await expect(nav.getByRole("link")).toHaveCount(7);
    const chart = page.locator("[data-chart-container] svg").first();
    await expect(chart).toBeVisible();
    // Tag the live DOM node: a remount would lose the property.
    await chart.evaluate((el) => { (el as HTMLElement).dataset.e2eMarker = "mounted-once"; });
    for (const [label, segment] of TABS) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/${segment}$`));
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
      expect(await chart.evaluate((el) => (el as HTMLElement).dataset.e2eMarker)).toBe("mounted-once");
    }
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/news$`));
  });

  test("no tab route is requested before the visitor shows intent", async ({ page }) => {
    const tabRequests: string[] = [];
    page.on("request", (r) => {
      if (new RegExp(`/shorts/${CODE}/(${TABS.map(([, s]) => s).join("|")})`).test(r.url())) tabRequests.push(r.url());
    });
    await page.goto(`/shorts/${CODE}`);
    await page.waitForLoadState("networkidle");
    expect(tabRequests).toEqual([]);
    await page.getByRole("navigation", { name: "Stock sections" }).getByRole("link", { name: "Financials" }).hover();
    await expect.poll(() => tabRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
  });

  test("390px: the tab bar scrolls instead of widening the page, and a tap navigates", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shorts/${CODE}`);
    expect(await horizontalOverflow(page)).toBe(0);
    const nav = page.getByRole("navigation", { name: "Stock sections" });
    await nav.getByRole("link", { name: "Strategy" }).click();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/strategy$`));
    expect(await horizontalOverflow(page)).toBe(0);
    await expect(nav.getByRole("link", { name: "Strategy" })).toBeInViewport();
  });

  test("a legacy ?tab= link answers with a permanent redirect to the tab route", async ({ request }) => {
    const res = await request.get(`/shorts/${CODE}?tab=financials`, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toMatch(new RegExp(`/shorts/${CODE}/financials$`));
    const none = await request.get(`/shorts/${CODE}?tab=foo`, { maxRedirects: 0 });
    expect(none.status()).toBe(200);
  });

  test("a tab URL carries a self canonical and the stock's social image", async ({ page }) => {
    await page.goto(`/shorts/${CODE}/financials`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/shorts/${CODE}/financials$`));
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(og).toBeTruthy();
    await expect(page).toHaveTitle(new RegExp(`${CODE} Financials`));
  });

  test("the strategy tab of a currently triggered stock draws at least one level", async ({ page }) => {
    await page.goto("/picks/minervini-trend-template");
    const firstCode = await page.locator('a[href^="/shorts/"]').first().getAttribute("href");
    expect(firstCode).toBeTruthy();
    const code = firstCode!.split("/")[2]!;
    await page.goto(`/shorts/${code}/strategy`);
    await expect(page.locator("[data-strategy-chart]")).toBeVisible();
    await expect(page.getByRole("region", { name: /Minervini/ })).toBeVisible();
    await expect(page.locator("[data-chart-level]").first()).toBeVisible({ timeout: 15000 });
  });

  test("a community thread renders under the stock chrome once", async ({ page }) => {
    await page.goto(`/shorts/${CODE}/community`);
    const thread = page.locator(`a[href^="/shorts/${CODE}/community/"]`).first();
    if ((await thread.count()) === 0) test.skip(true, "no thread to open");
    await thread.click();
    await expect(page.getByRole("navigation", { name: "Stock sections" })).toHaveCount(1);
    await expect(page.locator("[data-chart-container]")).toHaveCount(1);
  });
});
```

- [ ] **Step 2: Run it against a production build**

```bash
cd web && SKIP_ENV_VALIDATION=1 npx next build && (npm run start &) && until curl -sf localhost:3020 >/dev/null; do sleep 1; done && npx playwright test e2e/stock-tabs.spec.ts --project=chromium; kill %1
```
Expected: 7 passed (the thread test may skip). If the picks page has no triggered Minervini row today, the levels test still passes on any row because every strategy set draws at least the SMA 200 level when features are present; if it fails with no `[data-chart-level]`, check PR 1 is deployed to the API the build points at.

- [ ] **Step 3: Commit**

```bash
git add web/e2e/stock-tabs.spec.ts
git commit -m "test(e2e): stock tab routes, chart persistence, intent prefetch, redirect, mobile, levels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 20: Docs and the PR

**Files:**
- Modify: `CLAUDE.md` (add a "Stock page (one route per tab)" section after the "Stock picker" section)
- Modify: `docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md` (status line; record the two deviations)
- Modify: `web/src/app/shorts/[stockCode]/opengraph-image.tsx` only if the e2e `og:image` check failed (then add `export { default, ... } from "../opengraph-image"` style re-exports per tab folder is NOT possible for file conventions — instead copy the file into each tab folder that needs it; expected not to be needed)

- [ ] **Step 1: Write the CLAUDE.md section**

Insert after the "Stock picker" section:

```markdown
## Stock page (one route per tab)

`/shorts/[stockCode]` is a shared server `layout.tsx` (breadcrumbs, login
slot, profile + stats, short-interest summary, theme chips, the chart, the
tab bar) with seven ISR pages beneath it: `/` (Overview digest),
`/short-interest`, `/strategy`, `/financials`, `/company`, `/news` (600 s),
`/community` (+ `community/[threadId]`). The tab list lives ONCE in
`web/src/@/lib/stocks/stock-tabs.ts`; metadata goes through
`lib/seo/stock-tab-metadata.ts` (inherits `isStockIndexable`; Strategy adds
noindex when `in_universe` is false; Community is always noindex).
Spec: `docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md`.

### Landmines

- **Every tab page exports `revalidate`, `dynamicParams = true` and an EMPTY
  `generateStaticParams`**, and none reads `searchParams`, `cookies()` or
  `headers()`. Lose any of that and the route renders on every request.
  `npm run routes:kinds` (after `next build`) fails when a stock route is
  missing from `.next/prerender-manifest.json`; it runs in `test:bundle`
  and `perf-budget.yml`.
- **Tab links prefetch on intent only** (`StockTabNav`: pointer enter,
  touch start, focus; once per href). Never switch them to viewport
  prefetch: seven ISR regenerations per page view.
- **Old `?tab=` links are edge redirects** built from
  `web/src/config/stock-tab-redirects.json` in `next.config.mjs`; no
  client-side reader exists any more. An unmapped value falls through to the
  Overview.
- **The sync's `/shorts/[stockCode]` path is revalidated with type `layout`**
  (`/api/revalidate`), which expires every tab for every code in one call.
- **The chart lives in the layout** so it never remounts between tabs; the
  Strategy tab's levels chart calls `useStockChartData(code, "1y")` with the
  same key and costs no extra request.
- **`PriceFeatures` on `GetStockStrategyFit`** carries `has_` flags; the web
  maps absent to `null` (`StockPriceFeatures`), never zero. Level sets are
  pure (`components/strategy/strategy-levels.ts`); a moving-average line is
  drawn only with a full lookback.
- `stock-news-tab.tsx` stays (other components import its hooks); the old
  `stock-tabs.tsx` shell is gone.
```

- [ ] **Step 2: Update the spec's status line and deviations**

Change the spec's second line to `Date: 2026-10-09. Status: implemented by PRs <n> and <m> (fill in).` and append under "Judgement calls":

```markdown
- Implementation deviations: the Strategy tab's chart sits under the regime
  banner and its segmented control is the only switch (panels link to
  `/picks/<id>` instead of switching the chart); `stock-news-tab.tsx` is
  kept because `stock-news-feed.tsx` and `related-news-rail.tsx` import it.
```

- [ ] **Step 3: Run the full local gate**

```bash
task verify
```
Expected: green. Then `cd web && npm run lint && npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 4: Commit and open PR 2**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md
git commit -m "docs: stock page tab routes — rules, gates and the strategy levels contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

PR title: `feat(web): stock page as one route per tab, with a Strategy tab that draws the picker's levels`. Body: link the spec and this plan, list the seven routes, state that deploys run through Cuttlefish (the GitHub deploy workflow is disabled), and the post-deploy checklist from the spec §6 step 3 (revalidate once with `path=/shorts/[stockCode]`, confirm a tab's second hit is `x-vercel-cache: HIT`, check the redirect and the 390 px tab bar on prod, open a triggered stock's Strategy tab). End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review (done while writing; kept for the executor)

- **Spec coverage.** §1 routes → Tasks 8, 10-13, 16. §2 ISR trio → every page task; route-kinds → Task 18; intent prefetch → Task 6; redirects → Task 4; layout revalidation → Task 5; budgets → Task 18. §3 metadata → Task 7 + each page; sitemap → Task 17; robots gates → Tasks 7, 13, 16. §4 API → Tasks 1-3; panel, chart, degradation → Tasks 14-16. §5 tests → in each task; e2e → Task 19. §6 rollout → PR notes in Tasks 2 and 20.
- **Known differences from the spec**, all recorded in Task 16/20: chart above panels with its own switch; `stock-news-tab.tsx` kept.
- **Type consistency.** `StockPriceFeatures` field names are identical in Tasks 3, 15, 16 and the tests; `stockTabHref(code, id)` and `activeStockTab(pathname)` are used with the same signatures in Tasks 6-13; `layoutLevels` inputs in Task 14 match the call in `StockChart`; `LevelSet` in Task 15 matches the chart island's reads.
- **Review Focus pins:** #1 Task 16 (out-of-universe test), #2 Tasks 3 and 15 (null features), #3 Task 4 (unmapped value, no loop) and Task 19 (`?tab=foo` is 200), #4 Task 14 (band clipped at 0), #5 Task 19 (DOM marker survives every tab).
