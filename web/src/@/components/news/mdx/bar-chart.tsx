"use client";

import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom } from "@visx/axis";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";

type BarDef = { label: string; value: number };

type BarDataset = {
  title: string;
  subtitle?: string;
  formatValue: (v: number) => string;
  bars: BarDef[];
  /** Values on both sides of a zero baseline (two-pole diverging colors). */
  diverging?: boolean;
  footnote?: string;
};

const THEME_AMBER = "hsl(var(--primary))";
const THEME_MUTED = "hsl(var(--muted-foreground))";
const THEME_BORDER = "hsl(var(--border))";
const POPOVER_BG = "hsl(var(--popover))";
const POPOVER_FG = "hsl(var(--popover-foreground))";

// Diverging poles (validated vs light #fdfcfa and dark #121212 surfaces):
// negative = red, positive = blue, neutral zero baseline.
const POLE_NEG = "#dc2626";
const POLE_POS = "#2563eb";

const MARGIN = { top: 12, right: 52, bottom: 40 };
const MAX_BAR_THICKNESS = 24;
const LABEL_CHAR_W = 6.4;

const DATASETS: Record<string, BarDataset> = {
  "hormuz-lng-dependence": {
    title: "South Asia's LNG lifeline runs through the strait",
    subtitle: "Qatar + UAE share of 2025 LNG imports (Wood Mackenzie)",
    formatValue: (v) => `${v.toFixed(0)}%`,
    bars: [
      { label: "Pakistan", value: 99 },
      { label: "Bangladesh", value: 63 },
      { label: "India", value: 59 },
    ],
    footnote:
      "Pakistan sourced almost all of its 6.6 Mt of 2025 imports from Qatar. Roughly a fifth of globally traded LNG transited the strait before the closure.",
  },
  "hormuz-gdp-revision": {
    title: "IMF 2026 growth downgrades since the war began",
    subtitle: "Percentage points vs pre-war forecasts (WEO April + July 2026 updates)",
    formatValue: (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}pp`,
    diverging: true,
    bars: [
      { label: "Qatar", value: -14.7 },
      { label: "MENA", value: -2.8 },
      { label: "Mid-East & C. Asia", value: -1.7 },
      { label: "Saudi Arabia", value: -1.4 },
      { label: "United Kingdom", value: -0.5 },
      { label: "Global", value: -0.3 },
      { label: "Australia", value: -0.1 },
      { label: "United States", value: 0.0 },
    ],
    footnote:
      "Qatar vs October 2025 WEO; others vs January 2026 update. Global reflects the July update (3.0%).",
  },
  "hormuz-shipping-costs": {
    title: "What the crisis did to shipping costs",
    subtitle: "Peak level as a multiple of the pre-crisis baseline",
    formatValue: (v) => `${v.toFixed(1)}×`,
    bars: [
      { label: "War-risk insurance", value: 20 },
      { label: "VLCC spot rate", value: 8.5 },
      { label: "Baltic Dirty Tanker", value: 2.5 },
      { label: "Container rates (WCI)", value: 1.4 },
    ],
    footnote:
      "War-risk cover: ~0.25% of hull value pre-crisis to a ~5% market norm in July. VLCC: record $423,736/day on 2 March vs ~$50,000 baseline.",
  },
  "hormuz-reopening-odds": {
    title: "What prediction markets give a return to normal traffic",
    subtitle: "Polymarket implied probability, 11 July 2026",
    formatValue: (v) => (v > 0 && v < 1 ? "<1%" : `${v.toFixed(0)}%`),
    bars: [
      { label: "By 15 July", value: 0.5 },
      { label: "By 31 July", value: 8.5 },
      { label: "By 31 December", value: 83 },
    ],
    footnote:
      "Resolution: IMF PortWatch 7-day average of transit calls at or above 60/day. April, May and June contracts all resolved No.",
  },
};

/**
 * Horizontal bar path: square at the baseline, 4px-rounded at the data end.
 * `x` is the baseline edge, `w` extends right when positive, left when negative.
 */
function barPath(x: number, y: number, w: number, h: number, sign: 1 | -1): string {
  const r = Math.min(4, Math.abs(w), h / 2);
  if (Math.abs(w) < 0.5) return "";
  if (sign > 0) {
    const x1 = x + w;
    return `M${x},${y} H${x1 - r} A${r},${r} 0 0 1 ${x1},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x1 - r},${y + h} H${x} Z`;
  }
  const x1 = x + w; // w negative → x1 left of x
  return `M${x},${y} H${x1 + r} A${r},${r} 0 0 0 ${x1},${y + r} V${y + h - r} A${r},${r} 0 0 0 ${x1 + r},${y + h} H${x} Z`;
}

interface BarChartProps {
  dataset: string;
}

export function BarChart({ dataset }: BarChartProps) {
  const def = DATASETS[dataset];
  if (!def) return null;

  return (
    <figure className="my-8 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold tracking-tight text-foreground">
          {def.title}
        </div>
        {def.subtitle && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {def.subtitle}
          </div>
        )}
      </div>
      <div className="h-[280px] w-full px-1 sm:px-2">
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <BarCanvas width={width} height={280} def={def} />
            ) : null
          }
        </ParentSize>
      </div>
      {def.footnote && (
        <figcaption className="border-t border-border px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {def.footnote}
        </figcaption>
      )}
    </figure>
  );
}

interface CanvasProps {
  width: number;
  height: number;
  def: BarDataset;
}

function BarCanvas({ width, height, def }: CanvasProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<BarDef>();

  const [hovered, setHovered] = useState<string | null>(null);

  // Left margin sized to the longest category label. When the plot is too
  // narrow to give labels their own column (mobile), move them above the
  // bars instead of truncating them.
  const longestLabel = useMemo(
    () => Math.max(...def.bars.map((b) => b.label.length)),
    [def.bars],
  );
  const labelColW = longestLabel * LABEL_CHAR_W + 14;
  const labelsAbove = labelColW > width * 0.42;
  const marginLeft = labelsAbove ? 16 : Math.max(90, labelColW);

  const innerW = Math.max(width - marginLeft - MARGIN.right, 0);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  // Diverging: most negative first (the downgrade is the story).
  // Single-pole: largest first.
  const sorted = useMemo(
    () =>
      def.diverging
        ? [...def.bars].sort((a, b) => a.value - b.value)
        : [...def.bars].sort((a, b) => b.value - a.value),
    [def.bars, def.diverging],
  );

  const xScale = useMemo(() => {
    const lo = Math.min(0, ...sorted.map((b) => b.value));
    const hi = Math.max(0, ...sorted.map((b) => b.value));
    const pad = (hi - lo) * 0.06 || 1;
    return scaleLinear({
      domain: [lo < 0 ? lo - pad : 0, hi > 0 ? hi + pad : 0],
      range: [0, innerW],
      nice: true,
    });
  }, [sorted, innerW]);

  const yScale = useMemo(
    () =>
      scaleBand({
        domain: sorted.map((b) => b.label),
        range: [0, innerH],
        padding: 0.3,
      }),
    [sorted, innerH],
  );

  if (innerW <= 0 || innerH <= 0) return null;

  const zeroX = xScale(0);

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label={def.title}>
        <g transform={`translate(${marginLeft},${MARGIN.top})`}>
          {sorted.map((bar) => {
            const sign: 1 | -1 = bar.value < 0 ? -1 : 1;
            const barW = xScale(bar.value) - zeroX;
            const bandH = yScale.bandwidth();
            const labelH = labelsAbove ? 13 : 0;
            const barH = Math.min(bandH - labelH, MAX_BAR_THICKNESS);
            const barY =
              (yScale(bar.label) ?? 0) + labelH + (bandH - labelH - barH) / 2;
            const isHovered = hovered === bar.label;
            const color = def.diverging
              ? sign < 0
                ? POLE_NEG
                : POLE_POS
              : THEME_AMBER;
            // Value label rides outside the data end; when the tip runs into
            // the plot edge, move it just inside the bar instead (white ink).
            const valueText = def.formatValue(bar.value);
            const valueW = valueText.length * 6;
            const tipEdge = zeroX + barW;
            const overflows =
              sign > 0 ? tipEdge + 6 + valueW > innerW : tipEdge - 6 - valueW < 0;
            const inside = overflows && Math.abs(barW) > valueW + 16;
            const tipX = inside ? tipEdge - sign * 6 : tipEdge + sign * 6;
            const anchor: "start" | "end" =
              (sign > 0) !== inside ? "start" : "end";

            return (
              <g key={bar.label}>
                <path
                  d={barPath(zeroX, barY, barW, barH, sign)}
                  fill={color}
                  fillOpacity={isHovered ? 1 : 0.8}
                  onMouseMove={(event) => {
                    setHovered(bar.label);
                    const point = localPoint(event);
                    showTooltip({
                      tooltipData: bar,
                      tooltipLeft: point ? point.x : 0,
                      tooltipTop: point ? point.y : 0,
                    });
                  }}
                  onMouseLeave={() => {
                    setHovered(null);
                    hideTooltip();
                  }}
                />
                {/* category label — text token, never the series color */}
                {labelsAbove ? (
                  <text
                    x={Math.min(zeroX, zeroX + barW)}
                    y={barY - 4}
                    textAnchor="start"
                    fill={isHovered ? "hsl(var(--foreground))" : THEME_MUTED}
                    fontSize={10.5}
                    fontWeight={isHovered ? 600 : 400}
                  >
                    {bar.label}
                  </text>
                ) : (
                  <text
                    x={-6}
                    y={barY + barH / 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={isHovered ? "hsl(var(--foreground))" : THEME_MUTED}
                    fontSize={11}
                    fontWeight={isHovered ? 600 : 400}
                  >
                    {bar.label}
                  </text>
                )}
                {/* value at the data end */}
                <text
                  x={tipX}
                  y={barY + barH / 2}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  fill={inside ? "#ffffff" : THEME_MUTED}
                  fontSize={10}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                  pointerEvents="none"
                >
                  {valueText}
                </text>
              </g>
            );
          })}
          {/* zero baseline */}
          <line
            x1={zeroX}
            x2={zeroX}
            y1={0}
            y2={innerH}
            stroke={THEME_BORDER}
            strokeWidth={1}
          />
          <AxisBottom
            top={innerH}
            scale={xScale}
            numTicks={innerW < 300 ? 3 : 4}
            stroke={THEME_BORDER}
            hideTicks
            tickFormat={(v) => def.formatValue(Number(v))}
            tickLabelProps={() => ({
              fill: THEME_MUTED,
              fontSize: 10,
              textAnchor: "middle" as const,
            })}
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
            backgroundColor: POPOVER_BG,
            color: POPOVER_FG,
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 11,
          }}
        >
          <span className="font-semibold">{tooltipData.label}</span>
          {" · "}
          <span className="font-mono">{def.formatValue(tooltipData.value)}</span>
        </TooltipWithBounds>
      )}
    </div>
  );
}
