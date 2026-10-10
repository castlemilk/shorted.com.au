"use client";

import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import { EmbedDialog } from "~/@/components/ui/embed-dialog";
import { StockChart } from "./StockChart";
import { useStockChartData } from "./use-stock-chart-data";
import { useChartPrefs } from "./chart-prefs";
import { computeDivergenceRegions } from "./divergence";
import { CHART_BOX_HEIGHT_CLASS } from "./stock-chart-section";
import {
  CHART_PERIODS,
  CHART_VIEWS,
  SMA_COLOR,
  buildChartView,
  type ChartPeriod,
  type ChartViewId,
} from "./chart-views";

// Where each control sits, as CSS grid areas: every control is rendered once
// and only its place changes with the breakpoint (spec D4, phone controls).
// Below `xl` the view control and the embed button share a 40px row above the
// chart, and the period control (the full width) and the toggles sit under it.
// From `xl` it is one row above the chart.
//
// `xl`, where the spec says `sm`. The one row needs a panel 960px wide
// (measured, in a browser: the view control 329, the toggles 291, the period
// control 230, the embed button 76, three gaps of 12). A panel is that wide from
// a 1024px window signed out, and from 1280px beside the signed-in sidebar
// (256px), so `xl` is the first breakpoint that is safe for both. At exactly
// 1280 there it has no slack, and the toggles, which scroll, give up whatever a
// classic scrollbar takes. Given less width than that the row does not wrap as
// the old flex row did: at a 704px panel the toggles had 37px of their 291, at
// 886px 219, and at 576px the view control broke onto two lines and the row came
// out 62px tall. The skeleton breaks at `xl` too, so the two match at every
// width. The box's own height stays at `sm`.
//
// The divergence legend gets a row between the controls and the chart only
// while it shows. A row with nothing in it would still cost a gap, and the
// panel has to match the skeleton, row for row, when it is not there.
const AREAS =
  "[grid-template-areas:'view_embed'_'chart_chart'_'period_period'_'toggles_toggles'] xl:[grid-template-areas:'view_toggles_period_embed'_'chart_chart_chart_chart']";
const AREAS_WITH_LEGEND =
  "[grid-template-areas:'view_embed'_'legend_legend'_'chart_chart'_'period_period'_'toggles_toggles'] xl:[grid-template-areas:'view_toggles_period_embed'_'legend_legend_legend_legend'_'chart_chart_chart_chart']";

// A segmented control. Below `xl` it is a 40px bar whose buttons fill it edge
// to edge; the outline is an inset ring, which costs no height, so the buttons
// can be the 40px targets a thumb needs inside the 40px row. From `xl` it is the
// bordered 30px pill it was.
const SEG_GROUP =
  "flex h-10 items-center overflow-hidden rounded-md ring-1 ring-inset ring-border xl:h-auto xl:gap-0.5 xl:self-center xl:overflow-visible xl:border xl:p-0.5 xl:ring-0";

// The two toggles share a look; below `xl` they fill the 36px row they sit in
// (and, like the segmented buttons, draw their focus ring inside: the row clips).
const TOGGLE =
  "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-xl:focus-visible:-outline-offset-2 xl:h-auto";

function SegButton({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "min-h-10 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors max-xl:focus-visible:-outline-offset-2 xl:min-h-0",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface StockChartPanelProps {
  stockCode: string;
  defaultPeriod?: ChartPeriod;
  defaultView?: ChartViewId;
  /**
   * Where this panel keeps its view, SMA 20 and divergence choices between
   * mounts (see chart-prefs.ts): `"<CODE>:overview"`, `"<CODE>:short-interest"`.
   * The period is kept per stock, shared by every panel with a key. Without a
   * key the panel remembers nothing.
   */
  prefsKey?: string;
  /**
   * The chart box's height in px. Omitted, the box is CHART_BOX_HEIGHT_CLASS
   * (360px on a phone, 420px from `sm`) and the chart takes its height from it.
   */
  height?: number;
}

/**
 * Per-stock chart as a tabbed panel: Combined (price + short dual-axis) /
 * Short Interest / Price & Volume. Fetches once via useStockChartData and
 * renders the shared StockChart with the series config for the active view.
 */
export function StockChartPanel({
  stockCode,
  defaultPeriod = "1y",
  defaultView = "combined",
  prefsKey,
  height,
}: StockChartPanelProps) {
  const [{ period, view, showMA, showDivergence }, setPrefs] = useChartPrefs({
    stockCode,
    prefsKey,
    defaults: {
      period: defaultPeriod,
      view: defaultView,
      showMA: false,
      showDivergence: false,
    },
  });

  const { short, price, volume, correlation, anyLoading, isError } =
    useStockChartData(stockCode, period);

  // Shorted-only overlay (combined view): shade spans where short interest and
  // price trend the SAME way — shorts building into a rally (bearish) or
  // covering into a slide (bullish). Only computed when toggled on.
  const regions = useMemo(
    () =>
      showDivergence && view === "combined" && short.length && price.length
        ? computeDivergenceRegions(price, short)
        : [],
    [showDivergence, view, short, price],
  );

  // Per-view chart config — shared with the /embed/chart widget.
  const { series, volume: vol, indicators, leftAxis, rightAxis } = useMemo(
    () => buildChartView(view, { stockCode, short, price, volume, showMA }),
    [view, stockCode, short, price, volume, showMA],
  );

  const hasData = series.length > 0;
  const showMAToggle = view !== "short";
  const showLegend = showDivergence && view === "combined" && regions.length > 0;

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] gap-3 xl:grid-cols-[auto_minmax(0,1fr)_auto_auto]",
        showLegend ? AREAS_WITH_LEGEND : AREAS,
      )}
    >
      {/* The controls sit in the order of the one row they make from `xl`, which
          is the order a keyboard visits them in; below `xl` the grid areas put
          them where a thumb wants them. Nothing wraps: the view labels compact
          below `sm`, and the period control spans the width, so every button
          stays reachable without the card clipping any of them. */}
      <div
        className={cn(SEG_GROUP, "[grid-area:view] justify-self-start")}
        role="group"
        aria-label="Chart view"
      >
        {CHART_VIEWS.map((v) => (
          <SegButton
            key={v.id}
            active={view === v.id}
            onClick={() => setPrefs({ view: v.id })}
          >
            <span className="hidden sm:inline">{v.label}</span>
            <span className="sm:hidden">{v.shortLabel}</span>
          </SegButton>
        ))}
      </div>

      {/* Always rendered, even when no toggle applies to the view: the row it
          makes below `xl` is part of the footprint the skeleton holds. It
          scrolls sideways rather than wrapping, or the row would grow. Right
          aligned from `xl` by an auto margin, not `justify-end`, which would
          leave an overflow's first buttons out of reach to the left. The 2px of
          padding, taken back by the margin, keeps the edge buttons' focus rings
          inside the box that clips them. */}
      <div className="[grid-area:toggles] -mx-0.5 flex h-9 min-w-0 flex-nowrap items-center gap-2 overflow-x-auto px-0.5 xl:h-8 xl:[&>:first-child]:ml-auto">
        {view === "combined" && correlation != null && (
          <span
            className="shrink-0 whitespace-nowrap rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
            title="Pearson correlation between price and short interest over the selected period"
          >
            corr {correlation >= 0 ? "+" : ""}
            {correlation.toFixed(2)}
          </span>
        )}
        {showMAToggle && (
          <button
            type="button"
            onClick={() => setPrefs({ showMA: !showMA })}
            aria-pressed={showMA}
            className={cn(
              TOGGLE,
              showMA
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: showMA ? SMA_COLOR : "transparent", border: `1px solid ${SMA_COLOR}` }}
            />
            SMA 20
          </button>
        )}
        {view === "combined" && (
          <button
            type="button"
            onClick={() => setPrefs({ showDivergence: !showDivergence })}
            aria-pressed={showDivergence}
            title="Shade spans where short interest and price trend the same way — shorts building into a rally, or covering into a slide"
            className={cn(
              TOGGLE,
              showDivergence
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{
                background: showDivergence
                  ? "linear-gradient(90deg,#ef4444 50%,#22c55e 50%)"
                  : "transparent",
                border: "1px solid #94a3b8",
              }}
            />
            Divergence
          </button>
        )}
      </div>

      <div
        className={cn(SEG_GROUP, "[grid-area:period]")}
        role="group"
        aria-label="Period"
      >
        {CHART_PERIODS.map((p) => (
          <SegButton
            key={p}
            active={period === p}
            onClick={() => setPrefs({ period: p })}
            className="flex-1 xl:flex-none"
          >
            <span className="uppercase">{p}</span>
          </SegButton>
        ))}
      </div>

      <div className="[grid-area:embed] flex h-10 items-center justify-end xl:h-8">
        <EmbedDialog
          target={{ kind: "chart", code: stockCode, view, period }}
          className="min-h-10 min-w-10 justify-center xl:min-h-0 xl:min-w-0"
        />
      </div>

      {/* Divergence legend (only when on and regions were found) */}
      {showLegend && (
        <div className="-mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground [grid-area:legend]">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: "#ef444433", border: "1px solid #ef4444" }}
            />
            Shorts building into price strength
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: "#22c55e33", border: "1px solid #22c55e" }}
            />
            Shorts covering into price weakness
          </span>
        </div>
      )}

      {/* Chart. The box has its height whatever it holds, so the loading,
          empty and error states fill the footprint the chart will have. */}
      <div
        className={cn(
          "min-w-0 [grid-area:chart]",
          height === undefined && CHART_BOX_HEIGHT_CLASS,
        )}
        style={height === undefined ? undefined : { height }}
      >
        {isError ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Unable to load chart data. Please try again later.
          </div>
        ) : hasData ? (
          <StockChart
            series={series}
            volume={vol}
            indicators={indicators}
            regions={regions}
            leftAxis={leftAxis}
            rightAxis={rightAxis}
            height={height}
          />
        ) : anyLoading ? (
          <div
            className="h-full animate-pulse rounded-lg bg-muted/40"
            aria-label="Loading chart"
          />
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            No chart data available for {stockCode} in this period.
          </div>
        )}
      </div>
    </div>
  );
}

export default StockChartPanel;
