"use client";

// The interactive core of the Backtest tab: the window, the resolution and the growth chart.
//
// It receives only what the client needs (the windows' figures, the served series, the
// chart's marks and the disclosures). The monthly, annual, recipe and data-quality tables
// stay on the server and arrive as `main` and `sidebar`, already rendered.
//
// The window lives in React state, seeded from the URL (?window=). Choosing a window writes
// the URL with replaceState(null, "", url) and asks for that window's series from ONE place:
// the effect below, keyed on (window, resolution). A stale answer is dropped by request id.

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { BacktestChart } from "~/@/components/strategies/backtest-chart-loader";
import { IntegrityChips } from "~/@/components/strategies/integrity-chips";
import { RunSummary } from "~/@/components/strategies/run-summary";
import { WindowSelector } from "~/@/components/strategies/window-selector";
import {
  BACKTEST_WINDOW_PARAM,
  BACKTEST_WINDOWS,
  DEFAULT_BACKTEST_WINDOW,
  windowLabel,
  type BacktestWindowId,
} from "~/@/lib/strategies/backtest-windows";
import {
  GROWTH_TITLE,
  GROWTH_UNIT,
  HYPOTHETICAL_COPY,
  RETURN_BASIS_COPY,
} from "~/@/lib/strategies/backtest-copy";
import type {
  BacktestWindowView,
  EngineSegmentView,
  PaperTrackView,
  SeriesPointView,
} from "~/@/lib/strategies/map-backtest";
import { sectionTitle } from "~/@/lib/typography";
import { loadBacktestSeries } from "~/app/actions/strategies/backtestSeries";

type Resolution = "weekly" | "daily";

/** The daily series is served for windows of at most this many sessions (the API's rule). */
export const DAILY_MAX_SESSIONS = 500;

export interface BacktestPanelProps {
  strategyId: string;
  /** The window the URL names (raw), and the window the served series is for. */
  urlWindow: string;
  served: BacktestWindowId;
  servedSeries: SeriesPointView[];
  windows: BacktestWindowView[];
  /** The universe as a label, with the registry's sentence as its title ("" when unknown: omitted). */
  universeLabel: string;
  universeTitle: string;
  chips: string[];
  /** The freeze line for the in-sample windows, and the recorded line for the live window. */
  frozenChip: string;
  recordedChip: string;
  disclosures: string[];
  liveFrom: string;
  recordedFrom: string;
  engineSegments: EngineSegmentView[];
  coverageMonthly: Array<{ month: string; coveragePct: number | null; measurable: boolean }>;
  coverageLabel: string;
  benchmarkName: string;
  referenceName: string;
  referenceTo: string;
  paper: PaperTrackView | null;
  avgHoldSessions: number | null;
  /** The run's identity line, opening its disclosure (server-rendered). */
  identity: ReactNode;
  main: ReactNode;
  sidebar: ReactNode;
}

interface Series {
  key: string;
  series: SeriesPointView[];
}

export function BacktestPanel(props: BacktestPanelProps) {
  // useSearchParams needs a boundary; the fallback is the served window, so the first HTML
  // already shows the figures, and the URL's window is applied once the client reads it.
  return (
    <Suspense fallback={<PanelBody {...props} initialWindow={props.served} />}>
      <WindowFromUrl {...props} />
    </Suspense>
  );
}

function WindowFromUrl(props: BacktestPanelProps) {
  const params = useSearchParams();
  const urlWindow = params.get(BACKTEST_WINDOW_PARAM) ?? "";
  return <PanelBody {...props} urlWindow={urlWindow} initialWindow={parseWindow(urlWindow, props.windows, props.served)} />;
}

/** The window a query value names when the run carries it, else the run's served window. */
export function parseWindow(
  value: string | null,
  windows: readonly BacktestWindowView[],
  served: BacktestWindowId,
): BacktestWindowId {
  const known = BACKTEST_WINDOWS.find((w) => w.id === value)?.id;
  if (known && windows.some((w) => w.window === known && w.sessions > 0)) return known;
  return served || DEFAULT_BACKTEST_WINDOW;
}

function PanelBody({
  strategyId,
  urlWindow,
  served,
  servedSeries,
  windows,
  universeLabel,
  universeTitle,
  chips,
  frozenChip,
  recordedChip,
  disclosures,
  liveFrom,
  recordedFrom,
  engineSegments,
  coverageMonthly,
  coverageLabel,
  benchmarkName,
  referenceName,
  referenceTo,
  paper,
  avgHoldSessions,
  identity,
  main,
  sidebar,
  initialWindow,
}: BacktestPanelProps & { initialWindow: BacktestWindowId; urlWindow?: string }) {
  const [selected, setSelected] = useState<BacktestWindowId>(initialWindow);
  const [resolution, setResolution] = useState<Resolution>("weekly");
  const [cache, setCache] = useState<Series | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [note, setNote] = useState("");
  const requestId = useRef(0);

  const meta = windows.find((w) => w.window === selected) ?? windows[0] ?? null;
  const sessions = meta?.sessions ?? 0;
  const dailyAllowed = sessions > 0 && sessions <= DAILY_MAX_SESSIONS;
  const effectiveResolution: Resolution = resolution === "daily" && !dailyAllowed ? "weekly" : resolution;
  const key = `${selected}|${effectiveResolution}`;
  const servedKey = `${served}|weekly`;

  // The URL's window is named only when the run carries it: an unavailable one says so.
  useEffect(() => {
    if (!urlWindow || urlWindow === initialWindow) return;
    setNote(`${windowLabel(urlWindow)} is not in this run; showing ${windowLabel(initialWindow)}.`);
  }, [urlWindow, initialWindow]);

  // THE one place a series is requested: keyed on (window, resolution), stale answers dropped.
  useEffect(() => {
    if (key === servedKey || cache?.key === key) return;
    const id = ++requestId.current;
    setPending(true);
    setFailed(false);
    void loadBacktestSeries(strategyId, effectiveResolution, selected).then((result) => {
      if (id !== requestId.current) return;
      setPending(false);
      if (result) setCache({ key, series: result.series });
      else setFailed(true);
    });
    // retry re-runs the same request after a failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request's key and retry only.
  }, [key, retry]);

  const shown: SeriesPointView[] =
    cache && cache.key === key ? cache.series : (cache?.series ?? servedSeries);
  const windowed = meta?.from ? shown.filter((p) => p.date >= meta.from) : shown;

  const chooseWindow = (next: BacktestWindowId) => {
    setSelected(next);
    setNote("");
    const url = new URL(window.location.href);
    url.searchParams.set(BACKTEST_WINDOW_PARAM, next);
    window.history.replaceState(null, "", url);
  };

  // The choice is kept; a window too long for daily is drawn weekly, with the note saying why.
  const chooseResolution = (next: Resolution) => setResolution(next);

  const avail = windows.filter((w) => w.sessions > 0).map((w) => w.window as BacktestWindowId);
  const dailyNote = resolution === "daily" && !dailyAllowed ? "Daily points are served for windows of 500 sessions or fewer; weekly points are shown." : "";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-controls-row>
          {universeLabel ? (
            <p className="font-mono text-xs text-muted-foreground" data-universe title={universeTitle}>
              {universeLabel}
            </p>
          ) : null}
          <WindowSelector value={selected} onChange={chooseWindow} available={avail} label="Window" />
          <div role="group" aria-label="Series resolution" className="flex gap-1">
            {(["weekly", "daily"] as const).map((option) => {
              const enabled = option === "weekly" || dailyAllowed;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={effectiveResolution === option}
                  aria-disabled={!enabled || undefined}
                  aria-busy={pending || undefined}
                  onClick={() => (pending ? undefined : chooseResolution(option))}
                  className={`rounded-sm border px-2.5 py-1 font-mono text-xs capitalize transition-colors ${
                    effectiveResolution === option
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 text-muted-foreground hover:text-foreground"
                  } ${enabled ? "" : "opacity-50"}`}
                >
                  {option}
                </button>
              );
            })}
          </div>
          {identity}
        </div>
        {note ? <p role="status" className="font-mono text-xs text-muted-foreground">{note}</p> : null}
        {dailyNote ? <p className="font-mono text-[11px] text-muted-foreground">{dailyNote}</p> : null}
        <IntegrityChips chips={[selected === "live" ? recordedChip : frozenChip, ...chips].filter(Boolean)} />

        <section aria-labelledby="growth-heading" className="space-y-3">
          <div>
            <h2 id="growth-heading" className={sectionTitle}>
              {GROWTH_TITLE}
            </h2>
            <p className="font-mono text-xs text-muted-foreground">{GROWTH_UNIT}</p>
          </div>
          <div className="relative" aria-busy={pending || undefined}>
            {meta ? (
              <BacktestChart
                series={windowed}
                windowLabel={meta.label}
                windowFrom={meta.from}
                windowTo={meta.to}
                maxDrawdownPct={meta.maxDrawdownPct}
                troughDate={meta.troughDate ?? null}
                liveFrom={liveFrom}
                recordedFrom={recordedFrom}
                engineSegments={engineSegments}
                coverageMonthly={coverageMonthly}
                coverageLabel={coverageLabel}
                benchmarkName={benchmarkName}
                referenceName={referenceName}
                referenceTo={referenceTo}
                label={`${GROWTH_TITLE} against ${benchmarkName}`}
              />
            ) : null}
            {pending ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-sm bg-background/60 font-mono text-xs text-muted-foreground" role="status">
                Loading the series
              </div>
            ) : null}
            {failed ? (
              <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                <span>The series for this window is unavailable right now.</span>
                <button type="button" onClick={() => setRetry((n) => n + 1)} className="rounded-sm border border-border/70 px-2.5 py-1 font-mono text-xs hover:text-foreground">
                  Try again
                </button>
              </div>
            ) : null}
          </div>
          {disclosures.map((line) => (
            <p key={line} className="text-xs text-muted-foreground">{line}</p>
          ))}
          <p className="text-xs text-muted-foreground">{HYPOTHETICAL_COPY}</p>
          <p className="text-xs text-muted-foreground">{RETURN_BASIS_COPY}</p>
        </section>
      </div>

      {/* Below lg the summary follows the chart; from lg it sits in the right column beside it. */}
      <aside className="min-w-0 space-y-6 lg:col-start-2 lg:row-span-2 lg:row-start-1" aria-label="Run summary">
        <div className="space-y-2">
          <h2 className={sectionTitle}>Run summary</h2>
          <RunSummary window={meta} paper={paper} avgHoldSessions={avgHoldSessions} referenceName={referenceName} />
        </div>
        {sidebar}
      </aside>

      <div className="min-w-0 lg:col-start-1 lg:row-start-2">{main}</div>
    </div>
  );
}
