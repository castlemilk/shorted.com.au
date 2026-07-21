# Economy State Pages, Iconography, State Finances & Correlations — Design

**Date**: 2026-07-21 · **Status**: Approved (user-directed, four workstreams)
**Depends on**: #307/#309/#311/#316/#317 (all live)

## A. Per-state drill-down routes (replace SPA dossier)

- New route `web/src/app/economy/[state]/page.tsx` — server component, ISR 3600,
  `generateStaticParams` over the 8 state slugs, `notFound()` for anything else.
  Content = today's dossier (charts, Operating here, Top exports) rebuilt as a
  PAGE: SSR headline strip (state name, latest unemployment/SFD/exports chips
  from one `getEconomicSeries` call), client chart grid (existing components),
  per-state metadata/OG/JSON-LD.
- **Breadcrumbs**: `Economy › Western Australia` — check for an existing
  breadcrumb component/pattern in the repo (grep `aria-label="breadcrumb"` /
  BreadcrumbList JSON-LD, e.g. stock or scans pages); reuse it, else a small
  shared `EconomyBreadcrumbs` with schema.org BreadcrumbList JSON-LD.
- Hub `/economy` changes: map click → `router.push("/economy/<slug>")` (no
  inline dossier; StateDossier component is REMOVED from the explorer; its
  pieces move under `[state]/`); hover tooltips unchanged; legacy deep-link
  `?state=X` → client-side `router.replace("/economy/X")`; `?metric=` stays a
  hub concern. Map on the state page: a small locator inset (choropleth
  `fitToId`/`interactive=false` — the housing suburb-locator pattern) linking
  back to the hub.
- Sitemap: add the 8 state URLs. Nav unchanged (hub remains the entry).

## B. Iconography + alignment

- **Icon set** (transparent PNGs → sprite, exactly the housing-icons pipeline
  cloned to `web/scripts/economy-icons/`): ~22 icons, warm-duotone style suffix
  IDENTICAL in spirit to housing's (copy the STYLE constant):
  - Stat/chart headers: cash-rate, cpi, unemployment, participation, sfd,
    exports, imports, trade-balance, diesel/fuel, refinery, aud-usd,
    company-footprint, short-interest, state-finances.
  - Commodities (SITC): food, beverages-tobacco, crude-materials, mineral-fuels,
    oils-fats, chemicals, manufactured-goods, machinery-transport,
    misc-manufactures, other-commodities.
- **Generation path**: try the brandbrain flow-orchestrator MCP first (per
  memory: requires brandbrain#178 merged + rebuilt MCP at the
  `~/projects/.worktrees/brandbrain-flow-mcp` build; mock-run before live;
  landmines documented in `web/scripts/housing-icons/README.md` + the memory).
  If the flow path is still broken → the PROVEN direct path: a
  `generate-icons-openai.mjs` sibling (gpt-image-1 via OpenAI Images API,
  shared style suffix — the housing-banners `generate-backgrounds-openai.mjs`
  pattern). Then `pack-sprite.mjs` → `public/economy-icons/…` + typed manifest
  + `<EconomyIcon name size/>` (clone `HousingIcon`).
- Wire icons into: BigStat tiles + ChartCard headers on `/economy` and
  `/economy/[state]`, the commodities list rows, map metric chips (optional,
  only if it doesn't crowd).
- **Alignment fix**: TopExports first row misaligns — root-cause it (suspect:
  the `h4` heading + list flow vs the first row's bar starting at a different x
  because labels aren't a fixed grid; move to a CSS grid `[10rem 1fr auto]` so
  label/bar/value columns align for every row incl. the first).

## C. State government finances (new data source)

- ABS **Government Finance Statistics** via the SDMX API (probe-truth-wins, the
  established importer discipline): quarterly state+local or state general
  government — target series per state: total revenue, total expenses, net
  operating balance (and net debt if the flow carries a stock series).
  Topic `govfin`, keys like `govfin.revenue.total.{state}` (aud, quarterly),
  SourceKey `abs-government-finance`, licence CC-BY-4.0, registered in the
  registry like the other six sources; probe-pinned constants + fail-closed
  filters + Dimensions provenance; new `-mode govfin` in economy-collector +
  wired into `-mode all`.
- Surfaced: a "State finances" chart row on `/economy/[state]` (revenue vs
  expenses, net operating balance) + optional hub map metric (net operating
  balance, diverging) if the data supports it cleanly.

## D. Phase 2 correlations (from the state-exposure spec)

- **Derived market series into `economic_series`**: new `-mode markets` in
  economy-collector — computes MONTHLY per-state exposure-weighted short
  interest from the shorts DB itself (join shorts history × mv_company_state_
  exposure weights × market caps; month-end sampling): keys
  `markets.short_interest_wavg.{state}` (percent, monthly, source
  `derived-shorted-markets`, licence `derived`; registry entry marked as
  derived, exact_entity_required=false). Runs AFTER the exposure MV exists;
  idempotent upserts like every importer.
- **Dual-axis overlay** on `/economy/[state]`: "Local short interest vs …"
  chart — the shared @visx StockChart core already does dual-axis (memory);
  if reusing it is heavy, a small dedicated dual-line visx chart component
  (two y-axes, amber + slate) is acceptable. Default pairing per state:
  exports vs short interest; user-switchable second series (SFD, unemployment).
- **Correlation chips**: client-side rolling Pearson (24-month window) between
  the state's short-interest series and each of its economic series; show top
  2-3 by |r| ≥ 0.4 as chips — "WA goods exports vs local short interest:
  r = −0.62 (2y)" — ALWAYS labelled "correlation ≠ causation" in a footnote.
  Pure helpers unit-tested (pearson, alignment of mixed-frequency series by
  month; quarterly series forward-filled within quarter, documented).

## Non-goals
- No LLM insight prose (later); no commodity-level correlation drill; no
  operations-weighted rework of anything shipped.

## Ops/model directives (user)
- Planning/architecture/review: fable (coordinator + inherited reviewers).
- Implementation subagents: Opus 4.8, maximum reasoning instructed in-prompt
  (harness cannot set subagent effort directly).
- Icon generation spends real money (cents/icon) — mock/validate first where
  the flow path is used; direct path generates once, resumable.
- Prod backfill-style gated ops: none expected this round (collector deploys via
  CI; `-mode markets`/`govfin` first prod run = `gcloud run jobs execute`, flag
  at the end).

## Testing
Per established patterns: importer fixture tests (govfin, markets SQL-derived
series), pearson/alignment unit tests, route tests (params validation), jest
suites, Playwright walk (hub → state page breadcrumbs → back; icons render;
alignment fixed; overlay + chips), build ISR check, live verify post-merge.
