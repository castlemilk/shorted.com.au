"use client";

import { useCallback, useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { LinePath, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import { format } from "date-fns";

type SeriesDef = {
  key: string;
  label: string;
  /** short name for the direct end-label (falls back to label) */
  endLabel?: string;
  color: string;
  /** formats the RAW value for tooltips (e.g. $76, €43) */
  formatRaw: (v: number) => string;
  points: { date: Date; value: number }[];
};
type EventDef = { date: Date; label: string };
type Dataset = {
  title: string;
  subtitle?: string;
  series: SeriesDef[];
  events?: EventDef[];
};

const MARGIN = { top: 44, right: 52, bottom: 26, left: 44 };
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const AXIS_LINE = "hsl(var(--border))";
const SURFACE = "hsl(var(--card))";

// Categorical slots validated vs light #fdfcfa and dark #121212 surfaces.
const SLOT_1 = "#d97706"; // amber — lead series
const SLOT_2 = "#2563eb"; // blue
const SLOT_3 = "#059669"; // emerald

const usd = (v: number) => `$${v.toFixed(0)}`;
const usd1 = (v: number) => `$${v.toFixed(1)}`;
const eur = (v: number) => `€${v.toFixed(0)}`;

// Weekly closes reconstructed from verified anchors (EIA, IEA OMR, Reuters,
// Platts/IEA GMR, TradingEconomics); key sessions exact, intervening weeks
// interpolated between anchors.
const DATASETS: Record<string, Dataset> = {
  "hormuz-benchmarks": {
    title: "Oil round-tripped. Gas didn't.",
    subtitle:
      "Brent crude, European gas (TTF) and Asian spot LNG (JKM), indexed to 100 on 27 February 2026 — the eve of the closure",
    events: [
      { date: new Date("2026-02-28"), label: "Closure" },
      { date: new Date("2026-03-19"), label: "Ras Laffan hit" },
      { date: new Date("2026-04-07"), label: "April ceasefire" },
      { date: new Date("2026-06-17"), label: "MOU signed" },
      { date: new Date("2026-07-07"), label: "Re-escalation" },
    ],
    series: [
      {
        key: "brent", label: "Brent crude", endLabel: "Brent", color: SLOT_1, formatRaw: usd,
        points: [
          { date: new Date("2026-02-27"), value: 72 },
          { date: new Date("2026-03-02"), value: 79 },
          { date: new Date("2026-03-06"), value: 96 },
          { date: new Date("2026-03-13"), value: 108 },
          { date: new Date("2026-03-20"), value: 114 },
          { date: new Date("2026-03-27"), value: 112.6 },
          { date: new Date("2026-03-31"), value: 118 },
          { date: new Date("2026-04-07"), value: 116 },
          { date: new Date("2026-04-08"), value: 99 },
          { date: new Date("2026-04-17"), value: 104 },
          { date: new Date("2026-04-24"), value: 110 },
          { date: new Date("2026-04-30"), value: 118 },
          { date: new Date("2026-05-08"), value: 112 },
          { date: new Date("2026-05-15"), value: 110 },
          { date: new Date("2026-05-22"), value: 108 },
          { date: new Date("2026-05-29"), value: 104 },
          { date: new Date("2026-06-05"), value: 97 },
          { date: new Date("2026-06-10"), value: 94.5 },
          { date: new Date("2026-06-15"), value: 83.1 },
          { date: new Date("2026-06-19"), value: 80.6 },
          { date: new Date("2026-06-26"), value: 72 },
          { date: new Date("2026-07-01"), value: 69.5 },
          { date: new Date("2026-07-08"), value: 78 },
          { date: new Date("2026-07-10"), value: 76 },
        ],
      },
      {
        key: "ttf", label: "TTF gas (Europe)", endLabel: "TTF", color: SLOT_2, formatRaw: eur,
        points: [
          { date: new Date("2026-02-27"), value: 31 },
          { date: new Date("2026-03-02"), value: 46 },
          { date: new Date("2026-03-06"), value: 50 },
          { date: new Date("2026-03-13"), value: 56 },
          { date: new Date("2026-03-20"), value: 65 },
          { date: new Date("2026-03-27"), value: 58 },
          { date: new Date("2026-03-31"), value: 55 },
          { date: new Date("2026-04-10"), value: 50 },
          { date: new Date("2026-04-17"), value: 47 },
          { date: new Date("2026-04-24"), value: 45 },
          { date: new Date("2026-04-30"), value: 46 },
          { date: new Date("2026-05-08"), value: 48 },
          { date: new Date("2026-05-15"), value: 47 },
          { date: new Date("2026-05-22"), value: 46 },
          { date: new Date("2026-05-29"), value: 45 },
          { date: new Date("2026-06-05"), value: 44 },
          { date: new Date("2026-06-12"), value: 44 },
          { date: new Date("2026-06-17"), value: 43 },
          { date: new Date("2026-06-26"), value: 41 },
          { date: new Date("2026-07-01"), value: 44 },
          { date: new Date("2026-07-08"), value: 47.5 },
          { date: new Date("2026-07-10"), value: 49.9 },
        ],
      },
      {
        key: "jkm", label: "JKM LNG (Asia spot)", endLabel: "JKM", color: SLOT_3, formatRaw: usd1,
        points: [
          { date: new Date("2026-02-27"), value: 10.8 },
          { date: new Date("2026-03-02"), value: 16 },
          { date: new Date("2026-03-06"), value: 21 },
          { date: new Date("2026-03-13"), value: 20 },
          { date: new Date("2026-03-19"), value: 25.4 },
          { date: new Date("2026-03-27"), value: 22 },
          { date: new Date("2026-03-31"), value: 21 },
          { date: new Date("2026-04-10"), value: 18.5 },
          { date: new Date("2026-04-24"), value: 16 },
          { date: new Date("2026-05-08"), value: 18 },
          { date: new Date("2026-05-15"), value: 18.2 },
          { date: new Date("2026-05-22"), value: 17.8 },
          { date: new Date("2026-05-29"), value: 17.4 },
          { date: new Date("2026-06-05"), value: 17 },
          { date: new Date("2026-06-12"), value: 16.5 },
          { date: new Date("2026-06-19"), value: 15.6 },
          { date: new Date("2026-06-26"), value: 15.4 },
          { date: new Date("2026-07-03"), value: 15.8 },
          { date: new Date("2026-07-08"), value: 16.4 },
          { date: new Date("2026-07-10"), value: 16.6 },
        ],
      },
    ],
  },
};

type IndexedSeries = SeriesDef & {
  base: number;
  indexed: { date: Date; value: number; raw: number }[];
};

interface MultiSeriesChartProps {
  dataset: string;
}

export function MultiSeriesChart({ dataset }: MultiSeriesChartProps) {
  const def = DATASETS[dataset];
  // Hooks must run unconditionally — the unknown-dataset early return comes
  // after them (rules-of-hooks).
  const indexed: IndexedSeries[] = useMemo(
    () =>
      (def?.series ?? []).map((s) => {
        const base = s.points[0]?.value ?? 1;
        return {
          ...s,
          base,
          indexed: s.points.map((p) => ({
            date: p.date,
            value: (p.value / base) * 100,
            raw: p.value,
          })),
        };
      }),
    [def],
  );
  const dateExtent = useMemo(() => {
    const d = indexed.flatMap((s) => s.indexed.map((p) => p.date.getTime()));
    return { min: Math.min(...d), max: Math.max(...d) };
  }, [indexed]);

  if (!def) return null;

  return (
    <figure className="my-8 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold tracking-tight text-foreground">
          {def.title}
        </div>
        {def.subtitle && (
          <div className="mt-0.5 text-xs text-muted-foreground">{def.subtitle}</div>
        )}
      </div>
      <div className="h-[320px] w-full px-1 sm:px-2">
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <MultiSeriesCanvas
                width={width}
                height={320}
                series={indexed}
                events={def.events ?? []}
                dateExtent={dateExtent}
              />
            ) : null
          }
        </ParentSize>
      </div>
      <FigCaption series={indexed} />
    </figure>
  );
}

function FigCaption({ series }: { series: IndexedSeries[] }) {
  return (
    <figcaption className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
          <span className="font-semibold text-foreground">{s.label}</span>
          <span>from {s.formatRaw(s.base)}</span>
        </span>
      ))}
    </figcaption>
  );
}

interface CanvasProps {
  width: number;
  height: number;
  series: IndexedSeries[];
  events: EventDef[];
  dateExtent: { min: number; max: number };
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<{ date: Date }, Date>((d) => d.date).left;

function MultiSeriesCanvas({ width, height, series, events, dateExtent }: CanvasProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<{ date: Date; values: Record<string, { value: number; raw: number }> }>();

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const yDomain = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (const p of s.indexed) {
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
    const map = new Map<number, Record<string, { value: number; raw: number }>>();
    for (const s of series) {
      for (const p of s.indexed) {
        const t = p.date.getTime();
        if (!map.has(t)) map.set(t, {});
        map.get(t)![s.key] = { value: p.value, raw: p.raw };
      }
    }
    return [...map.entries()]
      .map(([t, values]) => ({ date: new Date(t), values }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [series]);

  // Event labels: stagger onto two tiers when neighbours would collide.
  // Below ~440px of plot there is no honest way to fit them — keep the
  // hairlines, drop the text (tooltip still carries the dates).
  const showEventText = innerW >= 440;
  const eventLabels = useMemo(() => {
    const CHAR_W = 5.6;
    const placed: { label: string; x: number; tier: number }[] = [];
    for (const e of [...events].sort((a, b) => a.date.getTime() - b.date.getTime())) {
      const x = xScale(e.date);
      if (x < 0 || x > innerW) continue;
      const halfW = (e.label.length * CHAR_W) / 2;
      const prev = placed[placed.length - 1];
      const collides =
        prev && x - halfW < prev.x + (prev.label.length * CHAR_W) / 2 + 6;
      const tier = collides ? (prev!.tier === 0 ? 1 : 0) : 0;
      placed.push({ label: e.label, x, tier });
    }
    return placed;
  }, [events, xScale, innerW]);

  // End labels: nudge apart when lines converge at the right edge.
  const endLabels = useMemo(() => {
    const labels = series
      .map((s) => {
        const last = s.indexed[s.indexed.length - 1];
        return last
          ? {
              key: s.key,
              label: s.endLabel ?? s.label,
              color: s.color,
              y: yScale(last.value),
            }
          : null;
      })
      .filter((l): l is NonNullable<typeof l> => l !== null)
      .sort((a, b) => a.y - b.y);
    const MIN_GAP = 14;
    for (let i = 1; i < labels.length; i++) {
      const prev = labels[i - 1]!;
      const cur = labels[i]!;
      if (cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP;
    }
    return labels;
  }, [series, yScale]);

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
      <svg width={width} height={height} role="img" aria-label="Benchmark energy prices, indexed to the eve of the closure">
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* 100 = pre-crisis reference line */}
          <line
            x1={0}
            x2={innerW}
            y1={yScale(100)}
            y2={yScale(100)}
            stroke={AXIS_LINE}
            strokeWidth={1}
          />
          {/* event annotations — labels staggered onto two tiers */}
          {eventLabels.map((e) => (
            <g key={e.label}>
              <line
                x1={e.x}
                x2={e.x}
                y1={showEventText ? (e.tier === 1 ? -22 : -8) : 0}
                y2={innerH}
                stroke={AXIS_LINE}
                strokeWidth={1}
              />
              {showEventText && (
                <text
                  x={e.x}
                  y={e.tier === 1 ? -28 : -14}
                  textAnchor="middle"
                  fill={AXIS_TEXT}
                  fontSize={9.5}
                >
                  {e.label}
                </text>
              )}
            </g>
          ))}
          {series.map((s) => (
            <LinePath
              key={s.key}
              data={s.indexed}
              x={(d) => xScale(d.date)}
              y={(d) => yScale(d.value)}
              curve={curveMonotoneX}
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {/* end markers with a surface ring */}
          {series.map((s) => {
            const last = s.indexed[s.indexed.length - 1];
            if (!last) return null;
            return (
              <circle
                key={`${s.key}-end`}
                cx={xScale(last.date)}
                cy={yScale(last.value)}
                r={4}
                fill={s.color}
                stroke={SURFACE}
                strokeWidth={2}
              />
            );
          })}
          {/* direct end-labels */}
          {endLabels.map((l) => (
            <text
              key={l.key}
              x={innerW + 8}
              y={l.y}
              dominantBaseline="middle"
              fill={AXIS_TEXT}
              fontSize={10}
              fontWeight={600}
            >
              {l.label}
            </text>
          ))}
          {tooltipOpen && tooltipData && (
            <>
              <line
                x1={xScale(tooltipData.date)}
                x2={xScale(tooltipData.date)}
                y1={0}
                y2={innerH}
                stroke={AXIS_TEXT}
                strokeWidth={1}
                strokeOpacity={0.4}
                pointerEvents="none"
              />
              {series.map((s) => {
                const v = tooltipData.values[s.key];
                if (v === undefined) return null;
                return (
                  <circle
                    key={s.key}
                    cx={xScale(tooltipData.date)}
                    cy={yScale(v.value)}
                    r={3.5}
                    fill={s.color}
                    stroke={SURFACE}
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
            numTicks={width > 480 ? 6 : 3}
            tickValues={
              width <= 480
                ? xScale.ticks(6).filter((_, i) => i % 2 === 0)
                : undefined
            }
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => format(new Date(+v), width > 480 ? "d MMM" : "MMM")}
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
            tickFormat={(v) => `${Number(v).toFixed(0)}`}
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
                <span
                  className="ml-auto font-mono text-muted-foreground"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {s.formatRaw(v.raw)}
                  {" · "}
                  {v.value >= 100 ? "+" : "−"}
                  {Math.abs(v.value - 100).toFixed(0)}%
                </span>
              </div>
            );
          })}
        </TooltipWithBounds>
      )}
    </div>
  );
}
