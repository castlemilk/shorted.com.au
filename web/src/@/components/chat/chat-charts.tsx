"use client";

// Every chart in the chat lives in this module, and it is loaded with
// next/dynamic (ssr: false) from the table and result components. visx is
// therefore never part of the eager chat bundle, which the root layout's chat
// sidebar loads on every page.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { scaleLinear, scaleTime } from "@visx/scale";
import { chartTheme } from "~/@/components/charts/chart-theme";
import {
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
  useChartScales,
} from "~/@/components/charts/use-chart-scales";
import { formatDay, formatPercent } from "./chat-tool-format";
import type { Reading } from "./chat-tool-data";

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;
const SPARK_PAD = 2;

export interface ChatSparklineProps {
  /** Names the sparkline for a screen reader, e.g. "DRO short interest". */
  label: string;
  /** The name the tooltip gives the series. Short, since a table cell holds it. Defaults to label. */
  seriesLabel?: string;
  points: Reading[];
  color: string;
  formatValue?: (value: number) => string;
}

/**
 * A tiny line of one stock's recent readings, for a table cell. Hover or focus
 * shows the reading under the pointer or the cursor: its day and value. Focused,
 * the arrow keys step through the readings and Escape clears the reading.
 */
export function ChatSparkline({
  label,
  seriesLabel,
  points,
  color,
  formatValue = formatPercent,
}: ChatSparklineProps) {
  const gradientId = `chat-spark-${useId()}`;
  const [index, setIndex] = useState<number | null>(null);

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
        range: [SPARK_PAD, SPARK_WIDTH - SPARK_PAD],
      }),
      y: scaleLinear<number>({
        domain: [low - pad, high + pad],
        range: [SPARK_HEIGHT - SPARK_PAD, SPARK_PAD],
      }),
    };
  }, [points]);

  const tooltipName = seriesLabel ?? label;
  const spec = useMemo<ChartSeriesSpec>(
    () => ({ id: label, label: tooltipName, color, axis: "left", kind: "line", points }),
    [label, tooltipName, color, points],
  );

  if (!scales || points.length < 2) return null;

  const active = index === null ? null : (points[index] ?? null);
  const hover: HoverState | null = active
    ? {
        cx: scales.x(new Date(active.t)) ?? 0,
        cy: scales.y(active.v) ?? 0,
        t: active.t,
        entries: [{ series: spec, point: active }],
      }
    : null;

  const readingAt = (x: number): number | null => {
    const near = nearest(points, scales.x.invert(x).getTime());
    return near ? points.indexOf(near) : null;
  };

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
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setIndex(readingAt(event.clientX - rect.left));
      }}
      onPointerLeave={() => setIndex(null)}
      onFocus={() => setIndex(points.length - 1)}
      onBlur={() => setIndex(null)}
      onKeyDown={(event) => stepReading(event, points, index, setIndex)}
      className="relative inline-block rounded-sm align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
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
        {hover && (
          <circle cx={hover.cx} cy={hover.cy} r={2} fill={color} />
        )}
      </svg>
      {/*
        The tooltip opens above the sparkline and aligns to its trailing edge. A table
        cell sits at the end of a scroll region, so one that opened to the right or
        below was clipped there. It never takes the pointer, so moving up to it does
        not end the reading.
      */}
      {hover && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 whitespace-nowrap"
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
              hover={hover}
              leftAxis={{ side: "left", format: formatValue }}
            />
          </div>
        </div>
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
  formatValue: (value: number) => string;
  /** Tick labels on the value axis. Defaults to formatValue. */
  formatAxis?: (value: number) => string;
  /** The id of the element that describes the chart, such as its caption. */
  describedBy?: string;
}

const CHART_HEIGHT = 180;
/** The width drawn before the box is measured (server-free tests, first paint). */
const FALLBACK_WIDTH = 480;
const PLOT_TOP = 16;
const PLOT_RIGHT = 14;
const PLOT_BOTTOM = 22;

/**
 * An interactive line (or area) chart of readings over time. It is the stock
 * page's chart primitives, scales and tooltip at a fixed height. The pointer
 * reads the nearest reading; the keyboard does too, with the arrow keys, Home
 * and End, and Escape to clear. A screen reader hears each reading through a
 * live region, and the caption (`describedBy`) gives the summary. Nothing
 * animates, so there is no motion to reduce.
 */
export function ChatLineChart({
  label,
  points,
  color,
  kind = "line",
  formatValue,
  formatAxis,
  describedBy,
}: ChatLineChartProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(boxRef);
  const width = measured > 0 ? measured : FALLBACK_WIDTH;
  const height = CHART_HEIGHT;
  const gradientId = `chat-line-${useId()}`;
  const [index, setIndex] = useState<number | null>(null);

  const spec = useMemo<ChartSeriesSpec>(
    () => ({ id: label, label, color, axis: "left", kind, points }),
    [label, color, kind, points],
  );
  const series = useMemo(() => [spec], [spec]);
  const tickFormat = formatAxis ?? formatValue;
  const margin = useMemo(
    () => ({
      top: PLOT_TOP,
      right: PLOT_RIGHT,
      bottom: PLOT_BOTTOM,
      // The left margin fits the widest tick label, as the stock chart's does.
      left: axisMargin(
        valueAxisLabels({
          series,
          side: "left",
          format: tickFormat,
          numTicks: AXIS_NUM_TICKS,
        }),
      ),
    }),
    [series, tickFormat],
  );
  const { dateScale, leftScale, innerW, innerH } = useChartScales({
    series,
    width,
    height,
    margin,
  });

  // The tooltip's own width, measured after each render (the setter bails out when the
  // width is unchanged), so it can be held inside the box. A fixed guess is wrong at a
  // phone-width bubble, where the tooltip is wider than the room on either side.
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(0);
  useLayoutEffect(() => {
    const measured = tipRef.current?.offsetWidth ?? 0;
    if (measured !== tipWidth) setTipWidth(measured);
  });

  if (points.length < 2) return null;

  const lastIndex = points.length - 1;
  const latest = points[lastIndex]!;
  const latestX = dateScale(new Date(latest.t)) ?? 0;
  const latestY = leftScale(latest.v) ?? 0;

  const active = index === null ? null : (points[index] ?? null);
  const cx = active ? (dateScale(new Date(active.t)) ?? 0) : 0;
  const cy = active ? (leftScale(active.v) ?? 0) : 0;
  const hover: HoverState | null = active
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

  const readingAt = (clientX: number, boxLeft: number): number | null => {
    const near = nearest(points, dateScale.invert(clientX - boxLeft - margin.left).getTime());
    return near ? points.indexOf(near) : null;
  };

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
      onPointerMove={(event) =>
        setIndex(readingAt(event.clientX, event.currentTarget.getBoundingClientRect().left))
      }
      onPointerLeave={() => setIndex(null)}
      onFocus={() => setIndex(lastIndex)}
      onBlur={() => setIndex(null)}
      onKeyDown={(event) => stepReading(event, points, index, setIndex)}
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
            through its digits where the series peaks near the latest reading.
          */}
          <text
            x={latestX}
            y={latestY - 7}
            textAnchor="end"
            fontSize={11}
            fontWeight={600}
            fill={chartTheme.tooltipFg}
            stroke="hsl(var(--background))"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {formatValue(latest.v)}
          </text>
        </g>
      </svg>
      {hover && (
        <div
          ref={tipRef}
          aria-hidden="true"
          className="pointer-events-none absolute top-1 z-20"
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
              hover={hover}
              leftAxis={{ side: "left", format: formatValue }}
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

/**
 * Keyboard stepping for a reading chart: ArrowLeft and ArrowRight move one reading
 * (from the one on screen, else the latest), Home and End jump to the ends, and
 * Escape clears the reading. Chords are left to the browser, Alt+Left above all.
 */
function stepReading(
  event: KeyboardEvent<HTMLElement>,
  points: Reading[],
  index: number | null,
  setIndex: (next: number | null) => void,
) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === "Escape") {
    if (index === null) return;
    event.preventDefault();
    setIndex(null);
    return;
  }
  const from = points[index ?? points.length - 1]?.t ?? null;
  const next = stepIndex(points, event.key, from);
  if (next === null) return;
  event.preventDefault();
  setIndex(next);
}
