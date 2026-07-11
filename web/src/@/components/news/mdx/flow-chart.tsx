"use client";

import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { sankey as d3Sankey, sankeyLinkHorizontal } from "d3-sankey";
import { localPoint } from "@visx/event";
import type { SankeyGraph, SankeyNodeMinimal, SankeyLinkMinimal } from "d3-sankey";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";

type FlowKind = "crude" | "lng" | "bypass";

interface FlowNodeExtra { name: string; emphasis?: boolean }
interface FlowLinkExtra { source: number; target: number; value: number; label?: string; kind: FlowKind }
type FlowNode = SankeyNodeMinimal<FlowNodeExtra, FlowLinkExtra> & FlowNodeExtra;
type FlowLink = SankeyLinkMinimal<FlowNodeExtra, FlowLinkExtra> & FlowLinkExtra;

type FlowDataset = {
  title: string;
  subtitle?: string;
  nodes: FlowNodeExtra[];
  links: FlowLinkExtra[];
};

const THEME_MUTED = "hsl(var(--muted-foreground))";
const POPOVER_BG = "hsl(var(--popover))";
const POPOVER_FG = "hsl(var(--popover-foreground))";

// Flow-type colors: identity is the KIND of flow, not the country — countries
// are direct-labeled on every node. Amber/blue validated vs both surfaces;
// bypass is deliberately neutral (dashed = the secondary encoding).
const FLOW_COLORS: Record<FlowKind, string> = {
  crude: "#d97706",
  lng: "#2563eb",
  bypass: "#78716c",
};
const FLOW_LABELS: Record<FlowKind, string> = {
  crude: "Crude & products",
  lng: "LNG",
  bypass: "Pipeline bypass (avoids the strait)",
};
const NODE_FILL = "hsl(var(--muted-foreground))";
const NODE_EMPHASIS = "hsl(var(--foreground))";

const MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };

// Approximate pre-crisis flows assembled from EIA/IEA/Dallas Fed figures
// (~20 mb/d oil + ~2 mb/d oil-equivalent LNG through the strait, ~80% to
// Asia); bypass capacities per Al Jazeera 27 Mar 2026 (post-conversion).
const DATASETS: Record<string, FlowDataset> = {
  "hormuz-oil-flows": {
    title: "What flows through the strait — and what can route around it",
    subtitle:
      "Approximate pre-crisis flows, millions of barrels per day (LNG as oil-equivalent); dashed = bypass pipeline capacity",
    nodes: [
      { name: "Saudi Arabia" },
      { name: "Iraq" },
      { name: "Kuwait" },
      { name: "UAE" },
      { name: "Iran" },
      { name: "Qatar (LNG)" },
      { name: "Terminals beyond the strait" },
      { name: "Strait of Hormuz", emphasis: true },
      { name: "China" },
      { name: "India" },
      { name: "Japan" },
      { name: "South Korea" },
      { name: "Europe / rest of world" },
    ],
    links: [
      { source: 0, target: 7, value: 6.3, label: "6.3 mb/d crude & products", kind: "crude" },
      { source: 1, target: 7, value: 3.3, label: "3.3 mb/d crude", kind: "crude" },
      { source: 2, target: 7, value: 2.5, label: "2.5 mb/d crude", kind: "crude" },
      { source: 3, target: 7, value: 3.0, label: "3.0 mb/d crude", kind: "crude" },
      { source: 4, target: 7, value: 1.4, label: "1.4 mb/d crude", kind: "crude" },
      { source: 5, target: 7, value: 2.0, label: "≈10 Bcf/d LNG (~2.0 mb/d oil-equivalent)", kind: "lng" },
      { source: 0, target: 6, value: 7.0, label: "East–West pipeline to Red Sea: ~7.0 mb/d capacity after March conversion", kind: "bypass" },
      { source: 3, target: 6, value: 1.5, label: "Habshan–Fujairah: ~1.5 mb/d capacity", kind: "bypass" },
      { source: 1, target: 6, value: 1.6, label: "Kirkuk–Ceyhan: ~1.6 mb/d capacity", kind: "bypass" },
      { source: 7, target: 8, value: 6.2, label: "6.2 mb/d crude to China", kind: "crude" },
      { source: 7, target: 9, value: 2.4, label: "2.4 mb/d crude to India", kind: "crude" },
      { source: 7, target: 10, value: 1.8, label: "1.8 mb/d crude to Japan", kind: "crude" },
      { source: 7, target: 11, value: 2.2, label: "2.2 mb/d crude to South Korea", kind: "crude" },
      { source: 7, target: 12, value: 3.9, label: "3.9 mb/d crude to Europe / RoW", kind: "crude" },
      { source: 7, target: 8, value: 0.4, label: "LNG to China (~0.4 mb/d oe)", kind: "lng" },
      { source: 7, target: 9, value: 0.5, label: "LNG to India (~0.5 mb/d oe)", kind: "lng" },
      { source: 7, target: 10, value: 0.3, label: "LNG to Japan (~0.3 mb/d oe)", kind: "lng" },
      { source: 7, target: 11, value: 0.2, label: "LNG to South Korea (~0.2 mb/d oe)", kind: "lng" },
      { source: 7, target: 12, value: 0.6, label: "LNG to Europe / RoW (~0.6 mb/d oe)", kind: "lng" },
    ],
  },
};

interface FlowChartProps {
  dataset: string;
}

export function FlowChart({ dataset }: FlowChartProps) {
  const def = DATASETS[dataset];
  if (!def) return null;

  const kindsUsed = [...new Set(def.links.map((l) => l.kind))];

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
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        {kindsUsed.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span
              className="h-2 w-3 rounded-[2px]"
              style={{
                backgroundColor: k === "bypass" ? "transparent" : FLOW_COLORS[k],
                border: k === "bypass" ? `1.5px dashed ${FLOW_COLORS.bypass}` : "none",
              }}
            />
            <span className="font-semibold text-foreground">{FLOW_LABELS[k]}</span>
          </span>
        ))}
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
    useTooltip<{ label: string; source: string; target: string; kind: FlowKind }>();

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
            const kind = (link as FlowLink).kind;
            const strokeColor = FLOW_COLORS[kind];

            return (
              <path
                key={i}
                d={sankeyLinkHorizontal<FlowNodeExtra, FlowLinkExtra>()(link) ?? undefined}
                fill="none"
                stroke={strokeColor}
                strokeOpacity={isHovered ? 0.85 : kind === "bypass" ? 0.3 : 0.4}
                strokeWidth={Math.max(1, link.width ?? 1)}
                strokeDasharray={kind === "bypass" ? "4 3" : undefined}
                onMouseMove={(event) => {
                  setHovered(i);
                  const point = localPoint(event);
                  showTooltip({
                    tooltipData: {
                      label: (link as FlowLink).label ?? `${link.value.toFixed(1)} mb/d`,
                      source: src.name,
                      target: tgt.name,
                      kind,
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
                  fill={n.emphasis ? NODE_EMPHASIS : NODE_FILL}
                  fillOpacity={n.emphasis ? 0.9 : 0.55}
                  rx={3}
                />
                {/* nodes in the left half label to the right of the rect;
                    right half label to the left — labels stay on-canvas */}
                {n.x0! < innerW * 0.5 ? (
                  <text
                    x={n.x1! + 6}
                    y={n.y0! + (n.y1! - n.y0!) / 2}
                    dominantBaseline="middle"
                    fill={n.emphasis ? "hsl(var(--foreground))" : THEME_MUTED}
                    fontSize={10}
                    fontWeight={n.emphasis ? 600 : 400}
                  >
                    {n.name}
                  </text>
                ) : (
                  <text
                    x={n.x0! - 6}
                    y={n.y0! + (n.y1! - n.y0!) / 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={n.emphasis ? "hsl(var(--foreground))" : THEME_MUTED}
                    fontSize={10}
                    fontWeight={n.emphasis ? 600 : 400}
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
            <span
              className="h-2.5 w-2.5 rounded-[2px]"
              style={{ backgroundColor: FLOW_COLORS[tooltipData.kind] }}
            />
            <span className="font-semibold">{tooltipData.source}</span>
            <span className="text-muted-foreground">→</span>
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
