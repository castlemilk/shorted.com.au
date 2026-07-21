# Economy Map Explorer — Design

**Date**: 2026-07-21
**Status**: Approved (user picked "map becomes the hero, charts become the drilldown")
**Depends on**: PR #307 (economy data platform — live on prod, 57,980 observations)

## Goal

Reshape `/economy` from a chart grid into a map-first explorer: a national
choropleth hero coloured by switchable state-level economic metrics, rich hover
tooltips, and click-to-drill state dossiers. Frontend-only — no backend, proto,
or collector changes; everything reads the existing
`GetEconomicSeries`/`ListEconomicSeries` RPCs.

## Non-goals (v1)

- LLM-composed state insight panels (phase 2).
- Commodity-level drill (state → commodity → series) beyond the top-exports bar
  list (phase 2; RPC already supports it).
- Any new data ingestion or RPC changes.
- Mobile-bespoke map interactions beyond what choropleth-map already does.

## Architecture

Reuses the housing map stack wholesale:

| Piece | Reused from | Economy variant |
|---|---|---|
| Choropleth renderer | `@/components/housing/choropleth-map.tsx` (d3-geo/zoom, continuous fills, `focusId`) | consumed as-is (import across trees is fine — it's an exported shared component) |
| Boundaries | `web/public/geo/states.topojson` | same file, preloaded |
| Metric registry | `@/lib/housing/highlight-metrics.ts` pattern | new `@/lib/economy/map-metrics.ts` |
| Tooltip | `suburb-tooltip.tsx` pattern | new `state-tooltip.tsx` (value, YoY, sparkline, rank) |
| Legend | `map-legend.tsx` | reused if importable, else minimal clone |
| Charts | `@/components/economy/economy-series-chart.tsx` (shipped in #307) | re-keyed per state in the dossier |

### Metric registry (`@/lib/economy/map-metrics.ts`)

Serializable entries only (no functions cross RSC — scales/formatters resolved
client-side from keys):

```ts
type EconomyMapMetricKey = "unemployment" | "participation" | "sfd" | "sfd_growth"
  | "exports" | "imports" | "trade_balance" | "diesel_sales";

interface EconomyMapMetric {
  key: EconomyMapMetricKey;
  label: string;            // "Unemployment rate"
  seriesKeyFor: never;      // NOT a function — use template string field:
  seriesKeyTemplate: string;// "labour.unemployment_rate.total.{state}.seasadj"
  format: "percent" | "aud" | "megalitres";
  palette: "continuous" | "diverging";  // diverging: sfd_growth, trade_balance
  higherIsBad?: boolean;    // unemployment true → tooltip delta colouring
  derived?: "yoy" | "balance"; // sfd_growth = yoy of sfd; trade_balance = exports − imports
  unavailableStates?: string[]; // labour: ["nt","act"] — grey fill + tooltip note
}
```

Derived metrics compute client-side from the fetched base series (no extra RPC
shapes): `sfd_growth` = YoY % of the SFD level series; `trade_balance` =
export − import totals per state.

### Data flow

- Map + tooltips are fully client-side (`dynamic(ssr:false)` wrapper module,
  same pattern as housing/economy charts). On metric switch:
  `getEconomicSeriesClient(8 state keys)` (16 for trade_balance) —
  session-cached, ≤50-key cap respected.
- Tooltip sparkline uses the last 24 observations of the hovered state's series
  (already in the fetched payload — no extra fetch on hover).
- Rank computed client-side across the 8 latest values.

### Drilldown

Click state → `focusId` zoom + dossier section renders below the map:

- State header (name, latest values chip row: unemployment vs AUS,
  share of national exports).
- Charts (existing `EconomySeriesChart`): unemployment (if exists), SFD,
  exports, imports, diesel sales — keys templated per state.
- **Top export commodities**: bar list of the state's 10 SITC product series'
  latest values (one `getEconomicSeriesClient` call with the 10 product keys),
  sorted desc, formatted $B/$M.
- Close/back → zoom out, dossier unmounts.

### URL state

`?state=wa&metric=unemployment` synced via `history.replaceState`, applied on
load by a Suspense-wrapped `useSearchParams` client component — the page stays
statically ISR-rendered (`revalidate = 3600`); NEVER `await searchParams` in
page.tsx (industry-intelligence landmine).

### Page structure (server component, unchanged ISR)

1. H1 + intro (unchanged) + headline tiles (unchanged, SSR from
   `getEconomicSeries`).
2. **EconomyMapExplorer** (client, ssr:false): metric switcher + choropleth +
   legend + tooltip + dossier.
3. National section (non-spatial): cash rate, CPI index, AUD/USD, refinery
   output, fuel imports, national diesel sales charts — kept from v1.
4. Sources footer (unchanged).

Removed from top level: the v1 per-state chart grids (unemployment NSW/VIC,
WA/QLD exports, the four SFD state charts) — they move into the dossier.

## Error handling

- Metric fetch failure → map renders with neutral fill + a retry affordance in
  the switcher row; tooltips show "data unavailable".
- States missing a series (NT/ACT labour) → grey fill, tooltip explains why.
- Dossier chart failures degrade per-chart (existing "No data available").

## Testing

- Jest: map-metrics registry (key templating, derived computations —
  YoY/balance math on fixture series), rank + sparkline slicing helpers.
- Existing economy chart/action tests must not regress.
- Playwright (manual + screenshots): hover tooltip, metric switch, state click
  → dossier + zoom, deep-link `?state=wa&metric=exports`, mobile 390px.
- `npm run build`: /economy stays ISR, no SSR crash.
