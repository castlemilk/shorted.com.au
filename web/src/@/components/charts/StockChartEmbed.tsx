"use client";

import React, { useEffect, useMemo, useState } from "react";
import { FunctionSquare, Maximize2, Smartphone } from "lucide-react";
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
  resolveChartView,
  type ChartPeriod,
  type ChartViewId,
} from "./chart-views";
import {
  NO_INDICATORS,
  drawnIndicatorIds,
  indicatorDef,
  indicatorsWithoutValues,
  menuIndicators,
  readyIndicators,
  toggleIndicator,
  visibleIndicators,
  type ChartIndicatorId,
} from "./chart-indicators";
import {
  IndicatorMenuPanel,
  useIndicatorAccess,
  useIndicatorMenu,
  type IndicatorSignIn,
} from "./indicator-menu";
import { useIndicatorHistory } from "./use-indicator-history";
import { isPortraitPhone } from "./portrait-phone";

/** Below this the chart is unreadable; the iframe scrolls instead. */
const MIN_CHART_HEIGHT = 160;
/**
 * From this chart height the reading is the strip above the plot; below it the
 * floating tooltip, which costs the plot no height (spec D5).
 */
const STRIP_MIN_CHART_HEIGHT = 260;
/**
 * From this chart height a panel indicator (RSI, MACD) has room under the plot.
 * Below it the panel is not drawn, and its menu item says so.
 */
const OSC_MIN_CHART_HEIGHT = 320;

/**
 * A round icon button in a chart's header row: the share page link, and the
 * Activity's search and open. Finger-sized where the pointer is a finger,
 * unless the screen is short (a phone held sideways), where 44px rows would
 * leave the chart no height; 32px still clears WCAG 2.2's 24px target minimum.
 */
export const EMBED_CONTROL_BUTTON =
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground [@media(pointer:coarse)_and_(min-height:481px)]:min-h-11 [@media(pointer:coarse)_and_(min-height:481px)]:min-w-11";

const asOfFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

/**
 * The indicator menu a host offers on its chart. Omitted (the public /embed/chart),
 * the chart has no menu, draws no overlay and asks for no history.
 */
export interface EmbedIndicatorOptions {
  /**
   * Whether a session opens the advanced indicators: the share page does
   * ("session"); the Discord Activity cannot hold one, so they stay locked there
   * ("never").
   */
  unlock: "session" | "never";
  /**
   * Handles the sign-in click itself (the Activity opens it outside Discord).
   * Without it, sign-in is a link to /signin that returns to this chart's share page.
   */
  onSignIn?: (chart: {
    stockCode: string;
    view: ChartViewId;
    period: ChartPeriod;
  }) => void;
  /** The picks to start from, for a host that keeps them across a stock switch. */
  initial?: readonly ChartIndicatorId[];
  /** Told the new picks each time the reader changes them. */
  onChange?: (ids: readonly ChartIndicatorId[]) => void;
  /**
   * A sign-in from `onSignIn` is on its way out: its menu button shows it busy and takes
   * no press until the host clears it (the Activity sets it while its link is out).
   */
  signInBusy?: boolean;
}

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
   * landscape screen the site gets in a browser never arrives. Read on the first
   * render, so the first frame is already turned. Only with `allowLandscape`;
   * on any other screen it does nothing. Ignored when `landscape` is given.
   */
  startLandscape?: boolean;
  /**
   * Whether the chart is turned sideways, when the host holds that choice itself
   * (the Discord Activity keeps it outside the chart, which remounts for each stock,
   * so a stock switch keeps the reader's choice). Given, the chart renders from it,
   * never reads the screen for `startLandscape`, and only reports the toggle and
   * Escape through `onLandscapeChange`, which the host answers by changing this.
   */
  landscape?: boolean;
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
  /**
   * Extra controls at the end of the header row, before the landscape toggle
   * (the Discord Activity's search and open).
   */
  headerActions?: React.ReactNode;
  /**
   * Told when the reader turns landscape on or off (the toggle, or Escape);
   * not when startLandscape turns it on.
   */
  onLandscapeChange?: (on: boolean) => void;
  /**
   * Drawn over the chart's box, which is `relative`: the caller positions it
   * (absolute, inside the box, so it turns with a landscape chart). The Discord
   * Activity's copy-link fallback.
   */
  chartOverlay?: React.ReactNode;
  /**
   * The Indicators menu and what it draws. Omitted, there is no menu, and the chart
   * draws nothing extra, asks for no history and carries no legend.
   */
  indicators?: EmbedIndicatorOptions;
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
 * INDICATORS: a host that passes `indicators` gets the Indicators menu (the base
 * set for everyone, the advanced set behind `unlock`), with each overlay on its
 * series' axis, a legend in the plot and the panel under the time axis (where the
 * chart is tall enough for one). Without the prop the chart is the public widget
 * it always was: no menu, no legend, and no request beyond its own.
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
  headerActions,
  onLandscapeChange,
  indicators,
  landscape: landscapeProp,
  chartOverlay,
}: StockChartEmbedProps) {
  // Read as a boolean, not the options object: the hooks below depend on it, and
  // a host passes a new object each render.
  const offers = indicators !== undefined;
  const [period, setPeriod] = useState<ChartPeriod>(defaultPeriod);
  const [chosenView, setView] = useState<ChartViewId>(defaultView);
  // Uncontrolled, the chart keeps its own choice. It starts turned when `startLandscape`
  // asks and the screen is a portrait phone, and the initializer reads the screen on the
  // first render, so the first frame is already sideways (no flash of upright). Given a
  // `landscape`, the screen is not read at all.
  const [ownLandscape, setOwnLandscape] = useState(
    () =>
      landscapeProp === undefined &&
      allowLandscape &&
      startLandscape &&
      isPortraitPhone(),
  );
  // Controlled, when the host passes `landscape`: the host holds the choice.
  const controlled = landscapeProp !== undefined;
  const landscape = landscapeProp ?? ownLandscape;
  const [chosen, setChosen] = useState<readonly ChartIndicatorId[]>(
    () => indicators?.initial ?? NO_INDICATORS,
  );

  useEffect(() => {
    if (!landscape) return;
    const onKey = (e: KeyboardEvent) => {
      // On window, after every listener on the page: a menu, a dialog or a pinned
      // reading that took this Escape has called preventDefault, and keeps landscape.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!controlled) setOwnLandscape(false);
      onLandscapeChange?.(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [landscape, controlled, onLandscapeChange]);
  const view = selectableView ? chosenView : defaultView;
  const { short, price, volume, anyLoading, isError } = useStockChartData(
    stockCode,
    period,
  );
  // The view the chart is drawn as, from the series that have arrived. The menu, the
  // selection and the history follow it, so a Combined chart with one series counts,
  // fetches and offers only what it draws (as the stock page's panel does).
  const shown = resolveChartView(view, { price, short });
  const [chartRef, chartBox] = useElementSize<HTMLDivElement>();
  const chartHeight = Math.max(MIN_CHART_HEIGHT, chartBox.height);
  const readout = chartHeight >= STRIP_MIN_CHART_HEIGHT ? "strip" : "tooltip";
  const panelFits = chartHeight >= OSC_MIN_CHART_HEIGHT;

  // The indicators the host offers and the visitor may see (base ones for everyone,
  // advanced ones with a session). A panel the chart is too short for is left out
  // here as well as from the drawing, so its history is not fetched for nothing.
  const access = useIndicatorAccess(indicators?.unlock ?? "never");
  const offered = useMemo(
    () =>
      panelFits
        ? chosen
        : chosen.filter((id) => indicatorDef(id).kind !== "panel"),
    [chosen, panelFits],
  );
  const visible = useMemo(
    () =>
      offers
        ? visibleIndicators(offered, { view: shown, access })
        : NO_INDICATORS,
    [offers, offered, shown, access],
  );
  // Each indicator waits for its own history (useIndicatorHistory). One that waits is
  // held back, and a panel among them keeps its place, empty, until it lands. An
  // indicator that has its history is drawn even while another one still loads.
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

  const {
    series,
    volume: vol,
    indicators: overlays,
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
  // and nothing still loading, is on a series too short for it (a young listing): it is
  // not counted, and the menu says so. The panel counts only where the chart draws one.
  const drawnIds = useMemo(
    () =>
      drawnIndicatorIds({
        indicators: overlays,
        oscillators: panelFits ? oscillators : [],
      }),
    [overlays, oscillators, panelFits],
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

  // A locked indicator's sign-in returns the reader to this chart's share page,
  // turned sideways if it is. A host that signs the visitor in itself gets the click.
  const sharePath = useMemo(() => {
    const share = new URL(chartShareUrl(stockCode, view, period));
    if (landscape) share.searchParams.set("landscape", "1");
    return share.pathname + share.search;
  }, [stockCode, view, period, landscape]);
  const onSignIn = indicators?.onSignIn;
  const signIn: IndicatorSignIn = onSignIn
    ? {
        onClick: () => onSignIn({ stockCode, view, period }),
        busy: indicators?.signInBusy,
      }
    : { callbackUrl: sharePath };

  const toggle = (id: ChartIndicatorId) => {
    // The whole selection, not `offered`: a panel the chart is too short for stays
    // chosen for when the chart is taller.
    const next = toggleIndicator(chosen, id);
    setChosen(next);
    indicators?.onChange?.(next);
  };

  const lastShort = short.length ? short[short.length - 1]!.t : null;
  const lastPrice = price.length ? price[price.length - 1]!.t : null;
  const asOf = view === "price" ? lastPrice : (lastShort ?? lastPrice);

  // Combined view with one side missing once loading settles: draw what
  // arrived, and say what didn't.
  const partialNote =
    view === "combined" && !anyLoading && series.length === 1
      ? price.length
        ? "No short position data for this period. Showing price only."
        : "No price data for this period. Showing short interest only."
      : null;

  const missingNoun =
    view === "short" ? "short" : view === "price" ? "price" : "price or short";

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
      <div
        data-embed-header
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
      >
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
          {offers && (
            <button
              ref={menu.triggerRef}
              type="button"
              aria-expanded={menu.open}
              aria-controls={menu.open ? menu.id : undefined}
              onClick={menu.toggle}
              title="Indicators"
              className={cn(
                EMBED_CONTROL_BUTTON,
                "relative",
                (menu.open || shownCount > 0) && "bg-muted text-foreground",
              )}
            >
              <FunctionSquare aria-hidden className="h-4 w-4" />
              <span className="sr-only">Indicators</span>
              {shownCount > 0 && (
                <>
                  <span
                    aria-hidden
                    className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[9px] leading-4 text-primary-foreground"
                  >
                    {shownCount}
                  </span>
                  <span className="sr-only">, {shownCount} on</span>
                </>
              )}
            </button>
          )}
          {headerActions}
          {allowLandscape && (
            <button
              type="button"
              onClick={() => {
                const next = !landscape;
                if (!controlled) setOwnLandscape(next);
                onLandscapeChange?.(next);
              }}
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
              className={EMBED_CONTROL_BUTTON}
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
        {/* Inside the chart box, so a landscape box turns it with the chart; the
            positioning is CSS, never a floating-ui popover, which a rotated box
            places wrongly. */}
        {offers && menu.open && (
          <IndicatorMenuPanel
            id={menu.id}
            items={menuItems}
            selected={offered}
            noHistory={noHistory}
            onToggle={toggle}
            access={access}
            signIn={signIn}
            onClose={menu.close}
            triggerRef={menu.triggerRef}
            panelUnavailable={!panelFits}
            className="right-2 top-2"
          />
        )}
        {isError ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Unable to load chart data.
          </div>
        ) : series.length ? (
          chartBox.height > 0 && (
            <StockChart
              series={series}
              volume={vol}
              indicators={overlays}
              // A panel is drawn only where the chart is tall enough for one.
              oscillators={panelFits ? oscillators : undefined}
              leftAxis={leftAxis}
              rightAxis={rightAxis}
              height={chartHeight}
              showBrush={false}
              readout={readout}
              // The price and the short series load separately, and in a narrow
              // frame each is a row of the strip: hold the second's row from the
              // first render so the plot does not move 18px when it lands.
              readoutReserveSeries={view === "combined" ? 2 : undefined}
              // A host that offers indicators also gets their legend and the room
              // they need in the value axis; a publisher's embed gets neither.
              indicatorLegend={offers}
              indicatorsInDomain={offers}
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
        {chartOverlay}
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
