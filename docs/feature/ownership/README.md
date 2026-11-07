# Ownership explorer: who holds ASX stocks

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

Spec: `docs/superpowers/specs/2026-11-02-ownership-explorer-design.md`.

## Ownership (who holds ASX stocks)

`/ownership` (hub: the map by kind, biggest holders, crowded registers, crowded
both ways, lending desks, index fund ownership, super funds' consensus, latest
notices, institutions directory), `/ownership/[slug]` (one institution),
`/ownership/stocks/[code]` (one stock's register: the Holder Lanes, the
holders, the index fund and super option rows, the notices trail),
`/ownership/notices` (the feed: every notice read, newest release first, with
window, event, kind, stock and holder filters and the window's weekly bars)
and `/ownership/stocks` (the registers list: eleven sorts, industry, kind,
interest and short-position floors, a code or name query), the workspace
(`/ownership/map`, `/connections`, `/activity`, `/funds`, `/funds/[fund]`,
`/holders`, `/changes`: one sub-nav, one toolbar row, one right-rail inspector
driven by `?sel=`) and, on the
stock page, the "Substantial holders" card on the Company tab (`#ownership`,
the summary) and the one-line strip on the Overview, over `OwnershipService`
(`ownership.proto`, 14 rpcs, all public, mirrored on `ShortedStocksService`).
Fed by `shorted ownership` (`services/jobs/README.md` "ownership"): a curated
registry of ~145 institutions, APRA's super fund statistics, ASX's ETF/LIC
report, 11 index funds' holdings files, 11 super funds' portfolio holdings
disclosures, and every substantial holding notice PDF since 2024. Migration
`000137_add_ownership` is in the deploy allowlist. Spec:
`docs/superpowers/specs/2026-11-02-ownership-explorer-design.md` (stages 1 to 4 built: section 13 is the desk, 14 the workspace; 7.1, 13.8, 14.7,
14.8 and 14.9 hold the decisions taken in review; 14.11 holds the backlog
pass of 2026-11-04 and 2026-11-05, `2026-11-04-ownership-workspace-backlog.md`,
nineteen items built in five waves and measured against a local production
build; the Short interest lending line, the register OG lanes and the e2e spec
remain specified and unbuilt).

| Piece | Where |
|---|---|
| Job, parser, registry | `services/jobs/internal/jobs/ownership/` (`notice.go` parser, fixtures in `testdata/notices/`; `registry.go` kinds, aliases, groups; `repair.go` the `-mode repair-placeholders` dry run) |
| API | `services/shorts/internal/services/shorts/ownership.go` (handlers assemble every response from ONE cached universe, `ownership_universe.go`: built once per `ownershipTTL` from 11 statements, refreshed in the background two minutes ahead of expiry, never served past it; a stock's or an institution's notices and the feed's first page are the per-key statements, cached under the universe's generation; `ownership_lists.go` holds `ListSubstantialNotices` (a keyset cursor `YYYY-MM-DD|url`, windows rounded UP to 7/30/90/365, 0 = every notice read) and `ListStockRegisters` (in memory over the universe, never cached per query), with every clamp mirrored in `web/src/@/lib/ownership/__fixtures__/clamps.json`, which a Go test and the web test both read), `store/shorts/postgres_ownership.go` (a schema without 000137 reads empty, never a 500; `eventOf` classifies a notice's event ONCE here: ceased, then 603 became, then 604 increased / decreased / changed, then nz) |
| Desk | The hub's instruments over one window of time, `components/ownership/desk/`: the map (`ownership-map.tsx`, a d3-hierarchy treemap of sectors and stocks, area = market cap, disclosed exposure or index fund holdings (Size), seven lenses (the last, index_flow, is the index fund change), a sector zoom and a stock panel), flows (`ownership-flows.tsx`, a d3-sankey from holder kinds to sectors by disclosed exposure, estimated, with a changes-in-the-window toggle), movement (`movement-heatmap.tsx`, sectors by week with a two-handle brush), index fund positions (`fund-positions.tsx`, a two-handle date slider over the funds' snapshot dates, the largest weight changes, per-fund series). Each has a `-static.tsx` twin the server renders from the pure layouts (`map-layout.ts`, `flows-layout.ts`, `fund-changes.ts`), one URL state (`desk-state.ts`: window, lens, sector, since/until, from/to, sort) and loaders in `app/actions/ownershipDesk.ts` over five rpcs (`GetOwnershipMap`, `GetOwnershipFlows`, `GetOwnershipActivity`, `ListFundPositionChanges`, `GetStockFundSeries`; `ownership_desk.go`). Colour is `desk-scales.ts` over the theme's stops in `globals.css` (`--desk-bin-N` with an ink token per stop, the diverging `--desk-fall-N`/`--desk-rise-N`, the short lens's `--desk-short-N`; `desk-ramp-contrast.test.ts` reads the CSS); below sm the map is `phoneLayout` (map-layout.ts), a two-column square of sectors; a Sort control (`workspace/sort-control.tsx`, `?sort=largest|changed`) orders the map (under a diverging lens), the heatmap, the holders directory and the fund exposure map by what moved |
| Workspace | The instrument pages. The shared kit is `components/workspace/`: `workspace-page.tsx` (the shell: the content column and the rail), `toolbar.tsx`, `workspace-sub-nav.tsx` (`WorkspaceSubNav`, the registry-driven bar that Ownership and Strategies both render) and `selection-tray.tsx` (`SelectionTray`, the sticky compare strip the funds page uses). `components/ownership/workspace/` keeps the ownership parts: `ownership-nav.tsx` (`OwnershipNav`, a thin wrapper over `WorkspaceSubNav` with the registry in `nav.ts`), `inspector.tsx` (the right rail from lg, a `SideSheet` bottom sheet below it, the content a plain contract from `inspectors/*` built in pure functions and loaded by `loadInspector` in `app/actions/ownershipDesk.ts`), `selection.ts` (the `?sel=` grammar: `stock:PLS`, `holder:vanguard`, `connection:index_manager>Materials`, `cell:Materials@2026-10-26[:kind]`, `fund:asx:A200`, `holding:asx:A200/BHP`; 280 characters at most, parsed never trusted), ONE row of labelled selects or segmented controls per page, folded under `view-disclosure.tsx` "Adjust view" below sm (`window-select.tsx` the shared Window select; `sort-control.tsx` the Sort control), `method-disclosure.tsx` (the one-line "How these figures are read" every page ends with), `trail.ts` (the rail's trail of selections, sessionStorage), `week-strip.ts` / `week-strip-view.tsx` (a stock's or a holder's notices by week, the rail's "weeks" section), the readings (every `inspectors/*` builder sets `InspectorContent.reading`, one computed sentence drawn first; `holder-reading.ts`), the internal selection kinds `sector` and `compare` (resolved from `?sector=` and `?funds=`, never read from `sel`), `components/ownership/show-all.tsx` (an institution page list's rows past the tenth), the logos (`stock-logo-box.tsx` over `CompanyLogo`, `holder-logo.tsx` the favicon of the registry's website with a monogram fallback, `sector-icon.tsx` the landing page's `/assets/sectors-v2` images via `lib/sector-images.ts`). Funds: `components/ownership/funds/` (`fund-portfolio-map.tsx` a treemap whose cells select `holding:`, `fund-exposure-map.tsx` six sectors plus Other, `fund-changes-table.tsx` two snapshots compared, `expandable-row.tsx` the in-row chevron; its compare tray is `SelectionTray`) over `ListFunds`, `GetFundPortfolio`, `CompareFundSnapshots` (`ownership_funds.go`) and `app/actions/ownershipFunds.ts`; `fundHref(key)` / `fundLabel` in `lib/ownership/kinds.ts`, which also holds `shortSector` (the short sector names every instrument prints, the full name in the title). Holders: `components/ownership/holders/` (`holder-browser.tsx` the twenty largest with Show all, `holder-connections-map.tsx` the tree, `holder-tree.ts`) over `app/actions/ownershipHolders.ts`. Vendored Gamma components live in `components/gamma/` with `gamma-bridge.css` mapping their tokens onto the house theme (standard ease only, no spring; the data table transitions colour and opacity, never width) |
| Web | `app/ownership/` (the hub, `[slug]`, `stocks/[code]`, and the static ISR pages `notices/` and `stocks/`), `components/ownership/` (server components; the islands are `ownership-tables.tsx`, `notice-feed-explorer.tsx` and `registers-explorer.tsx`: the action as a prop, `useSearchParams` under their own Suspense, `history.replaceState`, no Connect; `notice-mark.tsx`, `notice-week-bars.tsx`, `register-rows-table.tsx` are the parts they draw), `app/actions/ownershipExplorer.ts` ("use server"; the one loader a page and its island share; KV only for each page's DEFAULT view), `lib/ownership/query.ts` (the clamps and the URL codec) and `events.ts` (reads `notice.event`, never re-derives it), `components/stocks/register-strip.tsx` (props only), `lib/ownership/` (`trace.ts` the lane geometry, `kinds.ts`, `rows.ts`, `age.ts`, `register-indexability.ts`), `app/actions/getOwnership.ts` (ISR tag `ownership` + KV last-good under the `v2` keys, flush `ownership`), `app/actions/getStockRegisterStrip.ts` (the Overview's read: `unstable_cache`, a 4 s abort, no KV, tagged by stock and never `ownership`) |
| Guards | `app/ownership/__tests__/isr-source-safety.test.ts` (no `searchParams`, `cookies()`, `headers()`, `auth()` or `useSearchParams` under `app/ownership`), `app/__tests__/editorial-copy.test.ts` (no em dash, "of the voting power", "index ETF", "sold" in ownership copy), `scripts/route-kinds.mjs` `OWNERSHIP_ROUTES` (the two dynamic routes) and `OWNERSHIP_STATIC_ROUTES` (the hub, the feed, the registers list: each must keep a positive `initialRevalidateSeconds`), `components/ownership/__tests__/client-boundary.test.ts`, `app/api/static-pages/warm-cache/__tests__/budget.test.ts` (23 shell pages read eight at a time fit the 145 s the callers allow) |
| MCP | `get_stock_ownership` (holders, by-kind sum, the 15 largest fund holdings, each fund named with its institution) and `get_institution_holdings` (slug or name; an ambiguous name lists the slugs), `services/shorts/internal/mcp/tools_ownership.go`. A stated 0.00% fund weight beside a real value is omitted (super disclosures state two places) |

### Landmines

- **A workspace page is ISR, and its shell is in three lists.** Every page
  under `app/ownership/` exports `revalidate` and reads no `searchParams`;
  the selection, the window and the sorts live in `?sel=` and the desk
  params read by islands under their own Suspense (`history.replaceState`).
  A new page goes into `OWNERSHIP_STATIC_ROUTES` (`scripts/route-kinds.mjs`),
  `src/config/isr-shell-pages.json` (the warm sweep) and
  `lib/seo/sitemap-sections.ts`, or it is served cold after every deploy.
- **The island's placeholder is the toolbar's height.** A server-rendered
  toolbar row is one row from `sm` (`TOOLBAR_ROW_CLASS`); an island that
  mounts a taller control shifts the drawing. Measured at 1440 on
  2026-11-04: the map's row fits its 1016 px column with about 30 px to
  spare, so a longer option label wraps it (the Sort control cost the Colour
  option its "Index" word: "Fund shares"). Window is a select, never four
  chips, everywhere: the instrument pages, the notices feed and the Overview
  (whose row is the search, a Source select and the Window select).
- **Every drawn element selects, through the same `?sel=`.** A map cell, a
  sankey band, a heatmap cell, a fund treemap cell, a holder, a change row:
  each writes the selection and the rail reads it. The folded "Other
  sectors" band opens the tail instead. A heatmap cell is reached by
  keyboard through the sr-only table, whose Select buttons show when
  focused.
- **A connection the register refuses is empty, not down.** The register
  names its own industries; a band drawn from fund holdings can name a
  sector with no notice in it, and `ListStockRegisters` answers
  `invalid_argument`. `loadConnectionCompanies` reads that as zero companies
  (logged), so the rail shows a real zero; only a transport failure is an
  outage.
- **The fund page decodes its segment** (`asx%3AVAS` and `asx:VAS` are one
  key) and a fund the record does not hold draws its own not-found card
  inside the workspace; `notFound()` is for an empty or malformed segment.
- **Fundamentals of the house rules still bind here**: n/a never 0 (the
  Overview's coverage tile prints n/a without an overview), kinds and
  sectors are never market red or green, the one coloured figure in a rail
  is a change's whole signed figure.
- **A notice is withheld rather than guessed** (scans, annexure-only figures,
  a headline naming a company not on record, votes that do not fit ASIC's
  share count as at the notice's date). The overview reports read and
  withheld counts; never estimate a withheld figure.
- **Notices overlap.** MUFG files for First Sentier and Morgan Stanley, a bank
  files for its fund manager, CBA and KKR both file for Colonial First State.
  `countedHoldings` counts a registry `Group` once and identical (voting power,
  date) pairs once; other overlaps remain, so every sum is "what the notices
  disclose", never a share of the company. Say so wherever a sum is shown.
- **Kinds are colours of a category, never market red or green**
  (`kinds.ts`). A headline figure, a bar's figure or a sum prints to two
  decimals (`formatHeadlinePct`, `formatSum`); a single notice's figure keeps
  the precision it states (`formatVotingPower`) only in a list of notices and
  the register's own row.
- **A super fund's holdings disclosure is one investment option**, not the
  whole fund; ETF issuers are linked by the manager before the slash in ASX's
  issuer field ("Milford / EQT" is Equity Trustees the RE, not EQT the firm).
- **"Current" means the newest notice we could read**, not held today: a
  withheld 605 or a cessation filed under another holder key leaves a stale
  row (about a quarter of current holdings are over 12 months old). Every
  holding row carries its notice date and an age cue past 90 days
  (`lib/ownership/age.ts`); an empty register reads "no notice read", never
  "no holder".
- **A sum is never drawn against a 100% company track.** `DisclosedBar`'s full
  width is the disclosed sum, printed beside it; `KindBar` (a 0-100% track
  rescaled past 100 without saying so) was deleted. Counts and sums share one
  basis: "interests" is `sum(by_kind.holders)`, the deduplicated count, while
  `OwnershipStock.holders` counts rows.
- **Only per-holder history is drawn.** The Holder Lanes (`lib/ownership/trace.ts`)
  step one holder at a time from notice to notice, on a per-lane scale from the
  5% threshold up; a cessation ends at the 5% edge ("under 5%", never zero) and
  a dotted tail is the time since the last notice read. A stock-wide or by-kind
  history would reconstruct past registers from a record with withheld notices,
  split keys and the 100-notice cap, which is guessing. Server SVG, no visx, no
  client JS; kinds never colour a lane (`hedge_fund` is the short-interest
  series colour) and kinds and short interest never share one figure.
- **"Crowded" counts investors only.** `institutionalKinds` excludes
  `bank_broker`: ATH's 58% "crowded" register was 74% a lending desk. Banks and
  brokers stay in the register sums and the lending view; their notices are
  "often" securities lending, one word, everywhere.
- **"Withheld" is eight outcomes, reported apart.** The overview carries
  `withheld_by_outcome`; `not_a_notice` and `fetch_error` are never "unread".
  `GetStockOwnership.withheld_listed` is "listed under" the code (a notice
  under several codes is counted under one) and is never printed beside a sum.
  `history_total` says when the 100-notice `history` is capped.
- **Every figure carries its own date.** `short_as_of`, `index_as_at_from/to`
  and `index_files`, `latest_notice_date`, `OwnershipSource.as_at_from`; AUM is
  dated by `aum_as_at`, which was NULL until `parseAPRADate` learned Excel's
  format 14 (the next funds run writes it). Never one page-level "as at".
- **New rpc cost.** A field on an existing response needs only `ownership.proto`
  and `make openapi`; a NEW rpc needs the `shorts.proto` mirror (the parity test
  runs on pull requests). Per-query cache keys on the old loader cost 8-9 pool
  acquisitions each; every handler now reads the universe, and a list or feed
  filters it in memory or runs its own one-statement indexed query. The web KV
  keys are versioned (`cache:ownership:*:v2`): a new field read from an old
  entry is silently 0/false for up to 21,600 s otherwise.
- **The strip's read is outside the Overview's critical path** and reads no
  KV: the daily sync's layout expiry refreshes it, and the job's `ownership`
  ping must not add a regeneration wave to the most-visited tab.
- **Activity exists only on a first page.** `ListSubstantialNotices` computes
  the weekly counts for windows of at most 90 days and only when `cursor` is
  empty; the loader asks for it only there (`wantsActivity`), so a load-more
  never reads `activityOk` false. The first page is the only cached read
  (`ListSubstantialNoticesKey`, TTL the universe's remaining life); a cursor page
  is read through.
- **The API names no start date.** Window 0 is every notice read; the record's
  first day is not a fact the API states, so `feed.empty.all` says "No notices
  read match these filters." and nothing more.
- **The registry reaches the feed island only when it is whole.** The notices
  page passes `ListInstitutions` to the holder select only when
  `total <= institutions.length`; otherwise the API validates a `?holder=`
  slug. An unlisted slug from a link is kept as an option labelled by its
  slug; a slug the registry does not hold is refused by the API and drawn as
  the outage, never silently another view.
- **"All notices" links carry `window=all` and `rel="nofollow"`** and are
  drawn only when the page has a notice to show (`history_total > 0`, an
  institution's count > 0): over 1,100 filtered URLs each serving the default
  view's HTML otherwise. The hub's bare `/ownership/notices` link is followable.
- **The register list has three grammars switched on the TABLE's width**
  (a container query at 980 and 1,320 px, because the signed-in rail takes
  288 px of the viewport): two rows per stock below 980, seven columns with the
  name and industry under the code from 980, eleven from 1,320; every value is
  rendered once, every `<time>` is `whitespace-nowrap`. The feed stacks below
  `md`. Measured on static markup to fit 360 to 1280 px signed in; no e2e holds
  it yet (stage 3).
- **Dates bound the feed on their own.** When `since` or `until` is named on
  `ListSubstantialNotices` the window is ignored, the span is capped at 366
  days and `until` before `since` is refused; the heatmap's cell links depend
  on it (they carry dates and no window). The feed reads `industry`, `since`
  and `until` from its link.
- **The desk is one state.** `desk-state.ts` holds window, lens, sector, the
  brushed `since`/`until` and the fund window's `from`/`to`; every island writes
  through it, so no island's write erases another's. While a brush or the date
  slider is held nothing moves but its handles.
- **The stock panel never prints the short position** (sections 11, 12 and
  13.8: kinds and short interest never share a panel); it links the Short
  interest tab. The map's short lens is the one place the chart's short colour
  is used; a notice flow is drawn ink/paper/amber, never red or green.
- **Exposure is an estimate**: voting power x market cap, labelled "disclosed
  exposure, estimated" wherever it is drawn; a stock without a market cap has
  none (has_ false, never 0), and in the map its area is the universe's median,
  flagged in its title.
- **A screen-reader table takes the house wrapper** (`ScreenReaderTable`):
  `sr-only` on a `<table>` does not constrain a display:table box, and the
  map's own sr-only table made the hub scroll sideways to 801 px on a phone.
- **The hub's first-load JS grew from 127 to 179 kB** with the four
  instruments (the budget is 300 kB; the baseline carries it). A new
  instrument must earn its chunk: the layouts are pure and run on the server.
- **Unclassified holders (59% of positions) are plain text**: no holder pages,
  no holder search, no fuzzy merging across keys (`name:` keys split on text
  layer breaks: "Limite d"). The parser withholds placeholder names ("SEE
  ANNEXURE 1") as `no_holder` unless the name resolves to a curated
  institution; `-mode repair-placeholders` removes rows stored before the gate.

- **A lens is five stops, told apart and legible.** Every bin is a theme
  token (`globals.css`), the figure printed on it an ink token of its own, at
  4.5:1 or better and at least 7 L* from its neighbours in both themes;
  `desk-ramp-contrast.test.ts` reads the CSS and fails on a stop that is not.
  Never mix a colour in `desk-scales.ts` again (five mixes of amber over a
  near-black paper were five browns). Light's top bin is one step deeper than
  Burnt Amber for that reason.
- **The rail leads with a computed sentence, never model prose.** Every
  `InspectorContent.reading` is built clause by clause from figures the rail
  already shows; a missing figure drops its clause, so no reading can print
  n/a or 0. The holder rail's comes from `holderInspectorContent` (the holder
  pages never go through `loadInspector`).
- **The hub's panes are fixed-height and have no control row.** 420px for
  the map and the sankey, 320px for the heatmap (the count measure, the
  eleven most active sectors plus a fold, ranked by magnitude under the
  "changed" default) and the index fund positions (five rises beside five
  falls); the compact heatmap once drew the net-change measure, whose scale a
  few bad notices blew out to 200 pp so every cell was the paper. Measured
  2,129px at 1440 (4,401 at the review).
- **The phone map's minimum cell is 32 units** (`PHONE_MIN_CELL`): at 44 the
  live market drew three sectors and folded twenty-three. A sector's figure
  there is the market-cap-weighted mean of its stocks' figures, said in the
  cell's title and one caption; the fold cell names its three largest
  members and its chips sit in a details beneath.
- **The institution page shows ten rows per list** (`SECTION_ROWS_SHOWN`),
  the rest behind "Show all N" in the HTML: measured 5,413px at 1440, of
  which the holder's connections tree is 1,750. The backlog's 3,000px could
  not be reached with any number of rows; the figure is the record.
- **The parser cuts labels and refuses sentences.** A trailing "Name" label
  and a leading "This notice is given by" are cut off a holder name; a name
  still carrying a form phrase is withheld (`no_holder`); a 604 whose stated
  change is over 50 points is withheld unless both figures sit on one layout
  line of the voting-power section (`pairOnOneRow`). `-mode
  repair-placeholders` lists and removes the stored rows the rules refuse
  (`storedNotice.PreviousPct`); the production repair is a hand run.
- **Kind colours are on a leash** (`kinds.ts`, `kind-chroma.test.ts` reads
  the swatches): every kind is a light and dark hex pair, HSL chroma at or
  under 0.45 and under the amber's minus 0.1, outside the amber's hue band
  unless at or under 0.30, the dark pairs at least CIE76 9 apart; the active
  manager is a mustard, never the amber; the sankey's holder body is the
  foreground (muted for Unclassified) with the kind as a 4-unit edge
  (`kindEdgeClass`, `KindInfo.fill`), so the amber selection is the only
  bright mark.
- **The toolbar fold's first paint is closed on a phone.** `view-disclosure.tsx`
  renders `open` for the desktop's scriptless first paint, and `view-fold`
  (globals.css) hides the content below `sm` until the effect has set the
  attribute from the `sm` media query and marked the element ready; the
  effect follows the query, so a phone turned to landscape gets its controls
  back. The hub's plate lives inside that fold (DeskToolbar's `plate` prop,
  one plate in the DOM) and the band, the records and the method order after
  the panes below lg (`order-[10|11|12] lg:order-none`), so the map is the
  phone's first screen.
- **A comparison is the two keys in `?funds=`** (the checkboxes' cap is two,
  a third tick replaces the oldest): the rail resolves an internal "compare"
  selection (precedence `sel`, then the comparison, then the zoomed sector;
  "Clear selection" removes `funds` only; no bottom sheet below lg, as for
  the sector zoom; no trail step); a sector a complete file does not name is
  a true 0.00% in the diff and in the fund exposure map's cells, n/a only for
  a file with no holdings.
- **Company names are served clean.** Every name an ownership rpc serves goes
  through `cleanCompanyName` (`servedOwnershipName` in the store): BHP, CSL,
  NAB, ANZ, QBE, AMP, IAG, CBA, WBC, S32, REA and ASX stay capitals in any
  source, a shouted short English word ("RED") reads as a word; the stocklist
  copy and `web/src/@/lib/company-name.ts` carry the same tables.

### Insights explorer (folded into the desk, spec 14.10)

- The insights explorer folded into the desk: the market map and money flow are `/ownership/map` (Size "Index fund holdings", the `index_flow` lens), the heatmap and window are `/ownership/activity`, "Largest moves" is the Activity rail, and the connection rail names its holders.
- `/ownership/insights` answers 308 to the mapped desk link (`app/ownership/insights/route.ts`, built by `lib/ownership/insights-redirect.ts`); a bare request goes to `/ownership/map?lens=index_flow`.
- `OwnershipInsightsService` was removed: it was public for one day and nothing else called it, so the desk reads `OwnershipService` only.
- Spec: `docs/superpowers/specs/2026-11-02-ownership-explorer-design.md` 14.10.

