"use client";

import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom } from "@visx/axis";
import { TooltipWithBounds } from "@visx/tooltip";

import {
  AMBER,
  AXIS_LINE,
  AXIS_TEXT,
  TOOLTIP_STYLE,
} from "~/@/components/features/housing/charts/chart-theme";

export type FyBucketFormat = "aud" | "count" | "tonnes";

export interface FyBucketDatum {
  /** Australian financial-year label, e.g. "2023-24". */
  label: string;
  value: number;
  /** Records contributing to the bucket. */
  recordCount: number;
  /** Distinct matched entities in the bucket. */
  entityCount: number;
}

const HEIGHT = 220;
const MARGIN = { top: 20, right: 8, bottom: 26, left: 8 };

const FORMATTERS: Record<FyBucketFormat, (value: number) => string> = {
  aud: (value) =>
    new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value),
  count: (value) =>
    new Intl.NumberFormat("en-AU", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value),
  tonnes: (value) =>
    `${new Intl.NumberFormat("en-AU", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value)} t`,
};

function ChartInner({
  width,
  data,
  format,
  ariaLabel,
}: {
  width: number;
  data: FyBucketDatum[];
  format: FyBucketFormat;
  ariaLabel: string;
}) {
  const [hovered, setHovered] = useState<{
    datum: FyBucketDatum;
    left: number;
    top: number;
  } | null>(null);

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const small = width < 480;
  const fmt = FORMATTERS[format];

  const xScale = useMemo(
    () =>
      scaleBand({
        domain: data.map((d) => d.label),
        range: [0, innerWidth],
        paddingInner: 0.35,
        paddingOuter: 0.15,
      }),
    [data, innerWidth],
  );
  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, Math.max(...data.map((d) => d.value), 1)],
        range: [innerHeight, 0],
        nice: true,
      }),
    [data, innerHeight],
  );

  if (innerWidth <= 0) return null;

  const maxValue = Math.max(...data.map((d) => d.value));
  const barWidth = Math.min(xScale.bandwidth(), 44);
  // Direct-label only the peak and the most recent bucket (selective labels).
  const labelled = new Set<string>([
    data[data.length - 1]!.label,
    data.find((d) => d.value === maxValue)!.label,
  ]);

  return (
    <div className="relative" style={{ width, height: HEIGHT }}>
      <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {data.map((d) => {
            const x =
              (xScale(d.label) ?? 0) + (xScale.bandwidth() - barWidth) / 2;
            const y = yScale(d.value);
            const barHeight = Math.max(innerHeight - y, d.value > 0 ? 2 : 0);
            const isHovered = hovered?.datum.label === d.label;
            return (
              <g key={d.label}>
                <rect
                  x={x}
                  y={innerHeight - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx={3}
                  fill={AMBER}
                  opacity={hovered && !isHovered ? 0.5 : 0.9}
                />
                {/* square off the baseline so rounding only shows at the data end */}
                {barHeight > 4 ? (
                  <rect
                    x={x}
                    y={innerHeight - 3}
                    width={barWidth}
                    height={3}
                    fill={AMBER}
                    opacity={hovered && !isHovered ? 0.5 : 0.9}
                  />
                ) : null}
                {labelled.has(d.label) && !small ? (
                  <text
                    x={x + barWidth / 2}
                    y={innerHeight - barHeight - 6}
                    textAnchor="middle"
                    fontSize={10}
                    fill={AXIS_TEXT}
                    className="font-mono tabular-nums"
                  >
                    {fmt(d.value)}
                  </text>
                ) : null}
                {/* hover hit target wider than the mark */}
                <rect
                  x={xScale(d.label) ?? 0}
                  y={0}
                  width={xScale.bandwidth()}
                  height={innerHeight}
                  fill="transparent"
                  onMouseEnter={() =>
                    setHovered({
                      datum: d,
                      left: x + barWidth / 2 + MARGIN.left,
                      top: innerHeight - barHeight + MARGIN.top,
                    })
                  }
                  onMouseLeave={() => setHovered(null)}
                />
              </g>
            );
          })}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            stroke={AXIS_LINE}
            hideTicks
            numTicks={
              small ? 4 : Math.min(data.length, Math.floor(innerWidth / 72))
            }
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 9.5,
              textAnchor: "middle",
            })}
          />
        </g>
      </svg>

      {hovered ? (
        <TooltipWithBounds
          left={hovered.left}
          top={hovered.top}
          style={TOOLTIP_STYLE}
        >
          <div className="font-mono font-semibold">FY {hovered.datum.label}</div>
          <div>
            <span className="font-mono tabular-nums">
              {fmt(hovered.datum.value)}
            </span>
          </div>
          <div className="text-muted-foreground">
            {hovered.datum.recordCount} records · {hovered.datum.entityCount}{" "}
            entities
          </div>
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

/**
 * Financial-year bucket totals for one metric of one evidence channel. Single
 * amber series; identity comes from the surrounding channel section.
 */
export function FyBucketBarChart({
  data,
  format,
  ariaLabel,
}: {
  data: FyBucketDatum[];
  format: FyBucketFormat;
  ariaLabel: string;
}) {
  if (data.length === 0) return null;
  return (
    <ParentSize className="min-w-0">
      {({ width }) =>
        width > 0 ? (
          <ChartInner
            width={width}
            data={data}
            format={format}
            ariaLabel={ariaLabel}
          />
        ) : null
      }
    </ParentSize>
  );
}
