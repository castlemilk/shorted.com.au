"use client";

/**
 * The money flow: institution kind, then institution (the largest ten, the rest
 * as Other), then sector, as a Sankey. Under the index funds measure the flow is
 * the AUD value the index fund and super option files hold at the window's end;
 * under disclosed stakes it is voting power times market cap, as the newest
 * notices read state it.
 *
 * Hovering or focusing a node lights every path through it. A sector node
 * focuses that sector in the other views; an institution or kind node holds its
 * paths lit until it is pressed again. Every node is a button. The table under
 * the chart holds every figure.
 *
 * Loaded lazily by insights-charts-lazy.tsx with d3-sankey.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { kindInfo } from "~/@/lib/ownership/kinds";
import { formatAud } from "~/@/lib/ownership/insights/format";
import { flowPath, layoutFlow, type FlowNodeBox } from "~/@/lib/ownership/insights/sankey";
import { kindFill, kindStroke } from "~/@/lib/ownership/insights/scale";
import type { InsightFlowRow } from "~/@/lib/ownership/insights/types";
import { cn } from "~/@/lib/utils";

import { useElementSize } from "./use-element-size";

export interface MoneyFlowProps {
  flow: InsightFlowRow;
  /** The sector focused in the other views; null for none. */
  focusSector: string | null;
  onFocusSector: (sector: string | null) => void;
}

const LABEL_ROOM_NARROW = 112;
const LABEL_ROOM_WIDE = 170;
/** The least vertical room between two labels in a column, in pixels. */
const LABEL_MIN_GAP = 14;

function nodeLabel(n: FlowNodeBox): string {
  return n.column === 0 ? kindInfo(n.kind).plural : n.label;
}

function truncate(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

export function MoneyFlow({ flow, focusSector, onFocusSector }: MoneyFlowProps) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const width = box.width;
  const tallest = Math.max(1, ...[0, 1, 2].map((c) => flow.nodes.filter((n) => n.column === c).length));
  const height = Math.round(Math.min(560, Math.max(300, tallest * 30)));
  const narrow = width < 640;
  const labelRoom = narrow ? LABEL_ROOM_NARROW : LABEL_ROOM_WIDE;
  const labelChars = Math.floor((labelRoom - 10) / 6.6);
  // The middle column's labels sit right of their nodes, so the right column
  // keeps a label's room on its left, and the left column's labels need none.
  const layout = useMemo(
    () => layoutFlow(flow, width, height, { left: 0, right: labelRoom }),
    [flow, width, height, labelRoom],
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const lit = hovered ?? pinned;
  const path = useMemo(() => (lit == null ? null : flowPath(layout, lit)), [layout, lit]);
  const pinnedNode = pinned == null ? undefined : layout.nodes.find((n) => n.index === pinned);
  const share = (v: number) => (flow.total > 0 ? `${((v / flow.total) * 100).toFixed(1)}%` : "n/a");

  const press = (n: FlowNodeBox) => {
    if (n.column === 2) {
      if (n.id === "sector:other") return;
      onFocusSector(focusSector === n.sector ? null : n.sector);
      return;
    }
    setPinned((p) => (p === n.index ? null : n.index));
  };

  const litNode = lit == null ? undefined : layout.nodes.find((n) => n.index === lit);
  // A label is drawn only where it clears the label above it in its column; a
  // small node's name stays in its button's name, its title and the table.
  const labelled = useMemo(() => {
    const out = new Set<number>();
    for (const column of [0, 1, 2]) {
      let last = -Infinity;
      for (const n of layout.nodes.filter((x) => x.column === column).sort((a, b) => a.y0 - b.y0)) {
        const mid = (n.y0 + n.y1) / 2;
        if (mid - last >= LABEL_MIN_GAP) {
          out.add(n.index);
          last = mid;
        }
      }
    }
    return out;
  }, [layout.nodes]);

  return (
    <div className="space-y-2">
      <div ref={boxRef} className="relative w-full" style={{ height }}>
        {width > 0 && layout.nodes.length === 0 ? (
          <p className="absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground">
            Nothing on record flows in this view.
          </p>
        ) : null}
        {width > 0 && layout.nodes.length > 0 ? (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label="Money flow from institution kinds through institutions to sectors. Each node is a button."
            className="block font-mono"
          >
            <g fill="none">
              {layout.links.map((l) => {
                const source = layout.nodes.find((n) => n.index === l.source);
                const on = path ? path.links.has(l.index) : false;
                return (
                  <path
                    key={l.index}
                    d={l.path}
                    strokeWidth={l.width}
                    className={cn(kindStroke(source?.kind ? source.kind : "other"), "transition-[stroke-opacity] duration-150")}
                    strokeOpacity={path ? (on ? 0.62 : 0.07) : 0.3}
                  >
                    <title>{`${source ? nodeLabel(source) : ""} to ${layout.nodes.find((n) => n.index === l.target)?.label ?? ""}: ${formatAud(l.value)}`}</title>
                  </path>
                );
              })}
            </g>
            {layout.nodes.map((n) => {
              const on = path ? path.nodes.has(n.index) : true;
              const isFocus = n.column === 2 && focusSector !== null && n.sector === focusSector && n.id !== "sector:other";
              const h = Math.max(1, n.y1 - n.y0);
              const label = truncate(nodeLabel(n), labelChars);
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={n.column === 2 ? isFocus : pinned === n.index}
                  aria-label={`${nodeLabel(n)}: ${formatAud(n.value)}, ${share(n.value)} of the flow${n.column === 2 && n.id !== "sector:other" ? ". Press to focus this sector" : ""}`}
                  className="cursor-pointer outline-none [&:focus-visible>rect.flow-ring]:opacity-100"
                  opacity={on ? 1 : 0.35}
                  onPointerEnter={() => setHovered(n.index)}
                  onPointerLeave={() => setHovered(null)}
                  onFocus={() => setHovered(n.index)}
                  onBlur={() => setHovered(null)}
                  onClick={() => press(n)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      press(n);
                    }
                  }}
                >
                  <rect
                    x={n.x0}
                    y={n.y0}
                    width={n.x1 - n.x0}
                    height={h}
                    rx={2}
                    className={n.column === 2 ? "fill-muted-foreground" : kindFill(n.kind || "other")}
                  />
                  <rect
                    className={cn("flow-ring pointer-events-none fill-none stroke-primary", isFocus ? "opacity-100" : "opacity-0")}
                    x={n.x0 - 3}
                    y={n.y0 - 3}
                    width={n.x1 - n.x0 + 6}
                    height={h + 6}
                    rx={3}
                    strokeWidth={2}
                  />
                  {/* A wider transparent target than the drawn node. */}
                  <rect x={n.x0 - 6} y={n.y0 - 2} width={n.x1 - n.x0 + 12} height={h + 4} fill="transparent" />
                  <title>{`${nodeLabel(n)}: ${formatAud(n.value)}`}</title>
                  {labelled.has(n.index) ? (
                    <text
                      x={n.x1 + 6}
                      y={(n.y0 + n.y1) / 2}
                      dy="0.35em"
                      className="fill-foreground text-[11px] [paint-order:stroke] stroke-background"
                      strokeWidth={3}
                    >
                      {label}
                    </text>
                  ) : null}
                  {h >= 22 && labelled.has(n.index) ? (
                    <text
                      x={n.x1 + 6}
                      y={(n.y0 + n.y1) / 2 + 12}
                      dy="0.35em"
                      className="fill-muted-foreground text-[10px] tabular-nums [paint-order:stroke] stroke-background"
                      strokeWidth={3}
                    >
                      {formatAud(n.value)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
      <p className="min-h-[1.25rem] text-[11px] text-muted-foreground" aria-live="polite">
        {litNode ? (
          <>
            <span className="font-medium text-foreground tabular-nums">{formatAud(litNode.value)}</span>{" "}
            {nodeLabel(litNode)}, {share(litNode.value)} of the flow
            {pinnedNode?.slug ? (
              <>
                {" "}
                <Link href={`/ownership/${pinnedNode.slug}`} prefetch={false} className="text-primary hover:underline">
                  {pinnedNode.label}&apos;s holdings
                </Link>
              </>
            ) : null}
          </>
        ) : (
          "Hover, focus or press a node to follow its money. A sector node focuses that sector."
        )}
      </p>
    </div>
  );
}
