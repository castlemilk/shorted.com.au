"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Suspense, useEffect, useMemo, useState } from "react";

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
import {
  getSignalsForViewer,
  type ViewerSignalsResult,
} from "~/app/actions/strategies/viewer";

/** Rows drawn per step for a signed-in viewer; the list is never drawn whole. */
const SHOW_STEP = 50;

/**
 * The Signals tab's client island: the strategy select, the status chips (their
 * counts from the API), the stock-by-rule matrix and the evidence panel for the
 * selected stock. The selection is `?sel=stock:<CODE>`, read client-side under
 * its own <Suspense> so the static HTML is the same shell for every visitor.
 *
 * Only the stock code is sent to the server: the evidence (the stock's fit and
 * its prices) comes from getSignalStockFit, the public read the stock page uses.
 *
 * A signed-in viewer gets the whole list (getSignalsForViewer), read once in
 * rank order and sorted in the browser, with filters and a search over it.
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

/** The full list as the viewer's read answered it, for the stock list it was read for. */
type FullState = { slug: string; result: ViewerSignalsResult } | null;
type FullList = Extract<ViewerSignalsResult, { ok: true }>;

/** The sign-in link's lead words; the rest of the prompt copy follows them. */
const SIGN_IN_LEAD = "Sign in free";

function SignInPrompt({
  slug,
  counts,
  total,
}: {
  slug: string;
  counts: SignalsIslandProps["counts"];
  total: number;
}) {
  const copy = signInPromptCopy(counts, total);
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
  const { status } = useSession();
  // "loading" until the session is known. The ISR HTML and the first paint are
  // the anonymous view: the prompt row is drawn meanwhile, and the controls wait.
  const pending = status === "loading";
  const signedIn = status === "authenticated";

  const [filter, setFilter] = useState<SignalFilter>("all");
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [fitState, setFitState] = useState<FitState>(null);
  const [sortKey, setSortKey] = useState<PickSortKey | null>(null);
  const [query, setQuery] = useState("");
  const [gated, setGated] = useState(false);
  const [full, setFull] = useState<FullState>(null);
  const [shown, setShown] = useState(SHOW_STEP);

  // Signed-in depth: the whole list in rank order, read once per stock list. A
  // sort is applied in the browser below, so it costs no read.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const slug = props.slug;
    getSignalsForViewer({ strategyId: slug })
      .then((result) => {
        if (live) setFull({ slug, result });
      })
      .catch(() => {
        if (live)
          setFull({ slug, result: { ok: false, reason: "unavailable" } });
      });
    return () => {
      live = false;
    };
  }, [signedIn, props.slug]);

  const loaded = full && full.slug === props.slug ? full.result : null;
  // The full list is drawn only with the rule columns and provenance of this
  // page: the same rules version and the same session.
  const snapshotMatches = (snapshot: FullList["snapshot"]): boolean =>
    snapshot.sessionDate === (props.sessionDate ?? "") &&
    (snapshot.version?.rulesHash ?? "") === (props.version?.rulesHash ?? "");

  let fullList: FullList | null = null;
  let note: string | null = null;
  let signedOutNow = false;
  if (signedIn) {
    if (loaded === null) {
      note = "Loading the full list…";
    } else if (!loaded.ok) {
      if (loaded.reason === "signed-out") signedOutNow = true;
      else
        note = "The full list is unavailable right now; showing the top rows.";
    } else if (!snapshotMatches(loaded.snapshot)) {
      note =
        "The full list is from another session or rules version; showing the top rows.";
    } else {
      fullList = loaded;
    }
  }

  const pool = useMemo<PickRow[]>(() => {
    if (!fullList) return props.rows;
    return sortKey ? sortPickRows(fullList.rows, sortKey) : fullList.rows;
    // fullList is a state-derived value: it changes only when its read lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullList, props.rows, sortKey]);
  const counts = fullList
    ? (fullList.statusCounts ?? props.counts)
    : props.counts;
  const total = fullList ? fullList.totalCount : props.total;

  // Anonymous visitors who reach for a filter, the sort or the search see the
  // sign-in prompt instead; the top rows stay as they are.
  function gate() {
    setGated(true);
  }

  const selectedCode = selected ?? pool[0]?.code ?? null;
  const needle = query.trim().toLowerCase();
  const searched = needle
    ? pool.filter(
        (row) =>
          row.code.toLowerCase().includes(needle) ||
          row.name.toLowerCase().includes(needle),
      )
    : pool;
  const visible = searched.filter((row) => matchesFilter(row, filter));
  const drawn = visible.slice(0, shown);
  const hiddenCount = visible.length - drawn.length;
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
    // into view. Above it the evidence column is sticky and already in view.
    const narrow =
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 1023px)")?.matches === true;
    if (narrow) {
      document
        .getElementById("signals-evidence")
        ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }

  function changeFilter(chip: SignalFilter) {
    if (signedIn || chip === "all") {
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
                  onSelect={select}
                  caption={`${props.strategyName}: stocks by rule`}
                  footer={footer}
                />
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShown((count) => count + SHOW_STEP)}
                    className="self-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50"
                  >
                    Show {Math.min(SHOW_STEP, hiddenCount)} more · {hiddenCount}{" "}
                    left
                  </button>
                ) : null}
              </>
            )}

            {filtered || footer === null || note !== null ? (
              <p className="text-xs text-muted-foreground" data-signals-count>
                {filtered
                  ? fullList
                    ? `Showing ${visible.length} of ${total} signals`
                    : needle && filter === "all"
                      ? `${visible.length} ${visible.length === 1 ? "match" : "matches"} in the top ${pool.length}`
                      : `${visible.length} ${FILTER_LABELS[filter].toLowerCase()} in the top ${pool.length}`
                  : countLine(counts, pool.length, total)}
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
            className="min-w-0 lg:sticky lg:top-24 lg:self-start"
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
