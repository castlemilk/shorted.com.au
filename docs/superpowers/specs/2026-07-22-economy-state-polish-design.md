# Economy State Polish — Banners, Centering, New Sources & Finance Links

**Date**: 2026-07-22 · **Status**: Approved (user feedback round)
**Model directive**: fable plans/architects/reviews; Codex (`gpt-5.6-sol`, xhigh — the
user-config default) implements via `codex exec`.

## A. State banner + properly centered state (one workstream)

Replace the plain `/economy/[state]` header with a **banner** in the suburb-banner
mould (`web/src/@/components/housing/suburb-banner.tsx` + `web/scripts/housing-banners/`):

- `web/scripts/economy-banners/`: clone the housing-banners tooling (banner config,
  `generate-backgrounds-openai.mjs` direct gpt-image-1 1536×1024 path, `palette.mjs`
  LIGHT/DARK gradient ramps + `tone.mjs` — REUSE the housing modules by import if
  they're cleanly importable, else copy). 8 archetype scene prompts, one per state,
  landscape, no text, evocative of the state's economy: WA iron-ore country,
  QLD cane fields + port, NSW harbour city, VIC city laneways/skyline, SA vineyards
  + ranges, TAS wilderness coast, NT red-earth outback (no sacred sites/landmarks),
  ACT the lake + civic axis. Baked light+dark toned variants committed under
  `web/public/economy-banners/`.
- `state-banner.tsx` (server-safe presentational shell + small client piece only if
  needed): toned background, **the state silhouette rendered from
  `states.topojson`, properly centered and padded** (this IS the "nicely center the
  state" fix — the silhouette becomes the hero, replacing the locator inset), serif
  state name, breadcrumb row overlaid, theme scrim (light=source ramp,
  dark=dark-ramp — copy suburb-banner's scrim technique).
- No DB involvement (8 static states — archetype config lives in code; unlike
  suburbs, no migration/columns).
- The old locator-inset component is removed from the page (back-nav = breadcrumbs).

## B. New economic sources (3 SDMX importers — probe-truth-wins discipline)

| mode | flow | series (topic.metric.product.region) | freq |
|---|---|---|---|
| `approvals` | `BA_SA2` (state level rows; data from 2021-07) | `approvals.dwelling_units.total.{state}` (+ value series if the flow carries it cleanly) | monthly |
| `retail` | `RT` | `retail.turnover.total.{state}` (current prices, seasadj if available → adjustment segment per reality) | monthly |
| `population` | `ERP_Q` (+ `ERP_COMP_Q` if components live there) | `population.erp.total.{state}` + components: `population.natural_increase…`, `population.net_interstate_migration…`, `population.net_overseas_migration…` | quarterly |

Rules as established: probe + pin codes in dated comments, name-based columns,
fail-closed filters, UNIT_MULT verified with a magnitude cross-check (NSW ERP
~8.2M; national retail turnover ~$37B/mo), lfStates mapping, Dimensions
provenance, fixture tests, registry entries, `-mode all` inclusion. No new
migrations expected (registry constraints already cover method `api`/`download`).

## C. Government-finance detail + report links

- Extend `govfin.go` line items from the SAME workbook sheets (probe labels):
  taxation revenue, current grants and subsidies (revenue side), employee
  expenses, interest expenses → `govfin.revenue.taxation.{state}`,
  `govfin.revenue.grants.{state}`, `govfin.expenses.employees.{state}`,
  `govfin.expenses.interest.{state}` (keep the existing three aggregates
  untouched). Internal-consistency check where the workbook allows.
- **Links registry** `web/src/@/lib/economy/state-finance-links.ts`: per state —
  official budget-papers site + treasury annual/mid-year report page + the ABS GFS
  release page (static, hand-curated, serializable). Rendered as a
  "Sources & further reading" block in the State finances section with proper
  external-link affordances.

## D. Surfacing the new data

- State pages: retail turnover, dwelling approvals, population growth (ERP YoY)
  charts join the grid (icons: reuse closest existing or add to the icon set ONLY
  if a natural gap — no regeneration of the whole set); the govfin detail metrics
  render as a compact "finances breakdown" (taxation/grants/employees/interest)
  under the existing three.
- Correlation candidates: + retail turnover, dwelling approvals, population
  growth.
- Map metrics: + `retail` (aud) and `population_growth` (percent YoY, diverging)
  as `kind:"series"` registry entries. (Approvals stays off the map for now —
  chip row is at capacity.)

## Non-goals
- No re-generation of the existing 24-icon set; no OG images for state pages
  (later); no LGA/SA2-level drilldowns; no changes to shipped importers beyond
  govfin's additive line items.

## Verification bar (unchanged)
Importer fixture tests + local smokes with magnitude sanity; jest/tsc/build
gates; Playwright walk (banner renders both themes, silhouette centered, new
charts + links present); deploy → collector execute → revalidate → live verify.
