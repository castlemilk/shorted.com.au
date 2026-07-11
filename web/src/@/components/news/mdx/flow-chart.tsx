"use client";

import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { sankey as d3Sankey, sankeyLinkHorizontal } from "d3-sankey";
import { localPoint } from "@visx/event";
import type { SankeyGraph, SankeyNodeMinimal, SankeyLinkMinimal } from "d3-sankey";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";

interface FlowNodeExtra { name: string; color: string }
interface FlowLinkExtra { source: number; target: number; value: number; label?: string; dashed?: boolean }
type FlowNode = SankeyNodeMinimal<FlowNodeExtra, FlowLinkExtra> & FlowNodeExtra;
type FlowLink = SankeyLinkMinimal<FlowNodeExtra, FlowLinkExtra> & FlowLinkExtra;

type FlowDataset = {
  title: string;
  subtitle?: string;
  nodes: FlowNodeExtra[];
  links: FlowLinkExtra[];
};

const THEME_MUTED = "hsl(var(--muted-foreground))";
const THEME_BORDER = "hsl(var(--border))";
const POPOVER_BG = "hsl(var(--popover))";
const POPOVER_FG = "hsl(var(--popover-foreground))";

const MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };

const DATASETS: Record<string, FlowDataset> = {
  "hormuz-oil-flows": {
    title: "Strait of Hormuz oil flows by source and destination",
    subtitle: "Millions of barrels per day (mb/d) — pre-crisis volumes",
    nodes: [
      { name: "Saudi Arabia", color: "#f59e0b" },
      { name: "Iraq", color: "#3b82f6" },
      { name: "Kuwait", color: "#10b981" },
      { name: "UAE", color: "#8b5cf6" },
      { name: "Iran", color: "#ef4444" },
      { name: "Qatar (LNG)", color: "#14b8a6" },
      { name: "East-West Pipeline", color: "#78716c" },
      { name: "Strait of Hormuz", color: "#dc2626" },
      { name: "China", color: "#f59e0b" },
      { name: "India", color: "#3b82f6" },
      { name: "Japan", color: "#10b981" },
      { name: "South Korea", color: "#8b5cf6" },
      { name: "Europe / RoW", color: "#ec4899" },
    ],
    links: [
      { source: 0, target: 7, value: 6.5, label: "6.5" },
      { source: 1, target: 7, value: 3.3, label: "3.3" },
      { source: 2, target: 7, value: 2.5, label: "2.5" },
      { source: 3, target: 7, value: 3.0, label: "3.0" },
      { source: 4, target: 7, value: 1.5, label: "1.5" },
      { source: 5, target: 7, value: 4.0, label: "4.0 (LNG)" },
      { source: 0, target: 6, value: 5.0, label: "5.0 (pipeline)" },
      { source: 3, target: 6, value: 1.5, label: "1.5 (pipeline)" },
      { source: 7, target: 8, value: 6.8, label: "6.8 → China" },
      { source: 7, target: 9, value: 3.2, label: "3.2 → India" },
      { source: 7, target: 10, value: 2.3, label: "2.3 → Japan" },
      { source: 7, target: 11, value: 2.5, label: "2.5 → S. Korea" },
      { source: 7, target: 12, value: 5.2, label: "5.2 → Europe / RoW" },
    ],
  },
};

interface FlowChartProps {
  dataset: string;
}

export function FlowChart({ dataset }: FlowChartProps) {
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
      <div className="h-[320px] w-full px-1 sm:px-2">
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <FlowCanvas width={width} height={320} def={def} />
            ) : null
          }
        </ParentSize>
      </div>
      <figcaption className="border-t border-border px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Pipeline bypass capacity (East-West + Habshan-Fujairah) covers ~35% of
        normal Strait throughput. Hover flows for details.
      </figcaption>
    </figure>
  );
}

interface CanvasProps {
  width: number;
  height: number;
  def: FlowDataset;
}

function FlowCanvas({ width, height, def }: CanvasProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<{ label: string; value: number; source: string; target: string; sourceColor: string; targetColor: string }>();

  const [hovered, setHovered] = useState<number | null>(null);

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const layout = useMemo(() => {
    const gen = d3Sankey<FlowNodeExtra, FlowLinkExtra>()
      .nodeWidth(18)
      .nodePadding(10)
      .extent([[0, 0], [innerW, innerH]]);

    const graph: SankeyGraph<FlowNodeExtra, FlowLinkExtra> = {
      nodes: def.nodes.map((n) => ({ ...n })) as FlowNode[],
      links: def.links.map((l) => ({ ...l })) as FlowLink[],
    };

    return gen(graph);
  }, [def, innerW, innerH]);

  if (innerW <= 0 || innerH <= 0 || !layout) return null;

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label={def.title}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {layout.links.map((link, i) => {
            const isHovered = hovered === i;
            const src = link.source as FlowNode;
            const tgt = link.target as FlowNode;
            const strokeColor = (link as FlowLink).dashed ? "#78716c" : src.color;

            return (
              <path
                key={i}
                d={sankeyLinkHorizontal<FlowNodeExtra, FlowLinkExtra>()(link) ?? undefined}
                fill="none"
                stroke={strokeColor}
                strokeOpacity={isHovered ? 0.85 : 0.35}
                strokeWidth={Math.max(1, link.width ?? 1)}
                strokeDasharray={(link as FlowLink).dashed ? "4 3" : undefined}
                onMouseMove={(event) => {
                  setHovered(i);
                  const point = localPoint(event);
                  showTooltip({
                    tooltipData: {
                      label: (link as FlowLink).label ?? `${link.value.toFixed(1)} mb/d`,
                      value: link.value,
                      source: src.name,
                      target: tgt.name,
                      sourceColor: src.color,
                      targetColor: tgt.color,
                    },
                    tooltipLeft: point ? point.x : 0,
                    tooltipTop: point ? point.y : 0,
                  });
                }}
                onMouseLeave={() => {
                  setHovered(null);
                  hideTooltip();
                }}
                style={{ cursor: "pointer" }}
              />
            );
          })}
          {layout.nodes.map((node, i) => {
            const n = node as FlowNode;
            const isIn = hovered !== null && layout.links.some(
              (l, idx) => hovered === idx && (l.target as FlowNode).index === i,
            );
            const isOut = hovered !== null && layout.links.some(
              (l, idx) => hovered === idx && (l.source as FlowNode).index === i,
            );
            const highlight = hovered === null || isIn || isOut;

            return (
              <g key={i} opacity={highlight ? 1 : 0.25}>
                <rect
                  x={n.x0}
                  y={n.y0}
                  width={n.x1! - n.x0!}
                  height={n.y1! - n.y0!}
                  fill={n.color}
                  rx={3}
                />
                {n.x0! > innerW * 0.4 ? (
                  <text
                    x={n.x1! + 6}
                    y={n.y0! + (n.y1! - n.y0!) / 2}
                    dominantBaseline="middle"
                    fill={THEME_MUTED}
                    fontSize={10}
                  >
                    {n.name}
                  </text>
                ) : (
                  <text
                    x={n.x0! - 6}
                    y={n.y0! + (n.y1! - n.y0!) / 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={THEME_MUTED}
                    fontSize={10}
                  >
                    {n.name}
                  </text>
                )}
              </g>
            );
          })}
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
            padding: "6px 10px",
            fontSize: 11,
          }}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: tooltipData.sourceColor }} />
            <span className="font-semibold">{tooltipData.source}</span>
            <span className="text-muted-foreground">→</span>
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: tooltipData.targetColor }} />
            <span className="font-semibold">{tooltipData.target}</span>
          </div>
          <div className="font-mono text-foreground">
            {tooltipData.label}
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}
