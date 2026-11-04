# Ownership workspace: review and backlog (2026-11-04)

A review of the live workspace (`/ownership` and its seven pages, the institution page and the stock
register) the day it shipped, against the owner's brief: it still reads cluttered, a reader should
get further by drilling and come away with an insight, and dark mode's palette needs work (the
navbar shows a sharp green). Reviewed from production screenshots in both themes at 1440 and 390
(`~/.cache/shorted-ownership-explorer/review-prod/`), with the impeccable critique rubric and
DESIGN.md as the standard. The spec is `2026-11-02-ownership-explorer-design.md`; its sections 13,
14 and 14.7 to 14.10 bind every item here.

Each item is sized for one sub-agent (haiku implements, opus reviews, as the workspace was built):
a problem with its evidence, the decision, what done looks like, and the files. Items in one group
are independent of each other unless a dependency is named. House rules stand throughout: n/a never
0, true minus, no em dash, kinds and sectors never market red or green, one lit surface per view,
every ISR rule (no `searchParams` in a page, islands under their own Suspense, no Connect in a client
module), every instrument toolbar on one row at 1440, the shortlist caps.

## A. Chrome and palette

**A1. The navbar's green is the active "More" button.** `main-nav.tsx` paints an active item
`bg-secondary text-foreground`; `--secondary` in dark mode is Sage (`hsl(96 33% 63%)`), and "More"
is active whenever the path is a secondary item, which `/ownership` is. DESIGN.md: "Active state
carries Burnt Amber; hover tints toward accent". Decision: the active nav item (top-level and inside
More) carries `text-primary` with a 2px amber underline (`border-b-2 border-primary`, the sub-nav's
own grammar) and no fill; hover keeps `hover:bg-secondary/50` only in light mode, dark mode hovers to
`hover:bg-muted`. "More" reads active when the open page is inside it, by the same underline. Done:
no element of the header computes a hue between 70 and 170 at saturation over 0.25 in dark mode (the
review's probe, `review-prod.mjs` `greenish`), both themes screenshot, a test on the class strings.
Files: `web/src/@/components/ui/main-nav.tsx`, its test. Size S.

**A2. One stepped ramp with real separation.** The map's five bins in dark mode are five browns
(`desk-scales.ts`), so a 20% cell and a 60% cell read alike and only the top bin lifts; light mode is
five taupes. Decision: keep five bins and the ink-to-amber family, but space the steps in lightness
and chroma so each bin is told from its neighbours at 1x on a 20px cell (dark: from `hsl(32 12% 18%)`
to Phosphor Amber; light: from warm paper's step to Burnt Amber), check every step against the ink
printed on it (WCAG AA for the 11px figures), and use the same ramp on the heatmap, the fund
exposure map and the holders' bars so one legend teaches every instrument. The diverging lenses
(`flow`, `index_flow`) take ink for falls and amber for rises on the same spacing, paper at zero.
Done: a contrast table in the test (each bin's ink), screenshots of all four instruments in both
themes, the legend unchanged in shape. Files: `desk-scales.ts`, `lens-legend.tsx`, the heatmap's
and fund map's colour reads, tests. Size M.

**A3. Kind colours on a leash.** The holders list's dots and the sankey's holder nodes use the kind
palette (`kinds.ts`); in dark mode "Super fund" is a green bar at the top of the sankey, the first
thing the eye lands on. Decision: kind colours stay categorical but are desaturated in dark mode to
the sage/olive family's muted step and never brighter than the amber selection; the sankey's holder
nodes carry their kind colour only as a 4px edge, the node body in the neutral band colour. Done:
no kind colour's chroma exceeds the amber's in either theme (a test over `kinds.ts`), sankey and
holders screenshots. Files: `lib/ownership/kinds.ts`, `ownership-flows-static.tsx`,
`holder-browser.tsx`. Size S.

**A4. Figures at the precision of the view.** The stock rail prints "19.4336%" and "13.131%"
because `formatVotingPower` keeps a notice's stated precision. That rule is right for a single
notice's figure (spec 14.9) and wrong for a sum and for a headline. Decision: the rail's headline
and every sum print two decimals; a single notice's figure keeps its precision only in the notices
list and the register's own row. Done: a `formatHeadlinePct` with tests, the rail screenshot.
Files: `inspectors/stock-inspector.tsx`, `lib/ownership/kinds.ts` (`formatSum` already exists;
use it). Size S.

## B. Declutter

**B1. The map page's method is a disclosure, not a chapter.** Under the map sit seven paragraphs of
"Sources and method" (about 900 words), then the footer. Decision: the map (and every instrument
page) ends with one line, "How these figures are read" as a `<details>` holding the method, with the
first sentence of each paragraph as its summary line; the full text stays in the HTML for crawlers
and the methodology page. The two captions above the map ("The net change and the notice counts
cover…", "7 funds compared…") merge into one coverage line, and the legend caption stops repeating
it. Done: the map page under 1,800px tall at 1440 with the map in view by 700px, the method still in
the HTML. Files: `app/ownership/map/page.tsx`, a shared `method-disclosure.tsx`, the other six pages.
Size S.

**B2. The Overview is a desk, not a stack.** `/ownership` is 4,400px tall at 1440: a search row, two
chip rows, four instruments at full height, five closed record expanders, the four KPI tiles, then
the method. Nothing says what to look at first. Decision: the hub becomes one screen plus a scroll:
(1) a headline band with the four figures that changed since the last file (the KPI tiles, rewritten
as sentences: "18,173 notices read, 41 released this week"); (2) the map and the flows side by side
at a fixed 420px, the heatmap and the fund positions below at 320px, each with its title as the link
to its page and NO second toolbar (the hub takes one Window select and one Source select, in the
same row as the search, see 14.9's Overview decision); (3) the five record sections move to a
"Records" row of five links with their counts, no expanders; (4) the method behind B1's disclosure.
Done: hub under 2,400px at 1440, one toolbar row, the four instruments visible by 1,100px.
Files: `app/ownership/page.tsx`, `desk/desk-toolbar.tsx`. Size M. Depends on B1.

**B3. The Funds toolbar in one row.** Funds has a search, a Manager select, two segmented controls
and a second row (Files available | All tracked). Decision: one `Toolbar` row of selects (Manager,
Kind: Index funds | Super options, View: Sector weights | Holdings, Files: Available | All tracked)
with the search first, folded under "Adjust view" below sm, as the instrument pages do; the table's
first column holds the logo, ticker and manager on ONE line (the manager monogram before the name,
the ETF/POOLED tag after the ticker). Done: one row at 1440 (the toolbar probe), rows 44px tall.
Files: `funds/fund-exposure-map.tsx`, `app/ownership/funds/page.tsx`. Size S.

**B4. Changes opens on something to read.** The default Fund snapshots tab opens on VAS with the
same date in both selects and the copy "Two file dates of this fund are needed to compare them":
an empty state on arrival. Decision: the default pair is the fund's two newest file dates (the API's
`CompareFundSnapshots` default), and a fund with one file is listed after every fund with two; the
Show select and Export CSV move into the toolbar row; the sentence under the title becomes the
comparison's own caption ("VAS, 2026-10-15 against 2026-11-02: 12 holdings changed"). Done: the
page's default view lists rows, a test on the default pair. Files: `funds/fund-changes-table.tsx`,
`app/actions/ownershipFunds.ts`. Size S.

**B5. The institution page is 19,000px tall.** `/ownership/vanguard` lists every interest and every
fund holding as full rows. Decision: the page keeps the holder's tree (as the Holders page draws it)
and the twenty largest rows of each list with "Show all N" (the holders' rule in 14.9), the rest
behind the disclosure, still in the HTML. Done: under 3,000px at 1440 with every row reachable.
Files: `app/ownership/[slug]/page.tsx`. Size S.

**B6. The connections' labels.** Holder-node labels are cut ("Sovereign or public…", "Active
manag…") and "Unclassified" is the third-largest node. Decision: holder labels use the kinds' short
names (`kindInfo(kind).short`: "Super", "Index", "Active", "Hedge", "Bank/broker", "Sovereign",
"PE", "Listed co", "Unclassified") with the full name in the title; "Unclassified" is drawn last,
in muted ink, at 60% band opacity, so it is read as a remainder; the gutter widens to the longest
short name. Done: no truncated label at 1440 or 390, screenshot. Files: `kinds.ts`,
`ownership-flows-static.tsx`, `flows-layout.ts`. Size S.

## C. Drill-down and insight

**C1. The rail leads with the finding.** Every inspector opens with a figure and a list; nothing says
what is notable. Decision: each inspector gets one "Reading" line under its heading, a plain
sentence computed from the data, never prose from a model: a stock: "Index funds hold 3.41%, up
0.12 pp since 15 Oct; State Street added 1.2M shares; 3 notices in 91 days, the last on 27 Oct"; a
connection: "Index managers hold 2 companies in Materials, BHP largest at $13.4B"; a holder: "172
positions, 14 new this quarter, largest in Banks"; a cell: "8 notices in the week of 26 Oct, 5 rises
and 3 falls, net +4.2 pp"; a fund: "VAS, 2026-11-02: Banks 25.0% (+0.4 pp since 30 Sep)". Each
figure in the sentence is one the rail already shows or the rpc already serves; a missing figure
drops its clause, never reads 0. Done: pure `reading(content)` functions with tests per inspector,
the sentence first in every rail. Files: `workspace/inspectors/*.tsx`, `inspector.tsx`. Size M.

**C2. A trail you can walk back.** Drilling (sector zoom, then a stock, then its holder) leaves no
trace; the only way back is the browser. Decision: the rail's header carries a trail of the
selections the reader has taken on this page (`Materials > BHP > State Street`, at most four, in
sessionStorage, never in the link), each a link that restores that selection; the sub-nav's page
link keeps the current selection in its href when the target page can show it (a stock on the map
and the connections; a holder on Holders and Connections). Done: a trail test, a screenshot after
three drills. Files: `workspace/inspector.tsx`, `workspace/selection.ts`, `ownership-nav.tsx`.
Size M.

**C3. Rank by what moved.** The instruments draw levels; the reader wants movers. Decision: every
instrument gets a "Sort: Largest | Most changed" segmented control in its toolbar row where it has a
change measure (the map's sector bands order by net change under a diverging lens; the heatmap's rows
by the window's net change with a direction glyph; the holders' list by positions gained in the
window; the fund exposure map's rows by the largest weight change); the Overview's four instruments
default to "Most changed". Done: a sort test per instrument, one toolbar row kept. Files: the
`-static.tsx` of each instrument, `desk-state.ts` (`sort` param). Size M.

**C4. The sector's holders, on zoom.** A zoomed map sector shows its stocks and nothing of who holds
the sector. Decision: with `sector` set and no selection, the rail's empty state lists the sector's
ten largest holders by estimated exposure with their change in the window (`GetOwnershipFlows`
bands already carry `top_holders`; the sector's exposure by holder is their sum), each a selection
link to the connection. Done: a test on the aggregation, a screenshot of a zoomed sector. Files:
`app/actions/ownershipDesk.ts`, `inspectors/sector-inspector.tsx` (new). Size S.

**C5. Compare two funds.** The fund exposure map's checkboxes select rows but nothing compares them.
Decision: ticking two funds opens a "Compare" rail: the two columns of sector weights side by side
with the difference per sector, the holdings only one holds, and a link to Changes with both funds;
a third tick replaces the oldest. Done: a pure diff with tests, the rail screenshot. Files:
`funds/fund-exposure-map.tsx`, `inspectors/compare-inspector.tsx` (new). Size M.

**C6. Notices behind a map cell, by week.** The stock rail's "Recent activity" is five notices with
no shape. Decision: the stock rail draws a 26-week strip of the stock's notices (one bar per week,
the hovered week's count in the title), and clicking a bar opens the feed for that week and stock;
the same strip sits in the holder rail for the holder. Done: a pure `weekStrip` with tests, both
rails screenshot. Files: `inspectors/stock-inspector.tsx`, `holder-inspector.tsx`, a `week-strip.tsx`
drawn with the heatmap's bins. Size S. Depends on A2.

**C7. Explain a cell by its holders.** The heatmap's cell inspector lists the week's notices. Decision:
it groups them by holder kind first (the counts per kind as five short rows), then lists the ten
largest moves of the cell (present less previous), then the "View N notices" link, so a reader sees
who moved the sector before reading the notices. Done: tests on the grouping, screenshot. Files:
`inspectors/cell-inspector.tsx`, `app/actions/ownershipDesk.ts`. Size S.

## D. Phone

**D1. The phone map is a map.** At 390 the map is a column of sector chips with full GICS names; no
cell is drawn. Decision: the compact map draws a 1:1 treemap of the sectors only (area by the Size
lens, colour by the Colour lens, the short sector name and its figure in each cell, 2 columns at
most), and a sector tap opens that sector's stocks as the full map does on a zoom; the chips go.
Done: a treemap at 390 with every sector readable, screenshot, the toolbar folded. Files:
`desk/ownership-map-static.tsx` (`variant="phone"`), `map-layout.ts`. Size M.

**D2. The hub's first phone screen.** At 390 the Overview's first screen is the title, the lede, a
plate of dates, the search, two chip rows and the window chips; the first instrument starts at
700px. Decision: the plate folds into the "Adjust view" disclosure with the controls; the first
instrument (the map, D1) is in view under the title. Done: an instrument within 420px at 390.
Files: `app/ownership/page.tsx`. Size S. Depends on B2, D1.

## E. Data the surfaces reveal

**E1. Holder names from the notice parser.** The Activity rail's largest moves print "Eric
Sondergaard Name" and "This notice is given by Carma", and a +73 pp move on MHC: the stored holder
name of a notice the parser read badly. Decision (the job, not the web): `notice.go` rejects a
holder name that contains "Name", "This notice", "is given by" or a form phrase, and a stated change
over 50 pp is withheld unless both figures are read from the same table row; the repair mode
re-reads the affected rows. Done: fixtures for the three notices, the rail no longer lists them.
Files: `services/jobs/internal/jobs/ownership/notice.go`, `repair.go`, fixtures. Size M.

**E2. Company names in title case.** The rail prints "Bhp Group" and the map "Bhp Group Limited"
where the register says "BHP Group". Decision: the API serves the company name as `company-metadata`
holds it, and only a name stored in all caps is title-cased, with an allowlist of tickers that stay
upper (BHP, CSL, NAB, ANZ, QBE, AMP, IAG, CBA, WBC, S32, REA, ASX). Done: a Go test on the cases.
Files: `services/shorts/internal/services/shorts/ownership_universe.go`. Size S.

## Order

A1, B1, B4 and A4 first (an afternoon each, visible at once). Then A2 and B6 together (the palette
and the sankey), then C1 (the reading line, the largest single gain in "insight"), C3, D1. B2 and
D2 after B1 and D1. C2, C4, C5, C6, C7, B3, B5, A3 fill in behind. E1 and E2 are the ownership
job's and can run in parallel with everything.

## Status (2026-11-05)

Built in five waves on `claude/ownership-workspace-backlog`, each item by one implementing agent under
strict file ownership and one reviewing agent, every wave gated (Go, tsc, lint, Jest, the scripts tests)
and measured against a local production build in both themes at 1440 and 390. The decisions taken are
section 14.11 of the design spec. Measured heights at 1440x900 (`document.documentElement.scrollHeight`,
the footer included), before and after:

| Page | At the review | After |
|---|---|---|
| `/ownership` | 4,401 | 2,129 (one toolbar row; the four instruments by 1,100px; a Records row) |
| `/ownership/map` | 2,568 | 1,763 (the map by 300px; the method folded) |
| `/ownership/funds` | 1,932 | 1,638 (one toolbar row; 44px rows) |
| `/ownership/vanguard` | 19,465 | 5,413 (ten rows per list; the connections tree is 1,750 of it; 3,000 was not reachable with any number of rows) |
| `/ownership/map` at 390 | 2,616 (a chip column) | 2,215 (a two-column square treemap of sectors) |
| `/ownership` at 390 | 5,460 | 3,843, the map the first screen's instrument |

Every item landed: A1 to A4, B1 to B6, C1 to C7, D1, D2, E1, E2. Refinements of the decisions above,
recorded in 14.11: the light ramp's top bin is one step deeper than Burnt Amber (AA at 11px); the
institution page shows ten rows, not twenty; the phone map's minimum cell is 32 units, not 44; the hub's
Window and Source are selects; the compact heatmap draws the count measure; the sort does not re-order the
phone square; a comparison is the two keys in `?funds=` and shows in the lg rail only; the map's Colour
option reads "Fund shares". E1's production repair (`shorted ownership -mode repair-placeholders
-apply -dry-run=false`) is a hand run after the deploy, and E2's clean names reach the pages when the API
deploys.
