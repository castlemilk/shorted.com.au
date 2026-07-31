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
import { partyColorFromAb, partyLabel } from "@/lib/politics/party-palette";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";

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

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * The party chip, rendered locally rather than imported from `compliance.tsx`.
 *
 * Same reason as `politician-explorer.tsx`: compliance has no "use client" and
 * imports the generated `RegisterHolder`, so pulling a chip from it drags the
 * protobuf runtime into this bundle and takes the static build of /politicians
 * down with an "Element type is invalid" error. `party-palette.ts` is pure data
 * and exists for exactly this.
 */
function TablePartyChip({ partyAb }: { partyAb?: string }) {
  if (!partyAb) {
    // Party reaches the register through an electorate join, not the APH
    // listing, so absence is real and is labelled as absence — never guessed.
    return <span className="text-[11px] text-muted-foreground">Party not recorded</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: partyColorFromAb(partyAb) }}
      />
      {partyLabel(partyAb)}
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
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
            className="h-8 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {status === "error" ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          These filters could not be applied just now. The full roll of members is further down
          this page, and nothing here is missing from the register.
        </p>
      ) : null}

      <div className="overflow-x-auto" aria-busy={status === "loading"}>
        <table
          className={`w-full min-w-[52rem] text-sm ${status === "loading" ? "opacity-60" : ""}`}
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
                className="py-2 pr-3 text-right font-normal"
              />
              <SortHeader
                sort="properties"
                activeSort={query.sort}
                onSort={toggleSort}
                className="py-2 pr-3 text-right font-normal"
              />
              <th scope="col" className="py-2 pr-3 text-right font-normal">
                Gifts &amp; travel
              </th>
              <SortHeader
                sort="recent_changes"
                activeSort={query.sort}
                onSort={toggleSort}
                className="py-2 pr-3 text-right font-normal"
              />
              <th scope="col" className="w-40 py-2 text-left font-normal">
                12-month trend
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug} className="border-b last:border-0 align-middle">
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
                      <Link
                        href={`/politicians/${row.slug}`}
                        className="font-medium hover:underline"
                      >
                        {row.displayName}
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-[11px] text-muted-foreground">{seatOf(row)}</span>
                        <TablePartyChip partyAb={row.partyAb} />
                      </div>
                    </div>
                  </div>
                </th>
                <td className="py-2 pr-3 text-right tabular-nums">{row.declaredItems}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{row.companies}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{row.realEstateEntries}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{row.giftsTravel}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{row.changes90d}</td>
                <td className="py-2">
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

      {rows.length === 0 && status !== "error" ? (
        // The wording turns on whether a filter is set, because the two empty
        // states mean opposite things. With filters, no match is an honest
        // answer about the filter. WITHOUT filters, an empty table can only be
        // our own outage — and "no members match" would then read as an absence
        // claim about every member of parliament at once.
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {filtersActive
            ? "No members match these filters. Widen them, or search by name above — an empty result is a filter, not a statement about anyone’s register."
            : "This table is unavailable right now. The full roll of members is further down this page, and nothing here is missing from the register."}
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
            className="rounded border px-2 py-1 disabled:opacity-40 enabled:hover:text-foreground"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!hasNext || status === "loading"}
            onClick={() => run({ ...query, offset: query.offset + query.limit })}
            className="rounded border px-2 py-1 disabled:opacity-40 enabled:hover:text-foreground"
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
