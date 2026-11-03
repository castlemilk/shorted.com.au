"use client";

/**
 * The register list on /ownership/stocks: every stock with a current substantial
 * holder, ranked by what its notices disclose, filtered by industry, kind and the
 * short position.
 *
 * The island, the action as a prop and the link work as they do in
 * notice-feed-explorer.tsx: the page is ISR and reads no `searchParams`, the server
 * renders the default view, and this island reads the link after the first paint.
 * The action declares its page with the types below, so a row that drifts from
 * what this island reads fails tsc in the action.
 *
 * Chips and sort heads are plain links (replace, no scroll, no prefetch,
 * nofollow), so a reader without JavaScript gets the same links. A click moves the
 * link, which this island reads back and asks the server for. The short filter and
 * the pager write the link and ask directly.
 *
 * AN INDUSTRY IS CHECKED AGAINST THE ANSWER ON SCREEN. A chip names an industry the
 * answer on screen listed, so the link's industry is kept. A shell (the server
 * could not render the default view) lists none yet, so its link's industry is
 * kept as well, and the API refuses one it does not know.
 *
 * EDITORIAL. Every sum is what the notices disclose, not a share of the company, and
 * the bar says so where it is drawn. A figure we do not hold is n/a, never 0.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useRef, useState } from "react";

import type { loadStockRegisters } from "~/app/actions/ownershipExplorer";
import {
  FilterChip,
  LOADING_COPY,
  OUTAGE_AFTER_MS,
  RegisterRowsTable,
  hrefWith,
  type RegisterStockRow,
} from "./register-rows-table";
import { KIND_ORDER, kindInfo } from "~/@/lib/ownership/kinds";
import {
  REGISTER_SHORT_STEPS,
  parseRegisterParams,
  serialiseRegisterParams,
  type RegistersQuery,
} from "~/@/lib/ownership/query";
import { POLITICS_PAGER_BUTTON_CLASS, POLITICS_SELECT_CLASS } from "~/@/lib/politics/control-classes";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { cn } from "~/@/lib/utils";

/* ------------------------------------------------------------------ shapes */

/** One industry of the register and the stocks in it, for the industry chips. */
export interface RegisterIndustry {
  industry: string;
  stocks: number;
}

/** One answer from the register list: the query the server ran, and its rows. */
export interface RegistersPage {
  /** Did the read answer? A false is an outage, never an empty list. */
  ok: boolean;
  /** The query the server ran, after its own clamping. */
  query: RegistersQuery;
  rows: RegisterStockRow[];
  /** The stocks matching the filters, which is not the length of `rows`. */
  total: number;
  /** The register's industries, distinct and sorted, for the industry chips. */
  industries: RegisterIndustry[];
}

export interface RegistersExplorerProps {
  /** The default view the server rendered: the action's answer to the default query. A shell (ok: false) draws as loading. */
  initial: RegistersPage;
  /**
   * The server action, passed down. It is typed as the action itself, so a change
   * to its signature fails tsc here. It never throws.
   */
  loadPage: typeof loadStockRegisters;
  /** The page's own path, which the chips and sort heads link to, e.g. /ownership/stocks. */
  basePath: string;
}

/* --------------------------------------------------------------- constants */

/** An answered empty list: the filters match no stock. */
const EMPTY_COPY = "No stock matches these filters.";

/** An answered page past the last stock: the link asks for an offset the filters do not reach. */
const PAST_END_COPY = "This page is past the last stock.";

/** registers.outage (section 7.1): the register list's own outage, never the notice feed's. */
const REGISTERS_OUTAGE_COPY =
  "The registers could not be read just now. Nothing here is missing from the register: this is our end.";

/** bar.caption (section 7): the four sums are what the notices disclose, said under the table on every width. */
const BAR_CAPTION = "What the notices disclose, each interest counted once; not a share of the company.";

const SHORT_LABELS: Readonly<Record<number, string>> = {
  0: "Any",
  1: "1% or more",
  3: "3% or more",
  5: "5% or more",
  10: "10% or more",
};

const FIELD_LABEL = "text-[10px] uppercase tracking-wide text-muted-foreground";

/** The link's own parameters for this list. Anything else in the link is left alone. */
const REGISTER_PARAMS = ["sort", "dir", "industry", "kind", "short", "q", "offset"] as const;

/* ----------------------------------------------------------------- helpers */

/** The link a query is written as: the key the island compares, so a link it wrote is never asked again. */
function keyOf(query: RegistersQuery): string {
  return serialiseRegisterParams(query).toString();
}

/**
 * The industries an answer listed, for the link's industry check. None when the
 * answer lists none, so the link's industry is kept and the API decides it.
 */
function industriesOf(page: RegistersPage): ReadonlySet<string> | undefined {
  return page.industries.length > 0
    ? new Set(page.industries.map((entry) => entry.industry))
    : undefined;
}

/** Writes a query into the link: the list's own parameters are replaced and nothing else is touched. */
function writeLink(query: RegistersQuery): void {
  const url = new URL(window.location.href);
  for (const name of REGISTER_PARAMS) url.searchParams.delete(name);
  serialiseRegisterParams(query).forEach((value, name) => url.searchParams.set(name, value));
  // A null state, never the current one: Next stamps its own entries with a
  // marker (__NA), and a replaceState that carries it skips the router's update,
  // so useSearchParams would not follow the link (Next 14.2 app-router).
  window.history.replaceState(null, "", url);
}

/* ------------------------------------------------------------------ state */

type Status = "idle" | "loading" | "error";

interface RegistersState {
  /** The last answer written to the screen. Its rows belong to `page.query`. */
  page: RegistersPage;
  /** What the controls hold: the query in flight, or the one on the screen. */
  controls: RegistersQuery;
  status: Status;
  /** True once a request has been in flight for OUTAGE_AFTER_MS. */
  slow: boolean;
}

function initialState(page: RegistersPage, controls: RegistersQuery, status: Status): RegistersState {
  return { page, controls, status, slow: false };
}

/* ------------------------------------------------------------------ pieces */

interface RegistersViewProps {
  state: RegistersState;
  basePath: string;
  /** Absent in the server's fallback, where the short filter and the pager draw but do nothing until the island takes over. */
  onShortChange?: (value: number) => void;
  onPage?: (offset: number) => void;
}

/** The register list as the reader sees it. The island and the server's fallback draw this same markup. */
function RegistersView({ state, basePath, onShortChange, onPage }: RegistersViewProps) {
  const id = useId();
  const { page, controls, status, slow } = state;
  const busy = status === "loading";
  // The screen holds an answer only once a read has answered. A shell holds none: no count, no zero.
  const answered = page.ok;
  // An error, or an answer the server never read: both are outages, never an empty list.
  const failed = status === "error" || (status === "idle" && !answered);
  const showNotice = failed || slow;
  // A failed read's rows belong to a query the controls no longer show, so they are not drawn.
  const rows = failed ? [] : page.rows;
  const empty = status === "idle" && answered && page.rows.length === 0;
  const { offset, limit } = page.query;
  const hasPrevious = offset > 0;
  const hasNext = offset + page.rows.length < page.total;
  // A request in flight with no rows on screen has nothing to dim, so the wait is said in the list's place.
  const loading = busy && rows.length === 0;
  const pastEnd = empty && page.total > 0;

  /** A chip's link: the controls as they stand, with this one value changed and the first page asked for. */
  const chip = (patch: Partial<RegistersQuery>) =>
    hrefWith(basePath, serialiseRegisterParams({ ...controls, ...patch, offset: 0 }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <span id={`${id}-industry`} className={FIELD_LABEL}>
            Industry
          </span>
          <div role="group" aria-labelledby={`${id}-industry`} className="flex flex-wrap gap-1.5">
            <FilterChip href={chip({ industry: "" })} active={controls.industry === ""} label="All industries" />
            {/* ASX's placeholder industries ("Not Applic", "Class Pend") are no filter a reader
                would ask for: their stocks stay in the list under "All industries" with n/a. */}
            {page.industries
              .filter((entry) => industryLabel(entry.industry) !== "")
              .map((entry) => (
                <FilterChip
                  key={entry.industry}
                  href={chip({ industry: entry.industry })}
                  active={controls.industry === entry.industry}
                  label={industryLabel(entry.industry)}
                  count={entry.stocks}
                />
              ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <span id={`${id}-kind`} className={FIELD_LABEL}>
            Kind
          </span>
          <div role="group" aria-labelledby={`${id}-kind`} className="flex flex-wrap gap-1.5">
            <FilterChip href={chip({ kind: "" })} active={controls.kind === ""} label="All kinds" />
            {KIND_ORDER.map((kind) => (
              <FilterChip
                key={kind}
                href={chip({ kind })}
                active={controls.kind === kind}
                label={kindInfo(kind).label}
                kind={kind}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Short</span>
          <select
            id={`${id}-short`}
            className={POLITICS_SELECT_CLASS}
            value={String(controls.minShortPct)}
            onChange={(e) => onShortChange?.(Number(e.target.value))}
          >
            {REGISTER_SHORT_STEPS.map((step) => (
              <option key={step} value={step}>
                {SHORT_LABELS[step]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {controls.query !== "" ? (
        <div className="flex flex-wrap gap-1.5">
          {/*
            The list's search text. No control sets it, so this chip shows it, and clicking the chip takes it away. Its
            accessible name starts with the visible text, so a voice-control reader can say what they see (WCAG 2.5.3).
          */}
          <FilterChip
            href={chip({ query: "" })}
            active
            label={`Matching "${controls.query}"`}
            clearName={`Matching "${controls.query}", clear search`}
          />
        </div>
      ) : null}

      {showNotice ? (
        <p
          role="status"
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
        >
          {REGISTERS_OUTAGE_COPY}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div aria-busy={busy} className={cn(busy && "opacity-60")}>
          <RegisterRowsTable
            rows={rows}
            query={controls}
            basePath={basePath}
            caption="ASX substantial holder registers by stock"
          />
          <p className="mt-2 text-[11px] text-muted-foreground">{BAR_CAPTION}</p>
        </div>
      ) : loading ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading"
          className="flex min-h-[10rem] items-center justify-center rounded-md border border-dashed p-3 text-sm text-muted-foreground"
        >
          {LOADING_COPY}
        </div>
      ) : null}

      {empty && !pastEnd ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{EMPTY_COPY}</p>
      ) : null}

      {pastEnd ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {PAST_END_COPY}{" "}
          <Link
            href={chip({})}
            replace
            scroll={false}
            prefetch={false}
            rel="nofollow"
            className="text-primary underline-offset-4 hover:underline"
          >
            First page
          </Link>
        </p>
      ) : null}

      {answered && !failed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span role="status" className="tabular-nums">
            {rows.length === 0
              ? `${page.total.toLocaleString("en-AU")} stocks`
              : `${offset + 1}–${offset + rows.length} of ${page.total.toLocaleString("en-AU")} stocks`}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={!hasPrevious || busy || !onPage}
              onClick={() => onPage?.(Math.max(0, offset - limit))}
              className={POLITICS_PAGER_BUTTON_CLASS}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!hasNext || busy || !onPage}
              onClick={() => onPage?.(offset + limit)}
              className={POLITICS_PAGER_BUTTON_CLASS}
            >
              Next
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- island */

/**
 * The live list: the controls, the link and the requests. Mounted under the
 * Suspense boundary, so it reads the link only after the server's default view
 * is on the screen.
 */
function LiveRegisters({ initial, loadPage, basePath }: RegistersExplorerProps) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const [state, setState] = useState<RegistersState>(() => {
    const first = parseRegisterParams(new URLSearchParams(search), { industries: industriesOf(initial) });
    return initialState(
      initial,
      first,
      initial.ok === false || keyOf(first) !== keyOf(initial.query) ? "loading" : "idle",
    );
  });

  const sequence = useRef(0);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The key of the query this screen was last asked for. A change the reader makes moves it first,
  // so the link update that follows is not a second request.
  const askedKey = useRef<string | null>(null);
  // The last answer written to the screen. A link is checked against its industries when the link
  // changes; an answer's arrival alone never re-reads the link, so a stale link cannot re-ask a query.
  const shown = useRef<RegistersPage>(initial);

  const run = useCallback(
    (next: RegistersQuery) => {
      const ticket = (sequence.current += 1);
      clearTimeout(slowTimer.current);
      slowTimer.current = setTimeout(() => {
        if (sequence.current === ticket) setState((s) => ({ ...s, slow: true }));
      }, OUTAGE_AFTER_MS);
      setState((s) => ({ ...s, controls: next, status: "loading", slow: false }));
      const settle = (update: (s: RegistersState) => RegistersState) => {
        if (sequence.current !== ticket) return;
        clearTimeout(slowTimer.current);
        setState(update);
      };
      loadPage(next).then(
        (result) => {
          if (sequence.current === ticket && result.ok) shown.current = result;
          settle((s) =>
            result.ok
              ? { ...s, status: "idle", slow: false, controls: result.query, page: result }
              : { ...s, status: "error", slow: false },
          );
        },
        () => settle((s) => ({ ...s, status: "error", slow: false })),
      );
    },
    [loadPage],
  );

  // Leaving the screen ends the wait: no outage timer outlives the island, and a request
  // that settles after it writes nothing (the sequence has moved on). The asked key goes
  // too: under StrictMode the island mounts, unmounts and mounts again, and the second
  // mount must ask again, or the request the first one started is dropped and the list
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
    // The link as the API serves it, checked against the industries on screen.
    const asked = parseRegisterParams(new URLSearchParams(search), { industries: industriesOf(shown.current) });
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
  }, [search, initial, run]);

  const commit = useCallback(
    (next: RegistersQuery) => {
      askedKey.current = keyOf(next);
      writeLink(next);
      run(next);
    },
    [run],
  );

  const onShortChange = (value: number) => {
    commit({ ...state.controls, minShortPct: value, offset: 0 });
  };

  const onPage = (offset: number) => {
    commit({ ...state.controls, offset });
  };

  return (
    <RegistersView
      state={state}
      basePath={basePath}
      onShortChange={onShortChange}
      onPage={onPage}
    />
  );
}

/**
 * The register list. The default view is the Suspense fallback, drawn from the
 * same props, so the server HTML is the default view and the island takes over
 * once it has read the link.
 */
export function RegistersExplorer(props: RegistersExplorerProps) {
  // A shell is drawn as loading, so the server HTML says nothing it has not read.
  const fallbackStatus: Status = props.initial.ok === false ? "loading" : "idle";
  return (
    <Suspense
      fallback={
        <RegistersView
          state={initialState(props.initial, props.initial.query, fallbackStatus)}
          basePath={props.basePath}
        />
      }
    >
      <LiveRegisters {...props} />
    </Suspense>
  );
}
