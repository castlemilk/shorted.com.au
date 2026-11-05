"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import { StrategyLevelsChart } from "~/@/components/strategy/strategy-levels-chart-loader";
import { EvidencePanel } from "~/@/components/strategies/evidence-panel";
import { SignalsMatrix } from "~/@/components/strategies/signals-matrix";
import { SignalsProvenance } from "~/@/components/strategies/signals-provenance";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { sectionTitle } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";
import {
  notEvaluatedCopy,
  pickFromStockFit,
} from "~/@/lib/strategies/evidence";
import {
  FILTER_LABELS,
  chipFilters,
  countLine,
  coreRules,
  filterCount,
  matchesFilter,
  parseSelection,
  rankingInputsFor,
  signInPromptCopy,
  type SignalFilter,
  type SignalRule,
} from "~/@/lib/strategies/signals";
import {
  PICK_SORTS,
  sortPickRows,
  type PickSortKey,
} from "~/@/lib/strategies/sort";
import type {
  MarketRegimeView,
  PickRow,
  StatusCountsView,
  StrategyVersionDef,
} from "~/@/lib/strategies/types";
import type { StockStrategyFit } from "~/app/actions/getStockStrategyFit";
import { getSignalStockFit } from "~/app/actions/getSignalStockFit";
import type { ViewerSignalsResult } from "~/app/actions/strategies/viewer";
import { readSignalsOnce } from "./signals-read-cache";

/** Rows drawn per step for a signed-in viewer; the list is never drawn whole. */
const SHOW_STEP = 50;
/** The API's page: the rows a signed-in mount reads. */
const HEAD_ROWS = 100;

/**
 * The Signals tab's client island: the strategy select, the status chips (their
 * counts from the API), the stock-by-rule matrix and the evidence panel for the
 * selected stock. The selection is `?sel=stock:<CODE>`, read client-side under
 * its own <Suspense> so the static HTML is the same shell for every visitor.
 *
 * Only the stock code is sent to the server: the evidence (the stock's fit and
 * its prices) comes from getSignalStockFit, the public read the stock page uses.
 *
 * A signed-in viewer gets the first page of the list at mount. The whole list is
 * read only when they search, filter, sort or draw past that page, and it is then
 * sorted in the browser, with filters and a search over it. A read is held for a
 * minute (signals-read-cache), so returning to the tab costs no call.
 * Anonymous visitors get the top rows and a sign-in prompt: the last row, and
 * the same prompt inline wherever they use a filter, the sort or the search.
 * While the session loads the controls are disabled and the prompt row keeps
 * its place, so the ISR HTML and the first paint match.
 */
export interface SignalsIslandProps {
  slug: string;
  strategyName: string;
  /** False when the picks read failed; the tab says so instead of an empty list. */
  available: boolean;
  rules: SignalRule[];
  /** The anonymous visitor's rows: the top of the ranked list, in rank order. */
  rows: PickRow[];
  counts: StatusCountsView | null;
  total: number;
  asOf: string;
  /** YYYY-MM-DD of the session the picks are as at. */
  sessionDate?: string;
  shortReportDate?: string;
  shortAvailableDate?: string;
  stale: boolean;
  version?: StrategyVersionDef;
  regime: MarketRegimeView | null;
  universeLabel: string;
  strategies: Array<{ id: string; label: string }>;
}

export function SignalsIsland(props: SignalsIslandProps) {
  return (
    <Suspense fallback={<SignalsView {...props} initialSelected={null} />}>
      <QuerySignalsView {...props} />
    </Suspense>
  );
}

function QuerySignalsView(props: SignalsIslandProps) {
  const searchParams = useSearchParams();
  return (
    <SignalsView
      {...props}
      initialSelected={parseSelection(searchParams?.get("sel"))}
    />
  );
}

type FitState = { code: string; fit: StockStrategyFit | null } | null;

/** A signed-in read as it answered, for the stock list it was read for. */
type ReadState = { slug: string; result: ViewerSignalsResult } | null;
type FullList = Extract<ViewerSignalsResult, { ok: true }>;

/** The sign-in link's lead words; the rest of the prompt copy follows them. */
const SIGN_IN_LEAD = "Sign in free";

function SignInPrompt({
  slug,
  counts,
  total,
  wholeOnScreen = false,
}: {
  slug: string;
  counts: SignalsIslandProps["counts"];
  total: number;
  /** True when every signal is already drawn: the prompt names the controls, not more rows. */
  wholeOnScreen?: boolean;
}) {
  const copy = wholeOnScreen
    ? "Sign in free to filter, sort and search these signals."
    : signInPromptCopy(counts, total);
  const callbackUrl = `/strategies/${slug}/signals`;
  return (
    <>
      <Link
        href={`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`}
        prefetch={false}
        className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
      >
        {SIGN_IN_LEAD}
      </Link>
      {copy.slice(SIGN_IN_LEAD.length)}
    </>
  );
}

function sortKeyFrom(value: string): PickSortKey | null {
  return PICK_SORTS.find((sort) => sort.key === value)?.key ?? null;
}

const CONTROL =
  "h-8 rounded-md border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function SignalsView({
  initialSelected,
  ...props
}: SignalsIslandProps & { initialSelected: string | null }) {
  const { data: session, status } = useSession();
  // "loading" until the session is known. The ISR HTML and the first paint are
  // the anonymous view: the prompt row is drawn meanwhile, and the controls wait.
  const pending = status === "loading";
  const signedIn = status === "authenticated";
  const userId = session?.user?.id ?? null;

  const [filter, setFilter] = useState<SignalFilter>("all");
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [fitState, setFitState] = useState<FitState>(null);
  const [sortKey, setSortKey] = useState<PickSortKey | null>(null);
  const [query, setQuery] = useState("");
  const [gated, setGated] = useState(false);
  const [head, setHead] = useState<ReadState>(null);
  const [deep, setDeep] = useState<ReadState>(null);
  const [shown, setShown] = useState(SHOW_STEP);
  // Raised by the controls to ask for the whole list again after a failed read.
  const [deepAttempt, setDeepAttempt] = useState(0);

  const needle = query.trim().toLowerCase();
  const sessionDate = props.sessionDate ?? "";
  const rulesHash = props.version?.rulesHash ?? "";
  // A read is drawn only with the rule columns and provenance of this page: the
  // same session and rules version. Another snapshot reads as a mismatch.
  const settle = (result: ViewerSignalsResult): ViewerSignalsResult =>
    result.ok &&
    (result.snapshot.sessionDate !== sessionDate ||
      (result.snapshot.version?.rulesHash ?? "") !== rulesHash)
      ? { ok: false, reason: "snapshot-mismatch" }
      : result;

  // The first page, at mount. The list's rule columns and provenance come from
  // this page, so a read from another session or rules version is never drawn.
  useEffect(() => {
    if (!signedIn || userId === null || !props.available) return;
    let live = true;
    const slug = props.slug;
    readSignalsOnce({
      userId,
      strategyId: slug,
      sessionDate,
      rulesHash,
      full: false,
    })
      .then((result) => {
        if (live) setHead({ slug, result });
      })
      .catch(() => {
        if (live)
          setHead({ slug, result: { ok: false, reason: "unavailable" } });
      });
    return () => {
      live = false;
    };
  }, [signedIn, userId, props.available, props.slug, sessionDate, rulesHash]);

  const headRead =
    signedIn && head?.slug === props.slug ? settle(head.result) : null;
  const headOk = headRead?.ok ? headRead : null;
  const headWhole = headOk !== null && headOk.rows.length >= headOk.totalCount;
  // The whole list is needed for a filter, a search, a sort, or a draw past the
  // first page. A sort runs in the browser over the whole list.
  const wantDeep =
    signedIn &&
    props.available &&
    !headWhole &&
    (filter !== "all" ||
      needle !== "" ||
      sortKey !== null ||
      shown > HEAD_ROWS);

  // The whole list is asked for at most once per mount for a slug and snapshot.
  // Turning a filter, the search or the sort off and on again draws the list
  // already held, and a read still in flight is not asked for twice. A read
  // that failed is asked again the next time the viewer shows more, filters,
  // searches or sorts (retryDeep raises deepAttempt, the effect's only other
  // trigger). The result is kept whether or not the controls still want it:
  // deepRead checks the slug and snapshot it was read for before drawing it.
  const deepKey = `${props.slug}|${sessionDate}|${rulesHash}`;
  const deepAsked = useRef<string | null>(null);

  useEffect(() => {
    if (!wantDeep || userId === null || deepAsked.current === deepKey) return;
    deepAsked.current = deepKey;
    const slug = props.slug;
    const forget = () => {
      deepAsked.current = null;
    };
    readSignalsOnce({
      userId,
      strategyId: slug,
      sessionDate,
      rulesHash,
      full: true,
    })
      .then((result) => {
        if (!result.ok) forget();
        setDeep({ slug, result });
      })
      .catch(() => {
        forget();
        setDeep({ slug, result: { ok: false, reason: "unavailable" } });
      });
  }, [
    wantDeep,
    userId,
    props.slug,
    sessionDate,
    rulesHash,
    deepKey,
    deepAttempt,
  ]);

  const deepRead =
    signedIn && deep?.slug === props.slug ? settle(deep.result) : null;
  const deepOk = deepRead && deepRead.ok ? deepRead : null;
  const deepFailed = deepRead !== null && !deepRead.ok;
  // The signed-in list drawn: the whole list once it has landed, else the first page.
  const list: FullList | null = deepOk ?? headOk;

  let note: string | null = null;
  let signedOutNow = false;
  if (signedIn) {
    const governing = wantDeep ? deepRead : (deepOk ?? headRead);
    const loading = wantDeep
      ? deepRead === null
      : list === null && headRead === null;
    if (governing && !governing.ok) {
      if (governing.reason === "signed-out") signedOutNow = true;
      else if (governing.reason === "snapshot-mismatch")
        note =
          "The full list is from another session or rules version; showing the top rows.";
      else
        note = "The full list is unavailable right now; showing the top rows.";
    } else if (loading) {
      note = "Loading the full list…";
    }
  }

  const pool = useMemo<PickRow[]>(() => {
    if (!list) return props.rows;
    return sortKey ? sortPickRows(list.rows, sortKey) : list.rows;
  }, [list, props.rows, sortKey]);
  const counts = list ? (list.statusCounts ?? props.counts) : props.counts;
  const total = list ? list.totalCount : props.total;
  // The drawn list holds every row of the list (not only the first page).
  const whole = list !== null && list.rows.length >= list.totalCount;

  // Anonymous visitors who reach for a filter, the sort or the search see the
  // sign-in prompt instead; the top rows stay as they are.
  function gate() {
    setGated(true);
  }

  // A signed-in control that narrows or reorders a list read in part asks for
  // the whole list again when its last read failed; the Show more control does
  // the same. The read is cleared so the pane says it is loading.
  function retryDeep() {
    if (!deepFailed) return;
    setDeep(null);
    setDeepAttempt((count) => count + 1);
  }

  const selectedCode = selected ?? pool[0]?.code ?? null;
  const searched = needle
    ? pool.filter(
        (row) =>
          row.code.toLowerCase().includes(needle) ||
          row.name.toLowerCase().includes(needle),
      )
    : pool;
  const visible = searched.filter((row) => matchesFilter(row, filter));
  const drawn = visible.slice(0, shown);
  // Rows still to draw: those of the pool, and (while only the first page is
  // read, and no filter or search narrows the list) the rows not read yet.
  const unread =
    list !== null && !whole && filter === "all" && needle === ""
      ? list.totalCount - pool.length
      : 0;
  const left = visible.length - drawn.length + unread;
  // A count of matches, in the words the chips and the search use.
  const matchNoun = (count: number) =>
    needle
      ? count === 1
        ? "match"
        : "matches"
      : `${FILTER_LABELS[filter].toLowerCase()} ${count === 1 ? "signal" : "signals"}`;
  const core = coreRules(props.rules);
  const rankingInputs = rankingInputsFor(props.slug);
  const chips = chipFilters(counts);
  const filtered = filter !== "all" || needle !== "";
  // Row 11 of the anonymous view: the prompt names every signal, so it also
  // stands in for the count line above the table.
  const footer =
    !signedIn && props.total > props.rows.length ? (
      <SignInPrompt
        slug={props.slug}
        counts={props.counts}
        total={props.total}
      />
    ) : null;

  // The evidence reads the stock's fit: its prices for the chart, and its rules
  // when the list does not hold the stock. A fit for another code is ignored.
  useEffect(() => {
    if (!selectedCode) return;
    let live = true;
    getSignalStockFit(selectedCode)
      .then((fit) => {
        if (live) setFitState({ code: selectedCode, fit });
      })
      .catch(() => {
        if (live) setFitState({ code: selectedCode, fit: null });
      });
    return () => {
      live = false;
    };
  }, [selectedCode]);

  const fit =
    fitState && selectedCode && fitState.code === selectedCode
      ? fitState.fit
      : undefined;
  const listed = pool.find((row) => row.code === selectedCode) ?? null;
  const pick = listed ?? (fit ? pickFromStockFit(fit, props.slug) : null);
  const notice =
    pick === null
      ? fit === undefined
        ? "Loading this stock's reading."
        : fit === null
          ? "This stock's reading is unavailable right now."
          : (notEvaluatedCopy(fit) ??
            `Not in the ${props.strategyName} picks today.`)
      : null;

  function select(code: string) {
    setSelected(code);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("sel", `stock:${code}`);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // The selection still holds on screen without the address bar.
    }
    // Below the lg breakpoint the evidence sits under the whole table: bring it
    // into view (its scroll margin clears the sticky bars). Above it the evidence
    // column is sticky and already in view.
    const media =
      typeof window !== "undefined" ? window.matchMedia?.bind(window) : null;
    const narrow = media?.("(max-width: 1023px)")?.matches === true;
    if (narrow) {
      const still =
        media?.("(prefers-reduced-motion: reduce)")?.matches === true;
      document.getElementById("signals-evidence")?.scrollIntoView?.({
        block: "start",
        behavior: still ? "auto" : "smooth",
      });
    }
  }

  function changeFilter(chip: SignalFilter) {
    if (signedIn || chip === "all") {
      retryDeep();
      setFilter(chip);
      setShown(SHOW_STEP);
    } else {
      gate();
    }
  }

  return (
    <div className="flex flex-col gap-6" data-signals-tab={props.slug}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className={sectionTitle}>Find the stocks meeting your rules</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A stock triggers when every core rule passes. Unknown never counts
              as passing. Evaluated each session
              {props.universeLabel ? ` · ${props.universeLabel}` : ""}.
            </p>
          </div>
          <nav aria-label="Strategies">
            <ul className="flex flex-wrap gap-1.5 text-xs">
              {props.strategies.map((strategy) => {
                const active = strategy.id === props.slug;
                return (
                  <li key={strategy.id}>
                    <Link
                      href={`/strategies/${strategy.id}/signals`}
                      prefetch={false}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "inline-flex h-8 items-center rounded-md border px-2.5 font-medium transition-colors",
                        active
                          ? "border-primary/60 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-input hover:text-foreground",
                      )}
                    >
                      {strategy.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
        <SignalsProvenance
          asOf={props.asOf}
          shortReportDate={props.shortReportDate}
          shortAvailableDate={props.shortAvailableDate}
          version={props.version}
          stale={props.stale}
          regime={props.regime}
        />
      </div>

      {!props.available ? (
        <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
          Signals for this strategy are temporarily unavailable; they refresh
          automatically. Not financial advice.
        </section>
      ) : pool.length === 0 ? (
        <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
          No stock in the universe meets {props.strategyName}&apos;s rules in
          this session&apos;s data. Not financial advice.
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Filter by status"
                className="flex flex-wrap items-center gap-1 rounded-md border p-0.5"
              >
                {chips.map((chip) => {
                  const count = filterCount(chip, counts, total);
                  const pressed = filter === chip;
                  return (
                    <button
                      key={chip}
                      type="button"
                      aria-pressed={pressed}
                      disabled={pending}
                      onClick={() => changeFilter(chip)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                        pressed
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                    >
                      {FILTER_LABELS[chip]}
                      {count !== null ? (
                        <span className="tabular-nums opacity-80">{count}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <input
                type="search"
                aria-label="Search stock"
                placeholder="Search stock (e.g. WTC, BHP)"
                value={query}
                disabled={pending}
                onChange={(event) => {
                  if (!signedIn) {
                    gate();
                    return;
                  }
                  retryDeep();
                  setQuery(event.target.value);
                  setShown(SHOW_STEP);
                }}
                className={cn(CONTROL, "w-44")}
              />
              <select
                aria-label="Sort signals"
                value={sortKey ?? ""}
                disabled={pending}
                onChange={(event) => {
                  if (!signedIn) {
                    gate();
                    return;
                  }
                  retryDeep();
                  setSortKey(sortKeyFrom(event.target.value));
                  setShown(SHOW_STEP);
                }}
                className={CONTROL}
              >
                <option value="">Rank order</option>
                {PICK_SORTS.map((sort) => (
                  <option key={sort.key} value={sort.key}>
                    {sort.label}
                  </option>
                ))}
              </select>
            </div>

            {(gated && !signedIn) || signedOutNow ? (
              <p
                role="status"
                data-signals-gate
                className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground"
              >
                <SignInPrompt
                  slug={props.slug}
                  counts={props.counts}
                  total={props.total}
                  wholeOnScreen={props.total <= props.rows.length}
                />
              </p>
            ) : null}

            {visible.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                {needle
                  ? `No ${filter === "all" ? "" : `${FILTER_LABELS[filter].toLowerCase()} `}stock matches that search.`
                  : `No ${FILTER_LABELS[filter].toLowerCase()} stock in this list.`}
              </p>
            ) : (
              <>
                <SignalsMatrix
                  rows={drawn}
                  rules={core}
                  rankingInputs={rankingInputs}
                  selected={selectedCode}
                  sortKey={sortKey}
                  onSelect={select}
                  caption={`${props.strategyName}: stocks by rule`}
                  footer={footer}
                />
                {left > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      retryDeep();
                      setShown((count) => count + SHOW_STEP);
                    }}
                    className="self-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50"
                  >
                    Show {Math.min(SHOW_STEP, left)} more · {left} left
                  </button>
                ) : null}
              </>
            )}

            {filtered || footer === null || note !== null ? (
              <p className="text-xs text-muted-foreground" data-signals-count>
                {filtered
                  ? whole
                    ? visible.length === 0
                      ? `0 ${matchNoun(0)}`
                      : `Showing ${drawn.length} of ${visible.length} ${matchNoun(visible.length)}`
                    : needle && filter === "all"
                      ? `${visible.length} ${visible.length === 1 ? "match" : "matches"} in the top ${pool.length}`
                      : `${visible.length} ${FILTER_LABELS[filter].toLowerCase()} in the top ${pool.length}`
                  : countLine(counts, drawn.length, total)}
                {note ? ` · ${note}` : ""}
              </p>
            ) : null}

            <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {rankingInputs.length > 0 ? "* Ranking inputs · " : ""}
                Unknown never counts as passing
              </span>
              <span className="italic">
                A strategy score is rule fit, not probability.
              </span>
            </p>
          </div>

          <div
            id="signals-evidence"
            className="min-w-0 scroll-mt-[124px] lg:sticky lg:top-[124px] lg:max-h-[calc(100vh-140px)] lg:self-start lg:overflow-y-auto"
          >
            <EvidencePanel
              code={selectedCode ?? ""}
              name={listed?.name ?? ""}
              pick={pick}
              rules={props.rules}
              notice={notice}
              openHref={
                selectedCode ? stockTabHref(selectedCode, "strategy") : null
              }
              chart={
                selectedCode ? (
                  <StrategyLevelsChart
                    key={selectedCode}
                    stockCode={selectedCode}
                    fits={fit?.fits ?? []}
                    priceFeatures={fit?.priceFeatures ?? null}
                    initialStrategyId={props.slug}
                    hideSelector
                    keepVolumeOnNarrow
                    tagLastClose
                  />
                ) : null
              }
            />
            <p className="mt-3 text-xs text-muted-foreground">
              <Link
                href="/disclaimer"
                className="font-medium text-foreground hover:underline"
              >
                Not financial advice
              </Link>
              . Hypothetical rule results from published data, not a record of
              trading.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
