# Per-Stock Page Layout: Consolidate, Tabbed Chart, Relocated History

**Date:** 2026-06-14
**Status:** Approved
**Scope:** `web/` only — no backend/proto changes. Layout/UI of `web/src/app/shorts/[stockCode]/page.tsx` and the chart components it mounts.

## Problem

The per-stock page is tall and front-loaded before the useful content:

- A large **SEO hero** (`<h1>` + summary paragraph + a 4-stat `<dl>` grid) whose stats **duplicate** `CompanyStats` (short %, reported positions) and `CompanyProfile` (industry).
- The **`ShortInterestHistory`** trend/FAQ block renders **above the breadcrumb**, where it's easy to miss.
- The chart is a single consolidated card with toggles; the user wants chart views organized as **tabs**.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Chart organization | A **tabbed chart panel** — sub-tabs Combined / Short Interest / Price & Volume in one card |
| `ShortInterestHistory` | Move into the **Overview tab, below the chart**, in a `Collapsible` **open by default** |
| Top compression | **Slim the hero** — keep H1 + one-sentence summary + source line; drop the duplicate 4-stat grid |

## SEO constraint (load-bearing)

`ShortInterestHistory` is crawlable trend facts + FAQ and must stay in the **initial DOM**. Radix tabs unmount inactive tabs, so it can only live in the **default (Overview) tab**, and its wrapping `Collapsible` must be **open by default** (open = rendered in DOM at SSR). It stays a server component (Suspense) passed into the client `StockTabs` as part of `overviewContent`.

## Components

### New: `useStockChartData(code, period)` — `web/src/@/components/charts/use-stock-chart-data.ts`
Shared hook extracting the data-building currently inline in `StockPriceShortChart`: fetches `useShortTimeSeries` + `useHistoricalData`, returns `{ short: ChartPoint[], price: ChartPoint[], volume: ChartPoint[], correlation: number | null, isLoading, isError }` (loading = either still loading with no data; error = both failed). Used by both `StockChartPanel` and `StockPriceShortChart` (refactored to consume it — DRY).

### New: `StockChartPanel.tsx` — `web/src/@/components/charts/`
Client component, the per-stock chart card body. Owns `period` state + a sub-tab state (`combined` | `short` | `price`). Uses `useStockChartData`. Renders:
- A header row: sub-tab triggers (Combined / Short Interest / Price & Volume) on the left; period selector + correlation badge (Combined only) + MA toggle (Combined/Price) on the right.
- One `StockChart` configured per active sub-tab:
  - **Combined** — price (left, area) + short % (right, line) + volume, dual-axis, brush.
  - **Short Interest** — short % only (left, area), brush.
  - **Price & Volume** — price (left, area) + volume, brush.
- Loading / empty / error states (same logic as the consolidated chart).

`StockPriceShortChart` is kept (storied, standalone-usable) but refactored to consume `useStockChartData`.

### Modified: `web/src/app/shorts/[stockCode]/page.tsx`
- **Slim hero**: in the summary `<section>`, keep `<h1>` + the summary `<p>` + the source/methodology `<p>`; remove the `<dl>` 4-stat grid.
- **Remove** the `ShortInterestHistory` block from its current above-breadcrumb position.
- In `overviewContent`'s main column, replace the `StockPriceShortChart` card with a card mounting `StockChartPanel`, and **add `ShortInterestHistory` below it** wrapped in an open-by-default `Collapsible` titled "Short interest history & FAQ".

### Modified: page-import tests
`__tests__/page-all-imports.test.tsx` + `page-runtime.test.tsx` — swap the `StockPriceShortChart` import assertion for `StockChartPanel` (the component the page now mounts).

## Layout after redesign

```
[slim hero: H1 + 1-sentence summary + source]      ← above breadcrumb (just the hero now)
[breadcrumb]
[CompanyProfile (2/3) | CompanyStats (1/3)]
[Tabs: Overview | Community | News | Financials | Directors | Dividends | Peers]
  Overview:
    side (1/3): CompanyInfo, RelatedStocks
    main (2/3): StockChartPanel (sub-tabs)
                ShortInterestHistory (collapsible, open)
                CommunityOverviewTeaser
                EnrichedCompanySection
```

## Testing & harness

- `StockChartPanel` gets `*.stories.tsx` (Combined default + sub-tab switching play function + Short / Price views + loading/error), reusing the `fetchStockDataClient` / `getHistoricalData` mocks and fixtures.
- Bookworm visual baselines for the new panel (per the harness).
- `npx tsc --noEmit`, `eslint`, `npm run test:storybook`, jest page-import tests green.

## Risks

- **SEO regression** if the history block stops being server-rendered in the initial DOM → mitigation: keep it a server component in the default Overview tab inside an open-by-default `Collapsible`; verify the FAQ/trend text appears in the SSR HTML (curl/Playwright DOM check).
- **Duplicate-stat removal** losing info → verified `CompanyStats` shows short %/positions and `CompanyProfile`/hero sentence cover industry/as-of.
- **Visual baseline churn** for the new panel → regenerate once in bookworm.
