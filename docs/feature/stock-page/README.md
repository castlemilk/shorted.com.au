# Stock page: one route per tab

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

## Stock page (one route per tab)

`/shorts/[stockCode]` is a shared server `layout.tsx` (breadcrumbs, then
`StockHeader`, then the sticky `StockTabNav`) with seven ISR pages beneath it
(3600 s; `/news` 600 s): `/` (Overview digest), `/short-interest`,
`/strategy`, `/financials`, `/company`, `/news` and `/community`. The thread
pages at `community/[threadId]` render under the same layout but stay
per-request. The tab list lives ONCE in
`web/src/@/lib/stocks/stock-tabs.ts`; tab metadata goes through
`lib/seo/stock-tab-metadata.ts` (`stockTabMetadata` for the five newer tabs,
which inherit `isStockIndexable`; Strategy adds noindex when `in_universe` is
false, Short interest adds it (`noindexWhen`) when the stock read resolved and
reports no short position, and Community is always noindex; Overview and News
keep their own titles and share `stockOgImage`). An indexable page sets NO
`robots` key: Next merges metadata with `for (key in source)` (checked on 15.5.28,
`lib/metadata/resolve-metadata.js`), so `robots: undefined` would replace the root
layout's googleBot snippet and image-preview directives with nothing.
Specs: `docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md`
(one route per tab) and
`docs/superpowers/specs/2026-10-10-stock-page-visible-first-design.md`, which
amends it in three places: the layout chrome above the tab bar, the chart in
the layout and the theme chips in the layout. Where the two differ, the second
governs.

### Chrome, charts and the readout (2026-10-10)

Production (BHP, signed out, 2026-10-10) put the tab bar 1258px down on a
1280x900 desktop and 1774px down on a 390x844 phone, beneath a sign-in banner,
two cards, a summary, theme chips and a 420px chart. The layout now holds three
blocks, each followed by 16px (`mb-4`): the breadcrumbs, `StockHeader` and
`StockTabNav`. It loads no chart. `web/e2e/stock-tabs.spec.ts` pins the goals
(no workflow runs it): the tab bar at most 340px down on the phone and 280px on
the desktop, the tab's own content at most 400px and 340px down, the Overview
chart whole inside the phone's first screen, and layout shift under 0.02 on
first load and on a tab switch.

`StockHeader` is a server component: the logo (its only client child, read
inside `Suspense` in a fixed box so it cannot shift the header), the code, the
industry badge, the name, and the short-interest readout (short %, the 30-day
change in percentage points, reported shorts, shares on issue and the "as of"
date). The readout is the page's one lit surface (`shadow-terminal-inset`,
DESIGN.md's One Bloom Rule). The 30-day change is coloured by its rounded
direction (2026-10-19, at the owner's request): a rise in short interest is
signal red, a fall green (as the industry panel colours it), no change the
foreground; a fall takes U+2212. It is the only coloured figure in the header.
A missing value is left out, never a dash or "undefined".

`StockTabNav` is sticky at `top-16`, under the site header's `h-16` row, and
bleeds to `<main>`'s edges with `-mx-8`; the scrolling list inside carries the
`px-8`, so on a phone the tabs scroll to the screen edge. Its links pass
`scroll={false}`: Next's own scroll on a tab switch (`ScrollAndFocusHandler`,
`client/components/layout-router.js`, checked on 15.5.28) does nothing when the
new tab's first node is already in view, which leaves its first ~110px under
the two bars, and jumps to the top when it is above. So a click sets a flag,
and when the active tab changes a layout effect scrolls to `dockY` (the
sentinel's document top minus the bar's sticky top) only when the page is
scrolled past it. A bar that was not docked does not move, and back and
forward keep the scroll the browser restores. Intent prefetch is unchanged. A
hash target in a tab page takes `scroll-mt-[124px]` (64 header + 44 bar + 16).

Two more things live in `StockTabNav`. The list fades the edge that can scroll
(a 40px `mask-image`, driven by `data-scroll-start` / `data-scroll-end`, which
its scroll event and a ResizeObserver keep): the scrollbar is hidden and at 360
and 375px nothing of the fourth tab peeks out, so the fade is the only cue the
row scrolls, and a bar that fits (a desktop) draws none. And a document
`focusin` listener keeps keyboard focus out from under the docked bar (WCAG 2.2
SC 2.4.11): a `:focus-visible` control outside the bar, the site header, any
dialog and any `position: fixed` ancestor, with its top above the bar's bottom
+ 8px and its bottom on screen, is scrolled to sit 8px under the bar. It is not
CSS `scroll-padding-top`, which makes Tab across the docked tab links scroll the
page to the top; `stock-tabs.spec.ts` holds both.

**A price chart lives only on the tab it is about.** `StockChartPanel` is the
first block of the Overview (combined view, `prefsKey` `"<CODE>:overview"`) and
of Short interest (the short view, or combined for a stock with no short
history, `"<CODE>:short-interest"`), always client-only (`ssr: false`).
Strategy keeps its own levels chart; Financials, Company, News and Community
have none. The visitor's settings survive a tab switch in `chart-prefs.ts`, a
client-only module store: the period is kept per stock and shared by both chart
tabs, the view, indicators and divergence per `prefsKey`. It lives until a reload
and writes nothing to storage; a panel with no `prefsKey` (the dashboard, the
stories) is plain local state.

**Nor does a tab without a chart load one.** Next builds each tab's client
reference manifest from the Overview page's (the page above the other six; checked
on 15.5.28, `build/webpack/plugins/flight-manifest-plugin.js`), and
maps each client module to the whole first-load chunk list of the page that
holds it, so a tab that resolves a shared module (`next/link`) through the
Overview's mapping downloads all of the Overview's first-load chunks. A
On 14.2, a `nextDynamic` in a server page was bundled into that list: Financials
and Community downloaded the Overview's chart that way (227 KiB of JS for BHP). A
route group does not stop it (Next strips the group from the manifest's group
name). So the Overview and Short interest load the panel through
`StockChartPanelLazy` (`components/charts/stock-chart-panel-lazy.tsx`), and
Strategy loads its levels chart through
`components/strategy/strategy-levels-chart-loader.tsx`. Each is a `"use client"`
module whose `next/dynamic` is a real `import()`: the chart is a chunk of its
own, in no list another tab inherits. A server page may not call
`next/dynamic` with `ssr: false` (Next 15 refuses it), so the charts come
through these client modules. The panel's module starts that download as it
runs, so the chart lands when it did as a first-load chunk, but only when the
path is the Overview or Short interest: a tab that loads the Overview's page
chunk runs every Overview client module, and the unguarded `import()` put the
chart back on Financials and Community. `web/scripts/stock-chart-chunks.mjs`
(`npm run routes:charts` after `next build`; `task test:bundle` and
`perf-budget.yml` run it) fails when any stock tab's client manifest maps a
module to a chunk carrying the chart's code (`data-chart-capture`), when a chart
route's manifest stops mapping its loader, or when the loader's import in
`.next/react-loadable-manifest.json` stops listing that chunk. It cannot see an
`import()` started at runtime; the download check in
`web/e2e/stock-tabs.spec.ts` can (no workflow runs it).

The chart box is sized by CSS, `h-[360px] sm:h-[420px]`
(`CHART_BOX_HEIGHT_CLASS`), and `StockChart` takes its height from its parent
when it is given no `height`. One `StockChartPanelSkeleton` serves as the
dynamic import's `loading` fallback and as the first block of both chart tabs'
`loading.tsx`, so the placeholder and the chart are the same size. The controls
stack below `xl`: one 40px row above the plot (the view control and the embed
button), then the period and the toggles beneath it. From `xl` they sit in one
row, which needs about 975px of panel (at a 1280px window beside the signed-in
sidebar the toggles row scrolls about 15px, see **Indicators** below); every
narrower window gets the stacked form.

`StockChart` takes `readout?: "strip" | "tooltip"`, default `"strip"`. The
strip is a fixed-height band above the plot, so nothing covers the plot: 28px
from 640px wide, and below that `8 + 18 x (1 + series)` (44px for one series,
62px for two). Its height depends on the chart's width and its series count
only, never on the state or the values. The count is the series it has, or the
`readoutReserveSeries` it is told to expect if that is more: the Combined panel and
the embed's Combined view pass 2, so on a phone the short series landing after the
price finds its row held and moves nothing (the rows of series still to come are drawn empty). It
reads `latest` by default, then `hover`, `pinned` or `measure`
(`data-readout-state`). A persistent `sr-only` `role="status"` announces a pin
and its release, never a scrub, and the arrow keys step a reading from the pin,
or else the point under the pointer (Home and End jump, Escape releases).
`"tooltip"` is the floating card: the two dashboard widgets pass it, so does
the embed when its chart is under 260px tall, and the strip falls back to it
when the plot would be under 160px (`READOUT_MIN_PLOT`). Red and green mark the
price series' direction only; the short series reads in the foreground, in
percentage points, in the header's 30-day change format ("▲ +0.62 pp",
"▼ −0.31 pp", "– 0.00 pp"; the header colours its figure, the chart does not). Short interest prints to two decimals everywhere
the chart prints it (`shortFmt`). A reading is dated by the data point it
shows, never by the pointer's instant: the strip, the card, the measure's
headline and the pin's announcement all name the session, not a weekend the
cursor happens to be over. The svg clips whatever is drawn outside it, so the
margins follow the labels (`axis-margin.ts`): a side with an axis gets the room
of the widest label it prints, and never less than 48px, which holds six
characters at 10px mono after a tick and a gap ("$99.99", or short interest as
"12.00%"). A price of $100 or more is seven characters and gets 53px. The labels
are estimated from the data and the axis' format (the zoom, the normalised view,
the same ticks the axis draws) and never measured, because the margin sets the
plot's width. A zoom can widen a side but never narrows it: a side keeps the
widest that the whole series or any zoom since has needed, until the data, the
view or an axis changes, so a zoom whose widest label is a character shorter
does not move the plot 5px under the pointer. With no right axis the right keeps 28px (the time axis' last label
hangs half its width past the plot), and a compact chart its 32px and 12px.

Volume (the Price and Combined views, wider than 500px) is a grey bar per
session in the bottom 28% of the plot on a scale of its own, all ONE path
(`volume-bars.ts`). It is read, never left unlabelled: the strip's `Vol` entry
follows the series on one row and sits in the headline row on a phone (it adds
no row, so the strip's height rule stands), the card has a Volume row, the bar
under a reading is highlighted, and a measure leaves it out. A reading takes
volume from the RAW points on screen, never the decimated bars. The brush band
draws the one series spanning the most time (`brushOverviewPoints`): merged, a
$4 price and a 9% short position alternated day by day into a grey comb.

The sign-in banner renders on the Overview only, after the About card, as one
44px line. Under `html.anon`, `critical-css.ts` reserves its `.login-slot` at
46px (the line plus the wrapper's 2px border) with a 1rem margin, so the slot
is the same height before and after the banner mounts. The site header's Sign
in button stays on every page. The Strategy tab's `RegimeBanner` takes
`compact` below `sm` (the pill, the as-of date and the verdict, without the
four readouts and the ladder); on `/strategies` it is unchanged.

**Indicators.** The toggles row holds an **Indicators** trigger in every view:
an icon below `sm`, the word from `sm`, and a count badge when any are on. From
`xl` the one row needs about
975px (at a 1280px window beside the signed-in sidebar the toggles row scrolls
about 15px, as it was built to). The menu is a panel inside the chart box, CSS
positioned (`indicator-menu.tsx`): the base set for everyone, the advanced set
(SMA 200, Bollinger Bands, RSI, MACD, the 90-day short average) behind a session.
An overlay draws on its series' own axis and widens the value axis
(`indicatorsInDomain`); the legend sits inside the plot's top left
(`indicatorLegend`), its width estimated from its labels at `AXIS_CHAR_PX`
(6.1px a character) and never measured, as the axis labels are. At most one panel shows, under the time axis (it used to
overlap the labels' bottom 8px). An indicator whose lookback is more than a tenth of the window on screen (sessions for price, calendar days for short interest) fetches the first longer period that covers it, once, through that period's own query keys (`planWarmup`): 1M with SMA 50 fetches 6M, 2Y with SMA 200 fetches MAX, and SMA 20 at 1Y fetches nothing. Short interest never warms up from MAX, which is weekly buckets. A longer history this chart has already loaded, its own visible series included, serves the indicator when it covers the lookback, and nothing is fetched (`useIndicatorHistory`). That history lasts only while the chart stays mounted: a remount (a stock-page tab switch, or leaving a stock and returning to it in the Activity) asks for the longer history again, and TanStack's cache may answer from memory. Each indicator waits for its own history
(`readyIndicators` with `history.waiting`), and a waiting panel is drawn empty
(`buildChartView` `pending`), so the plot keeps its height. The menu follows the
view the chart is drawn as (`resolveChartView`: a Combined chart with one series
is that series' view), and a selected indicator the series is too short for says
so ("Not enough history") and is not counted in the trigger. The StockChartEmbed
follows the same rules. `ChatSidebar` and both environment banners read
`isChromelessRoute`, as the header does.

### Landmines

- **Every tab page exports `revalidate`, `dynamicParams = true` and an EMPTY
  `generateStaticParams`**, and nothing under the segment reads
  `searchParams`, `cookies()`, `headers()`, `auth()` or a no-store fetch. Lose
  any of that and the route renders on every request. Three guards, each
  blind to something the others see:
  - `web/scripts/route-kinds.mjs` (`npm run routes:kinds` after `next build`;
    `task test:bundle` and `perf-budget.yml` run it) fails when a stock route
    is missing from `dynamicRoutes` in `.next/prerender-manifest.json`. It
    catches a lost `generateStaticParams`, `revalidate = 0` and
    `dynamic = "force-dynamic"`. It does NOT catch a `cookies()`, `headers()`
    or `searchParams` read under an empty `generateStaticParams`: nothing
    renders at build time, so the route stays listed and fails at request
    time.
  - `web/src/app/shorts/__tests__/isr-source-safety.test.ts` (Jest) covers
    that half: it scans every non-test file in the segment for those reads and
    requires the trio in each tab page (the thread page is exempt; it is
    per-request by design). It reads the segment's own files only. A read
    inside a component imported from elsewhere is caught only by the e2e
    check that a second request to each tab answers `x-nextjs-cache: HIT`
    (`web/e2e/stock-tabs.spec.ts`; no workflow runs it) and the post-deploy
    HIT check.
  - `web/src/app/shorts/__tests__/ssr-import-safety.test.ts` (Jest) walks
    static imports from the layout, the data loader and every tab page, and
    fails when a `"use client"` module on the way reaches `@connectrpc` (the
    SSR failure under Known Issues). Client widgets load through a `"use client"`
    loader (`*-loader.tsx`) that holds `nextDynamic(() => import(...), { ssr: false })`:
    the page imports the loader, and the loader is listed in the test's
    `CONNECT_ISLANDS`. A server module never calls `next/dynamic` with
    `ssr: false`, and a test checks that across `src`. The two chart tabs share
    one loader, `stock-chart-panel-lazy.tsx`, and a test checks that no tab's
    loader is reachable from another tab. The walk's allowlist, `KNOWN_CLIENT_CONNECT`, holds only
    the pre-existing `company-info-with-retry` fallback (on the Overview) and
    can only shrink. The layout's two twins, `company-profile-with-retry` and
    `company-stats-with-retry`, were deleted with the cards they served, and
    `StockHeader` is a server component with no twin, so the layout has no
    entry. An allowlist entry is a risk, not a fix: `CompanyTaxCard` was on it,
    and the Financials route then answered 500 for every stock in a production
    build with every Jest test green. It is an island now.
- **A transient stock read fails the render; it never degrades it.** The
  layout, the Overview and the Short interest, Strategy, Financials and Company
  pages read the stock through `loadStockOrFail(code)`
  (`web/src/app/shorts/[stockCode]/stock-page-data.ts`): an unknown code is a
  404, a transient `undefined` throws, so a degraded shell is never baked into
  the cache for an hour. The News page applies the same rule to its own read: a
  failed `getStockNews` (undefined) throws, while an empty feed (a response
  with no articles) keeps its "No news found" copy. `[stockCode]/error.tsx`
  covers the tab pages, not the layout (a boundary sits inside its own
  layout): a throw from the layout renders the root error page with HTTP 500
  and caches nothing. A page that is merely stale keeps being served while it
  regenerates, so a failed regeneration leaves the last good one in place; but
  the sync's layout revalidation EXPIRES every entry, so the next regeneration
  is blocking and a transient read can show that error page for a stock that
  was cached too, until a retry succeeds. A
  `notFound()` from the layout is caught one level up, so
  `web/src/app/shorts/not-found.tsx` re-exports the stock 404 card. Do not add
  `app/shorts/error.tsx`: it would wrap the `/shorts` index too.
- **Tab links prefetch on intent only** (`StockTabNav`: pointer enter, touch
  start, focus; once per href). Never switch them to viewport prefetch: seven
  ISR regenerations per page view. Every other link into a tab follows suit:
  build it with `stockTabHref(code, tab)` and `prefetch={false}` (the stock
  breadcrumbs pass `prefetch={false}` to the shared `Breadcrumbs`, whose
  default is unchanged for the other pages; the News links in `take-related.tsx`
  and `stock-news-tab.tsx` do the same).
- **A missing community thread answers 200, not 404.**
  `community/[threadId]/page.tsx` calls `notFound()` for an unknown or deleted
  thread, but the segment's `loading.tsx` streams the layout before the page
  runs, so the status line is already sent: the response is a 200 carrying the
  not-found card and Next's `noindex` meta. A crawler reads a soft 404, and the
  `noindex` is what takes a deleted, once-indexed thread out of the index. The
  ISR tab pages are unaffected (static generation renders to completion before
  anything is cached). A `generateMetadata` that noindexes a missing thread is
  the alternative to accepting this.
- **Old `?tab=` links are edge redirects.** The map and the redirect builder
  live in `web/src/config/stock-tab-redirects.mjs` (dependency-free, so the
  repo-hygiene job can import it; there is no JSON file) and are spread into
  `redirects()` in `next.config.mjs`;
  `scripts/tests/stock-tab-redirects.test.mjs` pins both. `?tab=overview` is
  deliberately NOT redirected: Next forwards the query string, so a same-path
  redirect would loop on itself. It renders the Overview, like any other
  unmapped value. No client-side reader exists any more. Under `next start` the
  redirect's `Location` keeps the stale `?tab=`, so the e2e test compares its
  pathname.
- **The sync's `/shorts/[stockCode]` path is revalidated with type `layout`**
  (`/api/revalidate`), which expires every tab for every code in one call. An
  expired page regenerates only when it is next visited.
- **A chart is no longer one DOM node across the tabs.** Each chart tab mounts
  its own, so a return to one within 30 minutes (the chart queries'
  `DAILY_STALE`, and the client's `gcTime`) re-renders from the TanStack cache
  with no request, and its settings come back from `chart-prefs.ts`. The
  Strategy levels chart calls `useStockChartData(code, "1y")`, the default
  period and query key of those charts, so its 1y queries are shared with the
  Overview chart only after a visit to a chart tab. A visitor who lands on
  Strategy directly pays one extra request; the layout's chart used to fetch
  the prices first.
- **`PriceFeatures` on `GetStockStrategyFit`** carries `has_` flags; the web
  maps absent to `null` (`StockPriceFeatures`), never zero, and the fit's
  `unstable_cache` key is `v3` so no entry without the signal fields is read back
  (the picks and strategies-list keys are `v3` too).
  Level sets are pure (`components/strategy/strategy-levels.ts`); after a
  breakout the base band and its ranged pivot end at the BREAKOUT session, not
  the last close, because the features are as at that session ("The base is
  anchored" above); a moving-average line is drawn only with a full lookback. A
  stock outside the
  picker universe (under 60 sessions in the last 400 days, migration 000130)
  gets an explanation and `noindex`, never a chart with empty levels.
- `stock-news-tab.tsx` stays (`stock-news-feed.tsx` and `related-news-rail.tsx`
  import its hooks); the old `stock-tabs.tsx` shell is gone.
- **The Company tab draws its director trades on the server.** The page
  starts `getDirectorTrades(code, 20)` with its other reads and awaits it where
  the section renders (the ISR-safe fetch the insider-trading page uses; it
  resolves `undefined` on any failure, and a rejection is taken the same way),
  then draws `DirectorTradesView` from it: the table, or the "No director trades
  found" card. That module (`components/company/director-trades-view.tsx`) has
  no `"use client"`, no Connect and only type imports from the generated code,
  and the `DirectorTradesTable` island draws it too for its loaded and empty
  states, so the markup lives once. The island, under its
  `DirectorTradesSkeleton` placeholder, is only the fallback for a read that
  returned `undefined`. It used to be the only path: for a stock with no trades
  its 322px skeleton collapsed to a 92px card, moving every card below it up by
  230px (a first-load layout shift of 0.164 at 1280px and 0.215 at 390px for
  SPLR on a local production build; BHP, which has trades, was 0.0007).
  `PoliticianInterestsCard` had the same flaw one card lower (a 134px skeleton,
  then `null` for most stocks): it renders `null` while it loads, as
  `StockConnections` does, so a card that may resolve to nothing never holds a
  place it gives back.
- Every tab segment has a `loading.tsx` whose root is `role="status"` with
  `aria-busy` and `aria-label` (a bare `aria-label` on a div is not announced);
  `app/shorts/__tests__/loading-boundaries.test.tsx` finds them on disk. Where
  a tab's first card follows the sr-only h1 (`CardTitle` is an h3), the page
  carries one sr-only h2 naming the group so the outline never jumps a level;
  a title an island already prints is never repeated by a wrapper heading.

