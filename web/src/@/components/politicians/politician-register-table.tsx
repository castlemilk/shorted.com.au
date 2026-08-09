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
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  searchPoliticians,
  type PoliticianHit,
} from "@/lib/politics/politician-search";

import { SparkTrend } from "@/components/politicians/explorer/spark-trend";
import { PoliticsIcon } from "@/components/politicians/politics-icon";
import type { PoliticsIconName } from "@/components/politicians/politics-icons.generated";
import { PoliticianAvatar } from "@/components/politicians/politician-avatar";
import { PartyMark } from "@/components/politicians/party-mark";
import { partyLabel } from "@/lib/politics/party-palette";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";
import { SENATE_REGISTER_GAP_CORPUS } from "@/lib/politics/register-coverage";
import {
  POLITICS_FILTER_BUTTON_CLASS,
  POLITICS_FOCUS_RING,
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

/**
 * Column iconography — the same sprite ids the register categories carry
 * everywhere else, so a reader who learned the glyphs on a profile reads this
 * header without relearning them. Purely decorative beside the word
 * (`aria-hidden` inside PoliticsIcon): the LABEL is the header.
 */
const SORT_ICONS: Partial<Record<PoliticianTableSort, PoliticsIconName>> = {
  declared_items: "other-interests",
  companies: "shareholdings",
  properties: "real-estate",
  recent_changes: "entry-added",
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
    return (
      <span className="text-[11px] text-muted-foreground">
        Party not recorded
      </span>
    );
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
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          active
            ? "text-foreground underline decoration-dotted underline-offset-4"
            : ""
        }`}
      >
        {SORT_ICONS[sort] ? (
          <PoliticsIcon name={SORT_ICONS[sort]!} size={13} />
        ) : null}
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
  // The ACCUMULATED roll: page after page appends here, so scrolling reads as
  // one continuous list rather than 25-row screens with a pager between them.
  const [rows, setRows] = useState<PoliticianTableRow[]>(initialPage.rows);
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
          // Offset 0 is a fresh view (a filter or sort change); anything else
          // is the next stretch of the same view and appends.
          setRows((previous) =>
            result.query.offset === 0
              ? result.rows
              : [...previous, ...result.rows],
          );
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
  // reader deep in a list most of which no longer exists.
  const setFilter = useCallback(
    (patch: Partial<PoliticianTableQuery>) =>
      run({ ...query, ...patch, offset: 0 }),
    [query, run],
  );

  const toggleSort = useCallback(
    (sort: PoliticianTableSort) => run({ ...query, sort, offset: 0 }),
    [query, run],
  );

  const filtersActive =
    !!query.chamber || !!query.stateCode || !!query.partyAb || query.itemNo > 0;
  const hasNext = rows.length < page.total;
  /*
   * APPENDS FETCH 100 ROWS, NOT THE INITIAL 25. The 25 is a server-HTML
   * payload decision (portraits and sparklines prerendered into the ISR page);
   * an action append carries no such cost, and at 25 the roll advanced one
   * screenful per round-trip — a reader scrolling the window sat through a
   * visible stall every ~7 rows and read "Showing 1–50" as the table's end.
   * 100 is half the handler's own clamp (max 200), so the server accepts it
   * as-is. Avatars are `loading="lazy"` (politician-avatar.tsx), so a bigger
   * append does not fetch a bigger portrait burst — only what scrolls into
   * view.
   */
  const APPEND_PAGE_SIZE = 100;
  const loadMore = useCallback(() => {
    run({ ...query, limit: APPEND_PAGE_SIZE, offset: rows.length });
  }, [query, rows.length, run]);

  /*
   * THE SEARCH AND THE ROLL ARE ONE SURFACE.
   *
   * Typing a name, a company or a suburb swaps the window's body from the
   * server-paged roll to Algolia hits; clearing it swaps back, with the roll
   * exactly where it was. The chamber/state/party filters apply to BOTH — they
   * become Algolia facet filters while searching, so the two views never
   * disagree about what "filtered to Senate" means. (The register-category
   * filter has no search facet and applies to the roll only; its select says
   * so while a search is active.)
   */
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<PoliticianHit[] | null>(null);
  const [searchStatus, setSearchStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const searching = search.trim().length >= 2;
  const searchInputRef = useRef<HTMLInputElement>(null);

  // `/` focuses the command bar, the way every search-first tool does. Only
  // when the reader is not already typing somewhere: a `/` inside a text field
  // is a character, not a command.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!searching) {
      setHits(null);
      setSearchStatus("idle");
      return;
    }
    let cancelled = false;
    setSearchStatus("loading");
    const facetFilters: string[][] = [];
    if (query.chamber) facetFilters.push([`chamber:${query.chamber}`]);
    if (query.stateCode) facetFilters.push([`state_code:${query.stateCode}`]);
    if (query.partyAb) facetFilters.push([`party_ab:${query.partyAb}`]);
    const timer = setTimeout(() => {
      searchPoliticians(search.trim(), {
        hitsPerPage: 30,
        facetFilters,
        facets: [],
      })
        .then((result) => {
          if (cancelled) return;
          setHits(result.hits);
          setSearchStatus("idle");
        })
        .catch(() => {
          if (cancelled) return;
          setSearchStatus("error");
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, searching, query.chamber, query.stateCode, query.partyAb]);

  /*
   * INFINITE SCROLL, WITH A BUTTON UNDERNEATH IT.
   *
   * The sentinel auto-loads the next stretch as it scrolls into the window's
   * view. The "Show more" button stays rendered below it because the observer
   * is an enhancement, not the mechanism: keyboard readers, jsdom, and any
   * browser where IntersectionObserver misfires still have a working control,
   * and the button doubles as the visible "there is more" signal.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  // The observer stops feeding past this many rows and the button takes over.
  // The ceiling exists because an UNCAPPED sentinel once chained 28
  // back-to-back action calls (and a Wikimedia 429 storm from 700 eager
  // portraits). Both halves of that incident have since shrunk: appends are
  // 100 rows (the full 491-member roll is at most 5 chained calls, not 28)
  // and avatars are `loading="lazy"`, so off-screen rows fetch no portraits.
  // 600 therefore covers the whole roll — a reader who scrolls the window
  // flows through every member without hitting a button — while still
  // backstopping a future corpus that outgrows it.
  const AUTO_LOAD_CEILING = 600;
  const canAutoLoad =
    hasNext &&
    status === "idle" &&
    !searching &&
    page.ok !== false &&
    rows.length < AUTO_LOAD_CEILING;
  useEffect(() => {
    if (!canAutoLoad || typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          loadMoreRef.current();
      },
      // ~one window-height of lead: enough that the next append is in flight
      // before the reader reaches the loaded rows' end (240px started the
      // fetch ~4 rows out, inside the stall), but NOT enough to reach the
      // sentinel on a freshly-landed page — 1000px pre-fired on load and the
      // range line greeted readers with "Showing 1–125" before they had
      // touched anything. With 25 initial rows (~1,425px of content) the
      // sentinel sits ~800px below the fold, so 600px only fires once the
      // reader actually scrolls.
      { root: scrollRef.current, rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canAutoLoad]);

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
  const outage =
    status === "error" ||
    page.ok === false ||
    (rows.length === 0 && !filtersActive);

  return (
    <div className="space-y-2.5 rounded-2xl border bg-card p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.04)] sm:p-3 min-[1460px]:flex min-[1460px]:min-h-0 min-[1460px]:flex-1 min-[1460px]:flex-col">
      {/*
        Two columns on a phone, the flex row from `sm:` up. In a `flex-wrap` row
        at 375 px the four filters ran off the right edge — "Party" was clipped
        mid-word and "Register category" was entirely off screen and unreachable
        without scrolling the whole document sideways. See `control-classes.ts`
        for why the selects also need `w-full` here.
      */}
      {/* THE COMMAND BAR. This is the section's primary control — the one
          thing a reader who wants a person should see first — so it reads as
          one: full width, tall, a magnifier, a layered shadow that lifts it
          off the panel, and a `/` shortcut for keyboard readers. The same
          index the old separate explorer used, now in the same window as the
          list it searches.

          From `xl:` the search and the four filters share ONE row (`items-end`
          seats the h-8 selects on the input's baseline, their 10px labels
          floating above): the controls read as a single instrument strip and
          the two stacked control rows stop costing the scroller ~60px of
          window height. Below `xl:` nothing changes. */}
      <div className="space-y-2.5 xl:flex xl:items-end xl:gap-3 xl:space-y-0">
        <div className="relative xl:min-w-64 xl:flex-1">
          <label htmlFor={`${controlsId}-search`} className="sr-only">
            Search parliamentarians by name, electorate, company or suburb
          </label>
          <span
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            <PoliticsIcon name="search" size={18} />
          </span>
          <input
            ref={searchInputRef}
            id={`${controlsId}-search`}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search a name, an electorate, a company, a suburb…"
            autoComplete="off"
            className="h-12 w-full rounded-xl border bg-background pl-11 pr-12 text-[15px] [&::-webkit-search-cancel-button]:hidden shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_14px_rgba(0,0,0,0.05)] outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className={`absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-[background-color,transform] hover:bg-muted active:scale-[0.96] ${POLITICS_FOCUS_RING}`}
            >
              ✕
            </button>
          ) : (
            <kbd
              aria-hidden
              className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:block"
            >
              /
            </kbd>
          )}
        </div>

        <div className="grid grid-cols-2 items-end gap-2 [&>*]:min-w-0 sm:flex sm:flex-wrap xl:shrink-0 xl:flex-nowrap">
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
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              State
            </span>
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
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Party
            </span>
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
                setFilter({
                  chamber: "",
                  stateCode: "",
                  partyAb: "",
                  itemNo: 0,
                })
              }
              className={POLITICS_FILTER_BUTTON_CLASS}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      {/*
        THE CHAMBER NOTE, AND WHY IT LIVES INSIDE THE ISLAND.

        Filter to the Senate and some named rows still answer with zeros, and
        nothing on screen says why. A reader — or a crawler — reads named
        senators against columns of zeros as a finding about those people, and
        it is not one: the recent Senate volumes are read, but the older,
        scanned ones are not, so a zero can be our coverage rather than their
        register.

        The hub already carries this sentence, once, up beside the tile row. It
        is not enough. That paragraph is hundreds of pixels above a table the
        reader scrolls, sorts and re-filters without it ever being in view, and
        it is rendered by the SERVER PAGE — so it does not change, and cannot,
        when this island re-renders under a Senate filter. The explanation has
        to sit with the rows it explains and re-render with them, which means it
        has to be here.

        ONE SENTENCE FOR BOTH STATES, not two. Under a Senate filter every row
        is affected; unfiltered, the senators are mixed in among the members and
        the zeros are the same zeros. Wording it twice would invite the two to
        drift, and there is only one fact. It is suppressed only where no
        senator can be on screen at all — the House filter — because a caveat
        that is always present stops being read.
      */}
      {query.chamber !== "house" ? (
        <p className="rounded-r-md border-l-2 border-primary/40 bg-muted/20 py-1.5 pl-3 pr-2 text-[11px] leading-relaxed text-muted-foreground">
          {SENATE_REGISTER_GAP_CORPUS}
        </p>
      ) : null}

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
        THE TABLE IS A DIFFERENT TABLE BELOW `lg:`, not the same table squeezed.
        The seven-column layout needs ~830 px. It used to demand it from `sm:`
        up (`sm:min-w-[52rem]`), which put a PERMANENT horizontal scrollbar
        inside this scroller on every container narrower than that — including
        the hub's own desktop two-column layout, where the trend and gifts
        columns sat off-screen behind a second scroll axis.

        Two changes, and they work together:
          - the five count/trend columns are `hidden lg:table-cell`: below `lg`
            the counts they carry are re-rendered underneath the member's name
            as a wrapped summary line (`lg:hidden`). Nothing is withheld from a
            narrow reader; it is stacked instead of scrolled.
          - `min-w-[44rem]` engages only from `lg:` — the narrowest container
            the hub gives this island at `lg` is ~736 px, so all seven columns
            fit and the min-width is a floor for squeezed edge cases, not a
            standing demand for a scrollbar.

        The `<caption>`/`<thead>` semantics are untouched, so the screen-reader
        reading order is unchanged at every width.
      */}
      <div
        ref={scrollRef}
        aria-busy={status === "loading" || searchStatus === "loading"}
        // ONE fixed window for both bodies. The roll grows inside it by
        // infinite scroll; a search swaps its contents. The page's own height
        // never depends on how many rows are loaded. Three height regimes:
        //   - below `xl:` a flat 38rem cap;
        //   - `xl:` to the 1460px two-column split, VIEWPORT-relative (dvh) —
        //     the table is alone at full width there, so the screen is the
        //     right thing to fill (max() keeps 38rem as the floor);
        //   - from the split, the RAIL's natural height is the cap: the card
        //     is a flex column stretched to the grid row (whose height the
        //     rail sets) and this window is the flex-1/basis-0 filler, so the
        //     table's bottom lands exactly on the rail's bottom (~11 rows) at
        //     every screen size. A dvh cap here grew the card past the rail
        //     on tall screens and the two columns read as misaligned.
        // `overscroll-contain` keeps a trackpad fling from grabbing the
        // document when the window's scroll ends.
        className="max-h-[38rem] overflow-auto overscroll-contain rounded-lg border bg-background xl:max-h-[max(38rem,calc(100dvh-21rem))] min-[1460px]:min-h-0 min-[1460px]:max-h-none min-[1460px]:flex-1 min-[1460px]:basis-0"
      >
        {searching ? (
          <SearchHits
            hits={hits}
            status={searchStatus}
            query={search.trim()}
            filtersActive={filtersActive}
          />
        ) : (
          <table
            className={`w-full lg:min-w-[44rem] text-sm ${status === "loading" && rows.length === 0 ? "opacity-60" : ""}`}
          >
            <caption className="sr-only">
              Federal parliamentarians and what they currently declare in the
              Registers of Members&rsquo; and Senators&rsquo; Interests. Every
              column is a count of declared entries; the registers record no
              quantity or value.
            </caption>
            <thead className="sticky top-0 z-10 border-b bg-background text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortHeader
                  sort="name"
                  activeSort={query.sort}
                  onSort={toggleSort}
                  className="py-2 pl-2 pr-3 text-left font-normal"
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
                  className="hidden py-2 pr-3 text-right font-normal lg:table-cell"
                />
                <SortHeader
                  sort="properties"
                  activeSort={query.sort}
                  onSort={toggleSort}
                  className="hidden py-2 pr-3 text-right font-normal lg:table-cell"
                />
                <th
                  scope="col"
                  className="hidden py-2 pr-3 text-right font-normal lg:table-cell"
                >
                  <span className="inline-flex items-center gap-1">
                    <PoliticsIcon name="gifts" size={13} />
                    Gifts &amp; travel
                  </span>
                </th>
                <SortHeader
                  sort="recent_changes"
                  activeSort={query.sort}
                  onSort={toggleSort}
                  className="hidden py-2 pr-3 text-right font-normal lg:table-cell"
                />
                <th
                  scope="col"
                  className="hidden w-28 py-2 text-left font-normal lg:table-cell xl:w-40"
                >
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <PoliticsIcon name="timeline" size={13} />
                    <span aria-hidden>Trend</span>
                    <span className="sr-only">12-month trend</span>
                  </span>
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
                  <th
                    scope="row"
                    className="py-2 pl-2 pr-3 text-left font-normal"
                  >
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
                          <span className="text-[11px] text-muted-foreground">
                            {seatOf(row)}
                          </span>
                          <TablePartyChip partyAb={row.partyAb} />
                        </div>
                      </div>
                    </div>
                    {/*
                    THE COLUMNS THIS WIDTH CANNOT SHOW, STACKED INSTEAD.

                    Rendered only below `lg:`, where the matching cells are
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
                      className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground lg:hidden"
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
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {row.declaredItems}
                  </td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums lg:table-cell">
                    {row.companies}
                  </td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums lg:table-cell">
                    {row.realEstateEntries}
                  </td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums lg:table-cell">
                    {row.giftsTravel}
                  </td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums lg:table-cell">
                    {row.changes90d}
                  </td>
                  <td className="hidden py-2 lg:table-cell">
                    <SparkTrend
                      points={row.trend}
                      undatedOnly={
                        row.trend.length === 0 && row.undatedCount > 0
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!searching && rows.length === 0 && !outage ? (
          // The ONLY empty state that says anything about a result rather than
          // about us: the request answered, a filter is set, and nothing matched
          // it. That is an honest answer about the filter — and it says so, so a
          // reader cannot take it as a statement about anyone's register.
          <p className="m-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No members match these filters. Widen them, or search by name above
            — an empty result is a filter, not a statement about anyone&rsquo;s
            register.
          </p>
        ) : null}

        {/* The auto-load sentinel and its always-there manual counterpart. */}
        {!searching ? (
          <div ref={sentinelRef} aria-hidden className="h-px" />
        ) : null}
        {!searching && hasNext && !outage ? (
          <div className="flex justify-center border-t bg-muted/20 py-2">
            <button
              type="button"
              disabled={status === "loading"}
              onClick={loadMore}
              className={POLITICS_PAGER_BUTTON_CLASS}
            >
              {status === "loading" ? "Loading…" : "Show more"}
            </button>
          </div>
        ) : null}
      </div>

      <p
        role="status"
        className="text-[11px] tabular-nums text-muted-foreground"
      >
        {searching
          ? hits
            ? `${hits.length === 1 ? "1 match" : `${hits.length} matches`}${hits.length === 30 ? " shown" : ""}.`
            : ""
          : `Showing ${rangeLabel(0, rows.length, page.total)}.`}
      </p>

      <details className="text-[11px] leading-relaxed text-muted-foreground">
        <summary className="cursor-pointer select-none underline decoration-dotted underline-offset-2 hover:text-foreground">
          How to read these counts
        </summary>
        <p className="mt-1.5 max-w-prose">
          Counts are of entries currently declared. Real-estate entries are
          register entries under item 3 — some entries list more than one
          address, so the column is a floor on what was declared, not a tally of
          properties. The trend plots only entries whose start date the register
          states; entries with no stated date are not plotted.
        </p>
      </details>
    </div>
  );
}

/**
 * Search results, in the same window the roll occupies.
 *
 * Compact person rows rather than the seven-column table: a search answers
 * "take me to this person", so the row is the name, the seat, the party, and —
 * when the match came from a declaration — the declared thing that matched, so
 * a reader who typed a company sees WHY each person is in the list. Counts of
 * declared things ride on the right; never a value. A hit whose register we
 * have not read says so rather than showing zeros.
 */
function SearchHits({
  hits,
  status,
  query,
  filtersActive,
}: {
  hits: PoliticianHit[] | null;
  status: "idle" | "loading" | "error";
  query: string;
  filtersActive: boolean;
}) {
  if (status === "error") {
    return (
      <p className="m-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        Search is unavailable right now. The roll below the search box still
        works, and nothing is missing from the register.
      </p>
    );
  }
  if (!hits) {
    return <p className="m-3 text-sm text-muted-foreground">Searching…</p>;
  }
  if (hits.length === 0) {
    return (
      <p className="m-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        No parliamentarian matches &ldquo;{query}&rdquo;
        {filtersActive ? " with these filters" : ""}. An empty result is a
        search result, not a statement about anyone&rsquo;s register.
      </p>
    );
  }

  const needle = query.toLowerCase();
  return (
    <ul className="divide-y">
      {hits.map((hit) => {
        // The declared string that put this hit in the list, when one did.
        const matched =
          [
            ...(hit.company_names ?? []),
            ...(hit.suburbs ?? []),
            ...(hit.stock_codes ?? []),
          ].find((value) => value.toLowerCase().includes(needle)) ?? null;
        const seat =
          hit.chamber === "senate"
            ? hit.state_code
              ? `Senator for ${hit.state_code}`
              : "Senator"
            : hit.division
              ? `${hit.division}${hit.state_code ? ` · ${hit.state_code}` : ""}`
              : (hit.state_code ?? "");
        return (
          <li key={hit.objectID}>
            <Link
              href={`/politicians/${hit.slug}`}
              prefetch={false}
              className="flex items-center gap-2.5 px-2 py-2 transition-colors hover:bg-muted/40"
            >
              <PoliticianAvatar
                displayName={hit.display_name}
                partyAb={hit.party_ab}
                size="sm"
                photo={{
                  photoUrl: hit.photo_url ?? "",
                  photoLicence: hit.photo_licence ?? "",
                  photoAuthor: hit.photo_author ?? "",
                  photoSourceUrl: hit.photo_source_url ?? "",
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {hit.display_name}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  {seat ? <span>{seat}</span> : null}
                  <TablePartyChip partyAb={hit.party_ab} />
                  {matched ? (
                    <span className="truncate">declares: {matched}</span>
                  ) : null}
                </span>
              </span>
              <span className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {hit.has_interests === false ? (
                  <span className="font-sans">register not read yet</span>
                ) : (
                  <>
                    {hit.declared_listed_count}{" "}
                    {hit.declared_listed_count === 1 ? "company" : "companies"}
                    <span className="block">
                      {hit.declared_property_count} real-estate{" "}
                      {hit.declared_property_count === 1 ? "entry" : "entries"}
                    </span>
                  </>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
