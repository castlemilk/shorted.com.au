# Explorer UI — the politician explorer, profile, and compare surfaces

Plan of record for the 2026-07-31 explorer build. Three wireframes drive this
work (an explorer hub, a rich per-politician profile, a head-to-head compare).
The wireframes are donations-branded mockups from another product; this doc maps
them onto **our** data — the register of interests — under the editorial rules.
Read [README.md](README.md) and
[../../influence-editorial-standards.md](../../influence-editorial-standards.md)
first; nothing below overrides them.

## 1. The adaptation rules (wireframe → what we actually build)

The wireframes show things we must not or cannot build. These translations are
non-negotiable and every work package inherits them:

| Wireframe shows | We build | Why |
|---|---|---|
| `$2.45M total declared interests`, `$415K liabilities`, any `$` figure | **Counts**: declared items, distinct listed companies, properties, liabilities entries | Rule 5: what is held, never how much. No amount field exists anywhere in the subsystem and a migration test asserts none appears. Column and field names must avoid `value|amount|worth|price` even for counts |
| `Risk / status` column (`Low · Clean`, `Medium · Monitor`) | **Recent changes (90d)** count, or nothing | "Monitor"/"risk" next to a named MP is an imputation. Banned outright |
| `Battle`, `Battle Score 62–38`, `winner`, `leads`, trophy icons | Neutral **Compare**: symmetric side-by-side counts, shared holdings, differences. No score, no winner, no advantage chips | Editorial rule 2 (juxtaposition/iconography). The register-items glyph test already bans warning/currency iconography near named people |
| Donations, donors, funding growth | Register categories only (14 form items) | We have no donations data in this feature; do not fake it with register counts wearing donation labels |
| Trend sparklines and timelines | Counts over time from **dated** holding periods only (`declared_from_known`), with an explicit "N undated entries not plotted" note where nonzero | Same rule the changes feed already follows: never fabricate a timeline point |
| `Electorate margin`, `Next election` | Omitted (v1) | Not in our data; AEC joins are suburb-grained, not division-grained |
| `Follow`, `Export CSV` | Omitted (v1) | Auth feature / licence-review needed before inviting bulk reuse of CC BY-NC-ND-derived facts |
| Green/red trend arrows, multi-hue palettes | One sequential amber ramp (`@/lib/politics/analytics-palette`); party colours (`party-palette`) only for party identity; compare series use each side's party colour | House rule: "there is no bad end here". Enforced by existing tests |
| `Verified` badge | Omitted | Implies an endorsement we cannot substantiate |

Two more standing constraints from the codebase (both enforced by tests):

- **No chart library.** All politician surfaces are chart-lib-free by design
  (bundle + a11y). New charts are tiny hand-rolled SVG primitives (donut arc,
  polyline sparkline, area timeline, paired bars, radar polygon) with
  `role="img"`, full `aria-label`s and `sr-only` table fallbacks.
- **A `"use client"` file must never import `compliance.tsx` or
  `politicians_pb`** (`client-boundary.test.ts`). Client islands take
  serialisable props from server pages, or duck-typed JSON from server actions.

And the ISR rules that have bitten before: hub pages never read `searchParams`
(the compare page reads `?a=&b=` client-side via `useSearchParams` under
`Suspense`, the `/price-drops` pattern); server-action Connect transports keep
the `next: { revalidate }` tag; every KV writer/reader pair uses a
non-emptiness predicate.

## 2. The three surfaces

### 2a. `/politicians` — the explorer hub (wireframe 3)

Keeps its identity ("Parliament's Portfolio", server component, ISR 3600,
`bailOnEmptyRender`), gains the explorer layer:

1. **Status strip** (3 cards, replacing the mock's "data quality / filings /
   signal"): **Coverage** (volumes extracted vs pending, from the overview —
   states plainly that parliaments 44–45 and the Senate volumes are pending);
   **Recent activity** (change events in the last 7/30 days, count of members
   affected); **Category movement** (industries with the largest change in
   current declared listed holdings vs 90 days ago, dated-only, with method
   note).
2. **Search + filters**: the existing Algolia `PoliticianExplorer` island stays
   as the search surface. The new **politicians table** (below) carries its own
   server-backed filters: chamber, state, party, register category (item 1–14),
   sort.
3. **Count tiles** (BigStat row, extended): parliamentarians · current declared
   items · distinct ASX-listed companies · properties · gifts & sponsored
   travel (items 11+12) · liabilities entries (item 6). Deltas vs 12 months ago
   where the monthly series supports it, muted styling, no green/red.
4. **Politicians table**: portrait, name (linked), division · state, `PartyChip`,
   current declared items, distinct companies, properties, gifts/travel count,
   changes (90d), 12-month count sparkline. Default sort: declared items desc.
   Server-rendered first page; a small client island drives sort/filter/page via
   a server action. No "risk" column.
5. **Category mix donut** (14 items → grouped segments, counts) and **industry
   movement list** in a side rail; **recent filings** feed (top 8 from
   `ListRegisterChanges`, linking to `/politicians/changes`).
6. Existing heatmap, state split, full roll, cross-links, `SourceLine` +
   `CaveatNote` all stay. Footer gains the wireframe's "About this data" band:
   source, licence, as-at, refresh cadence, methodology link, Report-an-error.

### 2b. `/politicians/[slug]` — the profile (wireframe 2)

Stays a fully server-rendered SEO asset (ISR 86400, JSON-LD Person, thin-profile
noindex, `canonicalSlug` redirect). New layout:

1. **Header**: `PoliticianAvatar lg` + `PortraitCredit`, name, `PartyChip`,
   chamber · division · state, parliament range, and **terms** (the proto field
   exists; Wave 1a populates it). No margin/election facts.
2. **Count tiles**: current declared items · ASX-listed companies · properties ·
   liabilities entries · gifts & travel · "register last updated" (latest dated
   change / refresh date).
3. **Charts row**: category mix donut · declaration timeline (5y monthly count
   of current dated declarations, area chart, undated-note when nonzero) ·
   holder split donut (Self / Spouse-partner / Dependent children — the
   register's own attribute, rendered with the existing `HolderBadge` copy) ·
   top-5 industry exposure (CSS bars, counts of distinct companies).
4. **Declarations table**: one table of all published rows with category tabs
   (grouped item tabs with counts), text filter, holder filter, and per-row
   `RegisterItemTag`, `HolderBadge`, `DeclaredPeriod`, `SourceDocLink`. Client
   island receiving serialised rows (a member has ~10–100 rows; filter locally).
5. **Rail**: "Key facts" (neutral factual sentences with counts/percentages of
   counts, e.g. "12 of 18 declared listed holdings are held via spouse or
   partner"); **recent changes** for this member (from the new profile RPC);
   **source documents** (distinct APH deep links by parliament/volume).
6. `CoverageNote` stays above the lists. Compare cross-link ("Compare with…").

### 2c. `/politicians/compare` — head-to-head (wireframe 1, defanged)

New route. Server shell (static, ISR) + client island reading `?a=&b=`.

1. **Pickers**: two politician selectors (Algolia-backed typeahead, reusing the
   search plumbing), swap button, links back to each profile.
2. **Side-by-side header cards**: avatar, party, division, chamber, parliament
   range, count tiles. Visually symmetric; neither side is "winning".
3. **Category comparison**: paired horizontal bars per register category
   (counts), each side tinted by its party colour (fallback pair when both
   sides share a party). No winner column.
4. **Radar**: two translucent polygons over the grouped category axes (counts,
   sqrt-scaled). Decorative equivalent of the bars — same numbers, labelled.
5. **Shared holdings**: distinct ASX companies both declare (company, industry,
   each side's holder + currently-declared state). This is the most interesting
   panel and it is pure fact.
6. **Differences**: companies/categories only one side declares (capped list).
7. **Notes**: per-side coverage notes (different parliaments extracted for
   different members makes raw comparison misleading — say so), `SourceLine`,
   `CaveatNote`, Report-an-error.
8. OG image: static, neutral, names nobody (hub pattern).

## 3. Backend contract (Wave 1a)

Four new public rpcs on `PoliticiansService` in
`proto/shortedapi/shorts/v1alpha1/politicians.proto`, each mirrored verbatim
onto `ShortedStocksService` in `shorts.proto` (`proto_parity_test.go`), each
`VISIBILITY_PUBLIC`, each gated by `registerEnabled()` (empty response, never an
error), each carrying `source_licence` and `as_at`:

1. **`GetRegisterExplorer`** — hub aggregates: per-category counts
   (item_no, label, current row count, politician count), holder totals,
   change-event counts (7d/30d + members affected), industry movement (current
   vs 90-days-ago dated counts), coverage summary (parliament buckets from
   `register_documents`), plus the existing overview scalars it can reuse.
2. **`ListPoliticianSummaries`** — the hub table: filters (chamber, state,
   party_ab, item_no, query), sort enum (declared items / companies /
   properties / recent changes / name), limit/offset (clamped before cache
   key). Returns `Politician` + per-item counts + distinct company count +
   property count + gifts-travel count + liabilities count + changes-90d +
   12 monthly trend points (dated-only) + `undated_count`, and a real filtered
   `total`.
3. **`GetPoliticianExplorerProfile`** — profile analytics for one slug:
   item counts (current + all-time), holder counts, top-N industry exposure
   (distinct companies), 60 monthly timeline points, `undated_count`, recent
   `RegisterChangeEvent`s for this member, distinct source documents
   (label, aph.gov.au URL, parliament, chamber).
4. **`ComparePoliticians`** — `slug_a`/`slug_b` → both sides' summary
   aggregates + shared distinct companies (code, name, industry, per-side
   holder/currently-declared) + per-side-only companies (capped) + per-side
   coverage notes. Symmetric message shape; no derived score of any kind.

Also in Wave 1a: **populate `GetPoliticianResponse.terms`** (field 3 exists,
handler never fills it — the store already reads `politician_terms`).

**Data layer** — migration `000104_add_register_explorer_rollups`:

- `mv_register_politician_rollup`: one row per politician — per-item current
  counts, holder counts, distinct company count, property count, changes-90d,
  undated count. Unique index on `politician_id` (CONCURRENTLY-refreshable).
  Two measures here are easy to get wrong and are pinned by
  `register_explorer_rollups.test.mjs` + the store integration tests:
  - **`property_count` counts currently-declared item-3 ROWS, never distinct
    `sal_code`.** Only a minority of item-3 rows resolve to an ABS suburb, so a
    distinct-suburb measure publishes the resolver's hit rate as the member's
    holdings (members declaring 13–18 entries read as 0; the hub tile read 38
    against 1,248 rows). Same unit as `mv_register_suburb_property` (000096).
    It is a **floor on entries declared**, not a property tally — §2.9 of
    `architecture.md` applies, so no surface may render it as "owns N
    properties".
  - **`alltime_company_count` / `alltime_suburb_count`** replicate
    `politicianSelect`'s all-time distinct counts verbatim, and are what feeds
    `Politician.declared_listed_count` / `declared_property_count` in the
    explorer rpcs. Those proto fields are all-time on every other read path;
    the same person must not report a different number per rpc (a profile page
    gates indexability on `declaredListedCount > 0`). The currently-declared
    figures travel on `PoliticianSummary`'s own fields.
- `mv_register_politician_monthly`: (politician_id, month, current dated
  declared-item count) for the trailing 60 months, from
  `register_holding_periods` dated rows via `mv_register_public_holdings`'s
  publication gates — build it FROM the public MV so every publication
  guarantee is inherited, exactly as the analytics queries do. The month grid
  is anchored to `CURRENT_DATE` **at refresh time**, so every reader windows on
  the view's own `max(month)`, never on wall-clock `CURRENT_DATE`: a query-time
  anchor drops a point per late refresh and eventually returns nothing while
  the tiles beside the sparkline keep rendering. An empty view yields an empty
  trend, not an error.
- Industry movement (`GetRegisterExplorer`) is **dated-only and symmetric on
  both sides** — the same predicate evaluated at `CURRENT_DATE` and at
  `CURRENT_DATE - 90`. ~80% of currently-declared rows are undated, so an
  undated-inclusive "now" against a dated-only baseline reports every industry
  as growing by its undated population, and `ORDER BY abs(...)` then ranks the
  list by that artefact.
- Wire both into `refresh_register_materialized_views()`.
- No column may match the banned magnitude vocabulary
  (`register_of_interests.test.mjs` runs over migration text;
  `register_explorer_rollups.test.mjs` does the same for 000104).

Store methods in a new `postgres_politician_explorer.go`; handlers in a new
`politicians_explorer.go` following `politicians.go` conventions (clamped
limits before cache keys, `s.cache.GetOrSet`, re-assert `stock_code IS NOT
NULL`, mapper helpers). Handler tests + integration store tests
(`-tags=integration`) + parity test green.

**Prod landmine** (from [operations.md](operations.md)): the deploy does NOT
run `migrate up`. `000104` must be applied by hand on the session pooler
(port 5432, `statement_timeout=0`) BEFORE the code merges, or every politician
read path 500s.

## 4. Frontend shared kit (Wave 1b)

`web/src/@/components/politicians/explorer/` — props-only, client-safe, zero
protobuf imports, no chart library, amber/party palettes only:

- `count-donut.tsx` — SVG arcs; segments `{label, count, color?}`; centre
  total; `sr-only` table fallback.
- `spark-trend.tsx` — SVG polyline, fixed aspect, single amber.
- `trend-area.tsx` — monthly count area chart with year ticks and an optional
  "undated entries not plotted" footnote slot.
- `compare-bars.tsx` — paired A/B horizontal bars with party-colour props and
  a same-party fallback pairing.
- `compare-radar.tsx` — two translucent SVG polygons, sqrt scale, labelled
  vertices.
- `count-tile.tsx` — count + muted delta (no green/red), building on the
  existing BigStat look.
- `key-facts.tsx` — neutral factual-sentence card list.
- `about-this-data.tsx` — the footer band (source, licence, as-at,
  methodology, Report-an-error) composing existing `SourceLine`/`CaveatNote`.

Category labels/emoji come from the existing `@/lib/politics/register-items`
(no new taxonomy). Jest tests mirror the existing suites: banned-glyph checks,
editorial copy locks, a11y roles, client-boundary compliance.

## 5. Work packages & wave order

| Wave | Package | Owns (files) | Depends on |
|---|---|---|---|
| 1a | Backend: 000104 + proto + store + handlers + `buf generate` | `services/migrations/000104*`, `proto/**`, `services/shorts/**`, generated `web/src/gen/**` + `sdks/**` | — |
| 1b | Shared UI kit | `web/src/@/components/politicians/explorer/**`, kit tests | — |
| 2a | Hub redesign | `web/src/app/politicians/page.tsx`, hub-only components, `getPoliticians.ts` additions for explorer/summaries actions + `kv-cache.ts` keys | 1a, 1b |
| 2b | Profile redesign | `web/src/app/politicians/[slug]/**`, profile-only components, profile action | 1a, 1b |
| 2c | Compare page | `web/src/app/politicians/compare/**`, compare-only components, compare client action | 1a, 1b |
| 3 | Integrate, review, verify | merges, `make test`, bundle budget, Playwright vs wireframes, PR | 2a–2c |

Waves 2a/2b/2c run in parallel with **strict file ownership**: shared files
(`kv-cache.ts`, `getPoliticians.ts`) get separated per-package sections/files —
2a owns `getRegisterExplorer`/`listPoliticianSummaries` actions, 2b owns
`getPoliticianExplorerProfile`, 2c owns the compare client action; nav/cross-
link edits belong to 2a alone.

KV keys follow the house pattern (`cache:politicians:explorer`,
`…:summaries:{filters}`, `…:explorer-profile:{slug}`, `…:compare:{a}:{b}`),
each with a non-emptiness predicate on BOTH reader and writer.

## 6. Verification gates (Wave 3)

- `proto_parity_test.go`, migration tests, handler + store tests, jest suites
  (client-boundary, editorial-copy, glyph bans extended to the new components).
- `npm run bundle:budget` (the legacy `shorts_pb` import trap) and the 5%
  route-size gate on `/politicians`.
- `make test` end to end.
- Playwright screenshots of all three surfaces (light + dark) against the
  wireframes; verify via the path production uses (server actions → RPC), with
  the LISTEN-pid check before trusting any result.
- Editorial re-read of every template string against rules 1–5 (the templates
  changed, so template review re-triggers per the standards doc).
- PR prepared; merge and the hand-applied `000104` on prod stay with the
  operator.
