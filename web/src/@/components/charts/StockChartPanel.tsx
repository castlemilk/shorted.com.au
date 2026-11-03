"use client";

import React, { useMemo } from "react";
import { SquareFunction } from "lucide-react";
import { usePathname } from "next/navigation";
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
  buildChartView,
  resolveChartView,
  type ChartPeriod,
  type ChartViewId,
} from "./chart-views";
import {
  NO_INDICATORS,
  drawnIndicatorIds,
  indicatorsWithoutValues,
  menuIndicators,
  readyIndicators,
  toggleIndicator,
  visibleIndicators,
} from "./chart-indicators";
import {
  IndicatorMenuPanel,
  useIndicatorAccess,
  useIndicatorMenu,
} from "./indicator-menu";
import { useIndicatorHistory } from "./use-indicator-history";

// Where each control sits, as CSS grid areas: every control is rendered once
// and only its place changes with the breakpoint (spec D4, phone controls).
// Below `xl` the view control and the embed button share a 40px row above the
// chart, and the period control (the full width) and the toggles sit under it.
// From `xl` it is one row above the chart.
//
// `xl`, where the spec says `sm`. The one row needs a panel about 975px wide
// (measured in a browser before the Indicators trigger: the view control 329, the
// toggles 291, the period control 230, the embed button 76, three gaps of 12; the
// Indicators trigger makes the toggles about 306, so the row about 975). A panel is
// that wide from a 1024px window signed out, and from 1280px beside the signed-in
// sidebar (256px), so `xl` is the first breakpoint that is safe for both. At 1280
// beside the sidebar the panel is 960px, and the toggles, which scroll, give up
// about 15px of their row. Given less width than that the row does not wrap as
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

// The toggles share a look; below `xl` they fill the 36px row they sit in
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
   * Where this panel keeps its view, indicators and divergence choices between
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
  const [{ period, view, indicators: chosen, showDivergence }, setPrefs] = useChartPrefs({
    stockCode,
    prefsKey,
    defaults: {
      period: defaultPeriod,
      view: defaultView,
      indicators: NO_INDICATORS,
      showDivergence: false,
    },
  });

  const { short, price, volume, correlation, anyLoading, isError } =
    useStockChartData(stockCode, period);

  // The view the chart is drawn as, from the series that have arrived. The menu,
  // the selection and the history follow it, so a Combined chart with one series
  // offers, counts and draws only the series it can draw. A warm-up for the missing
  // series may already be on its way when the chart learns it is missing.
  const shown = resolveChartView(view, { price, short });
  const access = useIndicatorAccess("session");
  const pathname = usePathname();
  const visible = useMemo(
    () => visibleIndicators(chosen, { view: shown, access }),
    [chosen, shown, access],
  );
  // Each indicator waits for its own history (useIndicatorHistory). One that waits
  // is held back, and a panel among them keeps its place, empty, until it lands.
  const history = useIndicatorHistory(stockCode, period, visible);
  const drawn = useMemo(
    () =>
      readyIndicators(
        visible,
        { price: history.pricePending, short: history.shortPending },
        history.waiting,
      ),
    [visible, history.pricePending, history.shortPending, history.waiting],
  );
  const menu = useIndicatorMenu();
  const menuItems = useMemo(() => menuIndicators(shown), [shown]);

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
  const {
    series,
    volume: vol,
    indicators,
    oscillators,
    leftAxis,
    rightAxis,
  } = useMemo(
    () =>
      buildChartView(view, {
        stockCode,
        short,
        price,
        volume,
        indicators: drawn,
        pending: history.waiting,
        history: { price: history.price, short: history.short },
      }),
    [
      view,
      stockCode,
      short,
      price,
      volume,
      drawn,
      history.waiting,
      history.price,
      history.short,
    ],
  );

  // What is on screen, counted and named. A selected indicator with nothing to draw,
  // and nothing still loading, is on a series too short for it (a young listing):
  // it is not counted, and the menu says so.
  const drawnIds = useMemo(
    () => drawnIndicatorIds({ indicators, oscillators }),
    [indicators, oscillators],
  );
  const hasPrice = price.length > 0;
  const hasShort = short.length > 0;
  const noHistory = useMemo(
    () =>
      indicatorsWithoutValues(visible, {
        drawn: drawnIds,
        waiting: history.waiting,
        hasData: { price: hasPrice, short: hasShort },
      }),
    [visible, drawnIds, history.waiting, hasPrice, hasShort],
  );
  const shownCount = visible.length - noHistory.length;

  const hasData = series.length > 0;
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
          them where a thumb wants them (view, embed, chart, period, toggles),
          so a keyboard crosses the stack in another order than it is drawn in.
          WCAG 2.4.3 would have the two agree, and one instance of each control
          cannot agree with both layouts; the one row is the one most keyboard
          users meet, so it gets the matching order (accepted, spec D4). Nothing
          wraps: the view labels compact below `sm`, and the period control
          spans the width, so every button stays reachable without the card
          clipping any of them. */}
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
          scrolls sideways rather than wrapping, or the row would grow, and its
          scrollbar is hidden: the row has no height to spare (36px for 36px
          buttons; from `xl` 32px for 24px ones), so a classic scrollbar
          (Windows, or macOS set to always show them) would take 15px of it and
          cut the buttons. It still scrolls by wheel and by touch, and focusing
          a button brings it into view. Right aligned from `xl` by an auto
          margin, not `justify-end`, which would leave an overflow's first
          buttons out of reach to the left. The 2px of padding, taken back by
          the margin, keeps the edge buttons' focus rings inside the box that
          clips them. */}
      <div className="[grid-area:toggles] -mx-0.5 flex h-9 min-w-0 flex-nowrap items-center gap-2 overflow-x-auto px-0.5 [scrollbar-width:none] xl:h-8 xl:[&>:first-child]:ml-auto [&::-webkit-scrollbar]:hidden">
        {view === "combined" && correlation != null && (
          <span
            className="shrink-0 whitespace-nowrap rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
            title="Pearson correlation between price and short interest over the selected period"
          >
            corr {correlation >= 0 ? "+" : ""}
            {correlation.toFixed(2)}
          </span>
        )}
        <button
          ref={menu.triggerRef}
          type="button"
          aria-expanded={menu.open}
          aria-controls={menu.open ? menu.id : undefined}
          onClick={menu.toggle}
          className={cn(
            TOGGLE,
            menu.open || shownCount > 0
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          <SquareFunction aria-hidden className="h-4 w-4 sm:hidden" />
          <span className="max-sm:sr-only">Indicators</span>
          {shownCount > 0 && (
            <>
              <span
                aria-hidden
                className="rounded bg-primary/15 px-1 text-[10px] tabular-nums"
              >
                {shownCount}
              </span>
              <span className="sr-only">, {shownCount} on</span>
            </>
          )}
        </button>
        {view === "combined" && (
          <button
            type="button"
            onClick={() => setPrefs({ showDivergence: !showDivergence })}
            aria-pressed={showDivergence}
            title="Shade spans where short interest and price trend the same way: shorts building into a rally, or covering into a slide"
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
          empty and error states fill the footprint the chart will have. The
          indicator menu sits over it, inside the box, so it never moves the
          chart. */}
      <div
        className={cn(
          "relative min-w-0 [grid-area:chart]",
          height === undefined && CHART_BOX_HEIGHT_CLASS,
        )}
        style={height === undefined ? undefined : { height }}
      >
        {menu.open && (
          <IndicatorMenuPanel
            id={menu.id}
            items={menuItems}
            selected={chosen}
            noHistory={noHistory}
            onToggle={(id) => setPrefs({ indicators: toggleIndicator(chosen, id) })}
            access={access}
            signIn={{ callbackUrl: pathname ?? "/" }}
            onClose={menu.close}
            triggerRef={menu.triggerRef}
            className="right-2 max-xl:bottom-2 xl:top-2"
          />
        )}
        {isError ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Unable to load chart data. Please try again later.
          </div>
        ) : hasData ? (
          <StockChart
            series={series}
            volume={vol}
            indicators={indicators}
            oscillators={oscillators}
            regions={regions}
            leftAxis={leftAxis}
            rightAxis={rightAxis}
            height={height}
            indicatorLegend
            indicatorsInDomain
            // The price and the short series load separately, and on a phone each
            // is a row of the strip: hold the second's row from the first render
            // so the plot does not move 18px when it lands.
            readoutReserveSeries={view === "combined" ? 2 : undefined}
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
