# Dashboard Improvement: Harness, Performance, Reliability, Responsiveness

**Date:** 2026-06-12
**Status:** Approved
**Scope:** `web/` only — no backend changes. Both dashboard surfaces, `/dashboards` first, homepage second (widgets are shared).

## Problem

The dashboard system (`/dashboards` widget grid + homepage Top Shorts/Treemap) is feature-rich but has no component-isolation harness, no visual regression coverage, conservative caching for daily-cadence data, ad-hoc data fetching in some widgets (duplicate requests), thin Suspense coverage, and limited mobile layout support. There is no repeatable way to prove an improvement actually improved anything.

## Decisions (made during brainstorming)

| Decision | Choice |
|---|---|
| Surface priority | Both; `/dashboards` first, shared improvements flow to homepage |
| Sequencing | Harness first (Storybook + measurement), then improvements validated against it |
| Measurement | Storybook interaction tests + local visual snapshots in CI; custom perf benchmark script. No Lighthouse-CI-in-Actions, no Speed Insights (deferred) |
| Budget | Free/OSS only — no Chromatic/Percy |
| Storybook stack | Storybook 9 + `@storybook/nextjs-vite` + Vitest addon; Playwright `toHaveScreenshot` for visual regression |

## Architecture: four gated phases

```
Phase 1: Harness          Storybook 9 + interaction/visual tests + perf baseline
Phase 2: Perf & caching   TTLs, query dedup, persistence, prefetch, bundle
Phase 3: Reliability      Suspense/error-boundary standardization, save robustness
Phase 4: Responsive + UX  Mobile grid breakpoints, widget polish, small features
```

Gate: each phase ends with interaction + visual suites green, the perf benchmark re-run, and results recorded in `docs/perf/PHASE-N.md`. Improvements must be demonstrated, not asserted.

## Phase 1 — Storybook + measurement harness

### Storybook

- Storybook 9 with `@storybook/nextjs-vite` framework, installed in `web/`, dev on port 6006.
- `.storybook/preview.tsx` decorators: ThemeProvider, fresh `QueryClientProvider` per story (retries off, `staleTime: Infinity`), jotai `Provider`, Tailwind global CSS, theme/viewport toolbar.
- Vite-vs-webpack divergences from the Next build (path aliases `@/`, SSR-unsafe `@connectrpc/connect` import chains) are resolved with explicit vite config in `.storybook/main.ts`. Surfacing these early is a feature: it exposes the SSR landmines documented in CLAUDE.md.

### Data mocking

- **Module mocking via Storybook 9 `sb.mock`** (amended 2026-06-12 during planning): widgets fetch through TanStack Query hooks that call server-action-style modules (`~/app/actions/getTopShorts`) and lib fetchers (`@/lib/stock-data-service`, `@/lib/client-api`) — there is no client-side Connect transport to inject, so the originally proposed `createRouterTransport` injection would not intercept anything and would require a needless refactor. Instead, the four data modules are mocked at module level with `sb.mock` and per-story `mocked(fn).mockResolvedValue(fixture)`. No app-code changes needed; MSW not needed.
- **Fixtures**: `web/src/@/mocks/fixtures/` — realistic ASIC short data (top shorts, treemap, time series, quotes, news) built with protobuf `create()` so types match the generated schemas, deterministic (seeded, fixed base date) so visual snapshots are stable. One canonical fixture module reused by stories, vitest, and jest.

### Stories

All 11 primary widgets + dashboard chrome:

- Widgets: top-shorts, industry-treemap, stock-chart, market-watchlist, portfolio-summary, time-series, correlation-matrix, sector-performance, watchlist, news-feed, screener.
- Chrome: widget-wrapper, save-status-indicator, widget-picker, skeleton states, error-boundary fallbacks.
- Required states per widget story file: **Default, Loading, Error, Empty, Compact, Mobile viewport**. These states are where reliability bugs live; they become permanent visual contracts.

### Tests

- **Interaction tests**: Vitest addon (`@storybook/addon-vitest`, browser mode) running play functions — sorting, period switching, config dialog edits, retry-after-error — headless in CI via `npm run test:storybook`.
- **Visual regression**: Playwright spec iterating story IDs against the built Storybook (`storybook build` + static serve), `expect(page).toHaveScreenshot()` with committed PNG baselines. Baselines are **generated in CI (Linux)** for font/AA determinism — a `--update-snapshots` workflow path or docker-local equivalent regenerates them. `npm run test:visual`.

### Perf benchmark script

`web/scripts/perf-benchmark.mjs` (Playwright):

- Targets `/` and `/dashboards` on a locally built `next start` (production build), N runs each (default 5), reporting median + p75.
- Metrics: TTFB, FCP, LCP, CLS, total hydration time, per-widget data-ready marks (`performance.mark` instrumentation added to widget-wrapper), route JS bundle sizes parsed from the build manifest.
- Output: JSON to `perf-results/<timestamp>.json` (gitignored) + `--compare <baseline.json>` mode printing a per-metric delta table with regression highlighting.
- Baseline JSON committed to `docs/perf/baseline-2026-06.json` before phase 2 starts.

### CI

One GitHub Actions job (`.github/workflows/storybook-tests.yml`), triggered on PRs touching `web/`: install, build Storybook, run interaction tests, run visual snapshots, upload diff artifacts on failure. The perf benchmark is run locally/on-demand (CI hardware too noisy for latency assertions), with results committed per phase.

## Phase 2 — Performance & caching

1. **TTL tuning** (per-query via existing `query-keys.ts` factory): short-position + treemap + top-shorts data changes once daily → `staleTime` of hours; stock quotes stay 30s; `gcTime` raised to ~30min globally so drag/remount within a session never refetches.
2. **Standardize all widgets on TanStack Query** with shared query keys. Widgets currently fetching ad hoc (direct client-action calls in effects) move to `useQuery` — identical data across widgets dedupes to one request.
3. **Cache persistence**: `@tanstack/react-query-persist-client` + localStorage persister for daily-cadence query keys → instant dashboard repaint on revisit with background revalidate (SWR behavior). Quote-frequency keys excluded from persistence.
4. **Prefetching**: hover/focus-prefetch stock details from top-shorts/watchlist rows (`queryClient.prefetchQuery`); prefetch default-dashboard widget data when the nav link to `/dashboards` is hovered.
5. **Bundle**: dynamic-import heavy chart widgets (stock-chart + Visx) so the grid shell loads first; verify with `ANALYZE=true` build before/after; confirm no three.js leakage.

Validation: perf benchmark compare vs baseline (expected: repeat-visit LCP and widget data-ready times drop materially; request count per dashboard load drops); visual suite confirms no rendering change.

## Phase 3 — Reliability

1. **Widget-wrapper standardization**: every widget renders inside `ErrorBoundary` + TanStack `QueryErrorResetBoundary` (the retry button resets queries, not just boundary state) + a layout-matched skeleton (same dimensions as loaded content — kills per-widget CLS).
2. **Stale-data degradation**: when a refetch fails or hits rate limits while cached data exists, keep rendering the stale data with a subtle "data may be stale · retry" indicator instead of replacing content with an error card. New `useStaleWhileError` helper around query state.
3. **Layout-save robustness**: save failures retry with backoff; `beforeunload` guard when dirty; a monotonically-increasing version stamp on the saved layout so a stale tab cannot clobber a newer save (last-writer-wins with version check, surface a "dashboard changed elsewhere — reload?" prompt on conflict).
4. Every failure mode introduced or touched gets a story + visual baseline.

Validation: interaction tests simulating transport failure/rate-limit fixtures; visual baselines for stale/error/conflict states.

## Phase 4 — Responsiveness & features

1. **Mobile grid**: add `sm`/`xs` breakpoints to react-grid-layout config (2 cols / 1 col, auto-stacked order derived from lg layout, drag/resize disabled on touch), bigger touch targets on widget controls.
2. **Widget compact-mode audit**: every widget reviewed in Storybook mobile viewports; fix overflow/truncation issues found.
3. **Small features**: per-widget manual refresh button + "last updated" relative timestamp (reads query `dataUpdatedAt`); keyboard-accessible grid (focus widget → arrow keys move in edit mode).

Out of scope (explicitly): new widget types, dashboard sharing, real-time streaming, Chromatic/hosted services, backend/API changes.

## Error handling summary

- Mock transports can simulate every Connect error code → stories exist for rate-limit (code 8), unavailable (14), not-found (5), timeout.
- Phase 3 standardizes the runtime handling; phase 1 makes every error state renderable and snapshot-tested on demand.

## Testing summary

| Layer | Tool | When |
|---|---|---|
| Interaction (play fns) | Vitest addon, browser mode | CI on `web/` PRs |
| Visual regression | Playwright `toHaveScreenshot` vs built SB | CI on `web/` PRs |
| Unit | Existing Jest suite (unchanged) | existing CI |
| E2E | Existing Playwright specs (unchanged) | existing flow |
| Performance | `perf-benchmark.mjs` vs committed baseline | end of each phase, local |

## Risks

- **Vite/Next divergence**: `@storybook/nextjs-vite` may need shims for `next/navigation`, fonts, and webpack-specific config. Mitigation: framework handles most Next mocks; remaining gaps fixed in `.storybook/main.ts`; worst-case fallback is the webpack `@storybook/nextjs` framework with the same stories.
- **Transport injection refactor**: making Connect transports injectable touches shared client code. Mitigation: small, behavior-preserving change validated by existing Jest + E2E suites before any story depends on it.
- **Visual-test flake**: charts with animation/randomness. Mitigation: disable animations globally in preview when `prefers-reduced-motion`/test flag set; fixtures are deterministic; mask timestamp regions if needed.
- **Screenshot platform drift**: baselines are Linux-CI-generated only; local devs compare via docker or rely on CI.
