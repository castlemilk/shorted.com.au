"use client";

/**
 * The hub's centrepiece: every parliamentarian, with what they currently declare.
 *
 * WHY A CLIENT ISLAND AT ALL. /politicians is a static-ISR SEO asset and the
 * page must not read `searchParams` — doing so silently flips the route to
 * dynamic and kills the ISR (the trap /price-drops already paid for). So the
 * server page renders the FIRST page of this table into the HTML, and every
 * subsequent sort/filter/page is a server action call from here. The crawler
 * gets real rows; the reader gets a live table; the route stays static.
 *
 * WHY THE ACTION ARRIVES AS A PROP. A `"use client"` politician file may not
 * import the generated protobuf module, directly or through anything else
 * (`__tests__/client-boundary.test.ts` walks the whole import graph). Importing
 * the server action module here would reach `getPoliticians.ts` and therefore
 * `~/gen/...`, so the page passes the action down instead — which also makes
 * the fetch behaviour trivially mockable in tests.
 *
 * EDITORIAL. Every row names a real person, so:
 *   - every number is a COUNT OF DECLARED ENTRIES, never a quantity or a value
 *   - NO risk/status/score column, and no green/red — a colour that reads as a
 *     verdict beside a named member is exactly the imputation rule 2 forbids
 *   - the real-estate column counts currently-declared item-3 ENTRIES, and
 *     roughly a third of those entries list more than one property, so it is a
 *     FLOOR on entries declared and is labelled as entries. It must never be
 *     rendered as "owns N properties"
 *   - an empty row is coverage, not a finding: we have not read every document
 *     for every parliament
 */

import Link from "next/link";
import { useCallback, useId, useRef, useState } from "react";

import { SparkTrend } from "@/components/politicians/explorer/spark-trend";
import { PoliticianAvatar } from "@/components/politicians/politician-avatar";
import { PartyMark } from "@/components/politicians/party-mark";
import { partyLabel } from "@/lib/politics/party-palette";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";
import {
  POLITICS_FILTER_BUTTON_CLASS,
  POLITICS_PAGER_BUTTON_CLASS,
  POLITICS_SELECT_CLASS,
} from "@/lib/politics/control-classes";

/** Mirrors `PoliticianSummarySort` without importing the generated enum. */
export type PoliticianTableSort =
  | "declared_items"
  | "companies"
  | "properties"
  | "recent_changes"
  | "name";

export interface PoliticianTableQuery {
  chamber: string;
  stateCode: string;
  partyAb: string;
  /** 1–14, or 0 for every register item. */
  itemNo: number;
  sort: PoliticianTableSort;
  limit: number;
  offset: number;
}

export interface PoliticianTableTrendPoint {
  month: string;
  count: number;
}

/**
 * One row, as plain JSON.
 *
 * Mapped from the proto server-side: protobuf Timestamps are BigInt-backed and
 * do not survive `JSON.stringify`, and the generated message types carry a
 * `$typeName` that has no business crossing the RSC boundary.
 */
export interface PoliticianTableRow {
  slug: string;
  displayName: string;
  partyAb: string;
  chamber: string;
  division: string;
  stateCode: string;
  /** Sum of the fourteen register items, currently declared. */
  declaredItems: number;
  companies: number;
  /** Currently-declared item-3 ENTRIES. A floor — see the file docblock. */
  realEstateEntries: number;
  giftsTravel: number;
  changes90d: number;
  /** Entries with no stated start date, which cannot be plotted. */
  undatedCount: number;
  trend: PoliticianTableTrendPoint[];
  photoUrl: string;
  photoLicence: string;
  photoAuthor: string;
  photoSourceUrl: string;
}

export interface PoliticianTablePage {
  rows: PoliticianTableRow[];
  /** The filtered total, for pagination — not the size of `rows`. */
  total: number;
  /** The query the SERVER actually ran, after its own clamping. */
  query: PoliticianTableQuery;
  /**
   * Did the request actually answer?
   *
   * REQUIRED, AND NOT INFERABLE FROM `rows`. A backend outage and a filter
   * nobody matches both arrive here as zero rows; without this flag the island
   * words the first as the second and publishes "No members match these
   * filters" over our own downtime. `false` is a normal result, not an
   * exception — the action never throws.
   */
  ok: boolean;
}

/*
 * NO DEFAULT-QUERY CONSTANT IS EXPORTED FROM HERE, DELIBERATELY.
 *
 * A server component cannot read a plain value out of a "use client" module:
 * Next hands it a client-reference proxy, and the first property access throws
 *
 *   Cannot access itemNo.valueOf on the server. You cannot dot into a client
 *   module from a server component.
 *
 * — at PRERENDER time, so jest and tsc both pass and only the build finds it.
 * The default therefore lives on the server side (`loadPoliticianTable` clamps
 * a partial query into a full one), and this island only ever reads the query
 * the server echoed back on the page it was given.
 */

export interface PoliticianRegisterTableProps {
  initialPage: PoliticianTablePage;
  loadPage: (query: PoliticianTableQuery) => Promise<PoliticianTablePage>;
  /** State codes present in the corpus, in the order they should be offered. */
  stateOptions?: string[];
  /** Party abbreviations present in the corpus. */
  partyOptions?: string[];
}

const CHAMBER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Both chambers" },
  { value: "house", label: "House" },
  { value: "senate", label: "Senate" },
];

const ITEM_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Any register category" },
  ...Object.entries(REGISTER_ITEMS).map(([itemNo, item]) => ({
    value: Number(itemNo),
    label: `${itemNo}. ${item.label}`,
  })),
];

/**
 * The sortable columns, and the label each one carries.
 *
 * "Gifts & travel" is deliberately absent: the backend has no sort for it, and a
 * header that looks sortable and silently is not is worse than a plain one.
 */
const SORTABLE: Partial<Record<PoliticianTableSort, string>> = {
  name: "Member",
  declared_items: "Declared entries",
  companies: "Companies",
  properties: "Real-estate entries",
  recent_changes: "Changes (90d)",
};

const SELECT_CLASS = POLITICS_SELECT_CLASS;

/**
 * The party chip, rendered locally rather than imported from `compliance.tsx`.
 *
 * Same reason as `politician-explorer.tsx`: compliance has no "use client" and
 * imports the generated `RegisterHolder`, so pulling a chip from it drags the
 * protobuf runtime into this bundle and takes the static build of /politicians
 * down with an "Element type is invalid" error. `party-palette.ts` is pure data
 * and exists for exactly this — and `<PartyMark>` is client-safe by the same
 * construction, so the MARK is shared even though this wrapper is not.
 *
 * The mark carries the party's full name as its own accessible name, so the
 * visible label is `aria-hidden`: otherwise every one of 25 rows announces the
 * party twice.
 */
function TablePartyChip({ partyAb }: { partyAb?: string }) {
  if (!partyAb) {
    // Party reaches the register through an electorate join, not the APH
    // listing, so absence is real and is labelled as absence — never guessed.
    return <span className="text-[11px] text-muted-foreground">Party not recorded</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <PartyMark abbreviation={partyAb} size="sm" />
      <span aria-hidden>{partyLabel(partyAb)}</span>
    </span>
  );
}

/**
 * A sortable column header.
 *
 * Module-level, NOT nested in the table component: a component declared inside a
 * render is a NEW component type on every render, so React unmounts and remounts
 * the header on each state change and the sort button loses keyboard focus the
 * instant it is used.
 */
function SortHeader({
  sort,
  activeSort,
  onSort,
  className,
}: {
  sort: PoliticianTableSort;
  activeSort: PoliticianTableSort;
  onSort: (sort: PoliticianTableSort) => void;
  className?: string;
}) {
  const active = activeSort === sort;
  return (
    <th
      scope="col"
      // Every sortable column is descending — these are counts with a natural
      // zero and no polarity, so there is no "ascending" reading to offer.
      aria-sort={active ? "descending" : "none"}
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(sort)}
        className={`hover:text-foreground ${
          active ? "text-foreground underline decoration-dotted underline-offset-4" : ""
        }`}
      >
        {SORTABLE[sort]}
      </button>
    </th>
  );
}

function seatOf(row: PoliticianTableRow): string {
  if (row.chamber === "senate") {
    return row.stateCode ? `Senator for ${row.stateCode}` : "Senator";
  }
  if (row.division) {
    return row.stateCode ? `${row.division} · ${row.stateCode}` : row.division;
  }
  return row.stateCode;
}

function rangeLabel(offset: number, shown: number, total: number): string {
  if (shown === 0) return "0 members";
  const first = offset + 1;
  const last = offset + shown;
  return `${first}–${last} of ${total.toLocaleString()}`;
}

export function PoliticianRegisterTable({
  initialPage,
  loadPage,
  stateOptions = [],
  partyOptions = [],
}: PoliticianRegisterTableProps) {
  const [page, setPage] = useState<PoliticianTablePage>(initialPage);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  // Every request carries a sequence number and only the newest one may write
  // state: two fast filter changes otherwise race, and the SLOWER one wins,
  // leaving the table showing rows that match neither control.
  const sequence = useRef(0);
  const controlsId = useId();

  const query = page.query;

  const run = useCallback(
    (next: PoliticianTableQuery) => {
      const ticket = (sequence.current += 1);
      setStatus("loading");
      loadPage(next)
        .then((result) => {
          if (sequence.current !== ticket) return;
          setPage(result);
          setStatus("idle");
        })
        .catch(() => {
          if (sequence.current !== ticket) return;
          setStatus("error");
        });
    },
    [loadPage],
  );

  // Any filter change resets to the first page: keeping the offset would land a
  // reader on page 4 of a 2-page result and show them nothing.
  const setFilter = useCallback(
    (patch: Partial<PoliticianTableQuery>) => run({ ...query, ...patch, offset: 0 }),
    [query, run],
  );

  const toggleSort = useCallback(
    (sort: PoliticianTableSort) => run({ ...query, sort, offset: 0 }),
    [query, run],
  );

  const rows = page.rows;
  const filtersActive =
    !!query.chamber || !!query.stateCode || !!query.partyAb || query.itemNo > 0;
  const hasPrevious = query.offset > 0;
  const hasNext = query.offset + rows.length < page.total;

  /*
   * THE TWO EMPTY TABLES, WHICH MEAN OPPOSITE THINGS.
   *
   * An OUTAGE is either a thrown action or a page the server marked `ok: false`
   * — the request did not answer, whatever the row count says. It used to be
   * only the thrown case, so a failed fetch that resolved to `{rows: [], total:
   * 0}` fell through to the empty-state copy below and, with a filter set, read
   * as "No members match these filters": an absence claim about every member
   * that filter covers, published on our own downtime.
   *
   * An UNFILTERED empty table is an outage too, by arithmetic: parliament is
   * never empty, so zero rows with no filter set can only be us.
   *
   * Everything left over — zero rows, filters set, a response that answered —
   * is the one case where "no members match" is an honest sentence.
   */
  const outage = status === "error" || page.ok === false || (rows.length === 0 && !filtersActive);

  return (
    <div className="space-y-3">
      {/*
        Two columns on a phone, the flex row from `sm:` up. In a `flex-wrap` row
        at 375 px the four filters ran off the right edge — "Party" was clipped
        mid-word and "Register category" was entirely off screen and unreachable
        without scrolling the whole document sideways. See `control-classes.ts`
        for why the selects also need `w-full` here.
      */}
      <div className="grid grid-cols-2 items-end gap-2 [&>*]:min-w-0 sm:flex sm:flex-wrap">
        {/*
          Native selects, not the Radix kit: this island is a filter surface on
          a route whose bundle budget is watched, and its filter BEHAVIOUR is
          what the tests drive — the repo's Radix select mock renders inert
          divs, so a shadcn Select here would be untestable as well as heavier.
        */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Chamber
          </span>
          <select
            id={`${controlsId}-chamber`}
            className={SELECT_CLASS}
            value={query.chamber}
            onChange={(e) => setFilter({ chamber: e.target.value })}
          >
            {CHAMBER_OPTIONS.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">State</span>
          <select
            id={`${controlsId}-state`}
            className={SELECT_CLASS}
            value={query.stateCode}
            onChange={(e) => setFilter({ stateCode: e.target.value })}
          >
            <option value="">All states</option>
            {stateOptions.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Party</span>
          <select
            id={`${controlsId}-party`}
            className={SELECT_CLASS}
            value={query.partyAb}
            onChange={(e) => setFilter({ partyAb: e.target.value })}
          >
            <option value="">All parties</option>
            {partyOptions.map((ab) => (
              <option key={ab} value={ab}>
                {partyLabel(ab)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Register category
          </span>
          <select
            id={`${controlsId}-item`}
            className={SELECT_CLASS}
            value={String(query.itemNo)}
            onChange={(e) => setFilter({ itemNo: Number(e.target.value) })}
          >
            {ITEM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {filtersActive ? (
          <button
            type="button"
            onClick={() =>
              setFilter({ chamber: "", stateCode: "", partyAb: "", itemNo: 0 })
            }
            className={POLITICS_FILTER_BUTTON_CLASS}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {outage ? (
        // One outage paragraph, worded by whether the reader has a filter set —
        // "these filters could not be applied" is the wrong sentence when they
        // never applied any. Neither wording claims anything about a member.
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {filtersActive
            ? "These filters could not be applied just now. The full roll of members is further down this page, and nothing here is missing from the register."
            : "This table is unavailable right now. The full roll of members is further down this page, and nothing here is missing from the register."}
        </p>
      ) : null}

      {/*
        THE TABLE IS A DIFFERENT TABLE ON A PHONE, not the same table squeezed.
        At 375 px the seven-column layout put FOUR columns (Companies,
        Real-estate entries, Changes 90d, and the trend sparkline) off the right
        edge, and the `min-w-[52rem]` that forced them there also defeated this
        scroller — see the `min-w-0` note on the grid in page.tsx.

        Two changes, and they work together:
          - `min-w-[52rem]` is now `sm:` only, so below `sm` the table lays out
            inside the viewport and there is nothing to scroll horizontally at
            all. From `sm:` up the dense seven-column table and its scroller are
            exactly what they were.
          - the five count/trend columns are `hidden sm:table-cell`, and the
            counts they carry are re-rendered underneath the member's name as a
            wrapped summary line (`sm:hidden`). Nothing is withheld from a
            narrow reader; it is stacked instead of scrolled.

        The `<caption>`/`<thead>` semantics are untouched, so the screen-reader
        reading order is unchanged at every width.
      */}
      <div className="overflow-x-auto" aria-busy={status === "loading"}>
        <table
          className={`w-full sm:min-w-[52rem] text-sm ${status === "loading" ? "opacity-60" : ""}`}
        >
          <caption className="sr-only">
            Federal parliamentarians and what they currently declare in the Registers of
            Members&rsquo; and Senators&rsquo; Interests. Every column is a count of declared
            entries; the registers record no quantity or value.
          </caption>
          <thead className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <SortHeader
                sort="name"
                activeSort={query.sort}
                onSort={toggleSort}
                className="py-2 pr-3 text-left font-normal"
              />
              <SortHeader
                sort="declared_items"
                activeSort={query.sort}
                onSort={toggleSort}
                className="py-2 pr-3 text-right font-normal"
              />
              <SortHeader
                sort="companies"
                activeSort={query.sort}
                onSort={toggleSort}
                className="hidden py-2 pr-3 text-right font-normal sm:table-cell"
              />
              <SortHeader
                sort="properties"
                activeSort={query.sort}
                onSort={toggleSort}
                className="hidden py-2 pr-3 text-right font-normal sm:table-cell"
              />
              <th scope="col" className="hidden py-2 pr-3 text-right font-normal sm:table-cell">
                Gifts &amp; travel
              </th>
              <SortHeader
                sort="recent_changes"
                activeSort={query.sort}
                onSort={toggleSort}
                className="hidden py-2 pr-3 text-right font-normal sm:table-cell"
              />
              <th scope="col" className="hidden w-40 py-2 text-left font-normal sm:table-cell">
                12-month trend
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              // A hover tint on the whole row, because the row is a unit: the
              // member's name is the only link in it and the four counts to its
              // right belong to that person. `transition-colors` only — no
              // transform, no shadow, nothing that could move a row under a
              // pointer that is already travelling towards a name.
              <tr
                key={row.slug}
                className="border-b last:border-0 align-middle transition-colors hover:bg-muted/40"
              >
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <div className="flex items-center gap-2.5">
                    <PoliticianAvatar
                      displayName={row.displayName}
                      partyAb={row.partyAb}
                      size="sm"
                      photo={{
                        photoUrl: row.photoUrl,
                        photoLicence: row.photoLicence,
                        photoAuthor: row.photoAuthor,
                        photoSourceUrl: row.photoSourceUrl,
                      }}
                    />
                    <div className="min-w-0">
                      {/*
                        `prefetch={false}` ON A BULK LINK LIST. Next prefetches
                        the RSC payload of every `<Link>` in the viewport, and a
                        page of 25 member rows is 25 x ~23 KB of profile payload
                        for navigation that mostly will not happen — measured at
                        1,179 KB across 56 requests on the hub's first load,
                        roughly DOUBLING the page's transfer. Prefetch is kept
                        for the handful of primary CTAs, not spent on a roll.
                        `inline-block py-1` is the tap target: these links were
                        18 px tall against a 44 px floor, and padding buys the
                        height without touching the type scale.
                      */}
                      <Link
                        href={`/politicians/${row.slug}`}
                        prefetch={false}
                        className="inline-block py-1 font-medium hover:underline"
                      >
                        {row.displayName}
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-[11px] text-muted-foreground">{seatOf(row)}</span>
                        <TablePartyChip partyAb={row.partyAb} />
                      </div>
                    </div>
                  </div>
                  {/*
                    THE COLUMNS THIS WIDTH CANNOT SHOW, STACKED INSTEAD.

                    Rendered only below `sm:`, where the matching cells are
                    `hidden` — so no figure is ever on screen twice and no figure
                    is ever withheld from a narrow reader. `aria-hidden` because
                    the real cells are still in the accessibility tree with their
                    column headers attached: a screen reader should hear
                    "Companies, 4" once, not this shorthand as well.

                    A 2-COLUMN GRID, AND IT SITS OUTSIDE THE AVATAR ROW. Both
                    details are measured, not stylistic. Inside the name block it
                    only had 146 px (the cell is 201 px, less a 32 px avatar and
                    the gap), so four items became four lines — 86 px per row, on
                    25 rows. Out here it gets the full cell and a fixed 2x2, which
                    is 2 lines. The labels stay the column headers' own words so a
                    reader moving between the phone and the desktop layout is
                    reading the same table.
                  */}
                  <div
                    aria-hidden
                    className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground sm:hidden"
                  >
                    <span>{row.companies} companies</span>
                    <span>{row.realEstateEntries} real-estate</span>
                    {/*
                      "gifts/travel", not "gifts & travel": the ampersand form is
                      the only one of the four that does not fit an 83 px grid
                      cell at 10 px, and a cell that wraps costs every row a line.
                      Both words are kept — this is an abbreviation of the column
                      header, not a different measure.
                    */}
                    <span>{row.giftsTravel} gifts/travel</span>
                    <span>{row.changes90d} changes 90d</span>
                  </div>
                </th>
                <td className="py-2 pr-3 text-right tabular-nums">{row.declaredItems}</td>
                <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">
                  {row.companies}
                </td>
                <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">
                  {row.realEstateEntries}
                </td>
                <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">
                  {row.giftsTravel}
                </td>
                <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">
                  {row.changes90d}
                </td>
                <td className="hidden py-2 sm:table-cell">
                  <SparkTrend
                    points={row.trend}
                    undatedOnly={row.trend.length === 0 && row.undatedCount > 0}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && !outage ? (
        // The ONLY empty state that says anything about a result rather than
        // about us: the request answered, a filter is set, and nothing matched
        // it. That is an honest answer about the filter — and it says so, so a
        // reader cannot take it as a statement about anyone's register.
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No members match these filters. Widen them, or search by name above — an empty result is
          a filter, not a statement about anyone&rsquo;s register.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{rangeLabel(query.offset, rows.length, page.total)}</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={!hasPrevious || status === "loading"}
            onClick={() =>
              run({ ...query, offset: Math.max(0, query.offset - query.limit) })
            }
            className={POLITICS_PAGER_BUTTON_CLASS}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!hasNext || status === "loading"}
            onClick={() => run({ ...query, offset: query.offset + query.limit })}
            className={POLITICS_PAGER_BUTTON_CLASS}
          >
            Next
          </button>
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Counts are of entries currently declared. Real-estate entries are register entries under
        item 3 — some entries list more than one address, so the column is a floor on what was
        declared, not a tally of properties. The trend plots only entries whose start date the
        register states; entries with no stated date are not plotted.
      </p>
    </div>
  );
}
