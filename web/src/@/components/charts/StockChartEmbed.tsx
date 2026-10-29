"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Maximize2, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { useElementSize } from "@/hooks/use-element-size";
import { StockChart } from "./StockChart";
import { seriesColor } from "./chart-theme";
import { useStockChartData } from "./use-stock-chart-data";
import { chartShareUrl } from "@/lib/embed/snippet";
import {
  CHART_PERIODS,
  CHART_VIEWS,
  buildChartView,
  chartViewLabel,
  type ChartPeriod,
  type ChartViewId,
} from "./chart-views";

/** Below this the chart is unreadable; the iframe scrolls instead. */
const MIN_CHART_HEIGHT = 160;
/**
 * From this chart height the reading is the strip above the plot; below it the
 * floating tooltip, which costs the plot no height (spec D5).
 */
const STRIP_MIN_CHART_HEIGHT = 260;

/** Tailwind's `max-sm:portrait`, where landscape mode is offered. */
const PORTRAIT_PHONE = "(max-width: 639.98px) and (orientation: portrait)";

const asOfFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

export interface StockChartEmbedProps {
  stockCode: string;
  defaultView?: ChartViewId;
  defaultPeriod?: ChartPeriod;
  /**
   * Offer a landscape mode on a portrait phone. Only where the chart IS the
   * page (the share page, or /embed/chart opened on its own): inside a
   * publisher's iframe there is no screen to turn.
   */
  allowLandscape?: boolean;
  /**
   * Open already turned sideways on a portrait phone: for a link from an app
   * whose browser does not rotate (Discord's, reported 2026-10-29), where the
   * landscape screen the site gets in a browser never arrives. Only with
   * `allowLandscape`; on any other screen it does nothing.
   */
  startLandscape?: boolean;
  /**
   * Inside an iframe: a link that opens the chart, at the period on screen,
   * full screen on its share page in a new tab.
   */
  expandable?: boolean;
  /**
   * Let the reader switch views too. Off for a publisher's embed, whose view
   * is the one they chose; on in the Discord Activity, which is the reader's.
   */
  selectableView?: boolean;
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-0.5 w-3 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

/**
 * The public /embed/chart widget: the same three views as the stock page's
 * StockChartPanel (built by the shared buildChartView), sized to FILL its
 * container — the embed page gives it a 100dvh box, and the chart takes
 * whatever height is left after the header, legend and caption.
 *
 * The view is fixed by the snippet (it is what the publisher chose to embed);
 * only the period is interactive, unless `selectableView` hands the view to
 * the reader as well.
 *
 * LANDSCAPE MODE: a phone held upright gives a time series a tall, narrow
 * plot, and many phones keep rotation locked, which no page can override
 * (iOS Safari has no Screen Orientation lock at all). So the toggle draws the
 * chart sideways instead: a fixed box the size of the screen turned through
 * 90 degrees, which the reader reads by turning the phone. It applies only
 * while the viewport is portrait; turn the phone with rotation unlocked and
 * the viewport is landscape, so the box simply fills it unrotated. The chart
 * reads the pointer through getScreenCTM (visx localPoint), which includes
 * the rotation, so scrubbing and pinning follow the finger.
 */
export function StockChartEmbed({
  stockCode,
  defaultView = "short",
  defaultPeriod = "1y",
  allowLandscape = false,
  startLandscape = false,
  expandable = false,
  selectableView = false,
}: StockChartEmbedProps) {
  const [period, setPeriod] = useState<ChartPeriod>(defaultPeriod);
  const [chosenView, setView] = useState<ChartViewId>(defaultView);
  const [landscape, setLandscape] = useState(false);

  useEffect(() => {
    if (!allowLandscape || !startLandscape) return;
    // The same screens the toggle is offered on (`max-sm:portrait`).
    if (window.matchMedia?.(PORTRAIT_PHONE).matches) setLandscape(true);
  }, [allowLandscape, startLandscape]);

  useEffect(() => {
    if (!landscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLandscape(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [landscape]);
  const view = selectableView ? chosenView : defaultView;
  const { short, price, volume, anyLoading, isError } = useStockChartData(
    stockCode,
    period,
  );
  const [chartRef, chartBox] = useElementSize<HTMLDivElement>();

  const { series, volume: vol, indicators, leftAxis, rightAxis } = useMemo(
    () => buildChartView(view, { stockCode, short, price, volume }),
    [view, stockCode, short, price, volume],
  );

  const lastShort = short.length ? short[short.length - 1]!.t : null;
  const lastPrice = price.length ? price[price.length - 1]!.t : null;
  const asOf = view === "price" ? lastPrice : (lastShort ?? lastPrice);

  // Combined view with one side missing once loading settles: draw what
  // arrived, and say what didn't.
  const partialNote =
    view === "combined" && !anyLoading && series.length === 1
      ? price.length
        ? "No short position data for this period — showing price only."
        : "No price data for this period — showing short interest only."
      : null;

  const missingNoun =
    view === "short" ? "short" : view === "price" ? "price" : "price or short";

  const chartHeight = Math.max(MIN_CHART_HEIGHT, chartBox.height);
  const readout = chartHeight >= STRIP_MIN_CHART_HEIGHT ? "strip" : "tooltip";

  return (
    <div
      data-landscape={landscape || undefined}
      className={cn(
        "flex h-full min-h-[280px] flex-col gap-2 p-2 sm:p-3",
        landscape && [
          "fixed inset-0 z-[60] h-auto overscroll-contain bg-background",
          // Portrait viewport: a screen-sized box turned 90deg about its top
          // left corner, from the right edge, so it covers the screen exactly.
          "portrait:inset-auto portrait:left-full portrait:top-0 portrait:h-[100vw] portrait:w-[100dvh] portrait:origin-top-left portrait:rotate-90 portrait:touch-none",
        ],
      )}
    >
      {/* Header: code + view, then the period control. Wraps on narrow frames. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h2 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
          <span className="tracking-tight">{stockCode}</span>
          <span
            className={cn(
              "truncate font-normal text-muted-foreground",
              selectableView && "sr-only",
            )}
          >
            {chartViewLabel(view)}
          </span>
        </h2>
        <div
          className={cn(
            "flex items-center gap-1",
            selectableView && "flex-wrap",
          )}
        >
          {selectableView && (
            <div
              className="flex items-center gap-0.5 rounded-md border p-0.5"
              role="group"
              aria-label="View"
            >
              {CHART_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  aria-pressed={view === v.id}
                  className={cn(
                    // Finger-sized where the pointer is a finger, unless the
                    // screen is short (a phone held sideways), where 44px rows
                    // would leave the chart no height; 32px still clears
                    // WCAG 2.2's 24px target minimum.
                    "inline-flex min-h-8 items-center justify-center rounded px-2 text-xs font-medium transition-colors",
                    "[@media(pointer:coarse)_and_(min-height:481px)]:min-h-11",
                    view === v.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {v.shortLabel}
                </button>
              ))}
            </div>
          )}
          <div
            className="flex items-center gap-0.5 rounded-md border p-0.5"
            role="group"
            aria-label="Period"
          >
            {CHART_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                aria-pressed={period === p}
                className={cn(
                  "inline-flex min-h-8 min-w-8 items-center justify-center rounded px-2 text-xs font-medium uppercase transition-colors",
                  // Finger-sized targets where the pointer is a finger.
                  "[@media(pointer:coarse)_and_(min-height:481px)]:min-h-11 [@media(pointer:coarse)_and_(min-height:481px)]:min-w-11",
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {p}
              </button>
            ))}
          </div>
          {allowLandscape && (
            <button
              type="button"
              onClick={() => setLandscape((v) => !v)}
              aria-pressed={landscape}
              title={landscape ? "Back to portrait" : "Rotate to landscape"}
              className={cn(
                "min-h-11 min-w-11 items-center justify-center rounded-md border transition-colors hover:bg-muted/50 hover:text-foreground",
                // Offered only on a portrait phone, where the screen lacks the
                // width; once on, it stays, so the mode can always be left.
                landscape
                  ? "inline-flex bg-muted text-foreground"
                  : "hidden text-muted-foreground max-sm:portrait:inline-flex",
              )}
            >
              {/* A phone on its side, upright again once it is: the arrow
                  this replaced read as "refresh". */}
              <Smartphone
                aria-hidden
                className={cn("h-4 w-4", !landscape && "rotate-90")}
              />
              <span className="sr-only">
                {landscape ? "Back to portrait" : "Rotate chart to landscape"}
              </span>
            </button>
          )}
          {expandable && (
            <a
              href={chartShareUrl(stockCode, view, period)}
              target="_blank"
              rel="noopener"
              title="Open full screen"
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground [@media(pointer:coarse)_and_(min-height:481px)]:min-h-11 [@media(pointer:coarse)_and_(min-height:481px)]:min-w-11"
            >
              <Maximize2 aria-hidden className="h-3.5 w-3.5" />
              <span className="sr-only">
                Open {stockCode} chart full screen
              </span>
            </a>
          )}
        </div>
      </div>

      {/* The strip carries each series' dot and label, so this row is only for the
          tooltip, which has neither. */}
      {view === "combined" && readout === "tooltip" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <LegendSwatch color={seriesColor("price")} label="Share price ($, left)" />
          <LegendSwatch color={seriesColor("short")} label="Short interest (%, right)" />
        </div>
      )}

      {/* The chart takes the remaining height; measured, then handed to StockChart. */}
      <div ref={chartRef} className="relative min-h-0 flex-1">
        {isError ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Unable to load chart data.
          </div>
        ) : series.length ? (
          chartBox.height > 0 && (
            <StockChart
              series={series}
              volume={vol}
              indicators={indicators}
              leftAxis={leftAxis}
              rightAxis={rightAxis}
              height={chartHeight}
              showBrush={false}
              readout={readout}
              // The price and the short series load separately, and in a narrow
              // frame each is a row of the strip: hold the second's row from the
              // first render so the plot does not move 18px when it lands.
              readoutReserveSeries={view === "combined" ? 2 : undefined}
            />
          )
        ) : anyLoading ? (
          <div
            className="h-full animate-pulse rounded-lg bg-muted/40"
            aria-label="Loading chart"
          />
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            No {missingNoun} data for {stockCode}.
          </div>
        )}
      </div>

      {/* Caption. Right padding clears the embed layout's fixed brand link,
          which the landscape box covers, so it carries the brand itself. */}
      <div
        className={cn(
          "flex min-h-4 flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground",
          !landscape && "pr-24",
        )}
      >
        {asOf != null && series.length > 0 && (
          <span>As of {asOfFmt.format(new Date(asOf))}</span>
        )}
        {partialNote && <span>{partialNote}</span>}
        {landscape && <span className="ml-auto">shorted.com.au</span>}
      </div>
    </div>
  );
}

export default StockChartEmbed;
