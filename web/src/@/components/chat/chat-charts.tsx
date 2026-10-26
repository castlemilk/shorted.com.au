"use client";

// Every chart in the chat lives in this module, and it is loaded with
// next/dynamic (ssr: false) from the table and result components. visx is
// therefore never part of the eager chat bundle, which the root layout's chat
// sidebar loads on every page.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { scaleLinear, scaleTime } from "@visx/scale";
import { chartTheme } from "~/@/components/charts/chart-theme";
import {
  AXIS_MIN_MARGIN_PX,
  AXIS_NUM_TICKS,
  axisMargin,
} from "~/@/components/charts/axis-margin";
import {
  Axes,
  Crosshair,
  Grid,
  SeriesPath,
} from "~/@/components/charts/chart-primitives";
import { stepIndex, TooltipContent, type HoverState } from "~/@/components/charts/chart-tooltip";
import { nearest } from "~/@/components/charts/nearest";
import type { ChartSeriesSpec } from "~/@/components/charts/types";
import {
  valueAxisLabels,
  valueAxisTicks,
  useChartScales,
} from "~/@/components/charts/use-chart-scales";
import {
  placeLatestLabel,
  placeTooltip,
  readingIsInView,
  type ViewportRect,
} from "./chat-layout";
import {
  formatDay,
  formatPercent,
  timeTickLabel,
  type TickFormatter,
} from "./chat-tool-format";
import type { Reading } from "./chat-tool-data";

/** The sparkline's width in a full table. A table at the sidebar's width draws it narrower. */
const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;
const SPARK_PAD = 2;

/**
 * The rectangles that clip an element: every ancestor whose overflow crops it. A reading
 * scrolled out of one of them is out of view, and its tooltip goes with it.
 */
function clippingRects(element: Element): ViewportRect[] {
  const rects: ViewportRect[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (/auto|scroll|hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) {
      const rect = node.getBoundingClientRect();
      rects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }
  return rects;
}

/** A press that moves less than this, in px, is a tap rather than a scrub. */
const TAP_MAX_MOVE_PX = 6;

/** Maps a pointer's x (and the box's left edge) to the index of the reading nearest it. */
type IndexAt = (clientX: number, boxLeft: number) => number | null;

interface Press {
  startX: number;
  moved: boolean;
  /** What was pinned before the press. A press the browser turns into a scroll goes back to it. */
  pinnedBefore: number | null;
  /** The press landed on the reading already pinned, so a tap on it releases the pin. */
  onPinned: boolean;
}

/**
 * The reading a chart or sparkline shows, and the handlers that set it. Both charts
 * use it, so a pointer and a keyboard behave the same on each.
 *
 * There are two sources. A hover (a mouse or a pen) follows the pointer and clears
 * when the pointer leaves. A pin is set by a press and stays: a touch scrubs and lifts
 * to pin (`touch-action: pan-y` leaves a vertical swipe to the page), a tap on the
 * pinned reading releases it, and a press the browser turns into a scroll goes back to
 * what was pinned before. The reading on screen is the hover if there is one, else the pin.
 *
 * Focus shows the latest reading unless a press has already pinned one, so the reading
 * a click or tap made survives the focus that follows it. The arrow keys step from the
 * reading on screen, and Escape and blur clear both sources.
 */
function useReadingPointer(points: Reading[], indexAt: IndexAt) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const press = useRef<Press | null>(null);
  const shown = hover ?? pinned;
  const lastIndex = points.length - 1;

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const index = indexAt(event.clientX, event.currentTarget.getBoundingClientRect().left);
      if (index === null) return;
      press.current = {
        startX: event.clientX,
        moved: false,
        pinnedBefore: pinned,
        onPinned: pinned === index,
      };
      setPinned(index);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const index = indexAt(event.clientX, event.currentTarget.getBoundingClientRect().left);
      // A mouse that moves with no button down let go of its press elsewhere, and no
      // pointerup reaches the chart for it, so the press is over.
      if (event.pointerType === "mouse" && event.buttons === 0) press.current = null;
      const current = press.current;
      if (current) {
        if (Math.abs(event.clientX - current.startX) >= TAP_MAX_MOVE_PX) current.moved = true;
        if (index !== null) setPinned(index);
      }
      // A touch has no hover: the reading it shows is the pin its scrub sets.
      if (event.pointerType !== "touch") setHover(index);
    },
    onPointerUp: () => {
      const current = press.current;
      press.current = null;
      if (current && !current.moved && current.onPinned) setPinned(null);
    },
    onPointerCancel: () => {
      // The browser took the press for a scroll: the reading it had pinned goes back.
      const current = press.current;
      press.current = null;
      if (current) setPinned(current.pinnedBefore);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      // A touch's pointerleave arrives after its pointerup, so it must not clear the pin.
      if (event.pointerType !== "touch") setHover(null);
    },
    onFocus: () => {
      setPinned((current) => current ?? lastIndex);
    },
    onBlur: () => {
      press.current = null;
      setHover(null);
      setPinned(null);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "Escape") {
        if (shown === null) return;
        event.preventDefault();
        setHover(null);
        setPinned(null);
        return;
      }
      const from = points[shown ?? lastIndex]?.t ?? null;
      const next = stepIndex(points, event.key, from);
      if (next === null) return;
      event.preventDefault();
      // The step is the reading that is read out, so a hover still on screen gives way to it.
      setHover(null);
      setPinned(next);
    },
  };

  return { shown, handlers };
}

export interface ChatSparklineProps {
  /** Names the sparkline for a screen reader, e.g. "DRO short interest". */
  label: string;
  /** The name the tooltip gives the series. Short, since a table cell holds it. Defaults to label. */
  seriesLabel?: string;
  points: Reading[];
  color: string;
  formatValue?: (value: number) => string;
  /** The width in px. A table on a narrow sidebar draws a narrower line. */
  width?: number;
}

/**
 * A tiny line of one stock's recent readings, for a table cell. A hover, or a tap,
 * shows the reading under the pointer: its day and value. Focus shows the latest
 * reading. Focused, the arrow keys step through the readings and Escape clears the
 * reading.
 */
export function ChatSparkline({
  label,
  seriesLabel,
  points,
  color,
  formatValue = formatPercent,
  width = SPARK_WIDTH,
}: ChatSparklineProps) {
  const gradientId = `chat-spark-${useId()}`;

  const scales = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return null;
    let low = Infinity;
    let high = -Infinity;
    for (const point of points) {
      if (point.v < low) low = point.v;
      if (point.v > high) high = point.v;
    }
    // The same padding the chart domains use: 10% of the range, or a fraction
    // of the value when the series is flat.
    const pad = (high - low) * 0.1 || Math.abs(high) * 0.05 || 1;
    return {
      x: scaleTime<number>({
        domain: [new Date(first.t), new Date(last.t)],
        range: [SPARK_PAD, width - SPARK_PAD],
      }),
      y: scaleLinear<number>({
        domain: [low - pad, high + pad],
        range: [SPARK_HEIGHT - SPARK_PAD, SPARK_PAD],
      }),
    };
  }, [points, width]);

  const { shown, handlers } = useReadingPointer(points, (clientX, boxLeft) => {
    if (!scales) return null;
    const near = nearest(points, scales.x.invert(clientX - boxLeft).getTime());
    return near ? points.indexOf(near) : null;
  });

  const tooltipName = seriesLabel ?? label;
  const spec = useMemo<ChartSeriesSpec>(
    () => ({ id: label, label: tooltipName, color, axis: "left", kind: "line", points }),
    [label, tooltipName, color, points],
  );

  // The tooltip is drawn in a portal, positioned in viewport coordinates. A table's
  // scroll region clips anything inside it, so a reading in the first row (under the
  // sticky header) or the last column was cut off. Its position is set before paint,
  // and kept while the chat or the table scrolls. A reading scrolled out of its table or
  // the conversation has no tooltip: it would otherwise float over other content, away
  // from the reading it describes.
  const anchorRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [inView, setInView] = useState(true);
  const placeTip = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const reading = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const visible = readingIsInView(reading, [
      { left: 0, top: 0, right: viewport.width, bottom: viewport.height },
      ...clippingRects(anchor),
    ]);
    setInView(visible);
    const tip = tipRef.current;
    if (!visible || !tip) return;
    const next = placeTooltip(reading, { width: tip.offsetWidth, height: tip.offsetHeight }, viewport);
    setPlace((previous) =>
      previous && previous.left === next.left && previous.top === next.top
        ? previous
        : { left: next.left, top: next.top },
    );
  }, []);
  useLayoutEffect(() => {
    if (shown === null) {
      setPlace(null);
      setInView(true);
      return;
    }
    placeTip();
    // The tooltip's size follows the reading it shows, so it is placed again for each,
    // and again when it comes back into view (it is not rendered while out of it).
  }, [shown, points, formatValue, placeTip, inView]);
  useEffect(() => {
    if (shown === null) return;
    // Scrolling moves the sparkline, and a scroll does not bubble, so it is listened for in the capture phase.
    window.addEventListener("scroll", placeTip, true);
    window.addEventListener("resize", placeTip);
    return () => {
      window.removeEventListener("scroll", placeTip, true);
      window.removeEventListener("resize", placeTip);
    };
  }, [shown, placeTip]);

  if (!scales || points.length < 2) return null;

  const active = shown === null ? null : (points[shown] ?? null);
  const readout: HoverState | null = active
    ? {
        cx: scales.x(new Date(active.t)) ?? 0,
        cy: scales.y(active.v) ?? 0,
        t: active.t,
        entries: [{ series: spec, point: active }],
      }
    : null;

  // A keyboard-driven readout: the arrow keys step through the readings, so the
  // group takes a tab stop and key handlers (the stock chart does the same).
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      role="group"
      aria-roledescription="sparkline"
      aria-label={`${label}. ${points.length} readings. Arrow keys step through them.`}
      data-reading-active={active ? "true" : undefined}
      tabIndex={0}
      style={{ touchAction: "pan-y" }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onPointerLeave={handlers.onPointerLeave}
      onFocus={handlers.onFocus}
      onBlur={handlers.onBlur}
      onKeyDown={handlers.onKeyDown}
      className="relative inline-block rounded-sm align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        ref={anchorRef}
        width={width}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${width} ${SPARK_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
        className="block overflow-visible"
      >
        <SeriesPath
          series={spec}
          xScale={scales.x}
          yScale={scales.y}
          gradientId={gradientId}
        />
        {readout && (
          <circle cx={readout.cx} cy={readout.cy} r={2} fill={color} />
        )}
      </svg>
      {/*
        The tooltip opens above the sparkline on its trailing edge, or below it where
        there is no room above (a row under the sticky header). It is drawn in a portal
        and placed in viewport coordinates, so the table's scroll region cannot clip it.
        It never takes the pointer, so moving up to it does not end the reading.
      */}
      {readout &&
        inView &&
        createPortal(
          <div
            ref={tipRef}
            aria-hidden="true"
            data-testid="chat-spark-tooltip"
            className="pointer-events-none fixed z-[60] w-max whitespace-nowrap"
            style={{
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              visibility: place ? undefined : "hidden",
            }}
          >
            <div
              style={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                padding: "6px 8px",
                boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
              }}
            >
              <TooltipContent
                hover={readout}
                leftAxis={{ side: "left", format: formatValue }}
                formatDate={formatDay}
              />
            </div>
          </div>,
          document.body,
        )}
      <span className="sr-only" aria-live="polite">
        {active ? `${formatDay(active.t)}, ${formatValue(active.v)}` : ""}
      </span>
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}

export interface ChatLineChartProps {
  /** Names the chart for a screen reader, and the series in its tooltip. */
  label: string;
  points: Reading[];
  color: string;
  kind?: "line" | "area";
  /** The whole reading, with its unit, for the tooltip and the caption. */
  formatValue: (value: number) => string;
  /**
   * Tick labels on the value axis, built from the ticks the axis prints so their decimals
   * tell adjacent ticks apart. Defaults to formatValue.
   */
  formatAxis?: TickFormatter;
  /**
   * The latest-value label, which sits on the plot. It carries only the unit's short
   * symbol, so it stays short. Defaults to formatValue.
   */
  formatLatest?: (value: number) => string;
  /** The id of the element that describes the chart, such as its caption. */
  describedBy?: string;
}

const CHART_HEIGHT = 180;
/**
 * The longest time-axis label the chat prints, "14 Sep 2026", in characters. The axis keeps
 * neighbouring labels apart by this width, so a 300px chat chart does not print them touching.
 */
const TIME_LABEL_CHARS = 11;
/** The width drawn before the box is measured (server-free tests, first paint). */
const FALLBACK_WIDTH = 480;
const PLOT_TOP = 16;
const PLOT_RIGHT = 14;
const PLOT_BOTTOM = 22;
/**
 * The most of the chart's width the value axis may take. A long unit label is held to
 * this share, so the plot is never a sliver beside its axis.
 */
const MAX_AXIS_SHARE = 0.4;

/**
 * An interactive line (or area) chart of readings over time. It is the stock
 * page's chart primitives, scales and tooltip at a fixed height. The pointer reads
 * the nearest reading: a hover follows it, and a tap or press pins the reading
 * under it (a touch scrubs, and lifts to pin). The keyboard reads too, with the
 * arrow keys, Home and End, and Escape to clear. A screen reader hears each reading
 * through a live region, and the caption (`describedBy`) gives the summary. Nothing
 * animates, so there is no motion to reduce.
 */
export function ChatLineChart({
  label,
  points,
  color,
  kind = "line",
  formatValue,
  formatAxis,
  formatLatest = formatValue,
  describedBy,
}: ChatLineChartProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(boxRef);
  const width = measured > 0 ? measured : FALLBACK_WIDTH;
  const height = CHART_HEIGHT;
  const gradientId = `chat-line-${useId()}`;

  const spec = useMemo<ChartSeriesSpec>(
    () => ({ id: label, label, color, axis: "left", kind, points }),
    [label, color, kind, points],
  );
  const series = useMemo(() => [spec], [spec]);
  // The ticks come from the data alone, before the margin is known, so the formatter's
  // decimals are fixed by them. The margin then fits the labels those decimals print.
  const ticks = useMemo(
    () => valueAxisTicks({ series, side: "left", numTicks: AXIS_NUM_TICKS }),
    [series],
  );
  const tickFormat = useMemo(
    () => (formatAxis ? formatAxis(ticks) : formatValue),
    [formatAxis, ticks, formatValue],
  );
  const margin = useMemo(
    () => ({
      top: PLOT_TOP,
      right: PLOT_RIGHT,
      bottom: PLOT_BOTTOM,
      // The left margin fits the widest tick label, as the stock chart's does, and is held
      // to a share of the chart: a label too long for that leaves the plot a sliver.
      left: Math.min(
        axisMargin(
          valueAxisLabels({
            series,
            side: "left",
            format: tickFormat,
            numTicks: AXIS_NUM_TICKS,
          }),
        ),
        Math.max(AXIS_MIN_MARGIN_PX, Math.floor(width * MAX_AXIS_SHARE)),
      ),
    }),
    [series, tickFormat, width],
  );
  const { dateScale, leftScale, innerW, innerH } = useChartScales({
    series,
    width,
    height,
    margin,
  });

  const { shown, handlers } = useReadingPointer(points, (clientX, boxLeft) => {
    const near = nearest(points, dateScale.invert(clientX - boxLeft - margin.left).getTime());
    return near ? points.indexOf(near) : null;
  });

  // The tooltip's own width, measured after each render (the setter bails out when the
  // width is unchanged), so it can be held inside the box. A fixed guess is wrong at a
  // phone-width bubble, where the tooltip is wider than the room on either side.
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(0);
  useLayoutEffect(() => {
    const measured = tipRef.current?.offsetWidth ?? 0;
    if (measured !== tipWidth) setTipWidth(measured);
    // The tooltip's text is the reading it shows, so its width changes with the reading.
  }, [shown, points, formatValue, tipWidth]);

  if (points.length < 2) return null;

  const lastIndex = points.length - 1;
  const latest = points[lastIndex]!;
  const latestX = dateScale(new Date(latest.t)) ?? 0;
  const latestY = leftScale(latest.v) ?? 0;
  // The latest label sits above its reading, or below it where the line runs through the
  // space above (the series' own peak). The line is taken in plot coordinates.
  const latestText = formatLatest(latest.v);
  const latestLabel = placeLatestLabel({
    line: points.map((point) => ({
      x: dateScale(new Date(point.t)) ?? 0,
      y: leftScale(point.v) ?? 0,
    })),
    latest: { x: latestX, y: latestY },
    text: latestText,
    plotHeight: innerH,
  });

  const active = shown === null ? null : (points[shown] ?? null);
  const cx = active ? (dateScale(new Date(active.t)) ?? 0) : 0;
  const cy = active ? (leftScale(active.v) ?? 0) : 0;
  const readout: HoverState | null = active
    ? { cx, cy, t: active.t, entries: [{ series: spec, point: active }] }
    : null;
  // The tooltip sits to the right of the crosshair, or to its left when the right side
  // has no room, and never crosses either edge of the box.
  const TIP_GAP = 8;
  const anchorX = margin.left + cx;
  const tipOnRight = anchorX + TIP_GAP + tipWidth <= width;
  const tipLeft = Math.max(
    0,
    Math.min(
      tipOnRight ? anchorX + TIP_GAP : anchorX - TIP_GAP - tipWidth,
      width - tipWidth,
    ),
  );

  return (
    // A keyboard-driven chart: the arrow keys step through the readings, so the
    // group takes a tab stop and key handlers (the stock chart does the same).
    /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
    <div
      ref={boxRef}
      role="group"
      aria-roledescription="interactive chart"
      aria-label={`${label}. Use the left and right arrow keys to read each point.`}
      aria-describedby={describedBy}
      data-reading-active={active ? "true" : undefined}
      tabIndex={0}
      style={{ touchAction: "pan-y" }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onPointerLeave={handlers.onPointerLeave}
      onFocus={handlers.onFocus}
      onBlur={handlers.onBlur}
      onKeyDown={handlers.onKeyDown}
      className="relative w-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full overflow-visible"
        aria-hidden="true"
        focusable="false"
      >
        <g transform={`translate(${margin.left}, ${margin.top})`}>
          <Grid yScale={leftScale} width={innerW} />
          <Axes
            xScale={dateScale}
            leftScale={leftScale}
            rightScale={leftScale}
            innerW={innerW}
            innerH={innerH}
            hasRight={false}
            leftFormat={tickFormat}
            timeFormat={timeTickLabel}
            timeLabelChars={TIME_LABEL_CHARS}
          />
          <SeriesPath
            series={spec}
            xScale={dateScale}
            yScale={leftScale}
            gradientId={gradientId}
          />
          {active && (
            <Crosshair x={cx} dots={[{ y: cy, color }]} innerH={innerH} />
          )}
          <circle cx={latestX} cy={latestY} r={2.5} fill={color} />
          {/*
            The label is outlined in the background colour, so the line does not run
            through its digits where the series peaks near the latest reading. Where the
            line still runs through the space above the reading, the label sits below it
            instead (placeLatestLabel), and it is never placed left of the plot's edge.
            It is not drawn while a reading is on screen: the tooltip sits over the plot's
            top, where the label can fall, and the headline figure would read beside the
            reading's own value.
          */}
          {!readout && (
            <text
              data-testid="chat-latest-label"
              data-placement={latestLabel.placement}
              x={latestLabel.x}
              y={latestLabel.y}
              textAnchor="end"
              fontSize={11}
              fontWeight={600}
              fill={chartTheme.tooltipFg}
              stroke="hsl(var(--background))"
              strokeWidth={3}
              strokeLinejoin="round"
              paintOrder="stroke"
            >
              {latestText}
            </text>
          )}
        </g>
      </svg>
      {readout && (
        <div
          ref={tipRef}
          aria-hidden="true"
          // w-max sizes the tooltip to its text, not to the room left of its `left`: a
          // shrink-to-fit width would wrap it at the right edge, where focus starts.
          className="pointer-events-none absolute top-1 z-20 w-max"
          style={{ left: tipLeft }}
        >
          <div
            style={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              padding: "6px 8px",
              boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
              maxWidth: Math.min(200, width),
            }}
          >
            <TooltipContent
              hover={readout}
              leftAxis={{ side: "left", format: formatValue }}
              formatDate={formatDay}
            />
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {active ? `${formatDay(active.t)}: ${formatValue(active.v)}` : ""}
      </span>
    </div>
    /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  );
}

/** The rendered width of an element, kept current as it resizes. 0 until it is measured. */
function useMeasuredWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setWidth(element.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
