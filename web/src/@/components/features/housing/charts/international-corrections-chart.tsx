"use client";

import { useCallback, useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { Line, LinePath, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { cn } from "@/lib/utils";
import { COUNTRY_SERIES } from "../data/series";
import type { CountrySeries } from "../data/types";
import { AXIS_LINE, AXIS_TEXT, TOOLTIP_STYLE } from "./chart-theme";
import { SegmentedToggle } from "./chart-ui";

type View = "aligned" | "calendar";
type Pt = { x: number; y: number };

const MARGIN = { top: 18, right: 48, bottom: 30, left: 34 };
const HEIGHT = 400;

function peakValue(c: CountrySeries): number {
  return c.data.find((d) => d.year === c.peakYear)?.value ?? 100;
}

function pointsFor(c: CountrySeries, view: View): Pt[] {
  if (view === "aligned") {
    const peak = peakValue(c);
    return c.data
      .filter((d) => d.year >= c.peakYear)
      .map((d) => ({ x: d.year - c.peakYear, y: (d.value / peak) * 100 }));
  }
  return c.data.map((d) => ({ x: d.year, y: d.value }));
}

function ChartInner({
  width,
  view,
  visible,
}: {
  width: number;
  view: View;
  visible: Record<string, boolean>;
}) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<{ x: number; rows: { code: string; color: string; y: number }[] }>();

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const small = width < 520;

  const shown = COUNTRY_SERIES.filter((c) => visible[c.code]);

  const series = useMemo(
    () => shown.map((c) => ({ c, pts: pointsFor(c, view) })),
    [shown, view],
  );

  const { xDomain, yDomain, lookups } = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    const lk: Record<string, Map<number, number>> = {};
    for (const { c, pts } of series) {
      lk[c.code] = new Map();
      for (const p of pts) {
        xMin = Math.min(xMin, p.x);
        xMax = Math.max(xMax, p.x);
        yMin = Math.min(yMin, p.y);
        yMax = Math.max(yMax, p.y);
        lk[c.code]!.set(p.x, p.y);
      }
    }
    if (!isFinite(xMin)) {
      xMin = 0; xMax = 1; yMin = 0; yMax = 100;
    }
    const yPad = (yMax - yMin) * 0.08 || 5;
    return {
      xDomain: [view === "aligned" ? 0 : xMin, xMax] as [number, number],
      yDomain: [yMin - yPad, yMax + yPad] as [number, number],
      lookups: lk,
    };
  }, [series, view]);

  const xScale = useMemo(
    () => scaleLinear({ domain: xDomain, range: [0, innerWidth] }),
    [xDomain, innerWidth],
  );
  const yScale = useMemo(
    () => scaleLinear({ domain: yDomain, range: [innerHeight, 0], nice: true }),
    [yDomain, innerHeight],
  );

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const p = localPoint(event);
      if (!p) return;
      const xv = Math.round(xScale.invert(p.x - MARGIN.left));
      const rows: { code: string; color: string; y: number }[] = [];
      for (const { c } of series) {
        const y = lookups[c.code]?.get(xv);
        if (y !== undefined) rows.push({ code: c.code, color: c.color, y });
      }
      if (rows.length === 0) return;
      showTooltip({
        tooltipData: { x: xv, rows },
        tooltipLeft: xScale(xv) + MARGIN.left,
        tooltipTop: MARGIN.top + 8,
      });
    },
    [xScale, series, lookups, showTooltip],
  );

  if (innerWidth <= 0) return null;

  return (
    <div className="relative" style={{ width, height: HEIGHT }}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Real house-price indices across Australia, Japan, the US and China">
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* peak=100 reference in aligned view */}
          {view === "aligned" ? (
            <Line
              from={{ x: 0, y: yScale(100) }}
              to={{ x: innerWidth, y: yScale(100) }}
              stroke={AXIS_LINE}
              strokeWidth={1}
              strokeDasharray="2,3"
              opacity={0.6}
            />
          ) : null}

          {series.map(({ c, pts }) => {
            const last = pts[pts.length - 1];
            return (
              <g key={c.code}>
                <LinePath<Pt>
                  data={pts}
                  x={(d) => xScale(d.x)}
                  y={(d) => yScale(d.y)}
                  curve={curveMonotoneX}
                  stroke={c.color}
                  strokeWidth={c.code === "AUS" ? 2.5 : 1.75}
                  opacity={c.code === "AUS" ? 1 : 0.9}
                />
                {last ? (
                  <text
                    x={Math.min(xScale(last.x) + 5, innerWidth + MARGIN.right - 4)}
                    y={yScale(last.y) + 3}
                    fill={c.color}
                    fontSize={small ? 9 : 10}
                    className="font-mono font-semibold"
                  >
                    {c.code}
                  </text>
                ) : null}
              </g>
            );
          })}

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={small ? 5 : 9}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => {
              const n = Number(v);
              if (view === "calendar") return `${n}`;
              if (n === 0) return "peak";
              return `${n > 0 ? "+" : ""}${n}`;
            }}
            tickLabelProps={() => ({ fill: AXIS_TEXT, fontSize: 10, textAnchor: "middle" })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickLabelProps={() => ({ fill: AXIS_TEXT, fontSize: 9, textAnchor: "end", dx: "-0.25em", dy: "0.3em" })}
          />

          {tooltipOpen && tooltipData ? (
            <Line
              from={{ x: xScale(tooltipData.x), y: 0 }}
              to={{ x: xScale(tooltipData.x), y: innerHeight }}
              stroke={AXIS_TEXT}
              strokeWidth={1}
              opacity={0.35}
              pointerEvents="none"
            />
          ) : null}

          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMove}
            onTouchMove={handleMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>

      {tooltipOpen && tooltipData ? (
        <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={TOOLTIP_STYLE}>
          <div className="mb-0.5 font-mono font-semibold">
            {view === "aligned"
              ? tooltipData.x === 0
                ? "at the peak"
                : `${tooltipData.x > 0 ? "+" : ""}${tooltipData.x} yrs from peak`
              : tooltipData.x}
          </div>
          {tooltipData.rows.map((r) => (
            <div key={r.code}>
              <span style={{ color: r.color }}>{r.code}</span>{" "}
              <span className="font-mono tabular-nums">{r.y.toFixed(0)}</span>
            </div>
          ))}
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

/**
 * Dashboard ④ — real house-price indices (BIS, inflation-adjusted) for the four
 * markets. "Aligned" overlays each market's trajectory from its own cyclical
 * peak (=100) so the crash shapes compare directly; "calendar" shows the raw
 * 2010=100 levels. Japan and the US collapsed and ground back; China is sliding;
 * Australia barely dipped, then made new highs.
 */
export function InternationalCorrectionsChart() {
  const [view, setView] = useState<View>("aligned");
  const [visible, setVisible] = useState<Record<string, boolean>>(
    Object.fromEntries(COUNTRY_SERIES.map((c) => [c.code, true])),
  );

  const toggle = (code: string) =>
    setVisible((v) => {
      const next = { ...v, [code]: !v[code] };
      // never let all four switch off
      if (Object.values(next).every((on) => !on)) return v;
      return next;
    });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-2 sm:px-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {COUNTRY_SERIES.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => toggle(c.code)}
              aria-pressed={visible[c.code]}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[0.7rem] transition-[opacity,color,background-color,border-color] duration-200 ease-out",
                visible[c.code]
                  ? "border-border bg-card text-foreground"
                  : "border-transparent text-muted-foreground opacity-50 hover:opacity-80",
              )}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.color }} />
              {c.name}
            </button>
          ))}
        </div>
        <SegmentedToggle<View>
          ariaLabel="Chart view"
          value={view}
          onChange={setView}
          options={[
            { value: "aligned", label: "From peak" },
            { value: "calendar", label: "Calendar" },
          ]}
        />
      </div>

      <ParentSize className="min-w-0">
        {({ width }) => (width > 0 ? <ChartInner width={width} view={view} visible={visible} /> : null)}
      </ParentSize>

      <ul className="mt-3 grid gap-x-5 gap-y-1 px-2 sm:grid-cols-2 sm:px-3">
        {COUNTRY_SERIES.map((c) => (
          <li key={c.code} className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
            <span>
              <span className="font-semibold text-foreground">{c.name}</span> — {c.crashNote}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
