# Ownership explorer: design and implementation spec (2026-11-02)

Governing documents: CLAUDE.md "Ownership" and "Stock page" sections, DESIGN.md. Repo paths are relative to /Users/benebsworth/projects/shorted.com.au. Copy strings are referenced by id from section 7; implementers paste them verbatim. No em dash anywhere (copy, alt text, proto comments, test strings). A missing figure prints `n/a`, never 0 or a dash; negatives use U+2212 (`formatPointChange`); every sum is captioned "what the notices disclose, not a share of the company". Dates print as the API sends them (`YYYY-MM-DD`), inside `<time dateTime>` where a component draws them.

Preconditions (operator steps, before the stage 1 PR merges; see Unresolved): run `shorted ownership -mode repair-placeholders` on production as a dry run, check its lines, then `-apply -dry-run=false`, so placeholder holders (SYR's "SEE ANNEXURE 1" at 6.0049%) are gone before a lane or a sum shows them; and one `-mode funds` run so `aum_as_at` is dated (commit d0887317f fixed `parseAPRADate`; the next run writes the dates, no migration).

## 1. Decisions on the seven questions

1. **No eighth tab.** The full register is `/ownership/stocks/[code]` (ISR 3600, `dynamicParams = true`, empty `generateStaticParams`, the `[slug]` page's read rule). It reads ONLY `getStockOwnership`: no `GetStock` read, because `GetStock` reads `FROM shorts` (services/shorts/internal/store/shorts/postgres.go:309-325) and answers `CodeNotFound` on any database error (service.go:96-99), so a company that never appeared in ASIC's report has no stock page and a transient error reads as absence. The stock link row (Overview, Company card `#ownership`, Short interest) is drawn only when `summary.has_short_pct` is true (the code had a line in ASIC's report in the last fortnight, which is exactly what `GetStock` reads) AND the code matches `STOCK_CODE_PATTERN` (`/^[A-Z0-9]{1,4}$/`, the stock layout's own gate). The Company tab keeps the card as the summary with `id="ownership"` and `scroll-mt-[124px]`; the Overview gains a one-line strip (Strategy-fit-strip pattern) read through a KV-free, abort-bounded `unstable_cache` action. Every stock-code link on an ownership surface points at the register page; a listed HOLDER's name keeps `holderHref` (its own stock's Company tab), the one exception. Indexable when `holders >= 1` (`registerIsIndexable`), noindex otherwise (an all-ceased register renders but is noindex); sitemap listing waits for stage 2.
2. **Signature: the Holder Lanes** (section 2). One server-SVG lane per holder, reused on the register page (stage 1) and the register OG card (stage 3); the Company card and the strip stay text. Companion: `DisclosedBar` (outlined extent, no 100% track).
3. **Server-rendered SVG, no visx, no client JS for any figure.** The Company card is pinned to reach no client module; `SeriesPath` hard-codes `curveLinear`; a visx island is invisible to crawlers and joins a tab's chunk list (`stock-chart-chunks.mjs`); every lane prints its figure, date and age as text and the Notices table is the data, so no pointer is needed.
4. **URL state = island + "use server" action** (picks and politicians patterns). Server pages never read `searchParams`; an island under `components/ownership` reads `useSearchParams` under its own `Suspense` whose fallback is the default view from the same props, writes with `history.replaceState`, omits defaults; chips are `Link replace scroll={false} prefetch={false} rel="nofollow"`. Re-queries go through a server action returning plain string rows (`rows.ts` style), never browser Connect. Stage 1 has no URL state; the source guard ships in stage 1 anyway.
5. **API, bounded, one universe.** Stage 1: fields on existing responses plus ONE cached universe in the Go service, built from database reads only, held by `ownershipUniverseHolder` (refresh-ahead, generation-tagged; section 4.3). Every handler assembles its response per request from that universe plus, for a stock or an institution, one per-key notices read cached under the universe's generation, so no cached entry ever outlives the universe it was built from and the job's 11-minute wait (`revalidateWait`, services/jobs/internal/jobs/ownership/job.go:72-75) still outlasts every entry. Per-stock history and withheld counts come from two whole-table GROUP BYs at universe build, never a per-code statement. Stage 2: `ListSubstantialNotices` (own indexed keyset query) and `ListStockRegisters` (in memory over the universe). No rollup view, no migration, no MCP change.
6. **Hub shrinks in stage 2/3**: coverage with the withheld breakdown, the map, this week on the register, ONE hairline rack of five ranked views (top 10 each, the brief's decision; "Full list, sorted this way →" into the explorer), latest 10 notices linking into the feed, a directory filtered client-side, sources and method; target under 6,000 px at 1280. Stage 1 changes the hub's copy, tiles, plate, links and footer only; block order and 25-row tables stay.
7. **Vocabulary** (one meaning each): substantial holder (5% or more as its latest notice read states); voting power (the notice's own figure, as at the notice); notice (one ASX release: 603 became substantial, 604 changed, 605 ceased, nz an NZ disclosure); interest (a holding counted once after the overlap rule; counts of interests and sums share this basis); stake (a disclosed long interest; a bank or broker row is an interest, often lending); register (one stock's substantial holders, nothing else); crowded (investors' interests: super, index, active, hedge, sovereign, insurer; banks and brokers shown beside, never counted); lending desk (a bank or broker with a substantial interest); index fund (never "index ETF"; Vanguard rows carry the P mark); super option (one investment option's disclosure, never the fund); withheld (one of six outcomes: no_text, no_voting_power, implausible, ambiguous_target, no_holder, inconsistent_votes; not_a_notice and fetch_error are reported apart, never as "unread"); a fall in voting power is a fall in the notice's figure, never described as a disposal (the words "sold" and "sale" appear in no ownership string). Hedging is one word: banks' and brokers' notices are "often" securities lending, everywhere. Provenance: every figure carries its own date, and a source with several files carries a range (notices read to {as_of}; index fund files as at {from} to {to}; super options as at {from} to {to}; ASIC short position as of {date}, T+4; AUM as at {date} once the next funds run lands, `n/a`-dated until then). Every ownership page ends with the method, "Not financial advice" and Report an error; the Company card and the strip carry "Not financial advice" and Report an error in their footer line and link to the method.

## 2. The signature component: Holder Lanes

**Files**: geometry `web/src/@/lib/ownership/trace.ts` (pure, no React); drawing `web/src/@/components/ownership/holder-lanes.tsx` (server, no directive, type imports only).

**What it draws.** For one stock, one row per holder: the holder's name (link where `holderHref` allows), its KindBadge, a 28-unit-high SVG lane showing that holder's voting power stepping at each notice read, a text readout (figure, as-at date, age), the change, and the ASX glyph. The lane is a step line in the primary amber with a tick at each notice; the 5% threshold is the lane's bottom edge; a cessation ends the line with an end-stop on that edge ("under 5%", never zero); a dotted tail runs from the last notice read to the as-of date (staleness as length); a dotted lead-in shows the previous figure a first notice states. Each lane has its own y scale from 5% to its holder's highest figure. Ceased holders found in `history` get lanes too, so a register whose every holder has ceased still shows what was read.

**Geometry (`buildHolderLanes`)**:
- Inputs: `holders: SubstantialHolding[]` (API order), `history: SubstantialNotice[]` (newest first), `asOf: string`, `historyTotal: number`.
- Lane set: one lane per `holder_key` in `holders` (current, in API order), then one per `holder_key` that appears in `history` with no current row (ceased), ordered by last notice date desc. Group by `holder_key`, never by name.
- Points per lane: notices with that key, ascending by `(event_date || announced_on, announced_on, announcement_url)`. A current holder with no notice in `history` (the 100 cap) is seeded with one point from its holders row (`eventDate || announcedOn`, `votingPowerPct`, `hasPrevious/previousPct`, `form`) and flagged `seeded`.
- Dates: `days(d)` from `Date.UTC`; `to = asOf` if it is a `YYYY-MM-DD`, else the max date drawn; `from = min date drawn`; if `days(to) - days(from) < 180`, `from = to - 180 days`. `x(d) = clamp((days(d) - days(from)) / (days(to) - days(from)), 0, 1) * 1000`.
- Constants: `VIEW_W 1000`, `VIEW_H 28`, `BAND_TOP 3`, `Y5 23` (band bottom = threshold), end-stop from y 20 to 26, lead-in length 40 units, stub length 12 units, tick half-height 3, minimum tick spacing 8 units.
- Per-lane y: `lo = 5`, `hi = max(8, ceilHalf(laneMax * 1.1))` where `laneMax` is the max of every present and previous figure drawn in the lane and `ceilHalf` rounds up to 0.5. `y(p) = Y5 - (clamp(p, lo, hi) - lo) / (hi - lo) * (Y5 - BAND_TOP)`. The band is 20 units for `hi - 5` points, so a 1 pp step is 6.7 units on a lane up to 8%, 2 units at `hi` 15 (laneMax about 13.5%) and about 0.9 units on a 25% holder: the lane shows the shape, the readout and the Notices table carry small steps on a large holding. The caption says so (`register.lanes.caption`).
- Path rules, walking the points with `open = false`:
  - ceased point: if open, `solid += H{x}V23`, `ends += M{x} 20V26`, `open = false`; else `dotted += M{max(0,x-12)} 23H{x}`, `ends += M{x} 20V26`.
  - point without a present figure (not ceased): skipped, counted in `withoutFigure`.
  - point with a figure: `y = y(present)`. If not open: with a previous figure, `dotted += M{max(0,x-40)} {y(prev)}H{x}` and `solid` starts `M{x} {y(prev)}V{y}`; without one, `solid` starts `M{x} 23V{y}`; `open = true`. If open: `solid += H{x}V{y}`. Then a tick `M{x} {y-3}V{y+3}` unless within 8 units of the previous tick.
  - after the loop, if open: `dotted += M{xLast} {yLast}H1000`.
- Output per lane: `{ holderKey, name, href, kind, current: boolean, ceased: boolean, seeded: boolean, figure: string ("under 5%" for a ceased lane, else formatVotingPower), asAt: string, age: string ("" or "{m} mo"), change: string (formatPointChange or form label), url: string, scaleHi: number, paths: { threshold: "M0 23H1000", solid: string[], dotted: string[], ticks: string[], ends: string[] }, notices: number, withoutFigure: number }`. Top-level: `{ lanes, from, to, yearLabels: Array<{ x: number; label: string }> (each 1 Jan inside [from, to]), truncated: historyTotal > history.length }`.

**Drawing (`HolderLanes`)**: `<figure aria-labelledby="holders" aria-describedby="lanes-method">` (the section's h2 carries `id="holders"`) with a visible `figcaption id="lanes-method"` (copy `register.lanes.caption`, prefixed by `register.lanes.truncated` when truncated, followed by `register.withheld` when `withheldListed > 0`) and an sr-only sentence `register.lanes.sr`. Rows in an `<ol class="divide-y divide-border/60">`, the first 12 lanes drawn; the rest inside `Disclosure` (`ui/disclosure.tsx`) titled `register.lanes.more`, whose body holds its own `<ol start={13} class="divide-y divide-border/60 text-foreground">` (a `<details>` cannot sit in an `<ol>`, and Disclosure's body is `text-muted-foreground`). Row grid from `sm`: `grid-cols-[minmax(0,176px)_minmax(0,1fr)_112px_88px_32px] min-h-[44px] items-center gap-x-3`; cells: name (text-sm, truncate, `title`) over kind badge; the SVG; readout (`text-sm tabular-nums text-right` figure, then `text-[10px] text-muted-foreground tabular-nums` "{asAt}" alone, or "{asAt} · {age}" when age is non-empty, the age span carrying `title={copy register.age.title}` and `data-age-months`); change (`text-xs tabular-nums text-right`); ASX glyph (`ExternalLinkGlyph` through `safeExternalHref`, aria-label "{name}'s notice on ASX", `hit-target`). Below `sm`: row 1 name, badge, readout right-aligned; row 2 the SVG; the change folds under the figure. The SVG: `viewBox="0 0 1000 28" preserveAspectRatio="none" class="h-7 w-full" aria-hidden focusable="false"`, wrapper `title="Lane scale 5% to {scaleHi}%"`; every path `vector-effect="non-scaling-stroke" fill="none"`: threshold `stroke="hsl(var(--border))" stroke-width="1" stroke-dasharray="4 6"`; solid `stroke="hsl(var(--primary))" stroke-width="1.5" stroke-linejoin="miter"`; dotted `stroke="hsl(var(--muted-foreground))" stroke-width="1" stroke-dasharray="4 6"`; ticks and ends `stroke="hsl(var(--primary))"` and `hsl(var(--muted-foreground))` respectively, width 1.5, `stroke-linecap="round"`. No `<text>`, `<rect>` or `<circle>` inside any SVG. Axis row under the lanes: a 16px `relative` div with year labels (`text-[10px] tabular-nums text-muted-foreground absolute`, `left: {x/10}%`); the from and to dates go in the figcaption, never on the axis. Colour: never red or green, never a kind colour. Motion: none in stage 1.

**Accessibility**: the lanes are the holders list, every figure is real text; the sr-only sentence names the Notices table as the data; `title` and `data-age-months` carry the age's meaning and the figcaption repeats it; a row has at most two focusable targets (the name, when `holderHref` gives it one, and the ASX glyph), each at least 24px tall; an unclassified holder's name is plain text.

**Tests** (`web/src/@/lib/ownership/__tests__/trace.test.ts`, `web/src/@/components/ownership/__tests__/holder-lanes.test.tsx`): a 603 starts `M{x} 23V{y}`; a 604 first point draws a 40-unit dotted lead-in at y(prev); a 605 after an open line ends with `V23` and an end-stop and never reaches above the band; a lone 605 draws a 12-unit stub plus end-stop and no solid path; a 603/605/603 cycle (DRO's Citigroup shape) yields two solid subpaths with a gap; a current holder not in history is seeded and flagged; a register with no current holder and two ceased keys in history yields two ceased lanes; a 1 pp step on a lane with laneMax 6.5 is at least 4 units tall; a 1 pp step on a laneMax 25 lane is under 1 unit (documented, so nobody tests for more); `scaleHi` is 8 for a 5.2% holder and 27.5 for a 25% holder; a last notice that is not ceased produces a tail ending at x 1000; the 180-day minimum span; `truncated` iff `historyTotal > history.length`; lanes capped at 12 with the rest inside a `details` holding an `ol` with `start="13"`; no `text` inside any `svg`; no red or green class or stroke; the figcaption contains "under 5%"; the figure is labelled by the element with `id="holders"`; no row has more than two links.

## 3. Surfaces, top to bottom

### 3.1 `/ownership/stocks/[code]` (new, stage 1)
- **Rendering**: `revalidate = 3600`, `dynamicParams = true`, empty `generateStaticParams`. One read: `readRegister(code)` (section 5.3), which returns the `GetStockOwnershipResponse` or throws; `generateMetadata` calls the same function (React `cache`). A code failing `REGISTER_CODE_PATTERN` (`/^[A-Z0-9]{1,6}$/`, kinds.ts) after uppercasing is `notFound()` before any read. 404 only when `holders.length === 0 && fundHoldings.length === 0 && historyTotal === 0 && summary.companyName === "" && !summary.hasShortPct` (the register knows nothing about the code). A response with no `summary` is a failed read and throws (a nil ownership store). Nothing reads `searchParams`, `cookies()`, `headers()`, `auth()`.
- **Names**: `company = cleanCompanyName(summary.companyName || CODE, CODE)`; an empty name falls back to the code everywhere (h1, title, Dataset, description, OG).
- **Sections**: `ExternalLinkSymbol` (hidden); `Breadcrumbs` + `BreadcrumbStructuredData` (`Ownership` /ownership, `{CODE} register` self; `prefetch={false}`); header: `eyebrow` "ASX:{CODE} register", h1 `pageTitle` `register.h1`, lede `register.lede`, `OwnershipPlate` (items `register.plate.*`, each only when its data exists), link row `register.links` only when `summary.hasShortPct && STOCK_CODE_PATTERN.test(CODE)` (`stockTabHref(code,"overview")`, `stockTabHref(code,"company") + "#ownership"`, `stockTabHref(code,"short-interest")`, all `prefetch={false}`); **The register** (h2 `sectionTitle`, `id="register"`): `RegisterReadout` (the page's one lit surface, `shadow-terminal-inset`); **Substantial holders** (h2 `id="holders"`): `HolderLanes` when `lanes.length > 0`, else the empty paragraph; **Index funds and super options** (h2 `id="funds"`): `StockFundTable` with every row, or `register.funds.empty`; **Notices** (h2 `id="notices"`): `NoticeTable notices={history} showStock={false} showHolder caption="{CODE}'s substantial holding notices" limit={25} onRecord={historyTotal}`, preceded by `register.notices.truncated` when `historyTotal > history.length`; **Sources and method** (h2 `id="method"`): `OwnershipSourceLines`, `OwnershipMethodology`, `OwnershipReportError subject="Ownership data: {CODE} register"`, link "Who owns the ASX →" (/ownership).
- **Empty and withheld states**: no current holder, lanes present (every holder ceased): the lanes are drawn, the readout prints `n/a` in the disclosed cell, and the paragraph `register.ceased` sits above the lanes. No current holder and no lane: the readout prints `n/a`, the lanes are replaced by `<p>` `register.empty.holders` (+ `register.withheld` when `withheldListed > 0`) with the method link `/ownership#method`; funds still render. Both: metadata `robots: NOINDEX`. No fund rows: `register.funds.empty`. Withheld with holders present: the sentence appears in the figcaption and in Sources and method only, never in the readout or the plate. Failed read: throw (nothing cached). Schema without 000137: the empty state, noindex (recorded risk).
- **SEO**: title `registerTitle(code, company)`: `"{CODE} substantial holders: {company}"` when at most 60 characters, else `"{CODE} substantial holders"`; description `register.meta.description`; canonical `https://shorted.com.au/ownership/stocks/{CODE}`; indexable (`registerIsIndexable`) means NO robots key; else `NOINDEX` (the `[slug]` constant); openGraph/twitter as the `[slug]` page (no `images`); JSON-LD `BreadcrumbList` + `Dataset` (name `"{company} ({CODE}) substantial holders"`, `isBasedOn` the three source strings, `dateModified = as_of`); `opengraph-image.tsx` (section 6.17).
- **Loading**: `loading.tsx` root `role="status" aria-busy="true" aria-label="Loading"` with blocks 96px (header), 36px (plate), 140px (readout), 12 × 44px (lanes), 300px (table).

### 3.2 `/shorts/[stockCode]/company` (revised, stage 1)
- `company/page.tsx`: the section becomes `<section id="ownership" className="scroll-mt-[124px]" aria-label="Ownership">`. Three states: `hasOwnership` (holders or fund rows) draws `StockOwnershipView`; otherwise, when `ownership` resolved and `historyTotal > 0 || withheldListed > 0`, one `<p className="text-sm text-muted-foreground">` `company.none.line` (server HTML, no shift); otherwise nothing (gate unchanged).
- `StockOwnershipView` revised (section 6.9): CardTitle `company.title`; description `company.description`; `DisclosedBar` (`scaleMax = total`, full width); holders table unchanged columns plus the age under As at; 8 fund rows with the P mark and per-row as-at; `company.funds.more` link when more; footer `company.footer`: the sentence, then "How ownership is read →" (/ownership#method), "Full register →", "Not financial advice" (/disclaimer), "Report an error" (mailto, subject `Ownership data: {CODE} register`), joined by " · "; `company.withheld.short` is appended to the footer sentence when `withheldListed > 0`, never to the description beside the sum.

### 3.3 `/shorts/[stockCode]` Overview strip (new, stage 1)
- `page.tsx`: `const registerStripPromise = getStockRegisterStrip(stockCode).catch((err) => { console.warn(...); return null; });` declared beside `strategyFitPromise`, awaited after the critical `Promise.all`; mounted directly after `<StrategyFitStrip>`: `{registerStrip ? <RegisterStrip strip={registerStrip} /> : null}`.
- `RegisterStrip` (section 6.11): Card `role="region" aria-labelledby="register-strip-heading"`, CardTitle `strip.title` with `Landmark` icon, CardDescription `strip.description`, ONE `text-xs` line `strip.summary` (the figures and up to three holder names inline, each a link where `holderHref` allows, else plain text, with its figure), footer `strip.footer` + "Full register →" (`/ownership/stocks/{CODE}`, `prefetch={false}`). One line is the brief's decision; the names ride inside it so the crawlable links exist without rows. No bloom, no chart. Omitted when the read fails or there are no holders.

### 3.4 `/ownership` hub (stage 1 changes only)
Lede `hub.lede` (the date leaves the lede; the plate carries it); `DESCRIPTION = hub.meta`; `isBasedOn[3] = "Index fund holdings files (iShares, Vanguard, SPDR, Betashares)"`; `LLMMeta dataSource = hub.llm.source`; after the header an `OwnershipPlate` (`hub.plate.*`). Coverage tiles (4): `hub.tile.read` ({noticesParsed}, meta "to {asOf}"), `hub.tile.withheld` (value = sum of the six withholding outcomes from `withheldByOutcome`, meta `hub.tile.withheld.meta` with `{attempted} = documentsAttempted`, under it a `Disclosure` `hub.tile.withheld.details` containing `WithheldBreakdown`; when `withheldByOutcome` is empty the value is `noticesWithheld` with label `hub.tile.withheld.all` and no details), `hub.tile.indexfiles` ({sources.etf.funds} of {etfs}, meta `hub.tile.indexfiles.meta`), `hub.tile.superfiles` ({sources.super_phd.funds} of {superFunds}, meta `hub.tile.superfiles.meta`). A source whose `asAtFrom` equals `asAt` prints one date ("as at {date}"), else "as at {from} to {to}" (`asAtRange(source)` in kinds.ts). Card copy: `hub.crowded`, `hub.bothways`, `hub.lending`, `hub.index`, `hub.super`. The `bar` column becomes `DisclosedBar` scaled to the table's largest sum. Sources and method: per-source line "{description}: {records} records, as at {range}" plus `hub.sources.registers`, `OwnershipMethodology` wrapped in `<div id="method" className="scroll-mt-20">`, `OwnershipReportError subject="Ownership data: hub"`. Every stock code links to the register page (through `OwnershipStockTable` and `NoticeTable`). Block order and 25-row tables unchanged in stage 1. `page.test.tsx` (P6) replaces its `/Notices to/` assertion with one on the plate ("Notices read to 2026-10-16").

### 3.5 `/ownership/[slug]` (stage 1 changes only)
`isInstitutionSlug` now rejects the reserved segments `stocks` and `notices` (before any read). Stake and file rows link to register pages (via `StockLink`). The files heading sentence uses `institution.files.lede`, and when `fundHoldingsTotal > fundHoldings.length` the caption `institution.files.capped`. Method section gains `OwnershipReportError subject="Ownership data: {name}"`. `KIND_INFO.bank_broker.note` reads "Often securities lending: ..." (P1). Nothing else changes.

### 3.6 `/ownership/notices` (stage 2), 3.7 `/ownership/stocks` (stage 2), 3.8 hub desk (stage 3), 3.9 Short interest lending line (stage 3): section 10.

## 4. API

### 4.1 Stage 1: fields only (`proto/shortedapi/shorts/v1alpha1/ownership.proto`; no shorts.proto edit; from the repo root `make openapi`, which runs `buf generate` itself (Makefile:780-786), then commit every output under services/gen, web/src/gen, sdks/java, api/schema, web/public). Field names and comments must not contain `admin`, `Admin`, `Internal`, `MintToken`, and no comment may say "index ETF" (the header comment and the GetStockOwnership comment change to "index fund").

```proto
// Documents attempted and not parsed, by outcome. Six outcomes withhold a
// notice that was read or could not be read (no_text, no_voting_power,
// implausible, ambiguous_target, no_holder, inconsistent_votes); not_a_notice
// is a document that was never a substantial holding form and fetch_error a
// download that is retried. Neither is an unread notice.
message WithheldOutcome {
  string outcome = 1;
  int32 count = 2;
}
```
Append to `OwnershipStock`:
```proto
  // ASIC's report date behind short_pct; "" when there is none.
  string short_as_of = 16;
  // The oldest and newest file dates behind index_pct, and how many files
  // contributed; "" and 0 when there is no index figure.
  string index_as_at_from = 17;
  string index_as_at_to = 18;
  int32 index_files = 19;
  // The newest release date among the current holders' notices; "" when none.
  string latest_notice_date = 20;
```
Append to `OwnershipSource`:
```proto
  // Files (index funds) or options (super funds) the source holds. 0 for notices.
  int32 funds = 5;
  // The oldest file date behind the source; equals as_at when one file or
  // one date. "" for notices.
  string as_at_from = 6;
```
Append to `GetOwnershipOverviewResponse`:
```proto
  // Withheld documents by outcome; notices_withheld stays their total.
  repeated WithheldOutcome withheld_by_outcome = 19;
  // Every document attempted, parsed included: the base of notices_withheld.
  int32 documents_attempted = 20;
```
Append to `GetInstitutionResponse`:
```proto
  // Rows in its latest files; fund_holdings serves the largest 100.
  int32 fund_holdings_total = 6;
```
Append to `GetStockOwnershipResponse`:
```proto
  // Parsed notices for the stock on record; history serves the newest 100.
  int32 history_total = 7;
  // Documents listed under this code whose outcome is one of the six
  // withholding outcomes. A document ASX lists under several codes is counted
  // under one of them, so the figure is "listed under", never beside a sum.
  int32 withheld_listed = 8;
  // The newest notice release date read anywhere.
  string as_of = 9;
```
Comment edit on `GetOwnershipOverviewResponse.crowded`: "Stocks where investors (super, index, active, hedge, sovereign, insurer) disclose the most voting power; banks and brokers are not counted." Caps: `history` and institution `notices` stay capped at 100; nothing new is a percentage of anything.

### 4.2 Store (`services/shorts/internal/store/shorts/postgres_ownership.go`)
- Add `var _ OwnershipStore = (*postgresStore)(nil)` (a signature slip must not nil the store at runtime).
- Interface gains two whole-table reads, both through `ownershipRead` (missing schema = nil map or slice, never a 500):
  - `NoticeCountsByStock(ctx) (map[string]int, error)`: `SELECT stock_code, count(*) FROM substantial_holder_notices GROUP BY stock_code`.
  - `AttemptOutcomes(ctx) ([]AttemptOutcomeRow, error)` with `type AttemptOutcomeRow struct { StockCode, Outcome string; Count int }`: `SELECT stock_code, outcome, count(*) FROM substantial_holder_notice_attempts GROUP BY stock_code, outcome`.
- `NoticeStats` keeps its two statements unchanged. The service asserts (a test over one fixture) that `notices_withheld == sum(withheld_by_outcome.count)`.
- No per-code statement against the attempts table exists, so no index is needed and no EXPLAIN is a merge condition for stage 1; both GROUP BYs run once per universe build (about 27k and 18k rows).
- `postgres_ownership_pg_test.go`: both methods before and after 000137 (opt-in; running it against `make dev-db` with 000137 applied is a merge condition, section 11).

### 4.3 Service (`services/shorts/internal/services/shorts/ownership.go`, new `ownership_universe.go`, `interfaces.go`, `cache.go`, `mocks/mock_interfaces.go`)
- `institutionalKinds` drops `bank_broker` (comment: investors; banks and brokers are shown beside, never counted).
- **The universe** (`ownership_universe.go`):
  ```go
  const ownershipRefreshAhead = 2 * time.Minute   // a build starts this long before expiry
  const ownershipBuildTimeout = 60 * time.Second  // a background build's own deadline

  type ownershipUniverse struct {
      builtAt, expiresAt time.Time
      generation int64 // builtAt.UnixNano(): the key suffix of every entry built beside it
      data *ownershipData
      views map[string]*shortsv1alpha1.OwnershipStock
      overview *shortsv1alpha1.GetOwnershipOverviewResponse // built once here, immutable
      holdingsByStock, holdingsByHolder map[string][]shortsstore.SubstantialHoldingRow
      fundHoldingsByStock, fundHoldingsByInstitution map[string][]shortsstore.FundHoldingRow // file order kept (value desc)
      fundsByInstitution map[string][]shortsstore.OwnershipFundRow
      noticeCountByStock map[string]int
      attemptsByStock map[string]map[string]int // code -> outcome -> count
      byOutcome map[string]int                  // outcome -> count, every outcome
      documentsAttempted int
  }
  // Pure: builds every index and the overview from the rows; tests call it with a fixed now.
  func newOwnershipUniverse(d *ownershipData, counts map[string]int, attempts []shortsstore.AttemptOutcomeRow, now time.Time) *ownershipUniverse

  type ownershipUniverseHolder struct {
      mu sync.Mutex
      cur *ownershipUniverse
      refreshing bool
      sf singleflight.Group
      now func() time.Time
      build func(context.Context) (*ownershipUniverse, error)
  }
  func (h *ownershipUniverseHolder) get(ctx context.Context) (*ownershipUniverse, error)
  ```
  `get` rules: (1) `cur` valid and not within `ownershipRefreshAhead` of `expiresAt`: return `cur`. (2) `cur` valid and within the window and not `refreshing`: set `refreshing`, start a goroutine that runs `build` under `context.WithTimeout(context.WithoutCancel(ctx), ownershipBuildTimeout)` through `sf.Do("universe", ...)`, swaps `cur` on success, logs on failure, clears `refreshing` either way; return `cur` now. (3) `cur` nil or expired: `sf.Do("universe", build)` synchronously (a request arriving after expiry while a background build is in flight joins it rather than starting another), swap, return. Errors are never cached. Serving past `expiresAt` is forbidden: the job's `revalidateWait` (11 min) outlasts `ownershipTTL` (10 min) only if no entry built before a run is served after R+10 min, so an expired universe rebuilds on the request path; the refresh-ahead window is what makes that rare. `build` = `loadOwnership(ctx, OwnershipFilter{}, 30, "", true)` + `st.NoticeCountsByStock(ctx)` + `st.AttemptOutcomes(ctx)` + `newOwnershipUniverse(..., h.now())` with `expiresAt = builtAt + ownershipTTL` (11 statements per build, once per TTL per instance). `ShortsServer` gains the field `ownershipUniverse *ownershipUniverseHolder`, constructed where `ownershipStore` is set. Immutable after build: handlers never mutate `data`, a view or the overview; a response that embeds a view uses `proto.Clone`.
- **`Cache` interface** (`interfaces.go`): `GetStockOwnershipKey(stockCode string, generation int64) string` and `GetInstitutionKey(slug string, generation int64) string` (both `generateKey(prefix, code, generation)`); `GetOwnershipOverviewKey` and `ListInstitutionsKey` are removed. Regenerate mocks (`cd services/shorts/internal/services/shorts && GOWORK=off go generate ./...`, the `go:generate` line at interfaces.go:13).
- **Handlers** (every one starts with `u, err := s.ownershipUniverse.get(ctx)`; a nil `ownershipStore` keeps today's empty or NotFound answers):
  - `GetOwnershipOverview`: returns `u.overview` (built by `buildOwnershipOverview(u)` at universe build: today's output plus `WithheldByOutcome` from `u.byOutcome` minus `parsed`, sorted by count desc then outcome; `DocumentsAttempted`; `OwnershipSource.Funds` and `AsAtFrom` for etf and super_phd).
  - `ListInstitutions`: clamps as today; `buildInstitutionList(u.data, kind, query, limit, offset)` per request, no cache entry.
  - `GetInstitution`: slug not in `u.data.institutions` is `CodeNotFound` (no read); notices bundle `s.cache.GetOrSetWithTTL(s.cache.GetInstitutionKey(slug, u.generation), max(time.Until(u.expiresAt), time.Second), st.SubstantialNotices(ctx, OwnershipFilter{HolderKey: slug}, 100))`; `buildInstitution(u, slug, notices)`: positions from `u.holdingsByHolder[slug]` (sorted as today), fund holdings the first 100 of `u.fundHoldingsByInstitution[slug]` with `FundHoldingsTotal = len(...)`, funds from `u.fundsByInstitution[slug]`.
  - `GetStockOwnership`: bundle `s.cache.GetOrSetWithTTL(s.cache.GetStockOwnershipKey(code, u.generation), max(time.Until(u.expiresAt), time.Second), st.SubstantialNotices(ctx, OwnershipFilter{StockCode: code}, 100))` (1 statement per miss); `buildStockOwnership(u, code, notices)`: `Summary = proto.Clone(u.views[code])` or the fallback summary (code, company name, industry, `ShortPct`/`HasShortPct` AND `ShortAsOf` from `u.data.shorts`); holders from `u.holdingsByStock[code]` sorted as today; history from `notices`; fund holdings from `u.fundHoldingsByStock[code]`; `SharesOnIssue`; `HistoryTotal = u.noticeCountByStock[code]`; `WithheldListed = sum over the six outcomes of u.attemptsByStock[code]`; `AsOf = u.data.stats.LatestAnnounced`.
- `stockViews` additions: `ShortAsOf = sp.Date`; `IndexAsAtFrom/To` = min/max `AsAt` over etf rows with units for the code, `IndexFiles` = distinct `institution|fund` among them; `LatestNoticeDate` = max `AnnouncedOn` over the stock's current holdings. `ownershipSources` tracks min and max `AsAt` per source (`AsAtFrom`, `AsAt`).
- The pairing comment at ownership.go:16-23 is rewritten: "ownershipTTL is the life of the universe and of every entry built beside it (keyed by the universe's generation); the job waits out this TTL before it revalidates (ownership.revalidateWait): change one, change the other."
- Tests (`ownership_test.go`, `ownership_universe_test.go` with a fake clock): BHP's crowded score excludes the bank (`institutionalPct(BHP) == 5.1`, BHP still in `Crowded`); `WithheldByOutcome` mapped and sorted and its sum equals `NoticesWithheld`; `DocumentsAttempted`; `Funds` and `AsAtFrom`/`AsAt` per source over a fixture with two file dates; `ShortAsOf`, index as-at range and file count, `LatestNoticeDate`; `buildStockOwnership` carries `HistoryTotal`, `WithheldListed` (six outcomes only), `AsOf`, clones the summary, and the fallback summary carries `ShortAsOf`; `buildInstitution` carries `FundHoldingsTotal`; the holder: first `get` builds synchronously; within the window it returns the current universe and starts exactly one background build which swaps; expired rebuilds synchronously and a request during an in-flight background build joins it (one build counted); a failed background build keeps the current universe and clears `refreshing`; for every `now` the universe served satisfies `now < expiresAt` (so a universe built before R is never served after R + ownershipTTL, the job's contract); a stock bundle written under generation g is not read after a swap to g+1; overview, institution list, stock and institution calls share one build; `TestLegacyDomainServiceParity` green (no rpc change).

### 4.4 Stage 2 rpcs (both on `OwnershipService` and mirrored verbatim on `ShortedStocksService` with `VISIBILITY_PUBLIC`; no MCP tool)

```proto
// A notice's event, decided once from its form and figures, ceased first:
//   ceased (the ceased flag, or Form 605), became (603), increased or
//   decreased (604 with both figures and a difference), changed (604 with no
//   previous figure, no present figure, or an equal one), nz (an NZ
//   disclosure that is not a cessation).
// Appended to SubstantialNotice:
  string event = 16;

message ListSubstantialNoticesRequest {
  // 7, 30, 90 or 365; 0 means every notice read (no date clause). Another positive
  // value rounds UP to the next served window, and one above 365 is 0; the
  // response echoes the window used. A negative value is invalid.
  int32 window_days = 1;
  // "" or one of became, increased, decreased, changed, ceased, nz.
  string event = 2;
  // "" or an institution kind.
  string kind = 3;
  // "" or an ASX code (1 to 6 uppercase alphanumerics).
  string stock_code = 4;
  // "" or a registry slug; holders off the map cannot be filtered.
  string institution_slug = 5;
  // "" for the first page, else the previous page's next_cursor.
  string cursor = 6;
  // 1 to 100; 0 means 50.
  int32 limit = 7;
  // Also compute the window's counts, weekly buckets and largest moves
  // (windows of at most 90 days; omitted above that).
  bool include_activity = 8;
}
message NoticeWeek {
  string week_start = 1;  // the Monday, YYYY-MM-DD
  int32 became = 2; int32 increased = 3; int32 decreased = 4;
  int32 changed = 5; int32 ceased = 6; int32 nz = 7;
}
message NoticeActivity {
  int32 became = 1; int32 increased = 2; int32 decreased = 3;
  int32 changed = 4; int32 ceased = 5; int32 nz = 6;
  // Every ISO week in the window, oldest first, empty weeks included.
  repeated NoticeWeek weeks = 7;
  // Form 604 notices with both figures, by the largest rise and fall in
  // percentage points; at most five each.
  repeated SubstantialNotice largest_rises = 8;
  repeated SubstantialNotice largest_falls = 9;
}
message ListSubstantialNoticesResponse {
  repeated SubstantialNotice notices = 1;
  string next_cursor = 2;   // "" on the last page
  int32 total = 3;          // notices matching the filters in the window
  int32 window_days = 4;    // echoed
  string as_of = 5;
  NoticeActivity activity = 6;  // only when include_activity and the window allows
}

message ListStockRegistersRequest {
  // disclosed (default), investors, banks, hedge_active, short, index,
  // super_value, super_options, interests, latest_notice, code.
  string sort = 1;
  bool ascending = 2;
  // "" or one of the response's industries, matched exactly after trim.
  string industry = 3;
  // A kind that must disclose 5% or more in the stock; "" for any.
  string kind = 4;
  // Interests counted once; 0 means 1.
  int32 min_interests = 5;
  // One of 0, 1, 3, 5, 10; another value snaps DOWN to the nearest served step.
  double min_short_pct = 6;
  // A code prefix or a name substring, at most 24 characters.
  string query = 7;
  int32 limit = 8;   // 1 to 100; 0 means 50
  int32 offset = 9;  // 0 to 5000
}
message IndustryCount { string industry = 1; int32 stocks = 2; }
message ListStockRegistersResponse {
  repeated OwnershipStock stocks = 1;
  int32 total = 2;      // matching the filters
  int32 universe = 3;   // stocks with at least one current holder
  repeated IndustryCount industries = 4;  // distinct, sorted, for the filter
  string as_of = 5;
}
```
- **ListSubstantialNotices handler**: clamps (limit at most 0 or over 100 becomes 50 or 100; window rounded up to {7,30,90,365}, above 365 or 0 is 0, negative `InvalidArgument`; `stock_code` trimmed, uppercased, `^[A-Z0-9]{1,6}$` else `InvalidArgument`; `institution_slug` lowercased, must exist in the universe's registry else `InvalidArgument`; `event` and `kind` validated against their vocabularies; a cursor that does not decode as `YYYY-MM-DD|url` is `InvalidArgument`). Store method `SubstantialNoticesPage(ctx, NoticeFilter, cursorDate, cursorURL, limit+1)`: WHERE built dynamically in the `ownershipWhere` style (never `$1 = '' OR`), `h.announced_on >= $since` when windowed, `(h.announced_on, h.announcement_url) < ($d, $u)` when a cursor is set, event as a SQL CASE matching the proto comment exactly (ceased first; 604 with both figures and `present <> previous` is increased or decreased; every other 604 is changed), kind via `holderKindSQL`; `ORDER BY h.announced_on DESC, h.announcement_url DESC LIMIT $n` (`announcement_url` is the primary key, so the pair is a total order). `NoticeActivity(ctx, filter)`: one aggregate with `count(*) FILTER (WHERE event = ...)` per event and `date_trunc('week', announced_on)` buckets, Go gap-fills the Mondays; two `ORDER BY (present_pct - previous_pct) DESC/ASC LIMIT 5` statements for the moves (604 with both figures only). Total = `count(*)` over the same WHERE without the cursor. Activity only for windows of at most 90 days; above that `activity` is omitted. In-process cache only for `cursor == ""`, keyed on every clamped input (`ListSubstantialNoticesKey`), TTL ownershipTTL.
- **ListStockRegisters handler**: no SQL; filters, sorts (unknowns last whatever the direction; ties by code) and pages the universe's views in memory; `interests` per stock = sum of `by_kind.holders`; `investors` = kindPct over the investor kinds; `industry` must be one of the universe's industries after trim (else `InvalidArgument`); `kind` validated; `min_short_pct` snapped down to {0,1,3,5,10}; `query` trimmed, at most 24 chars, code prefix (upper) or name substring (lower); unknown `sort` is `InvalidArgument`. Not cached per query in process.
- Tests: keyset page two starts strictly after page one's last pair; window rounding, the above-365 rule and the echo; every clamp and `InvalidArgument`; the event precedence table (ceased 604 is ceased; 604 with previous and no present is changed); activity omitted above 90 days; weeks gap-filled across a year boundary; registers sort stability and unknowns-last; the snap of `min_short_pct`; an industry outside the list rejected; the universe shared by overview, stock and registers calls; parity test green for both mirrors; openapi-drift green.

## 5. Web data path

### 5.1 KV keys (`web/src/@/lib/kv-cache.ts`)
Stage 1: `ownershipOverview: () => "cache:ownership:overview:v2"`, `stockOwnership: (code) => "cache:ownership:stock:v2:${code}"`, `ownershipInstitution: (slug) => "cache:ownership:institution:v2:${slug}"`; `ownershipInstitutions` unchanged (its response gained no field). Stage 2 adds `ownershipNotices: () => "cache:ownership:notices:v1"` and `ownershipRegisters: () => "cache:ownership:registers:v1"`, the DEFAULT view of each page only (window 30, no filters, page 1; sort disclosed desc, no filters, offset 0); no other query is ever a KV key. Stage 2 bumps the overview and stock keys to v3 only if one of their readers starts reading `SubstantialNotice.event`. Every key keeps the `cache:ownership:` prefix (the job's flush and the revalidate route reach it). Test `web/src/@/lib/__tests__/kv-cache-ownership-keys.test.ts` pins the exact strings.

### 5.2 `web/src/app/actions/getOwnership.ts`
Unchanged shape; the three readers use the v2 keys. The stock predicate stays `holders.length > 0 || fundHoldings.length > 0`.

### 5.3 `web/src/app/ownership/stocks/[code]/register-data.ts` (plain server module, not "use server")
`readRegister(code)`: `ownership = await getStockOwnership(code)`; `undefined` throws "ownership data transiently unavailable for {code}; failing the ISR render"; `summary == null` throws (the one predicate the strip shares); returns the response. No stock read. Wrapped in React `cache`.

### 5.4 `web/src/app/actions/getStockRegisterStrip.ts` (new)
Copy `getStockStrategyFit.ts`'s contract: `unstable_cache(fn, ["stock-register-strip", normalizeStockPageCacheCode(code), "v1"], { revalidate: 3600, tags: stockPageCacheTags("register-strip", code) })`; transport `createConnectTransport({ fetch: serverFetchOutsideNextCache, baseUrl: SERVER_SHORTS_API_URL })` with an `AbortController` fired after `REGISTER_STRIP_TIMEOUT_MS` (the `withTimeout` helper of the fit action), `REGISTER_STRIP_TIMEOUT_MS = 4000` (section 11 sets it from the measured cold build), no retry, errors thrown inside (never cached); `skipForBuild()` throws like the fit action (the page's catch hides the strip). Calls `getStockOwnership({ stockCode })` on `OwnershipService`. `summary == null` throws (never cached). Returns `null` when `holders.length === 0` (a real answer, cached), else `StockRegisterStrip`:
```ts
export interface StockRegisterStrip {
  stockCode: string; holders: number; interests: number; disclosed: string;
  indexPct: string | null; indexAsAtFrom: string; indexAsAtTo: string; asOf: string;
  rows: Array<{ name: string; href: string | null; kind: string; votingPower: string; asAt: string; age: string }>; // top 3 by voting power
}
```
(`interests = sum(summary.byKind.holders)`; `disclosed = formatSum`; `age = ageLabel(asAt, asOf)`.) Deliberately NOT tagged "ownership" and reads no KV: the daily sync's layout expiry and the hourly revalidate refresh it, and the job's ping must not add a second regeneration wave to the Overview.

### 5.5 Stage 2 actions
`web/src/app/actions/ownershipExplorer.ts` ("use server", async exports only): `loadNoticeFeed(q)` and `loadStockRegisters(q)`; clamps live in `web/src/@/lib/ownership/query.ts` (pure, mirrored from Go, tested from a shared JSON fixture `web/src/@/lib/ownership/__fixtures__/clamps.json` that a Go test also reads; `loadNoticeFeed({})` defaults to window 30); each never throws and returns `{ ok, activityOk, query (echoed), rows: string rows, total, asOf, ... }` where `activityOk` is true when activity was not requested or was returned, false only when it was requested for a window that allows it and did not come back. Activity is asked for only on a first page (`cursor` empty) and the API returns it only there, so a load-more never requests it and never reads `activityOk` false; the default view is KV-cached under 5.1's keys with non-emptiness predicates; every other query goes to Cloud Run through the ISR-tagged transport (the data cache cannot key a Connect POST; the API's in-process page-1 cache and the in-memory registers are the dedupe). The same function serves the page's default render and the island.

## 6. Components (stage 1 unless marked)

| # | Name | File | Boundary | Props | Draws | Tests |
|---|---|---|---|---|---|---|
| 6.1 | `buildHolderLanes`, `ageLabel`, `ageMonths` | `web/src/@/lib/ownership/trace.ts`, `web/src/@/lib/ownership/age.ts` | pure | section 2; `ageLabel(asAt, asOf)` → `""` when at most 90 days or either date invalid, else `"{round(days/30.44)} mo"` | nothing | section 2; `age.test.ts`: 90 days → "", 91 → "3 mo", 400 → "13 mo", invalid → "" |
| 6.2 | `HolderLanes` | `components/ownership/holder-lanes.tsx` | server | `{ lanes, from, to, yearLabels, truncated, code, historyTotal, withheldListed, maxLanes?: 12 }` | section 2 | section 2 |
| 6.3 | `DisclosedBar` | `components/ownership/disclosed-bar.tsx` | server-safe, no directive, plain props | `{ segments: Array<{kind: string; pct: number; holders: number}>, total: number, scaleMax: number, showFigure?: boolean (default true), caption?: string, className? }` | `<div role="img" aria-label="{copy bar.aria}">`: an outlined track `border border-muted-foreground rounded-[1px] h-2.5` (never `border-input`, the control token) with `width: {total/scaleMax*100}%` (min 2px); inside, segments in `KIND_ORDER`, width `pct/total*100%`, fill `kindInfo(kind).swatch` (light and dark classes), `other` and `unclassified` hollow (no fill), each with `box-shadow: inset -1px 0 0 hsl(var(--card))` as the gap so adjacent segments stay distinct whatever their contrast; the figure `formatSum(total)` after the track in `text-xs tabular-nums` when `showFigure`; a `caption` line in `text-[11px] text-muted-foreground` when given. No background track, never 100%. Replaces `KindBar`, which is deleted. | `disclosed-bar.test.tsx`: width equals total/scaleMax; full width when scaleMax = total; no element wider than the outlined track; unclassified segment has no swatch class; aria sentence contains "not a share of the company"; the outline uses `border-muted-foreground` and not `border-input`; sum printed to two decimals |
| 6.4 | `KindBadge` | `components/ownership/kind-badge.tsx` | server-safe | `{ kind }` | the badge as today (P2 creates the file; P6 makes ownership-parts re-export it) | `kind-badge.test.tsx`: label and swatch |
| 6.5 | `RegisterReadout` | `components/ownership/register-readout.tsx` | server | `{ code, disclosed: string, interests: number, holders: number, asOf: string, indexPct: string|null, indexFiles: number, indexFrom: string, indexTo: string, superOptions: number, superValue: string|null, superFrom: string, superTo: string, segments, total }` | `<section aria-label="The register" class="rounded-lg border bg-card p-4 shadow-terminal-inset">`: a `<dl class="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">`, cells `bg-card p-3`, `dt` = stock-header LABEL classes, `dd` = text-2xl tabular; copy `readout.*`; under the dl `DisclosedBar` with `caption = bar.caption`. Short interest is NOT in the readout (kinds and short interest never share a panel); it lives in the plate and the link row. | `register-readout.test.tsx`: n/a never 0; three cells, none named short; metas carry their own dates or ranges |
| 6.6 | `OwnershipPlate` | `components/ownership/ownership-plate.tsx` | server-safe | `{ items: Array<{ text: string; dateTime?: string; href?: string }> }` | one `<p>` in the PicksProvenance classes, items joined by " · ", dates in `<time>`, the last item always the "Not financial advice" link to `/disclaimer` | `ownership-plate.test.tsx`: reads as one sentence; `<time dateTime>` set; ends with the disclaimer link |
| 6.7 | `OwnershipReportError`, `OwnershipSourceLines` | `components/ownership/ownership-provenance.tsx` | server-safe | `{ subject }`; `{ lines: Array<{ text: string; asAt?: string }> }` | `copy.report` with `mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(subject)}`; a `<ul>` of source lines | `ownership-provenance.test.tsx`: mailto subject encoded; link text "Report an error" |
| 6.8 | `WithheldBreakdown` | `components/ownership/withheld-breakdown.tsx` | server | `{ outcomes: Array<{ outcome: string; count: number }> }` | `<dl>` of the six withholding outcomes with `OUTCOME_COPY` phrases (kinds.ts), then the line `withheld.apart` naming not_a_notice and fetch_error counts; unknown outcomes print their raw name | `withheld-breakdown.test.tsx`: eight outcomes labelled; apart line; unknown raw |
| 6.9 | `PooledFundMark` | `components/ownership/pooled-fund-mark.tsx` | server-safe | `{}` | the letter P glyph with sr-only `pooled.sr` (DESIGN.md: a non-default source is a letter plus screen-reader text, never colour) | `pooled-fund-mark.test.tsx`: sr text |
| 6.10 | `StockFundTable` | `components/ownership/stock-fund-table.tsx` | server | `{ rows: FundHolding[] (type), code, limit?, moreHref? }` | Fund (HolderName over `fundLabel`, `PooledFundMark` on `isPooledFile` rows), Source (Index fund file / Super option), Value, Of shares, Of fund (`formatFundWeight`), As at per row; caption `register.funds.caption`; "and {k} more in the full register →" when limited; used by the register page (every row) and the Company card (8) | `stock-fund-table.test.tsx`: pooled mark only on `etf` + `vanguard`; `<0.01%` rule kept; per-row as-at |
| 6.11 | `RegisterStrip` | `components/stocks/register-strip.tsx` | server, props-only, no protobuf or connect import | `{ strip: StockRegisterStrip }` | section 3.3; imports `KindBadge` from `kind-badge.tsx` only | `register-strip.test.tsx`: one summary line; at most three names; no "0" or "n/a"; hrefs; footer links (register, disclaimer, mailto) |
| 6.12 | `StockOwnershipView` (revised) | `components/ownership/stock-ownership-view.tsx` | server, reaches no client module | `{ data: GetStockOwnershipResponse }` | section 3.2; `StockFundTable limit={8}`; links through `registerHref` | `ownership.test.tsx` cases rewritten: heading `company.title`; description basis; 8 rows; "Full register" href; `/shorts/F99/company` stock links become `/ownership/stocks/F99`; footer carries disclaimer and mailto |
| 6.13 | `ownership-parts.tsx` (revised) | same | server | `KindBar` deleted; `KindBadge` re-exported from `kind-badge.tsx`; `INSTITUTIONAL` → `INVESTOR_KINDS` without `bank_broker`; `OwnershipStockTable` links via `registerHref`, `bar` column = `DisclosedBar scaleMax={max disclosedPct in the table} showFigure={false}`; `OwnershipMethodology` copy `method.*` | `ownership.test.tsx`: institutional column excludes banks (fixture PLS 11.50 unchanged; add a bank share and assert it is not counted); link hrefs |
| 6.14 | `ownership-tables.tsx` (revised) | same | client island | `StockLink` → `registerHref(code)`; no other change | `ownership.test.tsx` hrefs; `client-boundary.test.ts` green |
| 6.15 | `kinds.ts` additions | `web/src/@/lib/ownership/kinds.ts` | pure | `registerHref(code) = "/ownership/stocks/" + code.toUpperCase()`; `REGISTER_CODE_PATTERN = /^[A-Z0-9]{1,6}$/`; `RESERVED_SLUGS = ["stocks","notices"]`, `isInstitutionSlug` rejects them; `isPooledFile(f) = f.sourceKind === "etf" && f.institutionSlug === "vanguard"`; `INVESTOR_KINDS`; `OUTCOME_COPY`; `WITHHOLDING_OUTCOMES` (the six); `asAtRange(from, to)` ("as at {d}" or "as at {from} to {to}"); swatches gain dark pairs where the light swatch fails 3:1 on #121212: corporate `bg-[#483932] dark:bg-[#B5A48C]`, private_equity `bg-[#9E5210] dark:bg-[#C77A2A]` (the other swatches hold 3:1 in both rooms; a full re-tone is the owner's, Unresolved); `KIND_INFO.bank_broker.note` = "Often securities lending: shares lent to, or held as collateral from, short sellers." | | `kinds.test.ts` (new): reserved slugs rejected; `registerHref("bhp") === "/ownership/stocks/BHP"`; `holderHref("", "asx:SFR")` still `/shorts/SFR/company`; `asAtRange` one date when equal |
| 6.16 | `rows.ts` additions | `web/src/@/lib/ownership/rows.ts` | pure | `holdingRow` gains `age` (needs `asOf` param, default "") | | existing tests + age |
| 6.17 | `registerIsIndexable` | `web/src/@/lib/ownership/register-indexability.ts` | pure | `({ holders: number }) => holders >= 1` | | `register-indexability.test.ts` |
| 6.18 | Register page, loading, OG | `web/src/app/ownership/stocks/[code]/page.tsx`, `loading.tsx`, `opengraph-image.tsx`, `register-data.ts` | server | section 3.1; OG: `OgCard eyebrow="ASX:{CODE} register" title="{company} substantial holders" subtitle={og.subtitle} stats=[disclosed, interests, short (only when hasShortPct)] footer="ASX substantial holding notices to {as_of}"`, module-level `export const alt = og.alt.register` (static: no OG route in this app has a per-param alt, and Next 14 would need `generateImageMetadata` and a changed image URL), `revalidate = 3600`, a failed read draws the card without stats, never a 500 | `page.test.tsx`: invalid code 404 before any read; transient undefined throws; no summary throws; an unknown code (empty summary, no rows, no history, no short figure) is 404; no current holder with a name = empty state + NOINDEX; all-ceased = lanes drawn + `register.ceased` + NOINDEX; indexable sets no robots key; title at most 60; withheld sentence only when > 0 and never in the plate; every `StockLink`-style code link and every stock column href starts with `/ownership/stocks/`; the link row present only with `hasShortPct` and absent for a five-character code; `#ownership` and overview hrefs; the only `shadow-terminal-inset` on the page is the readout; `opengraph-image.test.tsx`: never throws; alt has no em dash |

Stage 2 and 3 components (`NoticeFeedExplorer`, `NoticeMark`, `NoticeWeekBars`, `RegistersExplorer`, `RegisterRowsTable`, `InstitutionDirectory`, `RankedRack`) are specified in section 10.

## 7. Copy (id: text). `{braces}` are substitutions. Never "of the voting power", never "'s voting power", never "sold" or "sale", never "index ETF", never an em dash.

- `register.h1`: `{company} substantial holders`
- `register.lede`: `Who holds {CODE} as its ASX substantial holding notices state it: every holder of 5% or more whose notice we could read, what that notice states, and how each holding stepped from notice to notice. Index fund files and super fund option disclosures sit beside the notices, never added to them.`
- `register.plate.notices`: `Notices read to {as_of}` · `register.plate.short`: `short interest {x}% of {shares} shares on issue, as of {short_as_of} (ASIC, T+4)` (shares omitted when not held) · `register.plate.index`: `index fund files {asAtRange}` · `register.plate.super`: `super options {asAtRange}` · last item `Not financial advice` (link). No withheld item in the plate.
- `register.links`: `Stock overview →` · `Company tab →` · `Short interest →`
- `readout.disclosed.label`: `Disclosed by notices` · `readout.disclosed.meta`: `{k} interests counted once, {n} holders; not a share of the company` · `readout.disclosed.none`: `no current holder read` · `readout.index.label`: `Index funds tracked` · `readout.index.meta`: `{f} files, {asAtRange}` · `readout.index.none`: `no file tracked holds it` · `readout.super.label`: `Super options tracked` · `readout.super.meta`: `{value} combined, {asAtRange}` · `readout.super.none`: `none tracked holds it`
- `bar.caption`: `What the notices disclose, each interest counted once; not a share of the company.`
- `bar.aria`: `Disclosed voting power {total}, what the notices disclose and not a share of the company: {kind label} {pct} ({n} holders), ...`
- `register.lanes.caption`: `One line per holder, stepping at each notice read, on its own scale from 5% up: a small step on a large holding is slight here and exact in the figures beside it. Flat between notices means no later notice was read: a holding can move by less than the 1 percentage point that requires a new notice, and a notice we withheld is not drawn. A line ending at the 5% edge is a cessation (Form 605): under 5%, not zero. A dotted tail is the time since the holder's last notice read; a dotted lead-in is the previous figure the first notice drawn states. A notice without an event date sits on its release date. From {from} to {to}.`
- `register.lanes.truncated`: `The latest 100 of {history_total} notices; earlier notices are not drawn. `
- `register.lanes.sr`: `The notices behind each line are listed in the Notices table below.`
- `register.lanes.more`: `{n} more holders`
- `register.age.title`: `No later notice read: the holding may have moved by under 1 percentage point, or a later notice may be one we withheld or one filed under another name.`
- `register.withheld`: `{n} notices listed under {CODE} were withheld: not read or not reconcilable, never estimated.`
- `register.ceased`: `No current substantial holder read for {CODE}: the {n} notices read for it end in cessations (Form 605, under 5%). The lines below are what was read.`
- `register.empty.holders`: `No substantial holder notices read for this stock. A holder of 5% or more may still exist: a notice never lodged is not on record, and a notice we could not read is withheld.`
- `register.funds.caption`: `Index fund figures are the funds' own holdings files; Vanguard's are the pooled fund behind each ETF, not the ETF alone (marked P). Super fund figures are one investment option's disclosure, never the whole fund. Each row carries its file's date.`
- `register.funds.empty`: `No index fund file or super option disclosure tracked holds {CODE}. Only funds that publish a holdings file are tracked, and most do not; ` + `the hub lists them` (link /ownership#coverage) + `.`
- `register.notices.truncated`: `The latest 100 of {history_total} notices read for {CODE}.`
- `register.sources.notices`: `ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF; read to {as_of}.` · `register.sources.index`: `Index fund holdings files: {f} files holding {CODE}, {asAtRange}.` · `register.sources.super`: `Super fund portfolio holdings disclosures, one option per fund: {s} options holding {CODE}, {asAtRange}.` · `register.sources.short`: `ASIC short position report, as of {date}, published T+4.`
- `register.meta.description`: `{company} (ASX:{CODE}) substantial holders as their ASX notices state them: {k} interests disclosing {sum} between them, with index fund and super option holdings and the latest {h} notices read since 2024.`
- `og.subtitle`: `Substantial holders as their ASX notices state them, beside the index funds and super options that hold it.` · `og.alt.register`: `Substantial holders from ASX notices, on Shorted` · `og.alt.hub`: `Who owns the ASX, on Shorted` · `og.alt.institution`: `An institution's ASX holdings, on Shorted`
- `pooled.sr`: `pooled wholesale fund, not the ETF alone`
- `copy.report`: `Spotted a problem with a figure? ` + `Report an error` (mailto) + ` and the affected notice will be read again against its PDF.`
- `strip.title`: `Substantial holders` · `strip.description`: `Who holds {CODE}, as its notices state it` · `strip.summary`: `{n} holders, {k} interests counted once, disclose {sum} between them; largest: {name1} {pct1}, {name2} {pct2}, {name3} {pct3}` (as many names as there are, at most three; each with " as at {date}" only when its age is non-empty, printed as "{name} {pct} ({age})") + (when has_index_pct) `; index funds tracked hold {x}% of shares on issue (files {asAtRange})` · `strip.footer`: `Notices read to {as_of} · what the notices disclose, not a share of the company · ` + `Not financial advice` (link) + ` · ` + `Report an error` (mailto, subject `Ownership data: {CODE} register`) · `strip.link`: `Full register →`
- `company.title`: `Substantial holders` · `company.description`: `{n} holders, {k} interests counted once, disclose {sum} between them; held by {e} index funds and {s} super options tracked (Vanguard's files are the pooled fund's)` · `company.description.none`: `No current substantial holder read for this stock; held by {e} index funds and {s} super options tracked` · `company.funds.heading`: `Index funds and super options` · `company.funds.suffix`: `index funds tracked hold {x}% of shares on issue (files {asAtRange})` · `company.funds.more`: `All {n} fund rows in the full register →` · `company.footer`: `From ASX substantial holding notices (5% or more), index fund holdings files and super fund portfolio holdings disclosures (one option each). Holders' interests can overlap, so the sum is what the notices disclose.` + ` ` + `{company.withheld.short when > 0}` + ` · ` + `How ownership is read →` (/ownership#method) + ` · ` + `Full register →` + ` · ` + `Not financial advice` (/disclaimer) + ` · ` + `Report an error` (mailto) · `company.withheld.short`: `{n} notices listed under {CODE} were withheld.` · `company.none.line`: `No current substantial holder read for {CODE}` + (when history_total > 0) `: its {n} notices read end in cessations` + (when withheld_listed > 0) `; {m} notices listed under it were withheld` + `. ` + `Full register →` + ` · ` + `How ownership is read →`
- `hub.lede`: `Super funds, index funds, hedge funds, banks and the rest of the register: substantial holding notices read from their PDFs, the ASX-listed holdings in the latest files of {f} index funds and {s} super fund options (one option per fund), and where a crowded register meets heavy short interest.`
- `hub.meta`: `Which super funds, index funds, hedge funds, banks and other institutions hold ASX stocks: substantial holding notices read from their PDFs, the ASX holdings in the latest files of the index funds and super fund options tracked, and where crowded registers meet high short interest.`
- `hub.og.subtitle`: `Super funds, index funds, hedge funds and banks: substantial holding notices read from their PDFs, and the ASX holdings in the latest files of the index funds and super fund options tracked.`
- `hub.llm.source`: `ASX substantial holding notices; APRA fund-level statistics; ASX Investment Products report; the holdings files index funds and super fund options publish`
- `hub.plate`: `Notices read to {asOf}` · `index fund files {asAtRange(etf)}` · `super option files {asAtRange(super_phd)}` · `ASIC shorts T+4` · `Not financial advice`
- `hub.tile.read`: `Notices read` · `hub.tile.withheld`: `Notices withheld` · `hub.tile.withheld.meta`: `of {attempted} documents attempted` · `hub.tile.withheld.details`: `Withheld, by outcome` · `hub.tile.withheld.all`: `Documents not parsed (all outcomes)` · `hub.tile.indexfiles`: `Index fund files` · `hub.tile.indexfiles.meta`: `of {etfs} exchange-traded products; {asAtRange}` · `hub.tile.superfiles`: `Super option files` · `hub.tile.superfiles.meta`: `of {superFunds} APRA funds; {asAtRange}`
- `hub.sources.registers`: `ASX Investment Products report and APRA fund-level statistics: {etfs} exchange-traded products, {lics} listed investment companies and trusts, {superFunds} APRA-regulated super funds.`
- `OUTCOME_COPY`: no_text `no text layer (a scan)` · no_voting_power `voting power not stated, or only in an annexure` · implausible `figures that do not reconcile` · ambiguous_target `company not identified` · no_holder `holder not named` · inconsistent_votes `votes do not fit the share count` · not_a_notice `not a substantial holding form` · fetch_error `not yet downloaded (retried)`
- `withheld.apart`: `A further {n} documents were not substantial holding forms and {m} have not yet been downloaded; neither is a withheld notice.`
- `hub.crowded`: `Stocks where investors (super funds, index and active managers, hedge funds, sovereign funds and insurers) disclose the most voting power between them. Banks and brokers (often securities lending), listed companies and private holders are not counted.` · `hub.bothways`: `Hedge funds and active managers together disclose 5% or more, and at least 3% of the shares are reported short. Two disclosures on one page, not a finding.` · `hub.lending`: `Banks and brokers with a substantial interest, often securities lending (shares lent to, or held as collateral from, short sellers), beside each stock's short interest.` · `hub.index`: `The share of each company held by the index funds tracked (iShares, Vanguard, SPDR, Betashares), from their latest holdings files. Vanguard's files cover the whole fund behind each ETF, so VAS's figures are the fund's, not the ETF's alone.` · `hub.super`: `What the tracked super fund options hold most of, by combined value: each fund's default or balanced option, from its portfolio holdings disclosure, {asAtRange}.`
- `institution.files.lede`: `The largest ASX holdings, by value, in the latest holdings files {name} publishes` + ` (one investment option, not the whole fund)` for a super fund + `.` · `institution.files.capped`: `The largest {shown} of {total} ASX holdings in its files.`
- `method.p1`: `Substantial holdings are the voting power stated in each holder's latest ASX notice (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF. A holding is shown until a later notice read says it changed or ceased; the date is the notice's, and "current" means the newest notice we could read. A notice whose voting power cannot be read unambiguously (a scanned form, a figure only in an annexure) is withheld, never estimated.` · `method.p2`: `Holders' interests can overlap: MUFG reports Morgan Stanley's and First Sentier's interests as its own. Sums count each interest once where the overlap is known (a group and its member count the larger figure; two notices disclosing the same voting power on the same date count once), and every holder is still listed. Other overlaps remain, so a sum is what the notices disclose, not a share of the company. Banks' and brokers' notices are often securities lending, so crowded registers do not count them. A fall in voting power is a fall in the notice's figure, not necessarily a disposal: a placement dilutes a holder whose shares did not change.` · `method.p3`: `Index fund holdings are the funds' own holdings files (Vanguard's are the pooled fund behind each ETF); super fund holdings are each fund's portfolio holdings disclosure for one investment option, not the whole fund. Short interest is ASIC's daily short position report. Not financial advice.`
- Report-an-error subjects: `Ownership data: {CODE} register` · `Ownership data: hub` · `Ownership data: {institution name}` · (stage 2) `Ownership data: notices feed` · `Ownership data: registers`.
- Stage 2: `feed.lede`: `Substantial holding notices we could read, newest release first: who became substantial, whose holding changed by a percentage point or more, and who ceased. A fall is reported as a fall, not as a disposal: share counts change too.` · `feed.outage`: `The notices could not be read just now. Nothing here is missing from the register: this is our end.` · `feed.empty`: `No notices read match these filters in the last {window} days.`

### 7.1 Stage 2 amendments (2026-11-03, after the stage 2 review)

Copy ids the review found missing. Pasted verbatim, as section 7's are.

- `feed.empty.all` (the whole-register window): `No notices read match these filters.` The feed names no start date: window 0 is every notice read, and the record's first day is not a fact the API states.
- `registers.empty`: `No stock matches these filters.`
- `registers.past_end`: `This page is past the last stock.` followed by the link `First page` (a filter link: `rel="nofollow"`, `replace`, `scroll={false}`, `prefetch={false}`).
- `registers.outage`: `The registers could not be read just now. Nothing here is missing from the register: this is our end.` (the register list's own outage, never `feed.outage`).
- `registers.query_chip`: `Matching "{q}"`, a removable chip whose accessible name is `Matching "{q}", clear search` (the visible text first, so a voice-control user can say what they see: WCAG 2.5.3); it carries no `aria-current`.
- `registers.basis`: the register list prints `bar.caption` as a visible line under its table, so the four sums are captioned on every width (the DisclosedBar is hidden below `md` and the table caption is sr-only).
- `explorer.loading`: `Loading…` with `aria-label="Loading"`, the one loading line both islands use.
- `weeks.label`: the week bars' accessible name and table caption read `Notices by week over {scope}`; the figcaption prints `{n} notices` only when there is at least one week, else `n/a`; a range is written `{from} to {to}` in tabular figures, never with a dash.
- Event labels are sentence case at the start of a cell or an option (`Became substantial`, `Increased`, `Decreased`, `Changed`, `Ceased`, `NZ disclosure`), as `formLabel` already prints them; an event named mid-sentence takes lower case. Section 10's lower-case list is the vocabulary, not the cell text. There is no short form: a narrow screen wraps the label.

Decisions the review asked for.

- The feed's phone grammar (below `sm`): Released folds into the Event cell (the date under the label) and the holder folds under the stock code; every value is rendered once, with responsive classes, never a hidden twin. The feed table never scrolls sideways at 360 px.
- The register list below `sm`: the four visible columns (Stock, Disclosed, Short, Latest notice) fit 360, 375 and 390 px with one row's details open (`scrollWidth <= clientWidth`); a company name breaks with `[overflow-wrap:anywhere]`, and the details list is `grid-cols-[minmax(0,auto)_minmax(0,1fr)]` or its own full-width row. From `lg`, the Short and Index funds figures print their dates in a muted `text-[10px]` line under the figure; a date is never only a `title`.
- "All notices for {CODE} →" and the institution's "All notices →" carry `window=all` (the island reads it as `NOTICE_WINDOW_ALL`), so the link shows at least what the page already does; the register link is drawn only when `history_total > 0`, the institution link only when its notice count is positive; both filtered links carry `rel="nofollow"` (over 1,100 near-duplicate URLs otherwise). The hub's bare `/ownership/notices` link stays followable.
- The notices page passes the registry to the island only when it holds the whole directory (`directory.total <= institutions.length`); otherwise it passes none and the API validates a `?holder=` slug against the full registry. With a registry, an unlisted slug from the link is kept as an option labelled by its slug, never silently dropped.
- The holder filter in the feed's clamp refuses a key that is not an institution slug (`name:`, `asx:`, a reserved segment), the same rule the codec applies.
- A whole number above 365 in the link, int32 or not, reads as every notice; a negative reads as the default.
- The hub `/ownership` joins `OWNERSHIP_STATIC_ROUTES` in `route-kinds.mjs`, so the manifest gate covers all three static ownership pages.
- `warm-cache/route.ts` reads shell pages six at a time (17 pages: batches of 6, 6 and 5, a 120 s worst case under the 150 s ceiling and the callers' 145 s); its comment and `docs/deployment/vercel-cost-reduction.md` say so.
- The ISR-tagged ownership transport and the KV last-good read helper live once, in a plain server module both `getOwnership.ts` and `ownershipExplorer.ts` import; a "use server" file exports async functions only.
- A refused query is logged (`console.warn`, cut to about 200 characters) and a Connect `InvalidArgument` from the API maps to `{ ok: false, error: "refused by the API: ..." }`, distinct from an outage's empty error.

Second round (2026-11-03, after the islands' measurements: the register list needed about 1,389 px for its eleven columns and scrolled sideways at 1024 and 1280 px signed in; the feed scrolled between `sm` and `md`; dates split at their hyphens from `lg`).

- The register list has three grammars, switched on the TABLE's own width (a container query: `[container-type:inline-size]` on the wrapper, `@container(min-width:980px)` and `@container(min-width:1320px)`), not the viewport, because the signed-in rail takes 288 px of it; every value is rendered once. Below 980 px: two rows per stock, the figures row (Stock = the code only, Disclosed, Short, Latest notice) and a full-width row (`<tr><td colSpan>`) holding the company name and the native `details` with the other measures. From 980 px: the company name and the industry sit under the code in the Stock cell (`truncate`, `max-w-[14rem]`; the industry wraps within the cap), and Institutions, Index funds and Super value become columns, the Short and Index dates print under their figures; the DisclosedBar sits in the Disclosed cell from `md` at `w-24`, widening at 1,320 px. From 1,320 px: Banks and brokers, Hedge + active, Super options and Interests become columns too and the full-width row is hidden (the `details` holds whatever is not a column at the current width). The thresholds leave 13 px over the widest measured sort. Cells are `px-1` below `sm`, `px-2` from `sm`; heads are 11 px below `sm`. (Amended 2026-11-03: the viewport grammar first written here failed its own band check at 1024 and 1280 px signed in.)
- Every date in the register list is one line: `whitespace-nowrap` on each `<time>` (`Dated` takes a `timeClassName`); a range wraps only between its words.
- The feed's stacked phone grammar runs up to `md` (its folds use `md:` prefixes); from `md` the columns stand.
- Band checks, with one row's details open on the register list and the signed-in rail where it says so: 360, 375 and 390 (signed in), 640 and 768 (signed in), 1024 (signed out) and 1280 (signed in). No table wrapper scrolls sideways at any of them (`scrollWidth <= clientWidth`); the package measures static markup of the real islands with the app's CSS, and the owner's visual pass measures the running app.
- The post-deploy smoke re-primes the shell pages six at a time (a batch loop with `wait`, the route's own concurrency), each with its 90 s cap, and its job timeout covers 145 s plus `ceil(n / 6) * 90` s plus the route checks. A test pins the route's budget against the real list: `60 + 30 * (ceil(n / CONCURRENCY) - 1) <= 145`, reading CONCURRENCY from the route file's source (a route file cannot export it: Next refuses unknown exports).

## 8. Cross-link map

| From | To | Via |
|---|---|---|
| Register page | `/shorts/{CODE}`, `/shorts/{CODE}/company#ownership`, `/shorts/{CODE}/short-interest` | header link row, only when `has_short_pct` and the code matches `STOCK_CODE_PATTERN`; `stockTabHref`, `prefetch={false}` |
| Register page | `/ownership/{slug}` | `HolderName` on lanes and fund rows |
| Register page | `/shorts/{CODE2}/company` | a listed holder's name (`holderHref`, the one exception to "every stock link points at the register") |
| Register page | ASX PDF | `safeExternalHref`, one `ExternalLinkSymbol` per page |
| Register page | `/ownership`, `/ownership#method`, `/ownership#coverage` | breadcrumb, footer, method link, the funds empty state |
| Overview strip | `/ownership/stocks/{CODE}`, `/ownership/{slug}`, `/disclaimer`, mailto | "Full register →", names, footer |
| Company card | `/ownership/stocks/{CODE}`, `/ownership/{slug}`, `/ownership#method`, `/disclaimer`, mailto, ASX PDFs | footer, names |
| Hub tables, latest notices | `/ownership/stocks/{CODE}` | `OwnershipStockTable`, `StockLink` |
| Institution page stake and file rows | `/ownership/stocks/{CODE}` | `StockLink` |
| Hub, institution, register | mailto report-an-error | `OwnershipReportError` |
| Stage 2: hub, register, institution | `/ownership/notices?stock=`, `?holder=` | "All notices →" |
| Stage 2: hub rack | `/ownership/stocks?sort=` | "Full list, sorted this way →" |
| Stage 2: sitemap-ownership.xml | register pages (holders at least 1, cap 1,000, lastmod `latest_notice_date`) | `buildOwnershipSitemap` |

## 9. Stage 1 work packages (one PR; strict file ownership; a file appears in exactly one package; the dependency order is P0 → P1 → P2 → P3 → {P4, P5, P6} → P7, and a package compiles once the packages it imports have landed)

**P0 (first, serial)**: `proto/shortedapi/shorts/v1alpha1/ownership.proto`; `make openapi` from the repo root (commit services/gen, web/src/gen, sdks/java, api/schema, web/public); `services/shorts/internal/store/shorts/postgres_ownership.go`, `postgres_ownership_pg_test.go`; `services/shorts/internal/services/shorts/ownership.go`, `ownership_universe.go`, `ownership_test.go`, `ownership_universe_test.go`, `interfaces.go`, `cache.go`, `mocks/mock_interfaces.go` (go generate), the constructor file that sets `ownershipStore`. Gate: `cd services && GOWORK=off go test ./... -short`, `golangci-lint --concurrency 1`, `go mod tidy -diff`, openapi drift test.

**P1 lib** (after P0's generated types): `web/src/@/lib/ownership/trace.ts`, `age.ts`, `kinds.ts`, `rows.ts`, `register-indexability.ts`, `__tests__/trace.test.ts`, `__tests__/age.test.ts`, `__tests__/kinds.test.ts`, `__tests__/register-indexability.test.ts`.

**P2 leaf components** (after P1): `components/ownership/holder-lanes.tsx`, `disclosed-bar.tsx`, `kind-badge.tsx`, `pooled-fund-mark.tsx`, `register-readout.tsx`, `ownership-plate.tsx`, `ownership-provenance.tsx`, `withheld-breakdown.tsx`, `stock-fund-table.tsx` and their `__tests__/*.test.tsx` (one per file). These import from P1 and from each other only, never from `ownership-parts.tsx`.

**P3 data path** (after P0): `web/src/app/actions/getOwnership.ts`, `getStockRegisterStrip.ts`, `web/src/@/lib/kv-cache.ts`, `web/src/@/lib/__tests__/kv-cache-ownership-keys.test.ts`, `web/src/app/actions/__tests__/getStockRegisterStrip.test.ts` (null on no holders, throws on no summary and on failure, 4 s abort, key and tags pinned, no KV import).

**P4 register page** (after P2, P3): `web/src/app/ownership/stocks/[code]/page.tsx`, `loading.tsx`, `opengraph-image.tsx`, `register-data.ts`, `page.test.tsx`, `opengraph-image.test.tsx`.

**P5 stock pages** (after P2, P3): `web/src/@/components/stocks/register-strip.tsx` + `__tests__/register-strip.test.tsx`; `web/src/app/shorts/[stockCode]/page.tsx`; `company/page.tsx`; `__tests__/overview-page-mocks.tsx` (mock `~/app/actions/getStockRegisterStrip` → `jest.fn(async () => null)`); `__tests__/page-old-api.test.tsx` (assert `critical` does not contain `getStockRegisterStrip` and the source matches `/getStockRegisterStrip\(stockCode\)\.catch\(/`); `company/__tests__/company-ownership-anchor.test.tsx` (section id, scroll-mt, the three states).

**P6 existing ownership surfaces** (after P2, P3): `components/ownership/ownership-parts.tsx`, `ownership-tables.tsx`, `stock-ownership-view.tsx`, `__tests__/ownership.test.tsx`, `__tests__/client-boundary.test.ts` (extend: `holder-lanes`, `register-readout`, `stock-fund-table`, `stock-ownership-view`, `register-strip` reach no client module; `ownership-tables`, `disclosed-bar`, `kind-badge`, `pooled-fund-mark` reach no `gen/`, protobuf, connect or action); `web/src/app/ownership/page.tsx`, `page.test.tsx`, `opengraph-image.tsx` (static alt `og.alt.hub`, subtitle), `opengraph-image.test.tsx`; `web/src/app/ownership/[slug]/page.tsx`, `page.test.tsx` (hrefs → `/ownership/stocks/`, reserved slugs, capped caption), `opengraph-image.tsx` (static alt `og.alt.institution`).

**P7 guards and records** (last): `web/scripts/route-kinds.mjs` (a second export `OWNERSHIP_ROUTES = ["/ownership/[slug]", "/ownership/stocks/[code]"]` checked by `main` with its own line "2 ownership routes are ISR"; the stock line unchanged) and `scripts/tests/route-kinds.test.mjs` (a case for the ownership list); `web/src/app/__tests__/isr-hubs.test.ts` (HUBS gains `ownership/page.tsx`, `ownership/[slug]/page.tsx`, `ownership/stocks/[code]/page.tsx`); `web/src/app/ownership/__tests__/isr-source-safety.test.ts` (new: every non-test file under app/ownership reads none of `searchParams`, `cookies(`, `headers(`, `auth(`, `noStore(`, `useSearchParams`; each page exports a positive `revalidate`; each dynamic page exports `dynamicParams = true` and `generateStaticParams`); `web/src/app/ownership/__tests__/loading-boundaries.test.tsx` (new: `stocks/[code]/loading.tsx` root is `role="status"` with `aria-busy` and `aria-label`); `web/src/app/__tests__/isr-degraded-render.test.ts` (entry for the register page: a failed read throws, nothing cached; an unknown code is 404); `web/src/app/__tests__/editorial-copy.test.ts` (new: no em dash and none of "of the voting power", "'s voting power", "index ETF", "sold" in string literals under app/ownership, components/ownership, components/stocks/register-strip.tsx, lib/ownership); `docs/perf/bundle-baseline.json` (rows for `/ownership/stocks/[code]` after a clean `--compare` run); `CLAUDE.md` Ownership section (the register page, the lanes, the universe holder and generation keys, the v2 keys, the strip's read rule, the link-row rule).

Integration (after all packages): `cd web && npx tsc --noEmit && npm run lint && npm test -- --runInBand && SKIP_VERSION_BUMP=1 npm run build && npm run bundle:budget -- --compare ../docs/perf/bundle-baseline.json && npm run routes:kinds && npm run routes:charts`; then `npm run bundle:baseline`.

## 10. Stages 2 and 3

**Stage 2, the feed and the explorer** (one PR): section 4.4 rpcs mirrored on `ShortedStocksService`; `web/src/app/actions/ownershipExplorer.ts` + `lib/ownership/query.ts` + fixtures (default window 30; `activityOk` as 5.5 defines it); `lib/ownership/events.ts` (reads `notice.event`, never re-derives; label table became substantial / increased / decreased / changed / ceased / NZ disclosure); `components/ownership/notice-mark.tsx` (a fixed 16×12 pictogram per event in `currentColor`, no squares: a cap for became, chevron up/down for increased/decreased, a bar for changed, a strike on the baseline for ceased, a ring for nz; aria-hidden, the row's text is the content; ships inside the island); `notice-week-bars.tsx` (the WeekBars geometry with ONE amber series of notices per week, slot 14, bar 8, h-16, `vector-effect`, 26 weeks below `sm`, `role="img"` + `ScreenReaderTable`); `notice-feed-explorer.tsx` ("use client": filters Window 7/30/90/365/all, Event, Kind, Stock input, Holder select of registry slugs; own `Suspense` with the default view as fallback; `replaceState`; a 10 s timer keeps the rows dimmed with `aria-busy` then shows `feed.outage`; `feed.empty` for an answered empty result); `web/src/app/ownership/notices/page.tsx` + `loading.tsx` + `opengraph-image.tsx` (ISR 3600, default view from `loadNoticeFeed({})` = window 30, `bailOnEmptyRender` only when `!ok || !activityOk || (ok && notices.length === 0)`; a page test asserts the default render with a populated 30-day answer does not call it; lede `feed.lede`); `registers-explorer.tsx` + `register-rows-table.tsx` (sort heads are `<th aria-sort>` holding a `Link`; phone grammar: Stock, Disclosed, Short, Latest notice visible, the rest in a native `details` per row; `DisclosedBar` on a shared scale, hidden below `md`; the industry and kind chips are built from the response's `industries` and the kind vocabulary, so the island can only send values the API accepts; the short filter offers 0/1/3/5/10 only); `web/src/app/ownership/stocks/page.tsx` + `loading.tsx` (ISR 3600, default sort disclosed desc, 50 rows, `bailOnEmptyRender` on `!ok`, title "ASX substantial holder registers by stock" (41 chars), description from `registers.lede`, canonical fixed, no market cap column); both static pages added to `web/src/config/isr-pages.json` and `isr-shell-pages.json` and the pinned list in `isr-shell-pages.test.ts`, their build-skip render carrying `data-isr-shell="empty"`, and the island calling `loadPage` once on mount when `initial.ok === false`; `isInstitutionSlug` unchanged (already rejects both); the register page breadcrumb gains `Registers` (/ownership/stocks); "All notices for {CODE} →" and institution "All notices →" (`?holder={slug}`); `sitemap-sections.ts` lists register pages (holders at least 1, cap 1,000, lastmod `latest_notice_date`) and `/ownership/stocks`, `/ownership/notices`, with `sitemap-sections.test.ts` keeping the strict-subset rule; `isr-hubs.test.ts`, the ownership source guard and `OWNERSHIP_ROUTES` cover both pages; bundle baseline rows; EXPLAINs on a production copy recorded in the PR (the cursor page with each filter, the 90-day aggregate); the KV keys as 5.1 states (default views only).

**Stage 3, the desk and the edges**: hub rebuilt: ONE `<ol class="divide-y ...">` rack of five rows (title, method sentence, count, top 10 registers with `DisclosedBar` on the row's own scale, "Full list, sorted this way →"), "This week on the register" from `ListSubstantialNotices({window 7, include_activity})` through the action with `bailOnEmptyRender` on any failed block (never bake outage copy), latest 10 notices with "All notices →", `InstitutionDirectory` island (kind chips + name input over the 145 rows the page holds; fallback = the unfiltered three-column list so every slug stays in the HTML), per-source as-at ranges; targets under 6,000 px at 1280 and under 9,000 px at 390, measured by the scratchpad band script before merge. Short interest tab: one `<p>` (`lending.line` "Substantial holding notices from banks and brokers disclose {x}% between them, often securities lending. The register →") when a `bank_broker` share is at least 5, read like the strip (abort, catch, outside the critical path), measured first. Register OG card: four largest lanes drawn as fixed-size satori paths (no `vector-effect`; solid steps only if satori rejects dasharray). `web/e2e/ownership-register.spec.ts` (second request `x-nextjs-cache: HIT`, two-row lanes at 360 px, no horizontal overflow, `#ownership` lands under the docked bar). Optional `motion-safe:animate-trace-draw` on the solid lane paths (`pathLength=1`, once, never a loop). CLAUDE.md rewritten for the final shape.

## 11. Verification gates (every stage)
- Web: `tsc --noEmit`, `eslint`, `jest --runInBand`, `SKIP_VERSION_BUMP=1 next build`, `bundle:budget --compare ../docs/perf/bundle-baseline.json` (then refresh the baseline), `routes:kinds` (stock and ownership lists), `routes:charts`, `scripts/tests/*.test.mjs` (taskfile-safety, route-kinds, migration-drift unchanged).
- Go: `GOWORK=off go test ./... -short` for services, `golangci-lint --concurrency 1`, `go mod tidy -diff`, `buf generate` leaves no diff, `make openapi` drift test green, `TestLegacyDomainServiceParity`.
- Merge conditions beyond CI (stage 1): `SHORTS_TEST_POSTGRES_URL` run of `postgres_ownership_pg_test.go` against `make dev-db` with 000137 applied; the universe's cold build timed on a production copy (every statement of `build`, in sequence, five runs) and recorded in the PR; `REGISTER_STRIP_TIMEOUT_MS` set to at least twice the slowest build (4000 if that is under 2 s, else raised and the fit action's 4 s left alone); measured HTML size of `/shorts/ACL/company` and `/ownership/stocks/ACL` recorded in the PR; the preconditions (placeholder repair applied, a funds run dated AUM) confirmed. Stage 2 adds the feed EXPLAINs.
- Post-deploy checks (not merge conditions): a second request to `/ownership/stocks/BHP` answering `x-nextjs-cache: HIT`; `api_usage_monthly` and the API's logs show no synchronous universe rebuild outside the refresh-ahead path during a quiet hour; Search Console watched for the register pages for two weeks.
- Reviews: one bloom per view (the register readout on the register page; the stock header on stock pages, the strip adds none); no red or green on any ownership surface; no em dash; every sum captioned; kinds and short interest never in one figure or panel.

## 12. What is refused, and why
- An eighth stock tab (four tests fail by default, the sitemap `Record` forces a per-tab decision, the register page serves the trail with its own cache entry and indexability).
- A `GetStock` read on the register page (it answers NotFound for a company outside ASIC's report and for a transient database error alike); the link row is decided from the ownership response.
- A cached entry derived from another cached entry (the two-TTL layering that let pre-run data be baked into KV for six hours); every entry is a database read, keyed by the universe generation it was read beside, and no universe is served past its expiry.
- A per-code statement against the attempts table, and an index for it; the counts come from two whole-table GROUP BYs at build time.
- Any 100% company track, any "rest of the register" remainder, any sum worded as a share of the company; `KindBar` is deleted, not reskinned.
- A stock-wide or by-kind history, a stacked area or a reconstructed past register (withheld notices, split keys and the 100-row cap make that guessing); per-holder lanes only, cessation at the 5% edge, never zero.
- Kind colours on a lane, kinds and short interest on one figure or in one panel, red or green on a change in voting power, the control-boundary token on a data bar.
- visx or any client JS for a figure; a `useSearchParams` reader inside `app/shorts/[stockCode]/**` or any ownership server page reading `searchParams`, `cookies()`, `headers()` or `auth()`.
- Browser-direct Connect or `/edge/v1` calls from an island; per-query entries in the API's process map for in-memory filters; a loader-per-query path; a KV key per filter value (only each page's default view is a key).
- Holder pages, holder search or fuzzy merging for unclassified holders; a holder filter that accepts a `name:` key.
- A per-stock withheld count beside a sum or in the plate, or "32% unread"; estimating a withheld or stale figure; a single page-level as-at; an undated AUM figure; "sold" or "sale" anywhere in ownership copy.
- Market cap on any ownership surface until it carries a date.
- An MCP tool change (about 542 bytes of headroom); a rollup materialized view or a migration for the explorer.
- A per-param OG alt (needs `generateImageMetadata` and changes the image URL); alts are static.
- A modal, nested cards, a grid of identical cards, a loop animation, a second lit surface, a Storybook story without a CI-generated baseline.

## Review notes (findings applied in a different form)
- Serious 2 (stock links 404): applied by removing the `GetStock` read entirely and gating the link row on `summary.has_short_pct` plus `STOCK_CODE_PATTERN`, which is the condition under which the stock page exists, rather than by keeping a read whose NotFound cannot be told from a transient error.
- Serious 6 (universe rebuild cost): a serve-stale past expiry was not adopted because a request at R+11 min would then regenerate the web pages from a pre-run universe and pin it in KV for six hours; the holder refreshes in the background two minutes ahead of expiry and rebuilds on the request path only when it finds the universe expired, joining any build in flight.
- Minor (attempts index and EXPLAIN rule): made moot by moving the per-stock counts into the universe as build-time GROUP BYs; no per-code attempts statement exists.
- Minor (strip departs from the brief's one line): the strip is now one line, with the largest three holders' names inside it, so the brief's form and the cross-link value both hold.
- Minor (1 pp step always visible): the claim is withdrawn and restated honestly in section 2 and in the lanes caption; the per-lane scale stays.
- Minor (hub rack top 3 vs the brief's top 10): the brief's top 10 is restored for stage 3.
## 13. The desk: visual instruments with drilldowns (stage 3, decided 2026-11-03)

The owner's verdict on stages 1 and 2: the tables are the record, not the insight. The hub becomes a desk of four instruments over the same data, each a way in, each drilling to the record (the register page, the feed, the registers list, the institution page). The tables stay beneath as the record. One window of time drives every instrument. Nothing here is a new fact: every figure is the one the record already states, drawn.

### 13.1 Shared state and copy rules

- URL state on `/ownership`: `?window=<days>` (the window of change: 28, 91, 182 or 364; default 91), `?lens=<lens>` (the map's colour), `?sector=<industry>` (a zoomed sector; absent = the whole market), `?from=&to=` (the index-fund window, two snapshot dates). Written with `history.replaceState` by the islands, read by each island under its own Suspense; the server renders the default view (window 91, lens disclosed, whole market, the newest two index snapshots). No page reads `searchParams`.
- Colour: kinds keep their category colours (`kinds.ts`). A sequential lens runs paper to amber in the theme's tones; a diverging lens (net flow) runs ink to paper to amber, NEVER red or green: a notice flow is not a market direction. Short interest as a lens is the exception, drawn in the chart's short-interest colour. Every cell carries its figure as text in a `<title>` and in the sr-only table.
- Copy: every sum is "what the notices disclose"; exposure is "disclosed exposure, estimated" (voting power x market cap, an estimate that assumes the voting power is of the shares on issue; the caption says so once per instrument). A change over a window is "net change in disclosed voting power, percentage points"; never "bought" or "sold".
- Motion: `motion-safe:` only; a zoom is a 200 ms transform; the heatmap brush and the date slider move nothing but their own handles.

### 13.2 The map (hero): a treemap of sectors and stocks

- Cells are stocks grouped by industry (the company-metadata industry through `industryLabel`; placeholders fall into "Other"); area = market cap (a stock without one takes the universe's median, flagged in its title as estimated); the squarify layout from `d3-hierarchy`, computed on the SERVER for the default view so the HTML carries the SVG (ISR), and in the island for a zoom or a lens change.
- Lenses (`?lens=`): `disclosed` (the sum of substantial holdings, default), `institutional` (the investor kinds' sum), `hedge` (hedge funds), `index` (index funds' share of shares on issue), `short` (ASIC short interest), `flow` (net change in disclosed voting power over the window, diverging). A lens with no figure for a stock draws the cell hatched (`pattern`), never zero.
- Drilldown: click (or Enter on) a sector label zooms to that sector (`?sector=`), the breadcrumb above the map reads "Market > Materials", Escape or the breadcrumb zooms out; click a stock opens the **stock panel** beside the map (a `<aside>`, under the map on a phone): the code and name, the disclosed bar by kind (`DisclosedBar`), the three largest holders with their figures and dates, the index-fund share and the short position with dates, the five latest notices, and links "Full register", "Overview", "All notices for CODE". Arrow keys move between cells; the panel is a `role="dialog"`-free region with a heading, closed by its own button.
- Hover: a tooltip with the code, the lens figure and the sector; the sr-only table beneath lists every cell with its figure.
- Legend: the lens scale as a labelled bar; the window chip row (28/91/182/364 days) is shared with the heatmap and the flows.

### 13.3 Flows: a sankey from holder kinds to sectors

- Left nodes = holder kinds (the nine investor kinds plus banks and brokers, listed companies and unclassified), right nodes = sectors, bands = disclosed exposure, estimated (sum over current holdings of voting power x market cap). Toggle "Positions" / "Changes in the window": the second draws the same bands from the window's notices (Δ voting power x market cap), a band for increases and one for decreases, ink and amber.
- Layout from `d3-sankey` on the server for the default view; the island redraws on toggle or window change. Hover a band: the exposure in AUD (estimated), the number of holdings and the largest; click a band: the registers list filtered `?industry=&kind=` (an existing view); click a kind node: the institution directory filtered to the kind (an existing view); click a sector node: zooms the map.
- Caption: "Disclosed exposure, estimated: voting power x market cap, what the notices disclose; banks' and brokers' notices are often securities lending."

### 13.4 Movement: a heatmap of sectors by week, with the window brush

- Rows = sectors (sorted by the window's activity), columns = the last 52 weeks (Monday-started), cell = net change in disclosed voting power in percentage points, summed over the notices released that week (diverging ink/paper/amber); hover shows the counts by event (became, increased, decreased, ceased) and the net; click a cell: the feed filtered `?industry=&since=&until=` (new filters, 13.6).
- The brush: a two-handle selection over the week axis sets the window; the window chips set it to the last N days; the brush and the chips are the same state. A brushed window that does not end today is "from X to Y" on every instrument's caption. On a phone the heatmap shows 26 weeks and the brush becomes the chip row.
- The sr-only table lists sectors by week.

### 13.5 Index fund positions: the sliding window

- A two-handle date slider over the snapshot dates the tracked index funds have (`snapshot_dates` from the API; the history accumulates nightly as files change: iShares and Betashares daily, Vanguard monthly, super options semi-annually, so the first weeks have few steps). The default window is the two newest dates.
- Left: a diverging bar list of the largest changes in weight between the two dates, summed across the tracked funds per stock (percentage points of weight; AUD value change beside it as "estimated"); ten up, ten down; a stock whose weight is only in one date is marked "new" or "dropped" and sits in its own two rows, never counted as a change from zero.
- Right (or beneath): clicking a stock draws its weight series per fund as small multiples (one line per fund, the x axis the snapshot dates, a dot per snapshot); the panel names each fund with its institution and the file date range.
- Caption: "Index fund holdings files, one snapshot per file date; a weight is the fund's, not a share of the company. Super options disclose semi-annually."

### 13.6 API (OwnershipService, mirrored on ShortedStocksService, all VISIBILITY_PUBLIC)

- `GetOwnershipMap(from, to)` -> every stock of the universe: `code`, `name`, `industry`, `market_cap` (+has), `disclosed_pct`, `institutional_pct`, `hedge_pct`, `index_pct` (+has), `short_pct` (+has), `flow_pp` (+has; the net change in disclosed voting power from notices released in [from, to]), `notices` (count in the window), `as_of`. Dates default to the last 91 days ending at the newest notice. One statement for the window aggregate (`SUM(present_pct - previous_pct) GROUP BY stock_code` over notices in the range, a ceased notice counting its previous as a fall), the rest from the universe. Cached beside the universe for the default window only.
- `GetOwnershipFlows(from, to)` -> `positions`: rows of (kind, industry, exposure_aud, holdings, largest_code, largest_pct); `changes`: rows of (kind, industry, direction up|down, exposure_aud, notices). Computed from the universe and the same window aggregate grouped by (kind, industry).
- `GetOwnershipActivity(weeks)` -> rows of (industry, week_start, became, increased, decreased, ceased, nz, net_pp), 52 weeks at most, gap-filled; one statement.
- `ListFundPositionChanges(from, to, limit)` -> `snapshot_dates` (every distinct as_at across tracked index funds), `from`, `to` (the dates used: the newest at or before each), rows of (code, name, weight_from_pct, weight_to_pct, delta_pp, value_from_aud, value_to_aud, funds, state current|new|dropped) sorted by |delta|; and `GetStockFundSeries(code)` -> per fund: (fund, institution, source_kind, points of (as_at, weight_pct, value_aud)).
- `ListSubstantialNotices` gains `industry`, `since` and `until` (dates, inclusive; refused when until < since).
- Every number travels with its `has_`; the web prints n/a, never 0.

### 13.7 Web

- Islands under `components/ownership/desk/`: `ownership-map.tsx` (treemap; `map-layout.ts` pure, shared with the server render), `ownership-flows.tsx` (`flows-layout.ts` pure), `movement-heatmap.tsx`, `fund-positions.tsx`, `desk-state.ts` (the URL codec for 13.1), `stock-panel.tsx`; loaders in `app/actions/ownershipDesk.ts` ("use server"; one per rpc; KV for the default views only). The islands take the actions as props and plain rows, reach no protobuf, Connect or action module at run time (`client-boundary.test.ts`), and read the URL under their own Suspense with the default view as fallback.
- The hub `/ownership`: the plate, then the map with its lens and window chips, then flows and movement side by side from `lg` (stacked beneath), then index fund positions, then the existing sections as the record. ISR 3600 stays; the default view's SVGs are in the HTML; `bailOnEmptyRender` on any failed instrument read. The page's budget: under 450 kB of first-load JS for the route; the layouts are computed, not animated, on the server.
- Guards as stage 2's: the editorial scan, the ISR source scan, the client boundary, `isr-hubs`, the bundle baseline rows. Every instrument has a jsdom test for its sr-only table and its links; the layouts have pure tests (areas sum, bands sum, weeks gap-filled, the new/dropped rule).

### 13.8 Amendments after the first build's review (2026-11-03)

- **The stock panel keeps the rule of sections 11 and 12**: kinds and short interest never share a panel. The panel draws the disclosed bar by kind, the three largest holders, the index-fund share with its file dates and the five latest notices; the short position is a link, "Short interest →" (`stockTabHref(code, "short-interest")`), never a figure in the aside. 13.2 is read with this.
- **The map's caption follows the lens.** `disclosed`, `institutional`, `hedge` and `flow`: "What the notices disclose, each interest counted once; not a share of the company." `index`: "Index fund holdings files; a weight is the fund's, of shares on issue, not a share of the company." `short`: "ASIC short position report, published T+4; a short position is of shares on issue."
- **Dates bound the feed on their own.** When `since` or `until` is named on `ListSubstantialNotices`, `window_days` is ignored (the dates are the window), the span is capped at 366 days, `until` before `since` is refused. The web feed reads `?industry=`, `?since=` and `?until=` (its codec and loader forward them; an active industry or date range shows as a removable chip beside the window chips, and the window chips are hidden while a date range is set).
- **One desk state.** `since`/`until` (the brushed notice window) live in `desk-state.ts` beside `window`, `lens`, `sector`, `from` and `to`, so no island's write erases another's; the chips and the brush are that one state. While a brush is held, nothing moves but its handles: rows, captions and chips follow the committed window until release.
- **The brush reads week indices**: visx's Brush reports bounds in domain units (weeks), never pixels.
- **Index fund positions**: a stock's weight on a date is its sum over every tracked fund holding it; `new` and `dropped` are only a stock absent from every fund on one of the two dates; a stock held by different funds on the two dates is a change like any other. Rows are ordered current by |delta|, then new, then dropped. A `from` before the first snapshot clamps to the first; a `from` after the newest with no `to` is refused.
- **Drilldowns land filtered.** The directory on the hub gives each kind's group an id (`directory-<kind>`) and a kind node links to it; a heatmap cell links to the feed with `industry`, `since` and `until`, which the feed now reads.
- **The pure fund-change helpers live in `fund-changes.ts`**, so the fund island's chunk carries no d3-sankey; every desk module (islands, static twins, pure helpers) is in `client-boundary.test.ts`.
- **A segment's `loading.tsx` wraps its children**: `/ownership/[slug]` gets its own institution-shaped skeleton, so the hub's desk skeleton never shows before an institution page.
- **The movement heatmap takes its loader as a prop** (`loadActivity`), so its chips and brush redraw; the page passes `loadOwnershipActivity`.
