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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { WeekBars } from "@/components/politicians/explorer/week-bars";
import { partyColorFromAb, partyLabel } from "@/lib/politics/party-palette";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";
import { searchPoliticians } from "@/lib/politics/politician-search";

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

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring";

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
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [memberName, setMemberName] = useState(initialMemberName);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberHits, setMemberHits] = useState<{ slug: string; displayName: string }[]>([]);
  const [memberSearchFailed, setMemberSearchFailed] = useState(false);
  // Every request carries a sequence number and only the newest may write state:
  // two fast filter changes otherwise race and the SLOWER one wins, leaving the
  // page showing events that match neither control.
  const sequence = useRef(0);
  const controlsId = useId();

  const query = page.query;

  const run = useCallback(
    (next: RegisterActivityQuery) => {
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
    (patch: Partial<RegisterActivityQuery>) => run({ ...query, ...patch, offset: 0 }),
    [query, run],
  );

  // The member typeahead, over the same Algolia plumbing the hub search uses.
  useEffect(() => {
    const needle = memberQuery.trim();
    if (needle.length < 2) {
      setMemberHits([]);
      setMemberSearchFailed(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchPoliticians(needle, { hitsPerPage: 6, facets: [] })
        .then((result) => {
          if (cancelled) return;
          setMemberSearchFailed(false);
          setMemberHits(
            (result.hits ?? []).map((hit) => ({
              slug: hit.slug,
              displayName: hit.display_name,
            })),
          );
        })
        .catch(() => {
          if (cancelled) return;
          // Search being down says nothing about the register, and the rest of
          // the filters keep working.
          setMemberSearchFailed(true);
          setMemberHits([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memberQuery]);

  const chooseMember = useCallback(
    (hit: { slug: string; displayName: string }) => {
      setMemberName(hit.displayName);
      setMemberQuery("");
      setMemberHits([]);
      setFilter({ politicianSlug: hit.slug });
    },
    [setFilter],
  );

  const clearMember = useCallback(() => {
    setMemberName("");
    setMemberQuery("");
    setMemberHits([]);
    setFilter({ politicianSlug: "" });
  }, [setFilter]);

  const events = page.events;
  const groups = useMemo(() => groupByDay(events), [events]);
  const filtersActive =
    !!query.kind ||
    !!query.chamber ||
    !!query.partyAb ||
    query.itemNo > 0 ||
    !!query.politicianSlug;

  const datedEvents = page.weeks.reduce(
    (sum, week) => sum + week.addedCount + week.removedCount,
    0,
  );
  // Exact only when the feed holds every matching event; otherwise the distinct
  // members visible are a floor, and the page does not claim a number it cannot
  // support.
  const feedComplete = events.length >= page.total;
  const memberCount = new Set(events.map((event) => event.slug)).size;

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
      <div className="flex flex-wrap items-end gap-2">
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
            value={String(query.windowDays)}
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
            value={query.kind}
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
          <span className={FIELD_LABEL_CLASS}>Party</span>
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
          <span className={FIELD_LABEL_CLASS}>Register category</span>
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

        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL_CLASS} htmlFor={`${controlsId}-member`}>
            Member
          </label>
          {query.politicianSlug ? (
            <span className="flex h-8 items-center gap-2 rounded-md border border-input px-2 text-xs">
              <span>{memberName || query.politicianSlug}</span>
              <button
                type="button"
                onClick={clearMember}
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Clear member
              </button>
            </span>
          ) : (
            <div className="relative">
              <input
                id={`${controlsId}-member`}
                type="search"
                role="combobox"
                aria-expanded={memberHits.length > 0}
                aria-controls={`${controlsId}-member-results`}
                aria-autocomplete="list"
                className={`${SELECT_CLASS} w-56`}
                placeholder="Search a member…"
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
              />
              {memberHits.length > 0 ? (
                <ul
                  id={`${controlsId}-member-results`}
                  className="absolute z-10 mt-1 w-56 rounded-md border bg-background p-1 shadow-sm"
                >
                  {memberHits.map((hit) => (
                    <li key={hit.slug}>
                      <button
                        type="button"
                        onClick={() => chooseMember(hit)}
                        className="w-full rounded px-2 py-1 text-left text-xs hover:bg-muted"
                      >
                        {hit.displayName}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>

        {filtersActive ? (
          <button
            type="button"
            onClick={() => {
              setMemberName("");
              setMemberQuery("");
              setMemberHits([]);
              setFilter({
                kind: "",
                chamber: "",
                partyAb: "",
                itemNo: 0,
                politicianSlug: "",
              });
            }}
            className="h-8 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {memberSearchFailed ? (
        <p className="text-[11px] text-muted-foreground">
          Member search is unavailable right now. The other filters still work, and nothing here
          is missing from the register.
        </p>
      ) : null}

      {outage ? (
        // One outage paragraph, worded by whether the reader has a filter set.
        // Neither wording claims anything about a member.
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {filtersActive
            ? "These filters could not be applied just now. Nothing here is missing from the register — this is our end."
            : "This feed is unavailable right now. Nothing here is missing from the register — this is our end."}
        </p>
      ) : null}

      <section aria-labelledby={`${controlsId}-strip-heading`} className="space-y-2">
        <h2 id={`${controlsId}-strip-heading`} className="text-sm font-medium">
          Register events by week
        </h2>
        {page.railsOk ? (
          <WeekBars weeks={page.weeks} windowLabel={windowLabel(page.windowDays)} />
        ) : (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            The weekly counts are unavailable right now. Nothing here is missing from the
            register — this is our end.
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground" role="status">
          <span className="tabular-nums">{datedEvents.toLocaleString()}</span> dated register
          events in {windowLabel(page.windowDays)}
          {feedComplete && events.length > 0 ? (
            <>
              , from <span className="tabular-nums">{memberCount.toLocaleString()}</span>{" "}
              {memberCount === 1 ? "member" : "members"} in this view
            </>
          ) : null}
          .{" "}
          {page.undatedCurrentCount > 0 ? (
            <>
              A further{" "}
              <span className="tabular-nums">
                {page.undatedCurrentCount.toLocaleString()}
              </span>{" "}
              currently-declared entries state no start date, so they appear in no count on this
              page.
            </>
          ) : null}
        </p>
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby={`${controlsId}-feed-heading`} className="space-y-4">
          <h2 id={`${controlsId}-feed-heading`} className="text-sm font-medium">
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
                    <li key={row.id} className="flex flex-col gap-1 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {row.kind === "added" ? "added" : "removed"}
                        </span>
                        <Link
                          href={`/politicians/${row.slug}`}
                          className="text-sm hover:underline"
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
                        <span className="text-[10px] text-muted-foreground">
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
                onClick={() => run({ ...query, offset: Math.max(0, query.offset - query.limit) })}
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
        </section>

        <aside className="space-y-6">
          {/*
            THE RAILS DESCRIBE THE WINDOW, NOT THE FILTER. The aggregate rpc
            takes only a window, so captioning these with the member or party
            filter set above them would attribute parliament-wide counts to one
            member. Each heading says the window, and the note below says it
            once more.
          */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium">
              Most dated register events, {windowLabel(page.windowDays)}
            </h2>
            {page.activeMembers.length ? (
              <ul className="space-y-1">
                {page.activeMembers.map((member) => (
                  <li key={member.slug} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0">
                      <Link
                        href={`/politicians/${member.slug}`}
                        className="text-sm hover:underline"
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
              <p className="text-[11px] text-muted-foreground">
                No dated events in this window.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">
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
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {company.declarerCount}{" "}
                      {company.declarerCount === 1 ? "member" : "members"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No company was first declared in this window.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">
              Members declaring, compared with {page.windowDays} days ago
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
                        {Math.abs(difference) === 1 ? "member" : "members"} (
                        {company.declarersAtWindowStart} → {company.declarersNow})
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No company&rsquo;s declaring-member count changed on a dated basis in this window.
              </p>
            )}
          </section>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            These three lists cover the whole register over {windowLabel(page.windowDays)}. They
            are not narrowed by the filters above.
          </p>
        </aside>
      </div>
    </div>
  );
}
