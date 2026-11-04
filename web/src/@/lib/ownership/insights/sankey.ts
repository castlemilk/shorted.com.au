/**
 * The money flow's geometry: a three-column Sankey (institution kind, then
 * institution, then sector) laid out by d3-sankey, pure and in pixels.
 *
 * Each node keeps the column the API gave it, so a kind is always on the left
 * and a sector on the right whatever the graph's shape. Nodes stack by value
 * within a column. Loaded only by the lazy chart chunk.
 */

import { sankey, sankeyLinkHorizontal, type SankeyGraph } from "d3-sankey";

import type { InsightFlowNodeRow, InsightFlowRow } from "./types";

export interface FlowNodeBox extends InsightFlowNodeRow {
  index: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface FlowLinkPath {
  index: number;
  source: number;
  target: number;
  value: number;
  /** The ribbon's centre line; drawn with `width` as its stroke. */
  path: string;
  width: number;
}

export interface FlowLayout {
  nodes: FlowNodeBox[];
  links: FlowLinkPath[];
}

interface NodeExtra {
  index?: number;
  column: number;
}

interface LinkExtra {
  index?: number;
}

/** Node width and the gap between stacked nodes, in pixels. */
export const FLOW_NODE_WIDTH = 10;
export const FLOW_NODE_GAP = 8;

/**
 * Lays the flow out in a box. The columns sit at the box's left edge, its
 * middle and its right edge; the caller leaves room beside them for labels
 * through `inset`.
 */
export function layoutFlow(
  flow: InsightFlowRow,
  width: number,
  height: number,
  inset: { left: number; right: number } = { left: 0, right: 0 },
): FlowLayout {
  if (flow.nodes.length === 0 || flow.links.length === 0 || width <= 0 || height <= 0) {
    return { nodes: [], links: [] };
  }
  const right = Math.max(inset.left + FLOW_NODE_WIDTH * 3, width - inset.right);
  // Fewer nodes than the gaps can hold would push the stack past the box.
  const tallest = Math.max(...[0, 1, 2].map((c) => flow.nodes.filter((n) => n.column === c).length));
  const gap = Math.max(2, Math.min(FLOW_NODE_GAP, (height * 0.4) / Math.max(1, tallest - 1)));
  const generator = sankey<NodeExtra, LinkExtra>()
    .nodeId((n) => n.index ?? 0)
    .nodeWidth(FLOW_NODE_WIDTH)
    .nodePadding(gap)
    .nodeAlign((n) => n.column)
    .nodeSort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .linkSort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .extent([
      [inset.left, 0],
      [right, height],
    ]);
  const graph: SankeyGraph<NodeExtra, LinkExtra> = generator({
    nodes: flow.nodes.map((n, index) => ({ index, column: n.column })),
    links: flow.links
      .filter((l) => l.value > 0 && l.source !== l.target && flow.nodes[l.source] && flow.nodes[l.target])
      .map((l, index) => ({ index, source: l.source, target: l.target, value: l.value })),
  });
  const path = sankeyLinkHorizontal<NodeExtra, LinkExtra>();
  const nodes: FlowNodeBox[] = graph.nodes.map((n) => {
    const row = flow.nodes[n.index ?? 0]!;
    return { ...row, index: n.index ?? 0, x0: n.x0 ?? 0, x1: n.x1 ?? 0, y0: n.y0 ?? 0, y1: n.y1 ?? 0 };
  });
  const links: FlowLinkPath[] = graph.links.map((l, i) => {
    const source = typeof l.source === "object" ? (l.source.index ?? 0) : Number(l.source);
    const target = typeof l.target === "object" ? (l.target.index ?? 0) : Number(l.target);
    return {
      index: i,
      source,
      target,
      value: l.value,
      path: path(l) ?? "",
      width: Math.max(1, l.width ?? 1),
    };
  });
  return { nodes, links };
}

/**
 * Every node and link on a path through `node`: the node itself, the nodes it
 * reaches to its right and the nodes that reach it from its left, with the links
 * between them. Hover lights this set and dims the rest.
 */
export function flowPath(layout: FlowLayout, node: number): { nodes: Set<number>; links: Set<number> } {
  const nodes = new Set<number>([node]);
  const links = new Set<number>();
  const walk = (from: number, forward: boolean) => {
    for (const l of layout.links) {
      const [a, b] = forward ? [l.source, l.target] : [l.target, l.source];
      if (a !== from || links.has(l.index)) continue;
      links.add(l.index);
      nodes.add(b);
      walk(b, forward);
    }
  };
  walk(node, true);
  walk(node, false);
  return { nodes, links };
}
