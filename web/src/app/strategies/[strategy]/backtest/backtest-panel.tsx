"use client";

import { Suspense, useState, useTransition, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { BacktestChart } from "~/@/components/strategies/backtest-chart-loader";
import { IntegrityChips } from "~/@/components/strategies/integrity-chips";
import { RunSummary } from "~/@/components/strategies/run-summary";
import { WindowSelector } from "~/@/components/strategies/window-selector";
import {
  BACKTEST_WINDOW_PARAM,
  DEFAULT_BACKTEST_WINDOW,
  orderedWindows,
  windowFromParam,
  type BacktestWindowId,
} from "~/@/lib/strategies/backtest-windows";
import {
  seriesInWindow,
  nextDay,
} from "~/@/lib/strategies/backtest-series";
import {
  APPROXIMATE_CHIP,
  GROWTH_TITLE,
  GROWTH_UNIT,
  HYPOTHETICAL_COPY,
  RETURN_BASIS_COPY,
  inSampleChip,
} from "~/@/lib/strategies/backtest-copy";
import {
  coverageChip,
  fragileChips,
} from "~/@/lib/strategies/backtest-tables";
import type {
  BacktestRunView,
  SeriesPointView,
} from "~/@/lib/strategies/map-backtest";
import { sectionTitle } from "~/@/lib/typography";
import { loadBacktestSeries } from "~/app/actions/strategies/backtestSeries";

type Resolution = "weekly" | "daily";

export interface BacktestPanelProps {
  strategyId: string;
  /** The published run of the live version (state "published" or "approximate"). */
  run: BacktestRunView;
  /** The monthly returns, the coverage and the rest of the left column, rendered on the server. */
  main: ReactNode;
  /** The right column below the run summary: the assumptions, the recipe link, the callouts. */
  sidebar: ReactNode;
}

/**
 * The Backtest tab's interactive core: the window (in the URL, `?window=`), the
 * Daily/Weekly resolution and the growth chart beside its run summary. Everything
 * else on the page is server-rendered into the HTML and passed in as `main` and
 * `sidebar`, so the figures are in the first response.
 *
 * The window is read under a Suspense boundary, and the boundary's fallback is the
 * default window, so the first HTML already shows the since-May-2019 figures and
 * a reader who opens `?window=` sees that window once the client has read the URL.
 */
export function BacktestPanel(props: BacktestPanelProps) {
  return (
    <Suspense fallback={<PanelBody {...props} windowId={DEFAULT_BACKTEST_WINDOW} />}>
      <WindowFromUrl {...props} />
    </Suspense>
  );
}

function WindowFromUrl(props: BacktestPanelProps) {
  const params = useSearchParams();
  const windowId = windowFromParam(params.get(BACKTEST_WINDOW_PARAM));
  return <PanelBody {...props} windowId={windowId} />;
}

function PanelBody({
  strategyId,
  run,
  main,
  sidebar,
  windowId,
}: BacktestPanelProps & { windowId: BacktestWindowId }) {
  const [resolution, setResolution] = useState<Resolution>("weekly");
  const [daily, setDaily] = useState<{ series: SeriesPointView[]; resolution: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const identity = run.identity;
  const liveFrom = identity?.inSampleUntil ? nextDay(identity.inSampleUntil) : "";
  const benchmarkName = identity?.benchmark ? identity.benchmark : "S&P/ASX 200 Gross Total Return (XJT)";
  const referenceName = identity?.referenceName ? identity.referenceName : "same-data reference";
  const hasReference = run.series.some((p) => p.reference !== null);

  const activeSeries = daily?.series ?? run.series;
  const windows = orderedWindows(run.windows);
  const current = windows.find((w) => w.window === windowId) ?? windows[0] ?? null;
  const windowed = current ? seriesInWindow(activeSeries, current.from, current.to) : [];
  const chips = [
    liveFrom ? inSampleChip(liveFrom) : "In-sample backtest",
    coverageChip(run.coverageByYear),
    "Hypothetical · after costs",
    run.state === "approximate" ? APPROXIMATE_CHIP : "",
    ...fragileChips(run.sensitivity),
  ].filter(Boolean);

  const setWindow = (next: BacktestWindowId) => {
    // The address follows the choice without a navigation: the page is static, so
    // the replaced history entry is the only change, and useSearchParams reads it.
    const url = new URL(window.location.href);
    url.searchParams.set(BACKTEST_WINDOW_PARAM, next);
    window.history.replaceState(window.history.state, "", url);
  };

  const choose = (next: Resolution) => {
    setResolution(next);
    if (next === "weekly") {
      setDaily(null);
      return;
    }
    startTransition(async () => {
      const result = await loadBacktestSeries(strategyId, "daily");
      if (result) setDaily({ series: result.series, resolution: result.seriesResolution });
      else setResolution("weekly");
    });
  };

  const served = daily?.resolution ?? run.seriesResolution ?? "weekly";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-8">
        <div className="space-y-3">
          <WindowSelector
            value={windowId}
            onChange={setWindow}
            available={run.windows.map((w) => w.window as BacktestWindowId)}
            label="Window"
          />
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Series resolution" className="flex gap-1">
              {(["weekly", "daily"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={resolution === option}
                  onClick={() => choose(option)}
                  disabled={pending}
                  className={`rounded-sm border px-2.5 py-1 font-mono text-xs capitalize transition-colors ${
                    resolution === option
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            <span className="font-mono text-[11px] text-muted-foreground" aria-live="polite">
              {pending
                ? "Loading daily points"
                : served === "daily"
                  ? "Daily points"
                  : "Weekly points: daily is served for windows of 500 sessions or fewer"}
            </span>
          </div>
          <IntegrityChips chips={chips} />
        </div>

        <section aria-labelledby="growth-heading" className="space-y-3">
          <div>
            <h2 id="growth-heading" className={sectionTitle}>
              {GROWTH_TITLE}
            </h2>
            <p className="font-mono text-xs text-muted-foreground">{GROWTH_UNIT}</p>
          </div>
          <BacktestChart
            series={windowed}
            windowLabel={current?.label ?? ""}
            liveFrom={liveFrom}
            benchmarkName={benchmarkName}
            referenceName={referenceName}
            hasReference={hasReference}
            label={`${GROWTH_TITLE} against ${benchmarkName}`}
          />
          <p className="text-xs text-muted-foreground">{HYPOTHETICAL_COPY}</p>
          <p className="text-xs text-muted-foreground">{RETURN_BASIS_COPY}</p>
        </section>

        {main}
      </div>

      <aside className="min-w-0 space-y-6" aria-label="Run summary">
        <div className="space-y-2">
          <h2 className={sectionTitle}>Run summary</h2>
          <RunSummary
            window={current}
            paper={livePaper(run)}
            tradeSummary={run.tradeSummary}
            referenceName={referenceName}
          />
        </div>
        {sidebar}
      </aside>
    </div>
  );
}

/**
 * The paper track for the run summary, read from the live window (recorded_tail
 * windows carry it). The summary's out-of-sample row needs its counts, which the
 * run's live window states.
 */
function livePaper(run: BacktestRunView) {
  const live = run.windows.find((w) => w.window === "live");
  if (!live || live.sessions === 0) return null;
  return {
    since: run.identity?.inSampleUntil ? nextDay(run.identity.inSampleUntil) : "",
    sessions: live.sessions,
    closedTrades: live.closedTrades,
    openPositions: 0,
    returnPct: live.totalReturnPct,
    tooShort: live.sessions < 63 || live.closedTrades < 10,
  };
}
