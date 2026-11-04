"use client";

/**
 * The notice feed on /ownership/notices: what was released, newest first, by
 * window, event, kind, stock and holder.
 *
 * WHY A CLIENT ISLAND ON AN ISR PAGE. The page is ISR and must not read
 * `searchParams`: a read there forces the route dynamic and throws the cache
 * away. So the server renders the default view (the default window, no filters,
 * the first page) into the HTML, and this island reads the link itself through
 * `useSearchParams`, under its own Suspense boundary whose fallback is that same
 * default view. The window, event and kind are chips (a reader without JavaScript
 * gets the same links); the holder and the stock are written from here. Every
 * change is written back with `history.replaceState`, which leaves the defaults out.
 *
 * WHY THE ACTION ARRIVES AS A PROP. A "use client" module may not reach the
 * generated protobuf module by any import path (client-boundary.test.ts walks the
 * graph), so the page passes the action down. The action
 * (app/actions/ownershipExplorer.ts) imports the row and
 * page types declared here, so a row that drifts from what this island reads fails
 * tsc there. The action never throws: a read that did not answer is `ok: false`,
 * which is an outage, never an empty feed.
 *
 * EDITORIAL.
 *   - A FALL IS A FALL. Event labels come from the API's own decision
 *     (lib/ownership/events.ts), and every figure is the notice's own. Nothing
 *     here is red or green, and nothing is described as a disposal.
 *   - AN EMPTY FEED MEANS ONE THING: an answered request with no notice matching
 *     the filters. A request still in flight after OUTAGE_AFTER_MS is our outage,
 *     and the screen says so.
 *   - A STALE ANSWER NEVER WINS. Every request carries a sequence number and only
 *     the newest may write state, so two quick changes cannot leave the rows of
 *     the first on the screen.
 *   - A FAILED REQUEST LEAVES WHAT IT CAN. A failed change of filter does not draw
 *     the rows of the query it replaced. A failed Show more keeps the rows already
 *     drawn, with the outage beside them.
 *
 * WHAT THE PAGE DRAWS. Every ASX link is a `use` of the page's ExternalLinkSymbol
 * (external-link-glyph.tsx). The page renders that symbol once, or each link is an
 * empty 16 px target.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { loadNoticeFeed } from "~/app/actions/ownershipExplorer";
import { ExternalLinkGlyph } from "./external-link-glyph";
import { Toolbar, ToolbarSelect, type ToolbarFold } from "./workspace/toolbar";
import { ViewDisclosure } from "./workspace/view-disclosure";
import { NoticeMark } from "./notice-mark";
import { NoticeWeekBars, type NoticeWeekBar } from "./notice-week-bars";
import {
  FilterChip,
  LOADING_COPY,
  OUTAGE_AFTER_MS,
  hrefWith,
} from "./register-rows-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { NOTICE_EVENT_LABELS, noticeEventLabel } from "~/@/lib/ownership/events";
import { KIND_ORDER, kindSelectLabel, registerHref, type OwnershipKind } from "~/@/lib/ownership/kinds";
import {
  NOTICE_EVENTS,
  NOTICE_WINDOW_ALL,
  parseNoticeParams,
  type NoticeEvent,
  serialiseNoticeParams,
  wantsActivity,
  type NoticeQuery,
} from "~/@/lib/ownership/query";
import {
  POLITICS_FOCUS_RING,
  POLITICS_PAGER_BUTTON_CLASS,
} from "~/@/lib/politics/control-classes";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { cn } from "~/@/lib/utils";

/* ------------------------------------------------------------------ shapes */

/** One notice as the feed shows it. The action maps each row to these strings. */
export interface NoticeFeedRow {
  /** The release date, YYYY-MM-DD. */
  released: string;
  /** The notice's event, as the API decided it (lib/ownership/events.ts). */
  event: string;
  code: string;
  companyName: string;
  holder: string;
  /** The holder's page, or null for a holder off the map. */
  holderHref: string | null;
  /** The voting power the notice states: "under 5%" for a cessation, "n/a" when none is stated. */
  votingPower: string;
  /** The change in percentage points with a true minus, or "" when the notice states no earlier figure. */
  change: string;
  /** The notice on ASX. */
  url: string;
}

/** One answer from the feed: the query the server ran, and its rows. */
export interface NoticeFeedPage {
  /** Did the feed request answer? A false is an outage, never an empty feed. */
  ok: boolean;
  /** Did the weekly counts answer, when the window asked for them? */
  activityOk: boolean;
  /** The query the server ran, after its own clamping. */
  query: NoticeQuery;
  rows: NoticeFeedRow[];
  /** The notices matching the filters in the window, which is not the length of `rows`. */
  total: number;
  /** The cursor for the next page, or "" on the last. */
  nextCursor: string;
  /** Every week in the window, oldest first, with its notice count. Empty when no activity was asked for. */
  weeks: NoticeWeekBar[];
}

/** A holder the registry holds, for the holder select. */
export interface NoticeHolderOption {
  slug: string;
  name: string;
}

export interface NoticeFeedExplorerProps {
  /** The default view the server rendered: the action's answer to the default query. A shell (ok: false) draws as loading. */
  initial: NoticeFeedPage;
  /**
   * The server action, passed down (see the docblock). It is typed as the action
   * itself, so a change to its signature fails tsc here. It never throws.
   */
  loadPage: typeof loadNoticeFeed;
  /**
   * The registry's holders, for the holder select. Pass the whole registry (ListInstitutions
   * serves up to 200). A link's holder the list does not hold is kept: the select shows it
   * under its slug and the feed asks for it. The API checks the full registry and refuses a
   * slug it does not know, so the screen shows the outage rather than an unfiltered feed.
   */
  holders: readonly NoticeHolderOption[];
  /** The page's own path, which the chips link to, e.g. /ownership/notices. */
  basePath: string;
}

/* --------------------------------------------------------------- constants */

/** The window select's options (spec 14.9): the days the feed serves, the register's whole when 0. */
const WINDOW_OPTIONS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "365 days" },
  { days: NOTICE_WINDOW_ALL, label: "All notices" },
];

/** The value of the window select while a dated range is set: it names the range, and is not a window. */
const DATES_OPTION = "dates";

const FIELD_LABEL = "text-xs text-muted-foreground";
const INPUT_CLASS =
  "h-8 w-20 min-w-0 rounded-sm border border-input bg-background px-2 font-mono text-xs uppercase text-foreground " +
  POLITICS_FOCUS_RING;

/** The feed's toolbar fold below sm (spec 14.9): the one row under "Adjust view" on a phone. */
const feedToolbarFold: ToolbarFold = (row) => <ViewDisclosure>{row}</ViewDisclosure>;

/** An ASX code is one to six letters or digits. */
const CODE_MAX = 6;

/** The link's own parameters for this feed. Anything else in the link is left alone. */
const FEED_PARAMS = ["window", "event", "kind", "stock", "holder", "industry", "since", "until"] as const;

/** feed.outage (section 7): a request that did not answer is never an empty feed. */
const FEED_OUTAGE_COPY =
  "The notices could not be read just now. Nothing here is missing from the register: this is our end.";

/* ----------------------------------------------------------------- helpers */

/** The link a query is written as: the key the island compares, so a link it wrote is never asked again. */
function keyOf(query: NoticeQuery): string {
  return serialiseNoticeParams(query).toString();
}

/**
 * The stock box's text as a code. A reader pastes the site's own share text ("ASX:BHP") or a quote
 * ("BHP.AX"): the ASX: prefix and the .AX suffix go first, then letters and digits only, six at most.
 */
function stockFromText(text: string): string {
  const bare = text.trim().toUpperCase().replace(/^ASX:/, "").replace(/\.AX$/, "");
  return bare.replace(/[^A-Z0-9]/g, "").slice(0, CODE_MAX);
}

function filtersActive(query: NoticeQuery): boolean {
  return (
    query.event !== "" ||
    query.kind !== "" ||
    query.stockCode !== "" ||
    query.institutionSlug !== "" ||
    query.industry !== "" ||
    query.since !== "" ||
    query.until !== ""
  );
}

/**
 * The brushed dates as the chip names them: a range is "from to", a side left out is named alone. The
 * link's dates are what the feed runs, so the chip shows exactly those.
 */
function datesLabel(since: string, until: string): string {
  if (since !== "" && until !== "") return `${since} to ${until}`;
  if (since !== "") return `From ${since}`;
  return `Until ${until}`;
}

/**
 * feed.empty (section 7) for a window. The all-notices window names no day and no start: the feed
 * does not state its first day, so the copy does not guess one.
 */
function emptyCopy(windowDays: number): string {
  if (windowDays === NOTICE_WINDOW_ALL) return "No notices read match these filters.";
  return `No notices read match these filters in the last ${windowDays} days.`;
}

/** Writes a query into the link: the feed's own parameters are replaced and nothing else is touched. */
function writeLink(query: NoticeQuery): void {
  const url = new URL(window.location.href);
  for (const name of FEED_PARAMS) url.searchParams.delete(name);
  serialiseNoticeParams(query).forEach((value, name) => url.searchParams.set(name, value));
  // A null state, never the current one: Next stamps its own entries with a
  // marker (__NA), and a replaceState that carries it skips the router's update,
  // so useSearchParams would not follow the link (Next 14.2 app-router).
  window.history.replaceState(null, "", url);
}

function ignoreSubmit(event: FormEvent<HTMLFormElement>): void {
  event.preventDefault();
}

/* ------------------------------------------------------------------ state */

type Status = "idle" | "loading" | "error";

/**
 * Which request failed. A filter change's rows belong to a query the controls no
 * longer show, so they are not drawn; a Show more's rows are the ones on screen,
 * so they stay.
 */
type Failure = "none" | "filter" | "more";

interface FeedState {
  /** The last answer written to the screen. Its rows and counts belong to `page.query`. */
  page: NoticeFeedPage;
  /** What the controls hold: the query in flight, or the one on the screen. */
  controls: NoticeQuery;
  /** The stock box's text. It is applied on submit, not on each key. */
  stock: string;
  status: Status;
  failure: Failure;
  /** True once a request has been in flight for OUTAGE_AFTER_MS. */
  slow: boolean;
}

function initialState(page: NoticeFeedPage, controls: NoticeQuery, status: Status): FeedState {
  return { page, controls, stock: controls.stockCode, status, failure: "none", slow: false };
}

/**
 * The state after an answer. Only the newest request reaches here. A failed answer
 * leaves the answer on screen as it was, and says which request failed.
 */
function applyResult(state: FeedState, result: NoticeFeedPage, append: boolean): FeedState {
  if (!result.ok) {
    return { ...state, status: "error", slow: false, failure: append ? "more" : "filter" };
  }
  if (append) {
    return {
      ...state,
      status: "idle",
      slow: false,
      failure: "none",
      page: {
        ...state.page,
        rows: [...state.page.rows, ...result.rows],
        total: result.total,
        nextCursor: result.nextCursor,
      },
    };
  }
  return {
    ...state,
    status: "idle",
    slow: false,
    failure: "none",
    controls: result.query,
    stock: result.query.stockCode === state.controls.stockCode ? state.stock : result.query.stockCode,
    page: result,
  };
}

/* ------------------------------------------------------------------ pieces */

/**
 * A cell's padding on a phone: none across, a hair of air up and down. From md 8 px a side, and 12 px from xl
 * (the register list's), so the seven columns leave the holder its width: a 16 px cell took 224 px of a 768 px
 * window's 672 px, and a holder's name broke inside its words.
 */
const PHONE_CELL = "p-0 py-0.5 md:px-2 md:py-4 xl:px-3";

/**
 * One notice. Below md a row stacks, in this order: the event, the date under the event, the stock, the
 * holder under the stock, the voting power with the notice's link beside it, the change under the figure.
 * Each value is one element, and `order` places it. The DOM keeps the table's column order, which is the
 * order from md up, where the row is the table row again and `order` does nothing. Of the parts a reader
 * can tab to (the stock, the holder and the notice's link), the tab order reads down the card as it looks.
 */
function FeedRow({ row }: { row: NoticeFeedRow }) {
  const href = safeExternalHref(row.url);
  return (
    <TableRow className="flex flex-wrap py-2 md:table-row md:py-0">
      <TableCell
        className={cn(
          PHONE_CELL,
          "order-2 w-full whitespace-nowrap text-xs tabular-nums text-muted-foreground md:order-none md:w-auto md:text-sm md:text-foreground",
        )}
      >
        <time dateTime={row.released}>{row.released}</time>
      </TableCell>
      {/* The event takes the phone's whole line, so the date below it starts a line of its own. From md it is the column, and its label may wrap. */}
      <TableCell className={cn(PHONE_CELL, "order-1 w-full min-w-0 md:order-none md:w-auto")}>
        {/* The mark repeats the event's name; the label is the content a reader and a screen reader get. */}
        <span className="inline-flex items-center gap-1.5">
          <NoticeMark event={row.event} />
          {noticeEventLabel(row.event)}
        </span>
      </TableCell>
      <TableCell className={cn(PHONE_CELL, "order-3 w-full min-w-0 md:order-none md:w-auto")}>
        <Link
          href={registerHref(row.code)}
          prefetch={false}
          className="font-semibold text-primary underline-offset-4 hover:underline"
        >
          {row.code}
        </Link>
        {/* The space is a line break WebKit would not take between the link and an inline-block, so the name wraps as Chromium's does. */}
        {row.companyName ? (
          <>
            {" "}
            <span className="ml-2 hidden text-xs text-muted-foreground lg:inline-block lg:max-w-[8rem] lg:truncate lg:align-bottom xl:max-w-[12rem]">
              {row.companyName}
            </span>
          </>
        ) : null}
      </TableCell>
      <TableCell className={cn(PHONE_CELL, "order-4 w-full min-w-0 [overflow-wrap:anywhere] md:order-none md:w-auto")}>
        {row.holderHref ? (
          <Link
            href={row.holderHref}
            prefetch={false}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.holder}
          </Link>
        ) : (
          <span>{row.holder}</span>
        )}
      </TableCell>
      <TableCell
        className={cn(
          PHONE_CELL,
          "order-5 min-w-0 flex-auto text-left tabular-nums md:order-none md:w-auto md:flex-none md:text-right",
        )}
      >
        {row.votingPower}
      </TableCell>
      {/*
        A notice with no earlier figure has no change to state: n/a, never a blank. Below md the cell names itself,
        since its header is for a screen reader only; the name is decorative, the header already says the column.
        A change is a figure and its unit, so the cell never breaks between them ("+12.34 pp" is one line).
      */}
      <TableCell
        className={cn(
          PHONE_CELL,
          "order-6 w-full whitespace-nowrap text-left text-xs tabular-nums text-muted-foreground md:order-none md:w-auto md:text-right md:text-sm md:text-foreground",
        )}
      >
        <span aria-hidden="true" className="md:hidden">
          Change{" "}
        </span>
        {row.change || NOT_AVAILABLE}
      </TableCell>
      {/* On a phone the glyph sits beside the figure, after the holder's line as it is tabbed to. */}
      <TableCell className={cn(PHONE_CELL, "order-5 w-10 shrink-0 pr-1 text-right md:order-none md:w-auto")}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Notice for ${row.code}, released ${row.released}, on ASX`}
            className="hit-target inline-flex text-muted-foreground hover:text-primary"
          >
            <ExternalLinkGlyph />
          </a>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

interface NoticeFeedViewProps {
  state: FeedState;
  holders: readonly NoticeHolderOption[];
  basePath: string;
  /** The island's phone fold of the toolbar; absent in the server's fallback, where the row is drawn as it is. */
  toolbarFold?: ToolbarFold;
  /** Absent in the server's fallback, where the holder select draws but does nothing until the island takes over. */
  onFilter?: (patch: Partial<NoticeQuery>) => void;
  onStockChange?: (text: string) => void;
  onStockSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onShowMore?: () => void;
}

/** The feed as the reader sees it. The island and the server's fallback draw this same markup. */
function NoticeFeedView({
  state,
  holders,
  basePath,
  toolbarFold,
  onFilter,
  onStockChange,
  onStockSubmit,
  onShowMore,
}: NoticeFeedViewProps) {
  const id = useId();
  const { page, controls, status, failure, slow } = state;
  const busy = status === "loading";
  // The screen holds an answer only once a read has answered. A shell (the server
  // could not render the default view) holds none: no count, no zero, no bars.
  const answered = page.ok;
  // An answer the server never read is an outage, as is a request that failed.
  const unanswered = status === "idle" && !answered;
  // A failed filter change's rows belong to a query the controls no longer show.
  const hideRows = unanswered || (status === "error" && failure === "filter");
  const rows = hideRows ? [] : page.rows;
  const showNotice = status === "error" || slow || unanswered;
  const empty = status === "idle" && answered && page.rows.length === 0;
  const scoped = filtersActive(page.query);
  // The bars are drawn when the window owes them and they came back. A window too
  // wide to carry them, or an activity that did not answer, draws none: never a guess.
  const showBars =
    answered && !hideRows && page.activityOk && wantsActivity(page.query);
  // The registry by name. The link's holder, when the registry does not list it, is an option under its
  // own slug: the select then shows the filter the feed runs, never "Any holder" over a filtered list.
  const holderChoices = useMemo(() => {
    const selected = controls.institutionSlug;
    const unlisted =
      selected !== "" && !holders.some((holder) => holder.slug === selected)
        ? [{ slug: selected, name: selected }]
        : [];
    return [...holders, ...unlisted].sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
  }, [holders, controls.institutionSlug]);

  /** A chip's link: the controls as they stand, with this one value changed and the first page asked for. */
  const chip = (patch: Partial<NoticeQuery>) =>
    hrefWith(basePath, serialiseNoticeParams({ ...controls, ...patch, cursor: "" }));
  // A date range is the window while it is set, so the window chips give way to it. Clearing it
  // returns the feed to the default window, not to the all-notices window a dated query carries.
  const dated = controls.since !== "" || controls.until !== "";
  const datesText = datesLabel(controls.since, controls.until);
  // A placeholder industry in a link is named as the record names it: n/a would say the chip holds nothing.
  const industryText = `Industry: ${industryLabel(controls.industry) || controls.industry}`;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {/*
          One toolbar row (spec 14.9): the window, the event, the kind, the holder and the stock, labelled.
          Width (an estimate at IBM Plex Mono 12px, 7.2 px a character, against the 1016 px column at 1440):
          window about 170, event about 206, kind about 170, holder about 190 (its select capped at 9rem),
          stock about 116, with the gaps about 870 in all. Kind's names are the short ones (kindSelectLabel),
          and the caps keep a long holder name from taking the row.
        */}
        <Toolbar fold={toolbarFold}>
          <ToolbarSelect
            label="Window"
            value={dated ? DATES_OPTION : String(controls.windowDays)}
            onChange={
              onFilter === undefined
                ? undefined
                : (value) => {
                    if (value === DATES_OPTION) return;
                    onFilter({ windowDays: Number(value), since: "", until: "" });
                  }
            }
          >
            {dated ? <option value={DATES_OPTION}>Date range</option> : null}
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.days} value={String(option.days)}>
                {option.label}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Event"
            value={controls.event}
            onChange={onFilter === undefined ? undefined : (value) => onFilter({ event: value as NoticeEvent | "" })}
          >
            <option value="">Any event</option>
            {NOTICE_EVENTS.map((event) => (
              <option key={event} value={event}>
                {NOTICE_EVENT_LABELS[event]}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Kind"
            value={controls.kind}
            className="max-w-[9rem]"
            onChange={onFilter === undefined ? undefined : (value) => onFilter({ kind: value as OwnershipKind | "" })}
          >
            <option value="">Any kind</option>
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {kindSelectLabel(kind)}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Holder"
            value={controls.institutionSlug}
            className="max-w-[9rem]"
            onChange={onFilter === undefined ? undefined : (value) => onFilter({ institutionSlug: value })}
          >
            <option value="">Any holder</option>
            {holderChoices.map((holder) => (
              <option key={holder.slug} value={holder.slug}>
                {holder.name}
              </option>
            ))}
          </ToolbarSelect>
          <form className="flex items-center gap-2" onSubmit={onStockSubmit ?? ignoreSubmit}>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={FIELD_LABEL}>Stock</span>
              <input
                id={`${id}-stock`}
                type="text"
                value={state.stock}
                onChange={(e) => onStockChange?.(e.target.value)}
                placeholder="e.g. BHP"
                autoComplete="off"
                spellCheck={false}
                className={INPUT_CLASS}
              />
            </label>
          </form>
        </Toolbar>
        {/* A dated range names its own dates here: the window select says only "Date range". */}
        {dated ? <p className="text-xs text-muted-foreground">Dates: {datesText}</p> : null}

        {controls.industry !== "" ? (
          // A filter the link carries (a holder's or a sector's page) is named under the row, with its clear.
          <div className="space-y-1.5">
            <span id={`${id}-filters`} className={FIELD_LABEL}>
              Filtered by
            </span>
            <div role="group" aria-labelledby={`${id}-filters`} className="flex flex-wrap gap-1.5">
              <FilterChip
                href={chip({ industry: "" })}
                active={false}
                label={industryText}
                clearName={`${industryText}, clear filter`}
              />
            </div>
          </div>
        ) : null}
      </div>

      {showBars ? (
        <div aria-busy={busy} className={cn(busy && "opacity-60")}>
          <NoticeWeekBars
            weeks={page.weeks}
            windowLabel={`the last ${page.query.windowDays} days`}
            scopeNote={scoped ? "under the filters set above" : undefined}
          />
        </div>
      ) : null}

      {showNotice ? (
        <p
          role="status"
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
        >
          {FEED_OUTAGE_COPY}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div aria-busy={busy} className={cn(busy && "opacity-60")}>
          <Table>
            <caption className="sr-only">Substantial holding notices, newest release first</caption>
            {/* Below md the headers are read by a screen reader only: a phone row stacks its cells in its own order. */}
            <TableHeader className="sr-only md:not-sr-only">
              <TableRow>
                <TableHead>Released</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Holder</TableHead>
                <TableHead className="text-right">Voting power</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead>
                  <span className="sr-only">Notice on ASX</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <FeedRow key={row.url} row={row} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : busy ? (
        // Nothing to dim yet, so the wait is said in the list's place: a reader does not see a blank.
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading"
          className="flex min-h-[10rem] items-center justify-center rounded-md border border-dashed p-3 text-sm text-muted-foreground"
        >
          {LOADING_COPY}
        </div>
      ) : null}

      {empty ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {emptyCopy(page.query.windowDays)}
        </p>
      ) : null}

      {answered && !hideRows ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span role="status" className="tabular-nums">
            {rows.length === 0
              ? "0 notices"
              : `1–${rows.length} of ${page.total.toLocaleString("en-AU")}`}
          </span>
          {page.nextCursor ? (
            // Drawn in the server's fallback too, disabled there, so the line keeps its height when the island takes over.
            <button
              type="button"
              disabled={busy || !onShowMore}
              onClick={onShowMore}
              className={POLITICS_PAGER_BUTTON_CLASS}
            >
              Show more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- island */

/**
 * The live feed: the controls, the link and the requests. Mounted under the
 * Suspense boundary, so it reads the link only after the server's default view
 * is on the screen.
 */
function LiveNoticeFeed({ initial, loadPage, holders, basePath }: NoticeFeedExplorerProps) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  // The link, read the way the API serves it. The memo keys on the string, so a re-render with the same link keeps the same query.
  // The registry does not narrow it: a slug the list lacks is kept, and the API decides whether it exists.
  const asked = useMemo(() => parseNoticeParams(new URLSearchParams(search)), [search]);

  const [state, setState] = useState<FeedState>(() =>
    initialState(
      initial,
      asked,
      initial.ok === false || keyOf(asked) !== keyOf(initial.query) ? "loading" : "idle",
    ),
  );
  const sequence = useRef(0);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The key of the query this screen was last asked for. A change the reader makes moves it first,
  // so the link update that follows is not a second request.
  const askedKey = useRef<string | null>(null);

  const run = useCallback(
    (next: NoticeQuery, append = false) => {
      const ticket = (sequence.current += 1);
      clearTimeout(slowTimer.current);
      slowTimer.current = setTimeout(() => {
        if (sequence.current === ticket) setState((s) => ({ ...s, slow: true }));
      }, OUTAGE_AFTER_MS);
      setState((s) => ({
        ...s,
        controls: append ? s.controls : next,
        stock: append || next.stockCode === s.controls.stockCode ? s.stock : next.stockCode,
        status: "loading",
        failure: "none",
        slow: false,
      }));
      const settle = (update: (s: FeedState) => FeedState) => {
        if (sequence.current !== ticket) return;
        clearTimeout(slowTimer.current);
        setState(update);
      };
      loadPage(next).then(
        (result) => settle((s) => applyResult(s, result, append)),
        () =>
          settle((s) => ({
            ...s,
            status: "error",
            slow: false,
            failure: append ? "more" : "filter",
          })),
      );
    },
    [loadPage],
  );

  // Leaving the screen ends the wait: no outage timer outlives the island, and a request
  // that settles after it writes nothing (the sequence has moved on). The asked key goes
  // too: under StrictMode the island mounts, unmounts and mounts again, and the second
  // mount must ask again, or the request the first one started is dropped and the feed
  // stays dimmed.
  useEffect(() => {
    const sequenceRef = sequence;
    const timerRef = slowTimer;
    const askedRef = askedKey;
    return () => {
      sequenceRef.current += 1;
      clearTimeout(timerRef.current);
      askedRef.current = null;
    };
  }, []);

  useEffect(() => {
    const key = keyOf(asked);
    if (askedKey.current === null) {
      // The first look at the link. The server's default view answers the default link, unless the
      // server could not render one (its shell), in which case the query is asked for once.
      if (key === keyOf(initial.query) && initial.ok !== false) {
        askedKey.current = key;
        return;
      }
    } else if (key === askedKey.current) {
      return;
    }
    askedKey.current = key;
    run(asked);
  }, [asked, initial, run]);

  const commit = useCallback(
    (next: NoticeQuery) => {
      askedKey.current = keyOf(next);
      writeLink(next);
      run(next);
    },
    [run],
  );

  const onFilter = (patch: Partial<NoticeQuery>) => {
    commit({ ...state.controls, ...patch, cursor: "" });
  };

  const onStockSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = stockFromText(state.stock);
    setState((s) => ({ ...s, stock: code }));
    if (code !== state.controls.stockCode) onFilter({ stockCode: code });
  };

  const onShowMore = () => {
    const cursor = state.page.nextCursor;
    if (cursor === "") return;
    run({ ...state.page.query, cursor }, true);
  };

  return (
    <NoticeFeedView
      state={state}
      holders={holders}
      basePath={basePath}
      toolbarFold={feedToolbarFold}
      onFilter={onFilter}
      onStockChange={(text) => setState((s) => ({ ...s, stock: text }))}
      onStockSubmit={onStockSubmit}
      onShowMore={onShowMore}
    />
  );
}

/**
 * The notice feed. The default view is the Suspense fallback, drawn from the
 * same props, so the server HTML is the default view and the island takes over
 * once it has read the link.
 */
export function NoticeFeedExplorer(props: NoticeFeedExplorerProps) {
  // A shell is drawn as loading, so the server HTML says nothing it has not read.
  const fallbackStatus: Status = props.initial.ok === false ? "loading" : "idle";
  return (
    <Suspense
      fallback={
        <NoticeFeedView
          state={initialState(props.initial, props.initial.query, fallbackStatus)}
          holders={props.holders}
          basePath={props.basePath}
        />
      }
    >
      <LiveNoticeFeed {...props} />
    </Suspense>
  );
}
