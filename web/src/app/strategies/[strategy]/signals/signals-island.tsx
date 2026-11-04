"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { StrategyLevelsChart } from "~/@/components/strategy/strategy-levels-chart-loader";
import { EvidencePanel } from "~/@/components/strategies/evidence-panel";
import { SignalsMatrix } from "~/@/components/strategies/signals-matrix";
import { SignalsProvenance } from "~/@/components/strategies/signals-provenance";
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
  type SignalFilter,
  type SignalRule,
} from "~/@/lib/strategies/signals";
import type {
  MarketRegimeView,
  PickRow,
  StatusCountsView,
  StrategyVersionDef,
} from "~/@/lib/strategies/types";
import type { StockStrategyFit } from "~/app/actions/getStockStrategyFit";
import { getSignalStockFit } from "~/app/actions/getSignalStockFit";

/**
 * The Signals tab's client island: the strategy select, the status chips (their
 * counts from the API), the stock-by-rule matrix and the evidence panel for the
 * selected stock. The selection is `?sel=stock:<CODE>`, read client-side under
 * its own <Suspense> so the static HTML is the same shell for every visitor.
 *
 * Only the stock code is sent to the server: the evidence (the stock's fit and
 * its prices) comes from getSignalStockFit, the public read the stock page uses.
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

function SignalsView({
  initialSelected,
  ...props
}: SignalsIslandProps & { initialSelected: string | null }) {
  const router = useRouter();
  const [filter, setFilter] = useState<SignalFilter>("all");
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [fitState, setFitState] = useState<FitState>(null);

  const rows = props.rows;
  const selectedCode = selected ?? rows[0]?.code ?? null;
  const visible = rows.filter((row) => matchesFilter(row, filter));
  const core = coreRules(props.rules);
  const rankingInputs = rankingInputsFor(props.slug);
  const chips = chipFilters(props.counts);

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
  const listed = rows.find((row) => row.code === selectedCode) ?? null;
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
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Strategy</span>
            <select
              value={props.slug}
              onChange={(event) =>
                router.push(`/strategies/${event.target.value}/signals`)
              }
              className="h-9 rounded-md border border-input bg-background px-2 text-sm font-medium"
            >
              {props.strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.label}
                </option>
              ))}
            </select>
          </label>
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
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <div className="flex min-w-0 flex-col gap-3">
            <div
              role="group"
              aria-label="Filter by status"
              className="flex flex-wrap items-center gap-1 rounded-md border p-0.5"
            >
              {chips.map((chip) => {
                const count = filterCount(chip, props.counts, props.total);
                const pressed = filter === chip;
                return (
                  <button
                    key={chip}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setFilter(chip)}
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

            {visible.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No stock in the top {rows.length} is{" "}
                {FILTER_LABELS[filter].toLowerCase()}
                {props.counts
                  ? `; the list holds ${filterCount(filter, props.counts, props.total) ?? 0} in all`
                  : ""}
                .
              </p>
            ) : (
              <SignalsMatrix
                rows={visible}
                rules={core}
                rankingInputs={rankingInputs}
                selected={selectedCode}
                onSelect={select}
                caption={`${props.strategyName}: stocks by rule`}
              />
            )}

            <p className="text-xs text-muted-foreground" data-signals-count>
              {countLine(props.counts, rows.length, props.total)}
            </p>

            <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {rankingInputs.length > 0
                  ? "* Ranking inputs · "
                  : "* Ranking inputs are not used by this strategy · "}
                Unknown never counts as passing
              </span>
              <span className="italic">
                A strategy score is rule fit, not probability.
              </span>
            </p>
          </div>

          <div className="min-w-0">
            <EvidencePanel
              code={selectedCode ?? ""}
              name={listed?.name ?? ""}
              pick={pick}
              rules={props.rules}
              notice={notice}
              openHref={`/shorts/${selectedCode ?? ""}/strategy`}
              chart={
                selectedCode ? (
                  <StrategyLevelsChart
                    key={selectedCode}
                    stockCode={selectedCode}
                    fits={fit?.fits ?? []}
                    priceFeatures={fit?.priceFeatures ?? null}
                    initialStrategyId={props.slug}
                    hideSelector
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
