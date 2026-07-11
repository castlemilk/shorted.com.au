"use client";

import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { Bar } from "@visx/shape";
import { AxisBottom } from "@visx/axis";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { format } from "date-fns";

type BarDef = { label: string; value: number; color?: string };

type BarDataset = {
  title: string;
  subtitle?: string;
  formatValue: (v: number) => string;
  bars: BarDef[];
};

const THEME_AMBER = "hsl(var(--primary))";
const THEME_MUTED = "hsl(var(--muted-foreground))";
const THEME_BORDER = "hsl(var(--border))";
const THEME_CARD = "hsl(var(--card))";
const POPOVER_BG = "hsl(var(--popover))";
const POPOVER_FG = "hsl(var(--popover-foreground))";

const MARGIN = { top: 12, right: 16, bottom: 40, left: 100 };

const PALETTE = [
  "#f59e0b", "#3b82f6", "#10b981", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

const DATASETS: Record<string, BarDataset> = {
  "hormuz-oil-dependency": {
    title: "Oil imports via Strait of Hormuz by country",
    subtitle: "% of total crude imports that transit the strait",
    formatValue: (v) => `${v.toFixed(0)}%`,
    bars: [
      { label: "China", value: 32 },
      { label: "India", value: 15 },
      { label: "Japan", value: 11 },
      { label: "South Korea", value: 12 },
      { label: "EU / UK", value: 14 },
      { label: "Australia", value: 9 },
      { label: "Singapore", value: 18 },
      { label: "Taiwan", value: 8 },
    ],
  },
  "hormuz-gdp-revision": {
    title: "IMF 2026 GDP growth revisions",
    subtitle: "Change from Oct 2025 forecast, percentage points",
    formatValue: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`,
    bars: [
      { label: "Qatar", value: -14.7, color: "#ef4444" },
      { label: "Middle East", value: -3.2, color: "#ef4444" },
      { label: "India", value: -0.8, color: "#f97316" },
      { label: "China", value: -0.6, color: "#f97316" },
      { label: "Euro area", value: -0.5, color: "#f97316" },
      { label: "Global", value: -0.4, color: "#f97316" },
      { label: "United States", value: -0.1, color: "#10b981" },
      { label: "Australia", value: 0.3, color: "#10b981" },
    ],
  },
  "hormuz-shipping-costs": {
    title: "Shipping cost surge since Feb 28",
    subtitle: "Multiples of pre-crisis baseline",
    formatValue: (v) => `${v.toFixed(0)}x`,
    bars: [
      { label: "VLCC spot rate", value: 8.5 },
      { label: "War risk insurance", value: 8.0 },
      { label: "Container surcharges", value: 2.5 },
      { label: "Baltic Dirty Tanker", value: 2.5 },
      { label: "Drewry WCI container", value: 1.5 },
    ],
  },
  "hormuz-market-volatility": {
    title: "Asset class volatility since Feb 28",
    subtitle: "Current vs pre-crisis (multiples)",
    formatValue: (v) => `${v.toFixed(1)}x`,
    bars: [
      { label: "OVX (oil volatility)", value: 2.0 },
      { label: "Gold (GVZ)", value: 1.6 },
      { label: "VIX (equities)", value: 1.4 },
      { label: "MOVE (bonds)", value: 1.3 },
      { label: "AUD/USD (FX vol)", value: 1.5 },
    ],
  },
};

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
      <figcaption className="border-t border-border px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Hover bars for exact values
      </figcaption>
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

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const sorted = useMemo(
    () => [...def.bars].sort((a, b) => b.value - a.value),
    [def.bars],
  );

  const xScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, Math.max(...sorted.map((b) => b.value)) * 1.15],
        range: [0, innerW],
        nice: true,
      }),
    [sorted, innerW],
  );

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

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label={def.title}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {sorted.map((bar) => {
            const barW = xScale(bar.value);
            const barY = yScale(bar.label) ?? 0;
            const barH = yScale.bandwidth();
            const isHovered = hovered === bar.label;
            const color = bar.color ?? THEME_AMBER;

            return (
              <g key={bar.label}>
                <Bar
                  x={0}
                  y={barY}
                  width={barW}
                  height={barH}
                  fill={color}
                  fillOpacity={isHovered ? 1 : 0.75}
                  stroke={isHovered ? color : "none"}
                  strokeWidth={1}
                  rx={3}
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
              </g>
            );
          })}
          <AxisBottom
            top={innerH}
            scale={xScale}
            numTicks={4}
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
