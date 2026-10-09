# Stock page: one route per tab, a shared layout, and a Strategy tab with levels

Date: 2026-10-09. Status: implemented by PR 1 (#701) and PR 2.

## What this is

`/shorts/[stockCode]` has grown into one page that renders everything: a
fifteen-card Overview, eight tab triggers that overflow on a phone, and six
blocks between the title and the chart (measured on BHP, 2026-10-08: a
4,750 px desktop page). Inactive tabs are client-only panels, so the
crawlable content was all pushed into Overview, which is why Overview is the
busiest part.

This design splits the page into seven routes under one shared layout, moves
the Strategy fit card into a Strategy tab with the levels the evaluator uses
drawn over price, and keeps two constraints above everything else:

- **Fast.** Switching tabs never remounts the chart or the header, prefetch
  fires on intent (hover or touch-start) rather than on viewport entry, and
  every route is on-demand ISR served from the edge cache.
- **Cheap.** A route regenerates at most once an hour and only when visited;
  a tab fetches only its own data; nothing new is warmed; old `?tab=` links
  redirect at the edge without a function running; the API gains one field
  from a row it already loads.

Out of scope: restyling cards, new data sources beyond the price-features
field, changes to `/picks`, the MCP server, or the Overview's SEO copy.

## 1. Information architecture

Seven routes under `web/src/app/shorts/[stockCode]/`:

| Route | Page content | Comes from today |
|---|---|---|
| `/shorts/BHP` (Overview) | Digest cards in the main column: **Short interest** (the weekly-report context link and a link into the tab), **Strategy strip** (one row per strategy: name linking to `/picks/<id>`, status pill, score; a footer link into `/strategy`), **Fundamentals** (the existing crawlable `FundamentalsSummary` paragraph, link into `/financials`), **Latest news** (three headlines, link into `/news`). Rail: `CompanyInfo` (About), `RelatedStocks`, the Explore link list, `CommunityOverviewTeaser`, and a signed-out "Unlock the dossier" CTA that links to `/company`. | Trimmed Overview |
| `/shorts/BHP/short-interest` | `ShortInterestHistory` + FAQ (SSR, open by default now that it has its own page; a stock ASIC reports no short position in gets one sentence saying so instead), `PeerComparisonTable` (in a section named "Peer comparison" by an `aria-label`: the table prints its own title), `StockSignals`, `StockVerdict` (flag-gated; renders nothing while the flag is off). | Overview details block, Peers tab, signals, verdict |
| `/shorts/BHP/strategy` | `RegimeBanner`, one `StrategyFitPanel` per strategy (status, score, rank, rules table with the author's rule, our evaluation, the mark and the evidence line), the `StrategyLevelsChart` island. See §4. | Strategy fit card, new charting |
| `/shorts/BHP/financials` | `FinancialsTab` content as today (Latest result, Key ratios, statements island, filings, tax card last) with `DividendHistory` inserted before the tax card (in a section named "Dividends" by an `aria-label`: the component prints its own title). | Financials tab, Dividends tab |
| `/shorts/BHP/company` | `EnrichedCompanySection`, `DirectorTradesTable` (in a section named "Directors and insiders" by an `aria-label`: the table prints its own title), `PoliticianInterestsCard`, `StockStateExposure`, `StockConnections`, `StockEvidencePanelClient` (the dossier). | Company card, Directors tab, rail cards, exposure chips, dossier |
| `/shorts/BHP/news` | The existing news page body (hero + cards + NewsArticle schema) re-homed under the layout, then `EventTimeline` (in a section named "Events" by an `aria-label`: the timeline prints its own title and renders nothing without events). | News tab, Timeline tab, existing `/news` route |
| `/shorts/BHP/community` | `CommunityTab`. The thread pages at `community/[threadId]` stay where they are and render under the same layout with Community active. | Community tab, existing thread route |

The shared layout (`layout.tsx`, a server component) renders, in order:
breadcrumbs (tab-aware label), the signed-out login slot, the profile and
stats header grid, `ShortInterestSummary`, `StockThemeChips`, the chart
section (`StockChartPanel`, client-only), and the tab bar. Nothing else.
`LatestWeeklyReportLink` moves into the Overview's Short interest digest
card rather than the layout, so the one-line context stays on the
most-visited page without repeating on every tab.

Judgement calls, recorded so they are not re-litigated:

- The dossier lives on Company because it is a signed-in surface; Overview
  keeps only the CTA.
- Peer comparison lives on Short interest because it compares short
  positions, not businesses.
- `StockVerdict` and `StockSignals` are short-interest composites, so they
  go with the short-interest history.
- Theme chips stay in the layout: they are static registry data with no
  fetch, and they are the only cross-link to `/themes` a crawler sees.
- Implementation deviations: the Strategy tab's chart sits under the regime
  banner and its segmented control is the only switch (panels link to
  `/picks/<id>` instead of switching the chart); `stock-news-tab.tsx` is
  kept because `stock-news-feed.tsx` and `related-news-rail.tsx` import it.
- Wire names as PR 1 shipped them: six `PriceFeatures` fields differ from
  §4's block (same field numbers and `has_` flags): `sma200_prior_month` for
  `sma200_1m_ago`, and `high52w`, `low52w`, `rs3m_pct`, `rs6m_pct`,
  `volume_ratio50d` for `high_52w`, `low_52w`, `rs_3m_pct`, `rs_6m_pct`,
  `volume_ratio_50d`. The web mapper uses the shipped names.

## 2. Rendering, caching and cost

### Files

```
web/src/app/shorts/[stockCode]/
  layout.tsx            server: validates the code, fetches stock + deltas, renders the chrome
  loading.tsx           overview skeleton
  page.tsx              Overview digest (ISR 3600)
  error.tsx, not-found.tsx, opengraph-image.tsx   unchanged; see the note below the tree
  short-interest/{page,loading}.tsx
  strategy/{page,loading}.tsx
  financials/{page,loading}.tsx
  company/{page,loading}.tsx
  news/{page,loading}.tsx          existing page minus its own DashboardLayout/header
  community/{page,loading}.tsx
  community/[threadId]/page.tsx    existing, minus its own DashboardLayout/header
```

`DashboardLayout` wraps once, in the layout. `StockTabs` (`stock-tabs.tsx`) is
deleted and its lazy children are imported by the pages that need them;
`stock-news-tab.tsx` stays (see the implementation deviations under Judgement
calls in §1).

`error.tsx`, `not-found.tsx` and `opengraph-image.tsx` stay in the
`[stockCode]` segment, and a boundary does not wrap the layout of its own
segment. So `error.tsx` covers the tab pages only: a failure thrown by the
layout itself (a transient stock read, which `loadStockOrFail` in
`stock-page-data.ts` throws on purpose rather than bake a degraded shell into
the cache) renders the root error page with HTTP 500 and caches nothing, while
ISR keeps serving the last good page for any stock already cached. A
`notFound()` from the layout is caught one level up, so
`app/shorts/not-found.tsx` re-exports the stock card and an unknown code still
gets it. There is no `app/shorts/error.tsx`: it would wrap the `/shorts` index
as well.

### What makes every route ISR

Every `page.tsx` exports `revalidate` (3600; news keeps 600),
`dynamicParams = true` and an empty `generateStaticParams`. The empty export
is what marks a dynamic segment as statically optimisable; without it a route
is server-rendered on every request and the `revalidate` export is inert
(this is already documented on the current page, and the current `/news`
page lacks the export, which the move corrects). No page or layout reads
`searchParams`, `cookies()` or `headers()`; the layout receives `params` only.

Data reads are the existing `unstable_cache` actions (`getStockOrNotFound`,
`getDailyShortSeries`, `getStockFundamentals`, `getStockStrategyFit`,
`getStockHeadlines`, `getStateExposureIndex`, enrichment and news), each
with its current TTL and `stock-page:*` tags. A layout render reads the stock
and the daily series; each page reads only what it shows. Today's page awaits
six reads before it can render; after the split the Overview awaits three
and no tab awaits more than two.

### Build gate: route kinds

A new check, `web/scripts/route-kinds.mjs`, runs after `next build` beside
`bundle:budget` and fails the build if any route under
`/shorts/[stockCode]` is missing from `dynamicRoutes` in
`.next/prerender-manifest.json` (a route rendered dynamically never appears
there). It protects the cost model; a warning would be ignored.

### Navigation

`StockTabNav` (client) renders seven `<Link prefetch={false}>` anchors with
`aria-current="page"` on the active one, derived from `usePathname()`. It
calls `router.prefetch(href)` on `pointerenter`, `touchstart` and `focus`,
once per href per mount. The list scrolls horizontally on narrow screens and
scrolls the active trigger into view on mount, as the current tab list does.
Each tab segment has a `loading.tsx` so a cold tap shows the tab's skeleton
inside the chrome while the segment loads. Next 14.2's client router cache
keeps visited static segments for five minutes, so returning to a tab is
instant with no request.

### Redirects for old links

`next.config.mjs` `redirects()` gains one entry per legacy value that names
another tab, matched with `has: [{ type: "query", key: "tab", value }]` on
`source: "/shorts/:code"`, `permanent: true`:

| `?tab=` | Destination |
|---|---|
| `news`, `timeline` | `/shorts/:code/news` |
| `financials`, `dividends` | `/shorts/:code/financials` |
| `directors` | `/shorts/:code/company` |
| `peers` | `/shorts/:code/short-interest` |
| `community` | `/shorts/:code/community` |

`?tab=overview` has no entry: its destination would be its own source, and
Next forwards the request's query string on a redirect, so the redirect would
send `/shorts/:code?tab=overview` back to itself; the value renders the
Overview like any other unmapped value, as the old reader treated it.

Vercel serves these from its routing layer; no function runs. The post-mount
`?tab=` reader in the current `StockTabs` is deleted with it.

### Revalidation after a sync

The sync job's ping is unchanged (`paths` include `/shorts/[stockCode]`).
The `/api/revalidate` handler currently calls `revalidatePath(path, "page")`
for any path containing `[`; for `/shorts/[stockCode]` it calls
`revalidatePath("/shorts/[stockCode]", "layout")` instead, which expires the
layout and every page beneath it for every code in one call. A unit test in
`web/src/app/api/revalidate/__tests__/route.test.ts` pins the type.

### What does not change

- `/api/pages/warm-cache` keeps warming `/shorts/<code>` (Overview) only.
- `isr-pages.json`, `isr-shell-pages.json`, `vercel.json` and its crons are
  untouched; the existing config tests stay green.
- The edge worker, the rate-limit classes and the Connect rewrites are
  untouched; the chart still fetches through the same proxied RPCs.

### Cost model

| Line | Effect |
|---|---|
| Function invocations | At most one per hour per visited `(stock, tab)`; unvisited tabs never generate. Overview traffic dominates and its regeneration gets cheaper. |
| Backend calls per regeneration | Down: a tab reads one or two cached actions instead of six. |
| ISR cache entries | Up to seven per stock, on demand. |
| Edge requests | Tab switches add one RSC request per cold tab per session, nothing on return visits inside the router cache window. |
| First-load JS | Overview sheds the tab bundles; each tab is its own route under the per-route budget (`bundle-budget.mjs`, default 300 kB, Overview 330 kB; set per-tab guards from the measured values). |

## 3. SEO

Each page exports `generateMetadata`: its own title and description, a
self-referencing canonical, `en-AU`/`en`/`x-default` alternates, Open Graph
and Twitter cards in the shape the news page already uses. Titles:

| Route | Title |
|---|---|
| Overview | unchanged |
| short-interest | `{CODE} Short Interest History & FAQ | {Company}` |
| strategy | `{CODE} Strategy Fit: Breakout, CANSLIM & Trend Rules | {Company}` |
| financials | `{CODE} Financials: Results, Ratios & Statements | {Company}` |
| company | `{CODE} Company Profile: Directors, Insiders & Operations | {Company}` |
| news | unchanged |
| community | `{CODE} Community Discussion | {Company}` |

Robots: every tab inherits the stock's `isStockIndexable` gate the way the
news page does (fail open on a transient read). Strategy is additionally
`noindex, follow` when the fit response reports `in_universe = false`.
Community is `noindex, follow` (its list is client-rendered; the thread pages
beneath it keep their own indexability).

Sitemap: `buildShortsSitemap` already emits `/shorts/<code>/news` for the
qualified code list; it adds `/short-interest`, `/financials` and `/company`
for the same list. Strategy stays out of the sitemap so the many "not a
candidate" pages never read as thin content; it is discovered through the
Overview strip, the tab bar and `/picks`.

Breadcrumb structured data is emitted per page with the tab as the last
item. The `opengraph-image.tsx` at the stock segment is expected to apply to
the tabs; the Playwright check reads `og:image` on a tab URL to confirm it
rather than assuming it.

## 4. The Strategy tab

### API: `PriceFeatures` on the fit response

`proto/shortedapi/shorts/v1alpha1/strategies.proto` adds:

```protobuf
message PriceFeatures {
  string as_of = 1;                 // YYYY-MM-DD of the last close
  double close = 2;
  double sma50 = 3;          bool has_sma50 = 4;
  double sma150 = 5;         bool has_sma150 = 6;
  double sma200 = 7;         bool has_sma200 = 8;
  double sma200_1m_ago = 9;  bool has_sma200_1m_ago = 10;
  double high_52w = 11;      bool has_high_52w = 12;
  double low_52w = 13;       bool has_low_52w = 14;
  double base_high = 15;     bool has_base_high = 16;   // the pivot
  double base_low = 17;      bool has_base_low = 18;
  double base_depth_pct = 19; bool has_base_depth_pct = 20;
  int32 base_length_days = 21; bool has_base_length_days = 22;
  bool breakout_recent = 23;
  string breakout_date = 24;        // YYYY-MM-DD; empty when none
  double rs_3m_pct = 25;     bool has_rs_3m_pct = 26;
  double rs_6m_pct = 27;     bool has_rs_6m_pct = 28;
  double volume_ratio_50d = 29; bool has_volume_ratio_50d = 30;
  int32 sessions_available = 31;
}

message GetStockStrategyFitResponse {
  // ...existing fields 1-5...
  PriceFeatures price_features = 6;  // set only when in_universe
}
```

Every nullable number travels with a `has_` flag; an absent value is never
coalesced to zero (the house rule from `docs/plans/stock-picker.md`). Adding
a field is non-breaking; the rpc is already `VISIBILITY_PUBLIC` on both the
domain service and the legacy service. `buf generate` outputs are committed
in full, including the Java SDK.

Go: `priceFeaturesProto(c *strategies.Candidate) *shortsv1alpha1.PriceFeatures`
in `services/shorts/internal/services/shorts/strategy_fit.go`, called after
`resp.InUniverse = true` with `u.candidates[u.index[code]]`. Pure mapping,
no query, no cache change. Tests in `strategy_fit_test.go`: nil pointers map
to `has_ = false` and zero values, dates format as ISO days, a stock outside
the universe gets no message. The MCP server exposes no fit tool, so its
catalog and `tools/list` size are unaffected.

Web: `getStockStrategyFit.ts` maps the message to
`StockStrategyFit.priceFeatures: StockPriceFeatures | null` (camelCase,
`null` wherever `has_` is false, `breakoutDate: string | null`). Its
`unstable_cache` key moves from `v1` to `v2` so no hour-old entry is served
without the field.

### Page

Server-rendered from `getStockStrategyFit` (1 h cache) and `getStrategies`
(rule text, cached):

1. `RegimeBanner` from `components/picks`.
2. One `StrategyFitPanel` per strategy, ordered triggered → setup → watch →
   none: the name linking to `/picks/<id>` (`prefetch={false}`), the status
   pill or "Not a candidate", score, "rank N of M", then a rules table with
   columns Rule (title), The rule (author's `rule_text`), How we test it
   (`evaluation`), Result (pass/fail/unknown mark; core rules flagged) and
   Evidence (`RuleResult.detail`). Strategy description paragraphs are not
   repeated here.
3. The `StrategyLevelsChart` island (below).
4. "Prices to {as_of}. Mechanical readings of published rules, not
   recommendations. Not financial advice." with the disclaimer link, as the
   current card says.

A stock outside the universe renders the banner, a sentence explaining that
the picker reads a stock only with at least 60 sessions of price history in
the last 400 days (the admission rule of `mv_price_features`, migration
000130), links to `/picks`, and no chart; the page is `noindex, follow`.

The Overview strip is a new `StrategyFitStrip`: one row per strategy with
the status pill and score, each strategy name linking to `/picks/<id>` and
the strip's footer linking into `/shorts/<code>/strategy`, rendered only when
the fit resolved (the same guard as today's card).

### Levels chart

`components/strategy/strategy-levels-chart.tsx`, a client component loaded
with `ssr: false`. It calls `useStockChartData(code, period)` with the same
query keys the layout's chart uses, so TanStack Query serves it from cache
and no second request is made. It renders the shared `StockChart` with the
price series, and for the selected strategy adds:

| Strategy | Levels drawn |
|---|---|
| `zanger-breakout` | base band (`base_low`..`base_high`) over the last `base_length_days` sessions, pivot line labelled with its price, breakout session marker, 50-day volume ratio in the caption |
| `canslim` | 52-week high line, pivot and base band, RS 3 m / 6 m in the caption |
| `minervini-trend-template` | SMA 50 / 150 / 200 levels at their current values, the 52-week low line, SMA 200 one month ago as a dashed level |
| `crowded-short-breakout` | pivot and base band, the short-interest series on the right axis; the rule's threshold is quoted from its evidence line in the caption, not drawn, because the API reports the value tested and not the threshold |
| `quality-compounders` | SMA 200 level |

Moving-average lines through time are drawn only when the loaded window
gives every plotted point a full lookback; otherwise only the current-value
level is drawn. No partial averages, ever. The chart defaults to the
strategy with the strongest status (triggered > setup > watch > none,
ties by score) and a segmented control switches the level set; selecting a
panel's heading switches it too. Touch behaviour is the shared chart's.

`StockChart` gains three optional props to make this possible, each a pure
layout concern with unit tests on the computed geometry:

```ts
levels?:  { axis: "left" | "right"; value: number; label: string; color: string; dash?: string; from?: number; to?: number }[];
bands?:   { axis: "left" | "right"; low: number; high: number; from: number; to: number; color: string; label?: string }[];
markers?: { t: number; label: string; color: string }[];
```

The tooltip ignores them; `from`/`to` bound a level or band to a time span
so the pivot line spans the base rather than the whole chart.

### Degradation

If `priceFeatures` is `null` (the field not yet deployed, or the stock out of
the universe) the panels still render and the chart draws price only with a
one-line note. Neither PR depends on the other's deploy order.

## 5. Testing

Go:
- `strategy_fit_test.go`: the mapping cases above; existing strategy and MCP
  tests unchanged and green.
- `buf lint` and `buf breaking` against `main` (additive change).

Web unit (Jest):
- `StockTabNav`: active state from the pathname; `router.prefetch` fires once
  per href on hover/touch/focus and never on mount.
- `next.config.mjs` redirects: a test enumerates the `?tab=` map above
  (shape: `scripts/tests/*.test.mjs`, like the existing config tests).
- Per-page `generateMetadata`: titles, canonicals, the inherited noindex
  gate, Strategy's `in_universe` gate, Community's noindex.
- `getStockStrategyFit` mapping: `has_` false → `null`, cache key `v2`.
- `StockChart` levels/bands/markers geometry; the full-lookback rule for
  SMA lines.
- `StrategyLevelsChart` picks the default strategy by status then score.
- `/api/revalidate`: the stock pattern is revalidated with type `layout`.
- The stock page's existing `__tests__` (`page-all-imports`,
  `page-component-imports`, `page-old-api`, `page-runtime`, `page-ssr`,
  `page`, `short-interest-figures`) are re-pointed at `layout.tsx` and the
  Overview page; the import-boundary tests extend to every new page file.

Build gates:
- `route-kinds.mjs`: every stock route present in the prerender manifest.
- `bundle:budget` with per-tab guards; `bundle:baseline` refreshed in the
  same PR.
- `perf:bench` before and after on `/shorts/BHP` and `/shorts/BHP/strategy`.

Playwright (`web/e2e`):
- Desktop and 390 px: click every tab; the URL changes; the chart's SVG is
  the same DOM node throughout; the active tab is visible in the tab bar;
  browser back returns to the previous tab.
- `GET /shorts/BHP?tab=financials` answers 308 to `/shorts/BHP/financials`.
- `og:image` is present on a tab URL.
- The Strategy page for a currently triggered stock shows the levels chart
  with at least one level and one panel marked triggered.

## 6. Rollout

1. **PR 1, backend first**: proto, Go mapping, generated code, tests. The
   current web ignores the field.
2. **PR 2, web**: everything in §1–§5. Merge after PR 1 is live so the
   levels appear on day one; the degradation path makes the order a
   preference, not a dependency. "Live" is not enough on its own: the web
   decodes the response with the generated client in `web/src/gen`, which
   gains `PriceFeatures` only from PR 1's `buf generate` output. Take `main`
   into PR 2 after PR 1 merges, or the levels stay on the price-only note even
   with the API serving the field.
3. After the web deploy: call `/api/revalidate` with
   `path=/shorts/[stockCode]` once (it now expires the layout tree), confirm
   a second request to a tab returns `x-vercel-cache: HIT`, check the
   redirect and the 390 px tab bar on prod, and read the levels chart for a
   stock the picker has triggered. Compare Vercel function invocations and
   ISR writes against the prior week after seven days.

Deploys currently run through Cuttlefish and the local release recipe, not
the disabled GitHub `terraform-deploy` workflow; the PR descriptions say so.

## 7. Risks and how they are closed

| Risk | Closure |
|---|---|
| A tab route ends up dynamic (SSR per request) | `route-kinds.mjs` fails the build. |
| Reading `searchParams` anywhere in the tree bails the route to dynamic | No page reads it; redirects replace the `?tab=` reader. `web/src/app/shorts/__tests__/isr-source-safety.test.ts` fails on a `searchParams`, `cookies()` or `headers()` read in the segment and on a lost ISR export; the e2e check that a second request to each tab answers `x-nextjs-cache: HIT` catches a read the scan cannot see. The route-kinds gate catches a lost `generateStaticParams` export, `revalidate = 0` and `force-dynamic`, not a dynamic-API read under an empty `generateStaticParams`. |
| `generateStaticParams` on child pages does not inherit from the layout | Each page exports its own empty function; the gate verifies. |
| A `@connectrpc/connect` import reaches a server file and breaks SSR | The pages import client widgets through `next/dynamic` with `ssr: false` exactly as the current page does; `page-all-imports` style tests extend to each page. |
| Hover prefetch fires seven regenerations on a page view | Prefetch is intent-driven and once per href; the Playwright run asserts no tab request before interaction. |
| The thread page double-wraps the dashboard chrome | Its own `DashboardLayout` and header are removed; a Playwright check loads one thread. |
| Level lines mislead when the window is short | Full-lookback rule for SMA lines; levels carry their `as_of` in the caption. |
