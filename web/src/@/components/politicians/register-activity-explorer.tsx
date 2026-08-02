"use client";

/**
 * The register ACTIVITY explorer — what entered and left the registers, and when.
 *
 * WHY A CLIENT ISLAND ON A STATIC PAGE. /politicians/changes is an ISR route and
 * the page must not read `searchParams` (the documented trap that flips a route
 * to dynamic and kills the ISR). So the server page renders the DEFAULT window's
 * feed, strip and rails into the HTML — a crawler and a reader with JavaScript
 * off get the real thing — and every filter change is a server-action call from
 * here.
 *
 * WHY THE ACTION ARRIVES AS A PROP. A "use client" politician file may not reach
 * the generated protobuf module through ANY import path (`client-boundary.test
 * .ts` walks the graph). Importing the action module here would reach
 * `getPoliticians.ts` and therefore `~/gen/…`, so the page passes the action
 * down — which also makes the fetch behaviour trivially mockable.
 *
 * EDITORIAL. Every row names a real person, so:
 *   - counts and dates only, and "most dated register events" is the strongest
 *     characterisation on the page — a count ordering, the same class of claim
 *     as "most-declared companies". No row, member or company is CHARACTERISED
 *     anywhere: not in copy, not in an aria-label. `activity-vocabulary.test.ts`
 *     holds the banned register
 *   - A REMOVAL IS NOT A TRANSACTION. An entry can leave the register because an
 *     asset was disposed of, because a declaration was corrected, or because the
 *     member left parliament — the page says so and never implies a sale
 *   - the measures are DATED-ONLY. Entries whose start date the register never
 *     stated cannot be placed on a timeline, so they are counted and stated
 *     rather than silently dropped
 *   - activity reflects EXTRACTION COVERAGE as much as lodgement: a member with
 *     no events may simply sit in a volume we have not read
 *   - no green/red and no warning glyphs; amber and party colour only
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { WeekBars } from "@/components/politicians/explorer/week-bars";
import { PartyMark } from "@/components/politicians/party-mark";
import { PoliticsIcon, SectionIcon } from "@/components/politicians/politics-icon";
import { partyLabel } from "@/lib/politics/party-palette";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";
import { registerItemIcon } from "@/lib/politics/register-item-icons";
import { SENATE_REGISTER_GAP_CORPUS } from "@/lib/politics/register-coverage";
import { searchPoliticians } from "@/lib/politics/politician-search";
import {
  POLITICS_FILTER_BUTTON_CLASS,
  POLITICS_PAGER_BUTTON_CLASS,
  POLITICS_SEARCH_INPUT_CLASS,
  POLITICS_SELECT_CLASS,
} from "@/lib/politics/control-classes";
import { TypeaheadStatus } from "@/components/politicians/explorer/typeahead-status";

/* ------------------------------------------------------------------ shapes */

/**
 * The filter state, which is also exactly what the server action accepts.
 *
 * Plain and serialisable by construction: the action maps the protobuf response
 * into these shapes server-side, because register messages carry Timestamps
 * (BigInt-backed, so `JSON.stringify` throws) and a `$typeName` that has no
 * business crossing the RSC boundary.
 */
export interface RegisterActivityQuery {
  /** 30 | 90 | 180 | 365. The backend rounds anything else UP. */
  windowDays: number;
  kind: "" | "added" | "removed";
  chamber: string;
  partyAb: string;
  /** 1–14, or 0 for every register item. */
  itemNo: number;
  /** A canonical slug, taken from search — never derived from a name. */
  politicianSlug: string;
  limit: number;
  offset: number;
}

export interface ActivityEventRow {
  id: string;
  /** `YYYY-MM-DD`, or "" when the register stated no date. */
  changedOn: string;
  /** Formatted server-side so the server and hydrated renders cannot differ. */
  dateLabel: string;
  kind: "added" | "removed";
  slug: string;
  displayName: string;
  partyAb: string;
  itemNo: number;
  itemLabel: string;
  /** Kept identical to the compliance kit's holder copy. */
  holderLabel: string;
  declaredText: string;
  stockCode: string;
  companyName: string;
  /** "Family trust", "Private company"… — what kind of thing was named. */
  entityKindLabel: string;
}

export interface ActivityWeek {
  weekStart: string;
  addedCount: number;
  removedCount: number;
}

export interface ActiveMemberRow {
  slug: string;
  displayName: string;
  partyAb: string;
  eventCount: number;
}

export interface NewlyDeclaredCompanyRow {
  stockCode: string;
  companyName: string;
  firstDeclaredOn: string;
  firstDeclaredLabel: string;
  declarerCount: number;
}

export interface DeclarerCountChangeRow {
  stockCode: string;
  companyName: string;
  declarersNow: number;
  declarersAtWindowStart: number;
}

export interface RegisterActivityPage {
  /** The query the SERVER actually ran, after its own clamping. */
  query: RegisterActivityQuery;
  /**
   * The window the RESPONSE reported, which is the one to render.
   *
   * The backend rounds a window UP to the next one it serves (45 -> 90), so the
   * requested window and the window that produced these numbers are not always
   * the same number. Captioning the request would put "45 days" over 90 days of
   * events.
   */
  windowDays: number;
  events: ActivityEventRow[];
  /** The filtered total, which is not the length of `events`. */
  total: number;
  weeks: ActivityWeek[];
  activeMembers: ActiveMemberRow[];
  newlyDeclaredCompanies: NewlyDeclaredCompanyRow[];
  declarerCountChanges: DeclarerCountChangeRow[];
  /**
   * Currently-declared entries with no stated start date, and so absent from
   * every dated measure on this page. Published rather than dropped silently.
   */
  undatedCurrentCount: number;
  /**
   * Dated events matching THESE FILTERS in the window — the strip's own total,
   * equal to the sum of every bucket above it.
   */
  filteredEventCount: number;
  /**
   * DISTINCT members with at least one such event. People, never rows, and never
   * counted from the rendered page: `events` is one page of a paginated feed, so
   * a count taken from it is a floor that shrinks as the reader pages forward.
   */
  filteredMemberCount: number;
  /**
   * Did the FEED request answer?
   *
   * REQUIRED, AND NOT INFERABLE FROM `events`. An outage and a filter nobody
   * matches both arrive as zero rows, and wording the first as the second
   * publishes "no register events match" over our own downtime — an absence
   * claim about every member the filter covers. `false` is a normal result: the
   * action never throws.
   */
  ok: boolean;
  /** Did the ACTIVITY request answer? The rails and the strip come from it. */
  railsOk: boolean;
}

export interface RegisterActivityExplorerProps {
  initialPage: RegisterActivityPage;
  loadPage: (query: RegisterActivityQuery) => Promise<RegisterActivityPage>;
  /**
   * The member the initial page was filtered to, if any. The island holds the
   * NAME for the chip; the query only ever carries the slug.
   */
  initialMemberName?: string;
  /**
   * Party ABBREVIATIONS present in the corpus, from the server page.
   *
   * Data-derived, never derived from the palette: `PARTY_LABEL` maps two
   * abbreviations onto "Liberal" (LP and LIB), so a hand-built option list has
   * to guess one — and the backend filters on the abbreviation, so the guess
   * silently drops every member recorded under the other. An absence like that,
   * on a page about named people, is exactly what the editorial rules forbid.
   */
  partyOptions?: string[];
}

/* ----------------------------------------------------------------- options */

const WINDOW_OPTIONS: { value: number; label: string }[] = [
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
];

const KIND_OPTIONS: { value: RegisterActivityQuery["kind"]; label: string }[] = [
  { value: "", label: "Added and removed" },
  { value: "added", label: "Added only" },
  { value: "removed", label: "Removed only" },
];

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

const SELECT_CLASS = POLITICS_SELECT_CLASS;
const SEARCH_INPUT_CLASS = POLITICS_SEARCH_INPUT_CLASS;

const FIELD_LABEL_CLASS = "text-[10px] uppercase tracking-wide text-muted-foreground";

/* ------------------------------------------------------------------ pieces */

/**
 * The party chip, rendered locally rather than imported from `compliance.tsx`.
 *
 * Same reason as the hub table and the explorer: compliance has no "use client"
 * and imports the generated `RegisterHolder`, so pulling a chip from it drags
 * the protobuf runtime into this bundle and takes the static build down with an
 * "Element type is invalid" error. `party-palette.ts` is pure data and exists
 * for exactly this.
 */
function ActivityPartyChip({ partyAb }: { partyAb?: string }) {
  if (!partyAb) {
    // Party reaches the register through an electorate join, not the APH
    // listing, so absence is real and is labelled as absence — never guessed.
    return <span className="text-[11px] text-muted-foreground">Party not recorded</span>;
  }
  // The mark carries the party's full name as its own accessible name, so the
  // visible label is aria-hidden — without that a feed of fifty events
  // announces each party twice.
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <PartyMark abbreviation={partyAb} size="sm" />
      <span aria-hidden>{partyLabel(partyAb)}</span>
    </span>
  );
}

/**
 * What a row names.
 *
 * A resolved ticker links to the company; anything else renders the member's own
 * words, in the register's vocabulary, with no link and no apology — a family
 * trust has no ticker to be missing. The compliance kit's `DeclaredEntity` does
 * the same thing on the server; this is its client-safe twin, for rows that
 * arrive from a server action as plain JSON rather than as server-rendered
 * markup.
 */
function ActivityEntity({ row }: { row: ActivityEventRow }) {
  if (row.stockCode) {
    return (
      <Link href={`/shorts/${row.stockCode}`} className="hover:underline">
        <span className="font-medium">{row.stockCode}</span>
        {row.companyName ? (
          <span className="text-muted-foreground"> · {row.companyName}</span>
        ) : null}
      </Link>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">
      <span className="font-mono text-[11px]">{row.declaredText}</span>
      {row.entityKindLabel ? (
        <span className="rounded border border-muted-foreground/30 px-1.5 text-[10px]">
          {row.entityKindLabel}
        </span>
      ) : null}
    </span>
  );
}

/** Day headings, newest first, preserving the server's ordering within a day. */
function groupByDay(events: ActivityEventRow[]): { key: string; label: string; rows: ActivityEventRow[] }[] {
  const out: { key: string; label: string; rows: ActivityEventRow[] }[] = [];
  for (const event of events) {
    const key = event.changedOn || "undated";
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(event);
    else
      out.push({
        key,
        // An event with no date says so; it is never filed under today.
        label: event.dateLabel || "Date not stated",
        rows: [event],
      });
  }
  return out;
}

function windowLabel(windowDays: number): string {
  return `the last ${windowDays} days`;
}

/* ------------------------------------------------------------------ island */

export function RegisterActivityExplorer({
  initialPage,
  loadPage,
  initialMemberName = "",
  partyOptions = [],
}: RegisterActivityExplorerProps) {
  const [page, setPage] = useState<RegisterActivityPage>(initialPage);
  /**
   * THE CONTROLS' OWN STATE, which is not the last response's echoed query.
   *
   * Building each request from `page.query` meant building it from the last
   * response, so two changes in flight composed wrongly: change the chamber, then
   * the party before the first landed, and the second request carried the OLD
   * chamber — and when it landed, the chamber control snapped back to it. The
   * selection the reader had made undid itself in front of them.
   *
   * So the controls render from `pendingQuery` and every request is built from
   * it. A response RECONCILES it (the backend clamps: an out-of-range item number
   * comes back as 0, a window as the one it served), which is safe because a
   * newer request has already bumped the sequence and a stale response never
   * reaches here.
   */
  const [pendingQuery, setPendingQuery] = useState<RegisterActivityQuery>(initialPage.query);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [memberName, setMemberName] = useState(initialMemberName);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberHits, setMemberHits] = useState<{ slug: string; displayName: string }[]>([]);
  const [memberSearchFailed, setMemberSearchFailed] = useState(false);
  /** True from the keystroke until the lookup answers. See the effect below. */
  const [memberSearching, setMemberSearching] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  /** Index of the active option, or -1 for none. Nothing is preselected. */
  const [memberActiveIndex, setMemberActiveIndex] = useState(-1);
  /**
   * Where focus must land after the member field swaps between its input and its
   * selection chip. Without this, choosing a member unmounts the focused input
   * and focus falls to `<body>` — a keyboard reader loses their place on the page
   * entirely, and the very control describing their selection is unreachable.
   */
  const [focusTarget, setFocusTarget] = useState<"chip" | "input" | null>(null);
  const memberInputRef = useRef<HTMLInputElement>(null);
  const memberChipRef = useRef<HTMLButtonElement>(null);
  // Every request carries a sequence number and only the newest may write state:
  // two fast filter changes otherwise race and the SLOWER one wins, leaving the
  // page showing events that match neither control.
  const sequence = useRef(0);
  const controlsId = useId();
  const memberListId = `${controlsId}-member-results`;
  const memberOptionId = (index: number) => `${memberListId}-option-${index}`;

  /** The query that produced what is on screen — the copy's authority. */
  const query = page.query;

  const run = useCallback(
    (next: RegisterActivityQuery) => {
      const ticket = (sequence.current += 1);
      setPendingQuery(next);
      setStatus("loading");
      loadPage(next)
        .then((result) => {
          if (sequence.current !== ticket) return;
          setPage(result);
          // The backend's clamp wins over what was asked for: it is the only
          // description of the numbers now on screen.
          setPendingQuery(result.query);
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
    (patch: Partial<RegisterActivityQuery>) => run({ ...pendingQuery, ...patch, offset: 0 }),
    [pendingQuery, run],
  );

  /*
   * The member typeahead, over the same Algolia plumbing the hub search uses.
   *
   * WHY `memberSearching` EXISTS. Measured 2026-08-02: typing "alba" took 657 ms
   * end to end — ~420 ms of it AFTER the last keystroke — and a busy affordance
   * appeared in 0 of 5 runs. The listbox simply sat there holding stale options,
   * or nothing, with no indication that anything was happening. That was the
   * single largest perceived-responsiveness gap in the whole feature.
   *
   * The floor is not ours to remove: `/api/algolia/search` is a flat 205 ms
   * whether it is called through the Next rewrite or straight at the Go proxy,
   * i.e. it is the wire to Algolia. The debounce is already at the useful limit
   * (180 ms here, 160 ms on /compare) and SHORTENING IT WOULD MAKE THINGS WORSE
   * — more requests, same wire. So the fix is to say what is happening, not to
   * try to be faster.
   *
   * The flag is set the moment the query is worth searching — during the
   * debounce window as well as during the request — because from the reader's
   * side those are one uninterrupted wait.
   */
  useEffect(() => {
    const needle = memberQuery.trim();
    if (needle.length < 2) {
      setMemberHits([]);
      setMemberSearchFailed(false);
      setMemberSearching(false);
      setMemberActiveIndex(-1);
      return;
    }
    let cancelled = false;
    setMemberSearching(true);
    const timer = setTimeout(() => {
      searchPoliticians(needle, { hitsPerPage: 6, facets: [] })
        .then((result) => {
          if (cancelled) return;
          setMemberSearching(false);
          setMemberSearchFailed(false);
          setMemberHits(
            (result.hits ?? []).map((hit) => ({
              slug: hit.slug,
              displayName: hit.display_name,
            })),
          );
          // The active option indexes a list that just changed, so it is dropped
          // rather than left pointing at whoever now occupies that position.
          setMemberActiveIndex(-1);
        })
        .catch(() => {
          if (cancelled) return;
          // Search being down says nothing about the register, and the rest of
          // the filters keep working.
          setMemberSearching(false);
          setMemberSearchFailed(true);
          setMemberHits([]);
          setMemberActiveIndex(-1);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memberQuery]);

  // Focus follows the swap between the input and the chip, once, after the
  // element it is aimed at has actually rendered.
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget === "chip") memberChipRef.current?.focus();
    else memberInputRef.current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const chooseMember = useCallback(
    (hit: { slug: string; displayName: string }) => {
      setMemberName(hit.displayName);
      setMemberQuery("");
      setMemberHits([]);
      setMemberOpen(false);
      setMemberActiveIndex(-1);
      setFocusTarget("chip");
      setFilter({ politicianSlug: hit.slug });
    },
    [setFilter],
  );

  /**
   * The list is open only once there is something to say — the same two-character
   * threshold the search itself uses, so an open-but-silent popup never covers
   * the controls beneath it.
   */
  const memberListOpen = memberOpen && memberQuery.trim().length >= 2;

  const onMemberKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // preventDefault, or the arrow scrolls the page / jumps the caret
        // instead of moving through the list.
        event.preventDefault();
        if (!memberListOpen) {
          setMemberOpen(true);
          return;
        }
        if (memberHits.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMemberActiveIndex((current) => {
          const next = current + step;
          // Wrap: Up from the top lands on the last member rather than on
          // nothing — six options should never need a scroll to reach either end.
          if (next < 0) return memberHits.length - 1;
          if (next >= memberHits.length) return 0;
          return next;
        });
        return;
      }
      if (event.key === "Enter") {
        const hit = memberListOpen ? memberHits[memberActiveIndex] : undefined;
        // Only when a member is actually active: a bare Enter must not choose
        // whoever happens to be first, which would filter the page to a named
        // person the reader never picked.
        if (!hit) return;
        event.preventDefault();
        chooseMember(hit);
        return;
      }
      if (event.key === "Escape") {
        if (!memberListOpen) return;
        event.preventDefault();
        setMemberOpen(false);
        setMemberActiveIndex(-1);
      }
    },
    [chooseMember, memberActiveIndex, memberHits, memberListOpen],
  );

  const clearMember = useCallback(() => {
    setMemberName("");
    setMemberQuery("");
    setMemberHits([]);
    setMemberOpen(false);
    setMemberActiveIndex(-1);
    setFocusTarget("input");
    setFilter({ politicianSlug: "" });
  }, [setFilter]);

  const events = page.events;
  const groups = useMemo(() => groupByDay(events), [events]);
  /** What the RENDERED page was narrowed by — what the copy may describe. */
  const filtersActive =
    !!query.kind ||
    !!query.chamber ||
    !!query.partyAb ||
    query.itemNo > 0 ||
    !!query.politicianSlug;
  /** What the CONTROLS currently hold — what "Clear filters" would clear. */
  const controlsFiltered =
    !!pendingQuery.kind ||
    !!pendingQuery.chamber ||
    !!pendingQuery.partyAb ||
    pendingQuery.itemNo > 0 ||
    !!pendingQuery.politicianSlug;

  /**
   * What the strip and its count line are ABOUT, in the caption's own words.
   *
   * The backend narrows the weekly buckets and both filtered counts by the same
   * filters the feed uses, so the strip is the filter's strip — and it says so.
   * An unfiltered view says so too rather than saying nothing: "5 dated register
   * events" with no scope is read as whichever scope the reader last saw.
   */
  const stripScope = filtersActive
    ? "under the filters set above"
    : "across all members";

  const hasPrevious = query.offset > 0;
  const hasNext = query.offset + events.length < page.total;

  /*
   * THE TWO EMPTY FEEDS, WHICH MEAN OPPOSITE THINGS.
   *
   * An OUTAGE is a thrown action or a page the server marked `ok: false` — the
   * request did not answer, whatever the row count says. An UNFILTERED empty
   * feed is an outage too, by arithmetic: the registers are never empty over a
   * window this wide.
   *
   * Everything left over — zero events, a filter set, a response that answered —
   * is the one case where "no events match" is an honest sentence, and it is
   * about the FILTER, never about anyone's register.
   */
  const outage = status === "error" || page.ok === false || (events.length === 0 && !filtersActive);

  return (
    <div className="space-y-6">
      {/*
        A TWO-COLUMN GRID ON A PHONE, THE SAME FLEX ROW FROM `sm:` UP.

        Six controls in a `flex-wrap` row each took a full line at 375 px: the
        bar wrapped to SIX lines and 346 px, so the entire first screen below
        the hero was filters and a reader had to scroll past all of them to
        reach a single register event. A 2-column grid caps it at three rows and
        roughly halves that height, and it costs nothing above `sm` where the
        flex row already fitted.

        `[&>*]:min-w-0` because these children are labels wrapping `<select>`s:
        a grid item defaults to `min-width:auto`, and the longest option text
        ("Any register category", every party name) would otherwise push the
        column wider than its share and reintroduce the overflow this is fixing.
      */}
      <div className="grid grid-cols-2 items-end gap-2 [&>*]:min-w-0 sm:flex sm:flex-wrap">
        {/*
          Native selects, not the Radix kit: this is a filter surface on a route
          whose bundle size has a budget, and its filter BEHAVIOUR is what the tests
          drive — the repo's Radix select mock renders inert divs.
        */}
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Window</span>
          <select
            id={`${controlsId}-window`}
            className={SELECT_CLASS}
            value={String(pendingQuery.windowDays)}
            onChange={(e) => setFilter({ windowDays: Number(e.target.value) })}
          >
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Event</span>
          <select
            id={`${controlsId}-kind`}
            className={SELECT_CLASS}
            value={pendingQuery.kind}
            onChange={(e) =>
              setFilter({ kind: e.target.value as RegisterActivityQuery["kind"] })
            }
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value || "both"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Chamber</span>
          <select
            id={`${controlsId}-chamber`}
            className={SELECT_CLASS}
            value={pendingQuery.chamber}
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
          <span className={FIELD_LABEL_CLASS}>Party</span>
          <select
            id={`${controlsId}-party`}
            className={SELECT_CLASS}
            value={pendingQuery.partyAb}
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
          <span className={FIELD_LABEL_CLASS}>Register category</span>
          <select
            id={`${controlsId}-item`}
            className={SELECT_CLASS}
            value={String(pendingQuery.itemNo)}
            onChange={(e) => setFilter({ itemNo: Number(e.target.value) })}
          >
            {ITEM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {/* The member picker gets the full width on a phone: its input is wider
            than a select and its listbox is wider still. */}
        <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <label className={FIELD_LABEL_CLASS} htmlFor={`${controlsId}-member`}>
            Member
          </label>
          {pendingQuery.politicianSlug ? (
            <span className="flex h-11 items-center gap-2 rounded-md border border-input px-2 text-xs sm:h-8">
              <span>{memberName || pendingQuery.politicianSlug}</span>
              <button
                type="button"
                ref={memberChipRef}
                onClick={clearMember}
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Clear member
              </button>
            </span>
          ) : (
            /*
             * A REAL COMBOBOX, ported from the compare panel's picker — see its
             * docblock for the failure this pattern replaces. The input keeps
             * focus and carries `aria-activedescendant`; the options are
             * non-focusable `role="option"` elements chosen on mousedown (which
             * fires before the input's blur, so the pointer path needs no timer);
             * arrows move the active option and wrap, Enter takes only an active
             * one, Escape closes, and blur closes only when focus has left the
             * whole widget. A page naming parliamentarians may not be reachable
             * by pointer alone.
             */
            <div
              className="relative"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setMemberOpen(false);
                  setMemberActiveIndex(-1);
                }
              }}
            >
              {/*
                THE ONE PLACE THE MAGNIFIER IS ALLOWED. It marks the field as a
                search field and nothing else; `aria-hidden` because the label
                above already names it, and `pointer-events-none` so it cannot
                intercept a tap aimed at the input underneath it.
              */}
              <PoliticsIcon
                name="search"
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 opacity-70"
              />
              <input
                id={`${controlsId}-member`}
                ref={memberInputRef}
                type="search"
                role="combobox"
                aria-expanded={memberListOpen}
                aria-controls={memberListId}
                aria-autocomplete="list"
                aria-activedescendant={
                  memberListOpen && memberActiveIndex >= 0
                    ? memberOptionId(memberActiveIndex)
                    : undefined
                }
                autoComplete="off"
                className={`${SEARCH_INPUT_CLASS} sm:w-56`}
                placeholder="Search a member…"
                value={memberQuery}
                onChange={(e) => {
                  setMemberQuery(e.target.value);
                  setMemberOpen(true);
                }}
                onFocus={() => setMemberOpen(true)}
                onKeyDown={onMemberKeyDown}
              />
              {memberListOpen ? (
                <ul
                  id={memberListId}
                  role="listbox"
                  aria-label="Member results"
                  className="absolute z-10 mt-1 w-56 rounded-md border bg-background p-1 shadow-sm"
                >
                  {/* role="presentation": a status line is not a selectable
                      option, and a bare <li> in a listbox offers a screen reader
                      an option that cannot be chosen. */}
                  <TypeaheadStatus searching={memberSearching} />
                  {memberSearchFailed ? (
                    <li role="presentation" className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      Member search is unavailable right now. Nothing is missing from the
                      register — only the lookup is down.
                    </li>
                  ) : null}
                  {/*
                    NOT WHILE SEARCHING. "No members match" during the wait is a
                    false answer that then flips to the real one — the reader
                    reads the first, and it is about named people.
                  */}
                  {!memberSearchFailed && !memberSearching && memberHits.length === 0 ? (
                    <li role="presentation" className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      No members match. Try a surname or an electorate.
                    </li>
                  ) : null}
                  {memberHits.map((hit, index) => (
                    <li
                      key={hit.slug}
                      id={memberOptionId(index)}
                      role="option"
                      aria-selected={index === memberActiveIndex}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        chooseMember(hit);
                      }}
                      onMouseEnter={() => setMemberActiveIndex(index)}
                      className={`cursor-pointer rounded px-2 py-1 text-left text-xs ${
                        index === memberActiveIndex ? "bg-muted" : ""
                      }`}
                    >
                      {hit.displayName}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>

        {controlsFiltered ? (
          <button
            type="button"
            onClick={() => {
              setMemberName("");
              setMemberQuery("");
              setMemberHits([]);
              setMemberOpen(false);
              setMemberActiveIndex(-1);
              setFilter({
                kind: "",
                chamber: "",
                partyAb: "",
                itemNo: 0,
                politicianSlug: "",
              });
            }}
            className={POLITICS_FILTER_BUTTON_CLASS}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {/* role="status": these paragraphs REPLACE content that was there a moment
          ago, and a reader who is not looking at the region otherwise learns
          nothing changed. */}
      {memberSearchFailed ? (
        <p className="text-[11px] text-muted-foreground" role="status">
          Member search is unavailable right now. The other filters still work, and nothing here
          is missing from the register.
        </p>
      ) : null}

      {outage ? (
        // One outage paragraph, worded by whether the reader has a filter set.
        // Neither wording claims anything about a member.
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" role="status">
          {filtersActive
            ? "These filters could not be applied just now. Nothing here is missing from the register — this is our end."
            : "This feed is unavailable right now. Nothing here is missing from the register — this is our end."}
        </p>
      ) : null}

      <section aria-labelledby={`${controlsId}-strip-heading`} className="space-y-2">
        <h2 id={`${controlsId}-strip-heading`} className="text-sm font-medium">
          <SectionIcon name="timeline" size="sm" />
          Register events by week
        </h2>
        {/*
          EVERY MEASURE HERE COMES FROM THE ONE RPC, so every one of them is
          gated on it. When the aggregate request does not answer, its arrays and
          its counts arrive empty — and rendering that as "0 dated register
          events" publishes an absence claim about every member the filter covers,
          on our own downtime. One outage paragraph replaces the strip AND the
          count line; neither states a number.
        */}
        {page.railsOk ? (
          <>
            <WeekBars
              weeks={page.weeks}
              windowLabel={windowLabel(page.windowDays)}
              scopeNote={stripScope}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground" role="status">
              <span className="tabular-nums">
                {page.filteredEventCount.toLocaleString()}
              </span>{" "}
              dated register events in {windowLabel(page.windowDays)}, from{" "}
              <span className="tabular-nums">
                {page.filteredMemberCount.toLocaleString()}
              </span>{" "}
              {page.filteredMemberCount === 1 ? "member" : "members"} {stripScope}.{" "}
              {page.undatedCurrentCount > 0 ? (
                <>
                  A further{" "}
                  <span className="tabular-nums">
                    {page.undatedCurrentCount.toLocaleString()}
                  </span>{" "}
                  currently-declared entries state no start date, so they appear in no count on
                  this page.
                </>
              ) : null}
            </p>
          </>
        ) : (
          <p
            className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
            role="status"
          >
            The weekly counts are unavailable right now. Nothing here is missing from the
            register — this is our end.
          </p>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby={`${controlsId}-feed-heading`} className="space-y-4">
          <h2 id={`${controlsId}-feed-heading`} className="text-sm font-medium">
            <SectionIcon name="coverage" size="sm" />
            Additions and removals
          </h2>

          <div aria-busy={status === "loading"} className={status === "loading" ? "opacity-60" : ""}>
            {groups.map((group) => (
              <section key={group.key} className="space-y-1 pt-3 first:pt-0">
                <h3 className="text-[11px] font-medium uppercase tracking-wide tabular-nums text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="divide-y">
                  {group.rows.map((row) => (
                    <li
                      key={row.id}
                      className="-mx-2 flex flex-col gap-1 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {/*
                          Same ink, same weight, for both kinds — see the hub's
                          note. A removal is a register event, not a verdict.
                        */}
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          <PoliticsIcon
                            name={row.kind === "added" ? "entry-added" : "entry-removed"}
                            size={12}
                          />
                          {row.kind === "added" ? "added" : "removed"}
                        </span>
                        {/*
                          `prefetch={false}`: the event feed is a bulk list, and
                          Next was prefetching the RSC payload of every member
                          row in the viewport — 49 profile payloads, 1,035 KB,
                          on the first load of this page, for navigation that
                          mostly will not happen. `inline-block py-1` gives the
                          20 px-tall link a 44 px tap area without changing the
                          type scale.
                        */}
                        <Link
                          href={`/politicians/${row.slug}`}
                          prefetch={false}
                          className="inline-block py-1 text-sm hover:underline"
                        >
                          {row.displayName}
                        </Link>
                        <ActivityPartyChip partyAb={row.partyAb} />
                        <span className="text-[10px] text-muted-foreground">
                          {row.holderLabel}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <ActivityEntity row={row} />
                        {/*
                          The register category, with its own icon — the same
                          pairing the declaration rows on a profile use, so a
                          category looks the same wherever a reader meets it.
                          `row.itemNo` is the register's own item number, so an
                          item we cannot name renders the label alone.
                        */}
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          {registerItemIcon(row.itemNo) ? (
                            <PoliticsIcon name={registerItemIcon(row.itemNo)!} size={12} />
                          ) : null}
                          {row.itemLabel}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {events.length === 0 && !outage ? (
            // The ONLY empty state that says anything about a result rather than
            // about us: the request answered, a filter is set, and nothing
            // matched it.
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No register events match these filters in this window. Widen the window or the
              filters — an empty result is a filter, not a statement about anyone&rsquo;s
              register.
              {/*
                THE SENATE FILTER IS EMPTY FOR A REASON THIS SENTENCE CANNOT
                CARRY ON ITS OWN. Every other filter combination returns nothing
                because nothing matched it; chamber=senate returns nothing
                because there is no Senate register corpus behind this feed at
                all — the tabled volumes are unread. "Widen the window" is
                advice that cannot work there, and leaving it as the only
                explanation implies senators simply did not file anything.
              */}
              {query.chamber === "senate" ? <> {SENATE_REGISTER_GAP_CORPUS}</> : null}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {events.length === 0
                ? "0 events"
                : `${query.offset + 1}–${query.offset + events.length} of ${page.total.toLocaleString()}`}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={!hasPrevious || status === "loading"}
                onClick={() =>
                  // The FILTERS come from the controls, the OFFSET from the page
                  // on screen: paging must move from what the reader is looking
                  // at, under whatever they have currently selected.
                  run({ ...pendingQuery, offset: Math.max(0, query.offset - query.limit) })
                }
                className={POLITICS_PAGER_BUTTON_CLASS}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!hasNext || status === "loading"}
                onClick={() => run({ ...pendingQuery, offset: query.offset + query.limit })}
                className={POLITICS_PAGER_BUTTON_CLASS}
              >
                Next
              </button>
            </span>
          </div>
        </section>

        <aside className="space-y-6">
          {/*
            THE RAILS DESCRIBE THE WINDOW, NOT THE FILTER. The request now
            carries the feed's filters, but they narrow the strip only: these
            three lists answer corpus-wide questions inside the window, so
            captioning them with the member or party filter set above would
            attribute parliament-wide counts to one member.

            The note sits HERE, at the top of the aside and before the first
            heading, because a scope note beneath three lists is read after the
            lists it governs — which is after the misreading has happened. It
            does not claim to cover "the whole register": these measures are
            DATED-ONLY, and about 80% of currently-declared rows carry no start
            date.
          */}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            These three lists count dated declarations across all members, over{" "}
            {windowLabel(page.windowDays)}. They are not narrowed by the filters above.
          </p>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">
              <SectionIcon name="parliament" size="sm" />
              Most dated register events, {windowLabel(page.windowDays)}
            </h2>
            {page.activeMembers.length ? (
              <ul className="space-y-1">
                {page.activeMembers.map((member) => (
                  <li key={member.slug} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0">
                      <Link
                        href={`/politicians/${member.slug}`}
                        prefetch={false}
                        className="inline-block py-1 text-sm hover:underline"
                      >
                        {member.displayName}
                      </Link>{" "}
                      <ActivityPartyChip partyAb={member.partyAb} />
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {member.eventCount}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              // Absence and outage, told apart. An empty rail from a request
              // that never answered is OUR failure, and "no dated events in this
              // window" would publish it as a statement about parliament.
              <p className="text-[11px] text-muted-foreground" role="status">
                {page.railsOk
                  ? "No dated events in this window."
                  : "This list is unavailable right now — this is our end."}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">
              <SectionIcon name="shareholdings" size="sm" />
              First declared by any member, {windowLabel(page.windowDays)}
            </h2>
            {page.newlyDeclaredCompanies.length ? (
              <ul className="space-y-1">
                {page.newlyDeclaredCompanies.map((company) => (
                  <li key={company.stockCode} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0">
                      <Link href={`/shorts/${company.stockCode}`} className="text-sm hover:underline">
                        <span className="font-medium">{company.stockCode}</span>
                        {company.companyName ? (
                          <span className="text-muted-foreground"> · {company.companyName}</span>
                        ) : null}
                      </Link>
                      <span className="block text-[11px] tabular-nums text-muted-foreground">
                        {company.firstDeclaredLabel || company.firstDeclaredOn}
                      </span>
                    </span>
                    {/*
                      LABELLED, because the rail below states a member count for
                      a company too. Both are now the SAME dated measure (the
                      backend's own note on the two fields says so), and two
                      unlabelled member-counts for one company that could be read
                      as different measures is how a page contradicts itself.
                    */}
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {company.declarerCount}{" "}
                      {company.declarerCount === 1 ? "member" : "members"} with dated
                      declarations
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-muted-foreground" role="status">
                {page.railsOk
                  ? "No company was first declared in this window."
                  : "This list is unavailable right now — this is our end."}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">
              <SectionIcon name="compare" size="sm" />
              Members with dated declarations, compared with {page.windowDays} days ago
            </h2>
            {page.declarerCountChanges.length ? (
              <ul className="space-y-1">
                {page.declarerCountChanges.map((company) => {
                  const difference = company.declarersNow - company.declarersAtWindowStart;
                  return (
                    <li
                      key={company.stockCode}
                      className="flex items-baseline justify-between gap-2"
                    >
                      <Link
                        href={`/shorts/${company.stockCode}`}
                        className="min-w-0 text-sm hover:underline"
                      >
                        <span className="font-medium">{company.stockCode}</span>
                        {company.companyName ? (
                          <span className="text-muted-foreground"> · {company.companyName}</span>
                        ) : null}
                      </Link>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {difference > 0 ? `+${difference}` : `−${Math.abs(difference)}`}{" "}
                        {Math.abs(difference) === 1 ? "member" : "members"} with dated
                        declarations ({company.declarersAtWindowStart} →{" "}
                        {company.declarersNow})
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[11px] text-muted-foreground" role="status">
                {page.railsOk
                  ? "No company’s declaring-member count changed on a dated basis in this window."
                  : "This list is unavailable right now — this is our end."}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
