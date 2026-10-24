"use client";

// Every chart in the chat lives in this module, and it is loaded with
// next/dynamic (ssr: false) from the table and result components. visx is
// therefore never part of the eager chat bundle, which the root layout's chat
// sidebar loads on every page.

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { scaleLinear, scaleTime } from "@visx/scale";
import { SeriesPath } from "~/@/components/charts/chart-primitives";
import { stepIndex, TooltipContent, type HoverState } from "~/@/components/charts/chart-tooltip";
import { nearest } from "~/@/components/charts/nearest";
import type { ChartSeriesSpec } from "~/@/components/charts/types";
import { formatDay, formatPercent } from "./chat-tool-format";
import type { Reading } from "./chat-tool-data";

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;
const SPARK_PAD = 2;

export interface ChatSparklineProps {
  /** Names the sparkline for a screen reader, e.g. "DRO short interest". */
  label: string;
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

  const spec = useMemo<ChartSeriesSpec>(
    () => ({ id: label, label, color, axis: "left", kind: "line", points }),
    [label, color, points],
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
      {hover && (
        <div
          aria-hidden="true"
          className="absolute left-0 top-full z-20 mt-1 whitespace-nowrap"
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
