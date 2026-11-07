"use client";

import { Suspense, useEffect, useState, useTransition, type ReactNode } from "react";
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
import { nextDay } from "~/@/lib/strategies/backtest-series";
import {
  APPROXIMATE_CHIP,
  GROWTH_TITLE,
  GROWTH_UNIT,
  HYPOTHETICAL_COPY,
  RETURN_BASIS_COPY,
  inSampleChip,
} from "~/@/lib/strategies/backtest-copy";
import { coverageChip, fragileChips } from "~/@/lib/strategies/backtest-tables";
import type {
  BacktestRunView,
  PaperTrackView,
  SeriesPointView,
} from "~/@/lib/strategies/map-backtest";
import { sectionTitle } from "~/@/lib/typography";
import { loadBacktestSeries } from "~/app/actions/strategies/backtestSeries";

type Resolution = "weekly" | "daily";

export interface BacktestPanelProps {
  strategyId: string;
  /** The published run of the live version (state "published" or "approximate"). */
  run: BacktestRunView;
  /** The strategy's universe, as the registry states it (StrategyMetadata.universe). */
  universe: string;
  /** The monthly returns, coverage and the rest of the left column, rendered on the server. */
  main: ReactNode;
  /** The right column below the run summary: assumptions, the recipe link and the callouts. */
  sidebar: ReactNode;
}

/** A served series, keyed by what was asked for. */
interface SeriesState {
  window: BacktestWindowId;
  resolution: Resolution;
  series: SeriesPointView[];
  served: string;
}

/**
 * The Backtest tab's interactive core: the window (in the URL, `?window=`), the
 * resolution and the growth chart beside its run summary. The API serves a series per
 * window, so changing the window asks for that window's series. Everything else on the
 * page is server-rendered into the HTML and passed in as `main` and `sidebar`.
 *
 * The window is read under a Suspense boundary whose fallback is the default window, so
 * the first HTML already shows the since-May-2019 figures.
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
  universe,
  main,
  sidebar,
  windowId,
}: BacktestPanelProps & { windowId: BacktestWindowId }) {
  const served: BacktestWindowId =
    (run.windowId as BacktestWindowId) || DEFAULT_BACKTEST_WINDOW;
  const [resolution, setResolution] = useState<Resolution>("weekly");
  const [cache, setCache] = useState<SeriesState | null>(null);
  const [pending, startTransition] = useTransition();

  const identity = run.identity;
  const liveFrom = identity?.inSampleUntil ? nextDay(identity.inSampleUntil) : "";
  const benchmarkName = identity?.benchmark ? identity.benchmark : "S&P/ASX 200 Gross Total Return (XJT)";
  const referenceName = identity?.referenceName ? identity.referenceName : "same-data reference";
  const recordedFrom = run.paperStart;

  // The series on screen: the one this window and resolution were served as, else the run's own.
  const current: SeriesState | null =
    cache && cache.window === windowId && cache.resolution === resolution
      ? cache
      : windowId === served && resolution === "weekly"
        ? { window: served, resolution: "weekly", series: run.series, served: run.seriesResolution }
        : null;

  const fetchSeries = (nextWindow: BacktestWindowId, nextResolution: Resolution) => {
    startTransition(async () => {
      const result = await loadBacktestSeries(strategyId, nextResolution, nextWindow);
      if (result) {
        setCache({
          window: nextWindow,
          resolution: nextResolution,
          series: result.series,
          served: result.seriesResolution,
        });
      }
    });
  };

  // A reader who opens ?window= asks for that window's series once the client has read it.
  useEffect(() => {
    if (windowId !== served) fetchSeries(windowId, resolution);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the window is read from the URL once per change.
  }, [windowId]);

  const windows = orderedWindows(run.windows);
  const meta = windows.find((w) => w.window === windowId) ?? windows[0] ?? null;
  const available = windows.filter((w) => w.sessions > 0).map((w) => w.window as BacktestWindowId);
  const series = current?.series ?? [];
  const windowed = meta ? series.filter((p) => !meta.from || p.date >= meta.from) : series;
  const paper: PaperTrackView | null = livePaper(run);
  const chips = [
    liveFrom ? inSampleChip(liveFrom) : "In-sample backtest",
    coverageChip(run.coverageByYear),
    "Hypothetical · after costs",
    run.state === "approximate" ? APPROXIMATE_CHIP : "",
    ...fragileChips(run.sensitivity),
  ].filter(Boolean);

  const setWindow = (next: BacktestWindowId) => {
    // The address follows the choice without a navigation (the page is static); the replaced
    // history entry is the only change, and useSearchParams reads it.
    const url = new URL(window.location.href);
    url.searchParams.set(BACKTEST_WINDOW_PARAM, next);
    window.history.replaceState(window.history.state, "", url);
    if (next !== served || resolution !== "weekly") fetchSeries(next, resolution);
  };

  const choose = (next: Resolution) => {
    setResolution(next);
    if (next === "weekly" && windowId === served) return;
    fetchSeries(windowId, next);
  };

  const servedAs = current?.served ?? run.seriesResolution;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-8">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="font-mono text-xs text-muted-foreground" data-universe>
              Universe: {universe || "as the registry states"}
            </p>
          </div>
          <WindowSelector value={windowId} onChange={setWindow} available={available} label="Window" />
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
                ? "Loading the series"
                : servedAs === "daily"
                  ? "Daily points"
                  : resolution === "daily"
                    ? "Weekly points: daily is served for windows of 500 sessions or fewer"
                    : "Weekly points"}
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
          {current ? (
            <BacktestChart
              series={windowed}
              windowLabel={meta?.label ?? ""}
              liveFrom={liveFrom}
              recordedFrom={recordedFrom}
              engineSegments={run.paperEngineSegments}
              benchmarkName={benchmarkName}
              referenceName={referenceName}
              label={`${GROWTH_TITLE} against ${benchmarkName}`}
            />
          ) : (
            <div aria-busy="true" className="h-[390px] animate-pulse rounded-lg bg-muted/40" />
          )}
          <p className="text-xs text-muted-foreground">{HYPOTHETICAL_COPY}</p>
          <p className="text-xs text-muted-foreground">{RETURN_BASIS_COPY}</p>
        </section>

        {main}
      </div>

      <aside className="min-w-0 space-y-6" aria-label="Run summary">
        <div className="space-y-2">
          <h2 className={sectionTitle}>Run summary</h2>
          <RunSummary window={meta} paper={paper} tradeSummary={run.tradeSummary} referenceName={referenceName} />
        </div>
        {sidebar}
      </aside>
    </div>
  );
}

/**
 * The paper track for the run summary: its real first session (recorded_from), its
 * sessions and closed trades from the live window, and the too-short rule (under 63
 * sessions or 10 closed trades, 5.9). Null when the run carries no track.
 */
function livePaper(run: BacktestRunView): PaperTrackView | null {
  const live = run.windows.find((w) => w.window === "live");
  if (!live || live.sessions === 0 || !run.paperStart) return null;
  return {
    since: nextDay(run.identity?.inSampleUntil ?? ""),
    recordedFrom: run.paperStart,
    sessions: live.sessions,
    closedTrades: live.closedTrades,
    openPositions: 0,
    returnPct: live.totalReturnPct,
    tooShort: live.sessions < 63 || live.closedTrades < 10,
    engineSegments: run.paperEngineSegments,
  };
}
