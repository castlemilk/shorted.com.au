# Housing Affordability Panel Design

## Goal

Surface the already-ingested national affordability, lending, rates, and
household balance-sheet series on `/housing`, while replacing the frozen ABS
RPPI headline with the live `price_index_derived` series.

## Architecture

Keep `/housing` as a server-rendered ISR route. The page continues to read only
quarterly headline data from `GetHousingOverview`; its price-index lookup changes
from `price_index` to `price_index_derived`. Every monthly or otherwise dark
series is fetched in the browser through the existing
`getHousePriceSeriesClient`/`GetHousePriceSeries` path.

The affordability section is a focused server component containing serializable
chart and tile definitions. Single-series cards use the existing dynamically
imported, `ssr: false` `HousingSeriesChart`. Comparison cards use a new
`HousingComparisonChart` that fetches two or three `GetHousePriceSeries`
responses and plots them on one shared-scale line chart. It is exported through
a `"use client"` loader module using `dynamic(..., { ssr: false })`, matching
the route's non-negotiable interactive-chart boundary.
Both chart types are wrapped in `WhenVisible` so neither their chunks nor RPCs
are requested until the card approaches the viewport.

The user-visible section heading is exactly **Affordability & credit**. The
section opens with compact measure tiles that name the available series and
their unit/frequency, then groups the charts under rates and credit,
affordability, and household balance-sheet headings. Tiles are descriptive
rather than headline values because the monthly series deliberately do not pass
through the quarterly-only headline MV.

## Data and presentation

- The headline BigStat and a new national chart use `price_index_derived`,
  labelled as an ABS-derived mean dwelling price index with its earliest quarter
  equal to 100. They never call it RPPI.
- Rates compare `cash_rate`, `mortgage_rate_oo`, and
  `mortgage_rate_investor` from RBA F1.1/F6 in one shared-scale chart.
- Credit compares `housing_credit_growth_oo` and
  `housing_credit_growth_investor` from RBA D1 in one shared-scale chart, and
  shows total `housing_credit_growth` in a companion single-series chart.
- Affordability shows `rents_index` and `wage_index` as client-derived annual
  percentage changes against the same quarter one year earlier,
  `price_to_income` as a Shorted-derived national mean-price-to-WPI index
  (2015=100, not the OECD series), and `investor_loan_share` as the share
  derived from ABS `LEND_HOUSING` owner-occupier and investor commitments.
- Household balance sheets show `household_dwelling_assets`,
  `household_net_worth`, and `household_liabilities` from RBA E1 with compact
  AUD trillion/billion formatting.
- Every card states its source/table and CC BY 4.0 licence.

`price_index_derived` is labelled as a Shorted-derived rebase of ABS
`RES_DWELL_ST` national mean dwelling prices, earliest available quarter=100.
It is not described as the discontinued hedonic RPPI.

The year-over-year transform is a pure client helper keyed by the serializable
`transform="yoy"` prop. It matches a point to the same month/quarter one year
earlier, skips missing/zero bases, and returns percentage-change points. The
default `level` transform preserves existing chart behaviour. Serializable
formatter keys are `percent`, `index`, and `aud`; `aud` gains compact trillion
and billion branches for RBA E1 while preserving current dwelling-price output.

## Error and empty states

The existing client action already converts RPC failures to `undefined`, and
`HousingSeriesChart` already renders a no-data state for fewer than two points.
The comparison chart renders any series with enough points and does not fail the
whole comparison when another series is missing. If every comparison series is
empty, it renders the same no-data state. One unavailable series therefore does
not hide the rest of the panel or alter ISR regeneration.

## Testing

- Unit-test the annual-change transform, including missing prior-year points and
  zero bases.
- Component-test the affordability panel's exact measure list, client transform
  keys, lazy visibility wrappers, and source/licence labels.
- Add feature-specific Playwright coverage for the derived-index headline and
  attribution, comparison-chart labels, and the absence of affordability-series
  RPCs until the lazy section approaches the viewport.
- Run the touched Jest suites, `npx tsc --noEmit`, `npm run bundle:budget`, the
  feature-specific housing Playwright flow when its required backend is
  available, and inspect the production build output to confirm `/housing`
  remains static ISR.

## Deliberate exclusions

No proto, backend, collector, materialized-view, migration, or server-action
changes are required. No production DDL applies. The section does not claim the
derived price index uses the discontinued RPPI hedonic methodology.
