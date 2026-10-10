# Stock page: useful information first

Date: 2026-10-10. Direction from Ben the same day, after the tab-routes rollout:
"proceed fixing these issues, make the UI make the useful information visible
quickly and easily". This spec amends `2026-10-09-stock-page-tab-routes-design.md`
in three places: the layout chrome above the tab bar, keeping the chart in the
layout, and keeping the theme chips in the layout. Everything else in that spec
stands: one route per tab, the ISR trio, intent prefetch, redirects, per-tab
metadata, PriceFeatures and the Strategy tab.

Reviewed before implementation by three Fable 5.1 critics (product, Next.js and
SEO, chart readout) and a Sonnet 5.5 inventory. Section 6 records what changed
because of them.

## 1. Problem, measured on production

BHP, signed out, 2026-10-10 (`scratchpad/visible-first/measure.mjs`):

| Viewport | Tab bar top | Tab content top | Price chart top |
|---|---|---|---|
| Desktop 1280x900 | 1258px (1.40 screens) | 1314px (1.46) | 814px |
| Phone 390x844 | 1774px (2.10 screens) | 1830px (2.17) | 1330px (1.58) |

On a phone the Strategy levels chart starts 2.6 screens down (2221px). A tap on
the phone chart pins a reading card that covers 22% of the plot, docked top
right over the latest prices.

Cause: on every tab, above the tab bar, the layout stacks the breadcrumbs, a
sign-in banner (145px rendered on a phone, against a 127px reservation), a
company card with a three-to-four line description, a short-position card, a
four-sentence summary, theme chips and a 420px chart whose controls wrap to
three rows on a phone.

## 2. Goals (acceptance numbers)

Measured signed out (banner shown), BHP, after hydration, Chromium:

- **G1 phone 390x844:** tab bar top <= 340px on every tab; the tab's own
  content starts <= 400px.
- **G2 desktop 1280x900:** tab bar top <= 280px; tab content top <= 340px.
- **G3 Overview chart:** the chart container (`[data-chart-container]`) starts
  <= 480px and ends <= 844px on a phone (the whole chart in the first screen);
  starts <= 420px and ends <= 900px on desktop.
- **G4 Strategy:** the levels chart starts <= 800px on a phone.
- **G5 sticky tabs:** the tab bar stays docked under the site header while the
  page scrolls, at every width. A click on a tab while docked keeps the bar
  docked, and the new tab starts directly under it.
- **G6 chart reading:** nothing covers the plot in strip mode. A readout strip
  above the plot shows the latest values by default and the hovered, pinned or
  measured values otherwise. Its height depends only on the chart's width and
  how many series it shows, never on the state or the values.
- **G7 no regressions:** all seven tabs stay ISR (second request a cache hit);
  URLs, `?tab=` redirects, canonicals and robots unchanged; prefetch still on
  intent only; cumulative layout shift under 0.02 on first load and on a tab
  switch, phone and desktop; bundle budgets; SSR import safety; one `<main>`;
  the tab nav's `aria-current`; each tab's heading order; the summary prose
  crawlable on Overview.

## 3. Design

### D1 Compact header: `StockHeader`

A server component (`web/src/@/components/company/stock-header.tsx`). It
replaces the company card and the short-position card. Its only client child is
`CompanyLogo`, and it uses no client retry twin.

- **Identity:** the logo in a fixed box (40px on a phone, 48px from `sm`). The
  logo reads `getStockDetails` inside `Suspense`, and the fallback is the same
  box, so it cannot shift the header. The AI sparkle shows as a small corner
  badge on the logo when enriched. Then the code, the industry badge (from the
  layout's `stock`, no wait on details), and the display name. The name stays an
  `h2`: two lines at most on a phone, one line from `sm`.
- **Readout:** the page's single lit surface (DESIGN.md One Bloom Rule,
  `shadow-terminal-inset`; nothing else on the page glows).
  - Short % large, in mono with `tabular-nums`.
  - The 30-day change in percentage points: an arrow, the signed number (a true
    minus, U+2212, for a fall) and "30d", in the foreground colour, never red or
    green. Short-interest change is not
    market direction. It is omitted when unknown.
  - Reported shorts and shares on issue.
  - "as of <date>" (ASIC, T+4), omitted when unknown.
  - A missing value degrades by omission, never by a dash or "undefined".
- **No description in the header.** It moves to the Overview (D4).
- **Height:** <= 140px on a phone with a one-line name and <= 165px with a
  two-line name; <= 110px on desktop.
- **Spacing:** every block in the chrome has `mb-4` (16px): breadcrumbs, header
  and tab bar.

Layout order: breadcrumbs, `StockHeader`, `StockTabNav`, children. The layout
keeps exactly its current reads (stock, latest short date, short-interest
deltas).

### D2 Sticky tab bar

- **Markup:** `StockTabNav` renders a zero-height in-flow sentinel, then
  `<nav aria-label="Stock sections">` with
  `sticky top-16 z-30 -mx-8 mb-4 border-b bg-background/90 backdrop-blur`, and
  the scrolling list inside it carries the `px-8` (with `scroll-px-8` and a
  hidden scrollbar). On a phone the overflowing tabs then scroll to the screen
  edge, and the next tab peeks out to show the bar scrolls (ruled after Task 4
  review; with the padding on the nav the tabs clipped 32px short of the edge).
  The site header is `sticky top-0 z-50` with an `h-16` row. The container pads
  2rem at every breakpoint, so `-mx-8 px-8` bleeds to the edges of `<main>`
  (beside the sidebar on desktop, not the viewport). The header's 1px border
  overlapping the bar's top is accepted, as on the suburb context bar.
- **Links:** seven plain links in a 44px-tall row (`h-11`, links stretch to the
  full height, so every target is >= 40px). Mono `text-sm`; the active tab gets
  Burnt Amber text weight and a 2px underline indicator. There is no opaque
  muted track inside the translucent bar.
- **Kept:** intent prefetch, `aria-current`, and the active-tab horizontal
  scroll.
- **Scroll on a tab switch is specified, not left to Next.** Next 14.2's
  handler does nothing when the new segment's first node is inside the viewport,
  and jumps to the top when it is above. Docked, that hides the new tab's first
  ~110px under the bars or throws the visitor back to the top. So:
  - The links pass `scroll={false}`, and a click sets a pending flag.
  - When the active tab changes with the flag set, a layout effect computes
    `dockY = sentinel's document top - the nav's sticky top (64)` and calls
    `window.scrollTo({ top: dockY })` only when `scrollY > dockY`.
  - A bar that was not docked does not move. Back and forward (no flag) keep
    whatever scroll the browser restores.
- **In-page anchors:** `#strategy-chart` and any other hash target in the tab
  pages get `scroll-mt-[124px]` (64 header + 44 bar + 16).

### D3 Sign-in banner: Overview only, one line

- **Placement:** the banner leaves the chrome. It renders on the Overview only,
  after the About card (D4), inside the same `.login-slot` and `SignedOutOnly`
  wrapper. The site header's Sign in button remains on every page.
- **Shape:** one line at every width, 44px (`h-11`). The copy is "Get alerts"
  below `sm` and "Dashboards, portfolios and alerts" from `sm`, sized so it is
  not truncated from 360px up (ruled after Task 5 measured the first copy
  clipped to "Sign in for al..." at 390px). The SignIn button is size `sm` and the dismiss target is
  32px. Dismissing still removes `html.anon`.
- **Reservation:** `critical-css.ts` reserves one value: the rendered banner
  plus the wrapper's 2px border (46px), with `margin-bottom: 1rem`. It is
  verified by measurement at 390 and 1280: the slot's height is the same before
  and after the banner mounts.
- **Follow-up, not in this change:** persisting dismissal across visits.

### D4 Each chart lives on the tab it is about

- **Overview order:**
  1. The JSON-LD and the sr-only crawler section, unchanged and first.
  2. The chart section, full width above the existing grid: `StockChartHeading`
     ("Price & short interest", `id="stock-chart-heading"`, the hint shown
     from `xl`, where the controls also go to one row; from `sm` it wrapped the
     heading at 640px and broke the loading placeholder by 20px) and `StockChartPanel` with the combined view and `prefsKey`
     `"<CODE>:overview"`.
  3. The About card, full width, one card with:
     - an `h2` "About <company>";
     - the company description from `getStockDetails` (`enhancedSummary ||
       summary`, `line-clamp-3`, omitted when empty), with a "Company profile"
       link to the Company tab;
     - the four-sentence short-interest prose (`ShortInterestSummary`,
       unchanged text, without its own border);
     - the theme chips.
  4. The sign-in banner slot (D3).
  5. The existing grid, unchanged.
- **Short interest:** the chart section first: heading "Short interest chart",
  `prefsKey` `"<CODE>:short-interest"`, and the short view by default (combined
  when the stock has no short history). Then the existing history, FAQ and
  peers.
- **Strategy, Financials, Company, News, Community:** no price chart. Strategy
  keeps its levels chart at 360px total. Its market-regime banner takes a
  `compact` prop there: below `sm` it shows the pill, the as-of date and the
  verdict, without the four readouts and the ladder (347px measured on a
  phone, which pushed the levels plot below the fold). From `sm`, and on the
  /picks pages, it is unchanged.
- **Names:** the Overview's right-rail company card (website, address and
  links) is titled "Company details", so the page does not show two "About"
  headings. The Company tab shows the insights
  card's summary as a plain paragraph at the top of the card, and the other
  sections stay in the collapsed accordion. (Ruled after the local acceptance
  run: an accordion item open by default animated from zero height before
  hydration, because Radix sets the height it animates to only in the browser.
  The section popped open about 100ms after load and shifted the card's rows
  by 84px, a layout shift of 0.136 on desktop.)
- **Settings survive a tab switch.** A client-only module store keeps:
  - the **period per stock**, shared by both chart tabs;
  - **view, SMA 20 and divergence per `prefsKey`**, so each tab keeps its own
    default view.

  It survives soft navigation and resets on reload. Overview, then Financials,
  then Overview restores what the visitor chose.
- **Stacked chart controls** (below `xl`):
  - above the plot, one 40px row: the view control, and the embed button at the
    right;
  - below the plot: the period control (full width, 40px targets), then one row
    of SMA 20, Divergence and the correlation chip (no wrap; it scrolls
    sideways if it must, with its scrollbar hidden).

  From `xl` (1280px) up, one row above the plot as today. One instance of each
  control, placed with CSS grid areas. Row heights are fixed per breakpoint.
  (Ruled 2026-10-10, after Task 3 measured it: the one row needs about 960px of
  panel, and grid areas do not wrap. The panel reaches 960px only at a 1280px
  window with the signed-in sidebar. At `sm` the toggles got 37px of 291 and the
  row grew to 62px, breaking the skeleton match. A container query would be
  exact, but the repo has none, and Tailwind 3.4 needs a plugin for it.)
- **Height from CSS:** the chart box is `h-[360px] sm:h-[420px]`.
  `StockChart` takes its height from its parent when no `height` prop is given.
  One exported `StockChartPanelSkeleton` with the same heights serves as the
  dynamic import's `loading` and as the first block of the Overview and Short
  interest `loading.tsx`. The Overview `loading.tsx` also reserves the sign-in
  slot and an About block close to its measured height (`h-[500px]
  sm:h-[360px]`).
- **Accepted trade-offs:**
  - The chart is no longer one DOM node across all tabs. The TanStack queries
    stay fresh for 30 minutes (staleTime and gcTime both 30 minutes), so a
    return to a chart tab within that window re-renders from cache with no
    request.
  - The Strategy levels chart no longer finds its 1y prices pre-fetched when the
    visitor lands on Strategy directly: one extra request.
  - A page error on a chart tab now removes that tab's chart with its content.
  - Windows from 640px to 1279px get the stacked controls under a 420px box:
    about 100px taller than one row.
  - On the stacked layout a keyboard visits the controls in the one-row
    layout's order (view, toggles, period, embed, then the chart), not the order
    they are drawn in (view, embed, chart, period, toggles). One instance of
    each control, placed with grid areas, has one DOM order, and the one row is
    the layout most keyboard users meet. WCAG 2.4.3 would prefer the two to
    agree.
  - The theme chips and summary prose leave six of the seven tab URLs. This
    reverses the earlier spec's call to keep the chips in the layout: the space
    above the fold on every tab is worth more than six duplicate links to
    /themes per stock.

### D5 Chart readout strip

`StockChart` gains `readout?: "strip" | "tooltip"`, default `"strip"`.

- **Users:**
  - **Strip:** the stock page panel, the Strategy levels chart, the dormant
    `StockPriceShortChart`, and the embed when its chart is >= 260px tall.
  - **Tooltip (today's floating card):** the two dashboard widgets, and the
    embed below 260px. The embed drops its Combined legend row in strip mode,
    because the strip carries the dots and labels.
- **Fallback:** strip mode falls back to tooltip when the plot left after the
  strip would be under 160px (`READOUT_MIN_PLOT`).
- **Height and layout from the chart's width and series count only:**
  - >= 640px: one 28px row. Headline, then one entry per series, then OHLC when
    the width is >= 900px and the shown price point has all four values, then
    the Pinned chip.
  - Below 640px: a headline row with the Pinned chip at its right, then one
    18px row per series, plus 8px padding: 44px for one series, 62px for two.
    No OHLC. Each entry has its own row, so labels stay whole and one entry's
    width never moves another. (Ruled 2026-10-10: a single entries row
    truncated the labels to "P…" at a 326px chart and dropped them at 296px.)
  - No wrapping (`nowrap`, overflow hidden). The height is never read from the
    DOM.
  - The svg gets `height - stripH` and `display:block`, so the component's total
    height is unchanged.
- **States** (`data-readout-state`):
  - `latest`: the headline is "Latest · <date>" unzoomed, or just the date of
    the newest visible point after a zoom. Each entry shows its last visible
    value and its change over the visible range.
    - Price change is relative %, in signal red or green.
    - A percentage series is absolute, in the foreground with an arrow. The
      short series gets `measureMode: "absolute", measureUnit: "pp"` in
      `buildChartView`.
    - A normalised view shows no change.
    - An entry whose last point falls on another Sydney day carries its own
      date, so the short series (T+4) is never misdated.
    - A series with no visible points keeps its row and reads `n/a`
      (DESIGN.md: never a dash).
    - Negative changes use a true minus (U+2212), per DESIGN.md's Tabular Rule.
  - `hover`: values at the nearest points. The headline is the first entry's
    point date, and entries on another day carry their own date.
  - `pinned`: like hover, plus the Pinned chip. Its x button is labelled
    "Release pinned reading", and the old guidance sentence becomes the button's
    title. A pin holds the reading and the crosshair until a re-tap, the x
    button, a press outside the chart, a series change or a drag-measure.
  - `measure`: the drag-to-measure readout moves into the strip (the floating
    card goes in strip mode). The headline is "<date> → <date>", with each
    series' change, coloured by the same rule. The strip also carries
    `data-chart="measure-readout"` while measuring.
- **Accessibility:**
  - The visible strip is `aria-live="off"` and its dots are `aria-hidden`.
  - A persistent, visually hidden `role="status"` sibling announces a pin
    ("Pinned 6 Oct 2026: Price $43.21, Short % 3.20%") and a release ("Reading
    released"), never a scrub.
  - Release returns focus to the chart.
  - Keyboard: the chart container is focusable, with a visible ring. The arrow
    keys step a pinned reading one rendered point, Home and End jump to the
    ends, and Escape releases.
- **Shared maths:** the delta maths is one pure function, `seriesDelta`, used by
  both measure and latest.
- **Dates:** one module-level `Intl.DateTimeFormat` (en-AU, Australia/Sydney).
- **Performance:** the latest model is memoised on the rendered series, formats,
  view mode and zoom, and the strip is `React.memo`.
- **Tooltip mode is today's behaviour**, except for three changes it shares with
  the strip: the minus sign (U+2212), the en-AU / Sydney date, and the
  percentage-point measure row staying uncoloured.

### D6 Smaller fixes in the same change

- **Error card:** `error.tsx` takes the code from the segment after `/shorts/`.
  The card read "We couldn't load the data for STRATEGY" on tab routes.
- **Stale comments:** comments that say the chart lives in the layout, or that
  Strategy shares its cache, are corrected.
- **Dead components:** `companyProfile`, `companyStats`, their views and their
  retry twins have no other user. They are deleted with their tests, and their
  `KNOWN_CLIENT_CONNECT` entries go.

### D7 Out of scope (follow-ups)

- The report pages' first-visit content loss.
- The housing cache-key warnings.
- Recolouring the short series from signal red to the warm rust (DESIGN.md §2).
  Until then the strip adds no red or green to the short entry.
- Persisting banner dismissal.
- Pre-existing stale e2e specs: `enriched-stock-page`, `seo-smoke`'s `<dl` and
  "Reported positions", and `homepage-dashboard`'s banner text.

## 4. Tests that change (summary; the plan lists every file)

- **e2e `stock-tabs`:**
  - "chart node survives" becomes: a chart on Overview and Short interest only,
    and a period chosen on Overview survives Financials and back, with no new
    chart request.
  - The thread test expects zero `[data-chart-container]`.
  - The 390px test drops its scroll step.
  - New tests: G1-G5 positions, sticky docking, the scroll on a tab switch from
    three start positions, a phone tap that pins the strip without moving the
    svg, and the layout-shift sum.
- **Unit and guard tests:** the `ssr-import-safety` `CONNECT_ISLANDS` and
  `KNOWN_CLIENT_CONNECT` entries, `layout.test` order, the `page-runtime`
  source assertions, `page-all-imports`, `page-component-imports`,
  `page-old-api`, the short-interest page island count, `component-exports`,
  and `companyStats`.
- **Chart tests:**
  - `StockChart.touch` runs each interaction suite in both modes, keeps
    placement under tooltip, and adds the strip tests.
  - In the stories, `TooltipTracksCursor` and `MobileTouchPinned` pass `readout:
    "tooltip"`, and a strip interaction story is added.
  - The visual baselines for StockChart, StockChartPanel and
    StockPriceShortChart are regenerated in `node:22-bookworm-slim`.

## 5. Acceptance measurement

`measure.mjs` against a local production build, then against production after
deploy: positions per tab at 390x844 and 1280x900, plus a PerformanceObserver
layout-shift sum (`hadRecentInput` false) on first load and on a tab switch.

## 6. Review rulings (2026-10-10)

1. **Description:** given a real home on the Overview About card (the header
   was its only renderer). On the Company tab the summary is a plain paragraph
   above the collapsed sections (D4).
2. **Phone controls:** collapsed to one row above the plot, with the period and
   toggles under it. Without that the chart straddled the fold.
3. **Banner:** moved out of the chrome to the Overview, instead of being shrunk
   in place.
4. **Scroll on a tab switch:** specified (`scroll={false}`, a click flag and a
   dock clamp), not "checked".
5. **Strip:** one row from 640px; per-series dates; red and green only on price;
   measure folded in as a fourth state; a MIN_PLOT fallback; `pp` via
   `measureMode`.
6. **Sticky bar:** the bleed is `-mx-8 px-8` (the container pads 2rem
   everywhere); 44px row with no opaque track.
7. **Prefs:** the period shared per stock; view, SMA and divergence per tab.
8. **Header:** a server component with no retry twins. Its two client modules
   leave every tab's first-load JS.
9. **Phone plot:** 360px total, not 320, for a readable plot under a 44px
   strip.
10. **Keyboard access:** implemented with the strip (it was zero before).
11. **Phone strip (after Task 2):** one row per series below 640px, `n/a` for a
    missing value, U+2212 for negatives. A click re-reads the point under the
    cursor instead of resetting the strip to Latest. The tooltip card's hover
    date uses the same en-AU / Sydney formatter as the strip.
12. **After Task 5:** the banner copy, the regime banner's compact phone form,
    "Company details", the Overview loading placeholder, and per-route bundle
    budgets. Next's printed First Load JS counts the page entry, not the
    layout's. Moving the chart from the layout into the two chart pages raised
    their printed numbers and lowered every other tab's. Their budgets are
    raised to the measured value plus 10%, and a layout-aware metric is a
    follow-up.
