"use client";

import { useCallback, useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { LinePath, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import { format } from "date-fns";

type SeriesDef = {
  key: string;
  label: string;
  color: string;
  gradientId: string;
  points: { date: Date; value: number }[];
};
type Dataset = { title: string; series: SeriesDef[]; formatValue: (v: number) => string };

const MARGIN = { top: 16, right: 16, bottom: 26, left: 52 };
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const AXIS_LINE = "hsl(var(--border))";

const DATASETS: Record<string, Dataset> = {
  "hormuz-benchmarks": {
    title: "Benchmark energy prices through the crisis",
    formatValue: (v) => `$${v.toFixed(0)}`,
    series: [
      {
        key: "brent", label: "Brent", color: "#f59e0b", gradientId: "ms-brent",
        points: [
          { date: new Date("2026-02-27"), value: 72 },
          { date: new Date("2026-03-03"), value: 82 },
          { date: new Date("2026-03-10"), value: 126 },
          { date: new Date("2026-03-17"), value: 118 },
          { date: new Date("2026-03-24"), value: 107 },
          { date: new Date("2026-03-31"), value: 102 },
          { date: new Date("2026-04-07"), value: 98 },
          { date: new Date("2026-04-14"), value: 104 },
          { date: new Date("2026-04-21"), value: 101 },
          { date: new Date("2026-04-28"), value: 106 },
          { date: new Date("2026-05-05"), value: 99 },
          { date: new Date("2026-05-12"), value: 97 },
          { date: new Date("2026-05-19"), value: 95 },
          { date: new Date("2026-05-26"), value: 93 },
          { date: new Date("2026-06-02"), value: 96 },
          { date: new Date("2026-06-09"), value: 97 },
          { date: new Date("2026-06-17"), value: 82 },
          { date: new Date("2026-06-23"), value: 78 },
          { date: new Date("2026-06-30"), value: 76 },
          { date: new Date("2026-07-07"), value: 77 },
          { date: new Date("2026-07-10"), value: 76 },
        ],
      },
      {
        key: "ttf", label: "TTF Gas (×10)", color: "#3b82f6", gradientId: "ms-ttf",
        points: [
          { date: new Date("2026-02-27"), value: 30 },
          { date: new Date("2026-03-03"), value: 45 },
          { date: new Date("2026-03-10"), value: 56 },
          { date: new Date("2026-03-17"), value: 52 },
          { date: new Date("2026-03-24"), value: 48 },
          { date: new Date("2026-03-31"), value: 46 },
          { date: new Date("2026-04-07"), value: 44 },
          { date: new Date("2026-04-14"), value: 43 },
          { date: new Date("2026-04-21"), value: 42 },
          { date: new Date("2026-04-28"), value: 41 },
          { date: new Date("2026-05-05"), value: 40 },
          { date: new Date("2026-05-12"), value: 39 },
          { date: new Date("2026-05-19"), value: 38 },
          { date: new Date("2026-05-26"), value: 37 },
          { date: new Date("2026-06-02"), value: 36 },
          { date: new Date("2026-06-09"), value: 35 },
          { date: new Date("2026-06-17"), value: 32 },
          { date: new Date("2026-06-23"), value: 34 },
          { date: new Date("2026-06-30"), value: 35 },
          { date: new Date("2026-07-07"), value: 43 },
          { date: new Date("2026-07-10"), value: 43 },
        ],
      },
      {
        key: "wti", label: "WTI", color: "#10b981", gradientId: "ms-wti",
        points: [
          { date: new Date("2026-02-27"), value: 70 },
          { date: new Date("2026-03-03"), value: 78 },
          { date: new Date("2026-03-10"), value: 118 },
          { date: new Date("2026-03-17"), value: 110 },
          { date: new Date("2026-03-24"), value: 100 },
          { date: new Date("2026-03-31"), value: 95 },
          { date: new Date("2026-04-07"), value: 92 },
          { date: new Date("2026-04-14"), value: 97 },
          { date: new Date("2026-04-21"), value: 94 },
          { date: new Date("2026-04-28"), value: 99 },
          { date: new Date("2026-05-05"), value: 93 },
          { date: new Date("2026-05-12"), value: 90 },
          { date: new Date("2026-05-19"), value: 88 },
          { date: new Date("2026-05-26"), value: 86 },
          { date: new Date("2026-06-02"), value: 93 },
          { date: new Date("2026-06-09"), value: 91 },
          { date: new Date("2026-06-17"), value: 77 },
          { date: new Date("2026-06-23"), value: 73 },
          { date: new Date("2026-06-30"), value: 71 },
          { date: new Date("2026-07-07"), value: 72 },
          { date: new Date("2026-07-10"), value: 71 },
        ],
      },
    ],
  },
};

interface MultiSeriesChartProps {
  dataset: string;
}

export function MultiSeriesChart({ dataset }: MultiSeriesChartProps) {
  const def = DATASETS[dataset];
  // Hooks must run unconditionally — the unknown-dataset early return comes
  // after them (rules-of-hooks).
  const allPoints = useMemo(
    () => def?.series.flatMap((s) => s.points) ?? [],
    [def],
  );
  const dateExtent = useMemo(() => {
    const d = allPoints.map((p) => p.date.getTime());
    return { min: Math.min(...d), max: Math.max(...d) };
  }, [allPoints]);

  if (!def) return null;

  return (
    <figure className="my-8 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold tracking-tight text-foreground">
          {def.title}
        </div>
      </div>
      <div className="h-[300px] w-full px-1 sm:px-2">
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <MultiSeriesCanvas
                width={width}
                height={300}
                series={def.series}
                fmt={def.formatValue}
                dateExtent={dateExtent}
              />
            ) : null
          }
        </ParentSize>
      </div>
      <FigCaption series={def.series} />
    </figure>
  );
}

function FigCaption({ series }: { series: SeriesDef[] }) {
  return (
    <figcaption className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
          <span className="font-semibold text-foreground">{s.label}</span>
        </span>
      ))}
      <span className="ml-auto">Hover for values</span>
    </figcaption>
  );
}

interface CanvasProps {
  width: number;
  height: number;
  series: SeriesDef[];
  fmt: (v: number) => string;
  dateExtent: { min: number; max: number };
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<{ date: Date }, Date>((d) => d.date).left;

function MultiSeriesCanvas({ width, height, series, fmt, dateExtent }: CanvasProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<{ date: Date; values: Record<string, number> }>();

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const yDomain = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      }
    }
    const pad = (max - min) * 0.08 || 1;
    return [min - pad, max + pad];
  }, [series]);

  const xScale = useMemo(
    () =>
      scaleTime({
        domain: [new Date(dateExtent.min), new Date(dateExtent.max)],
        range: [0, innerW],
      }),
    [dateExtent, innerW],
  );

  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: yDomain,
        range: [innerH, 0],
        nice: true,
      }),
    [yDomain, innerH],
  );

  const merged = useMemo(() => {
    const map = new Map<number, Record<string, number>>();
    for (const s of series) {
      for (const p of s.points) {
        const t = p.date.getTime();
        if (!map.has(t)) map.set(t, {});
        map.get(t)![s.key] = p.value;
      }
    }
    return [...map.entries()]
      .map(([t, values]) => ({ date: new Date(t), values }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [series]);

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const point = localPoint(event);
      if (!point) return;
      const x0 = xScale.invert(point.x - MARGIN.left);
      const index = bisectDate(merged, x0, 1);
      const d0 = merged[index - 1];
      const d1 = merged[index];
      if (!d0) return;
      const hit =
        d1 && x0.valueOf() - d0.date.valueOf() > d1.date.valueOf() - x0.valueOf() ? d1 : d0;
      showTooltip({
        tooltipData: hit,
        tooltipLeft: xScale(hit.date) + MARGIN.left,
        tooltipTop: MARGIN.top + 4,
      });
    },
    [merged, xScale, showTooltip],
  );

  if (innerW <= 0 || innerH <= 0) return null;

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label="Multi-series time series chart">
        <defs>
          {series.map((s) => (
            <LinearGradient
              key={s.gradientId}
              id={s.gradientId}
              from={s.color}
              fromOpacity={0.15}
              to={s.color}
              toOpacity={0.01}
            />
          ))}
        </defs>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {series.map((s) => (
            <LinePath
              key={s.key}
              data={s.points}
              x={(d) => xScale(d.date)}
              y={(d) => yScale(d.value)}
              curve={curveMonotoneX}
              stroke={s.color}
              strokeWidth={2}
              strokeOpacity={0.9}
            />
          ))}
          {tooltipOpen && tooltipData && (
            <>
              {series.map((s) => {
                const v = tooltipData.values[s.key];
                if (v === undefined) return null;
                return (
                  <circle
                    key={s.key}
                    cx={xScale(tooltipData.date)}
                    cy={yScale(v)}
                    r={3.5}
                    fill={s.color}
                    stroke="hsl(var(--card))"
                    strokeWidth={1.5}
                    pointerEvents="none"
                  />
                );
              })}
            </>
          )}
          <AxisBottom
            top={innerH}
            scale={xScale}
            numTicks={width > 480 ? 6 : 4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => format(new Date(+v), "d MMM")}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "middle" as const,
            })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={5}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => fmt(Number(v))}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "end" as const,
              dx: "-0.25em",
              dy: "0.3em",
            })}
          />
          <Bar
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={handleMove}
            onTouchMove={handleMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          className="pointer-events-none"
          style={{
            position: "absolute",
            backgroundColor: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 11,
          }}
        >
          <div className="mb-1 font-semibold text-foreground">
            {format(tooltipData.date, "d MMM yyyy")}
          </div>
          {series.map((s) => {
            const v = tooltipData.values[s.key];
            if (v === undefined) return null;
            return (
              <div key={s.key} className="flex items-center gap-2 text-[11px]">
                <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
                <span className="font-semibold text-foreground">{s.label}</span>
                <span className="ml-auto font-mono text-muted-foreground">{fmt(v)}</span>
              </div>
            );
          })}
        </TooltipWithBounds>
      )}
    </div>
  );
}
