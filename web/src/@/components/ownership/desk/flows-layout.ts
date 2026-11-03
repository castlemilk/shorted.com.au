/**
 * The flows' layout (spec 13.3): a sankey from holder kinds on the left to
 * industries on the right, its bands the disclosed exposure, estimated (voting
 * power x market cap). Pure, like the map: the server computes the default view,
 * the island recomputes it on a toggle or a window change.
 *
 * THE CHANGE BANDS SPLIT BY DIRECTION. A change is drawn as one band per
 * direction for each kind and industry, an increase and a decrease, so a kind whose
 * disclosed voting power rose and fell in one industry shows both and neither cancels the other. The
 * bands carry a magnitude; the direction carries the sign.
 *
 * THE FUND WINDOW'S LIST LIVES HERE TOO. Its layout rule (spec 13.5: a stock
 * held on one date only is new or dropped, never a change from zero) is the same
 * sort of decision as a band's direction, and the desk keeps its pure layouts in
 * one place.
 */

import { sankey, sankeyJustify, sankeyLinkHorizontal, type SankeyNode } from "d3-sankey";
import { kindInfo, kindRank } from "~/@/lib/ownership/kinds";
import { sectorOf } from "./map-layout";

/** A holder kind's disclosed exposure in one industry, as the loader maps it. */
export interface FlowPositionRow {
  kind: string;
  industry: string;
  /** Null when no interest in the cell has a positive market cap to estimate it from. */
  exposureAud: number | null;
  holdings: number;
  largestCode: string;
  largestPct: number;
}

/** A change in one kind's exposure in one industry, split by direction. */
export interface FlowChangeRow {
  kind: string;
  industry: string;
  direction: FlowDirection;
  /** A magnitude; the direction carries the sign. Null when not estimable. */
  exposureAud: number | null;
  notices: number;
}

export type FlowDirection = "up" | "down";

export interface FlowNode {
  key: string;
  kind: "holder" | "sector";
  label: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The sum of the bands on the node's larger side. */
  value: number;
}

export interface FlowBand {
  /** Index into the layout's nodes. */
  source: number;
  target: number;
  /** Set for a change band; null for a position band. */
  direction: FlowDirection | null;
  /** The exposure in AUD (estimated) the band carries. */
  value: number;
  /** The band's vertical thickness in the drawing, from the layout. */
  width: number;
  path: string;
  holdings: number;
  largestCode: string;
  largestPct: number | null;
  notices: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  empty: boolean;
  nodes: FlowNode[];
  bands: FlowBand[];
}

/** A band before the layout: the one shape the two kinds of flow share. */
interface RawBand {
  kind: string;
  sector: string;
  value: number;
  direction: FlowDirection | null;
  holdings: number;
  largestCode: string;
  largestPct: number | null;
  notices: number;
}

interface SankeyNodeDatum {
  key: string;
  kind: "holder" | "sector";
  label: string;
}

interface SankeyLinkDatum {
  source: number;
  target: number;
  value: number;
  direction: FlowDirection | null;
  holdings: number;
  largestCode: string;
  largestPct: number | null;
  notices: number;
}

/** The padding between nodes in a column: no more than the column can take. */
const MAX_NODE_PADDING = 12;
const NODE_WIDTH = 12;

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

type GraphNode = SankeyNode<SankeyNodeDatum, SankeyLinkDatum>;

/** A band's end after layout: d3 swaps the index for the node, so either form is read. */
function endIndex(end: number | GraphNode): number {
  return typeof end === "number" ? end : (end.index ?? 0);
}

/** Lays out the bands as a sankey. A flow with no positive band is empty, not a drawing of zeros. */
function buildFlow(bands: readonly RawBand[], width: number, height: number): FlowLayout {
  const empty: FlowLayout = { width, height, empty: true, nodes: [], bands: [] };
  if (!(width > 0 && height > 0)) return empty;
  const drawn = bands.filter((band) => positive(band.value));
  if (drawn.length === 0) return empty;

  const nodes: SankeyNodeDatum[] = [];
  const indexByKey = new Map<string, number>();
  const nodeFor = (key: string, kind: "holder" | "sector", label: string): number => {
    const found = indexByKey.get(key);
    if (found !== undefined) return found;
    indexByKey.set(key, nodes.length);
    nodes.push({ key, kind, label });
    return nodes.length - 1;
  };

  // Holders first, in the kind rank. d3-sankey then orders each column by breadth
  // (no nodeSort is set), so the order the bands arrive in does not set the layout.
  const holderKinds = [...new Set(drawn.map((band) => band.kind))].sort(
    (a, b) => kindRank(a) - kindRank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const kind of holderKinds) nodeFor(`holder:${kind}`, "holder", kindInfo(kind).label);

  const links: SankeyLinkDatum[] = drawn.map((band) => ({
    source: nodeFor(`holder:${band.kind}`, "holder", kindInfo(band.kind).label),
    target: nodeFor(`sector:${band.sector}`, "sector", band.sector),
    value: band.value,
    direction: band.direction,
    holdings: band.holdings,
    largestCode: band.largestCode,
    largestPct: band.largestPct,
    notices: band.notices,
  }));

  const holderCount = nodes.filter((node) => node.kind === "holder").length;
  const sectorCount = nodes.length - holderCount;
  const nodePadding = Math.max(
    1,
    Math.min(MAX_NODE_PADDING, Math.floor(height / (2 * Math.max(holderCount, sectorCount, 1)))),
  );

  const graph = sankey<SankeyNodeDatum, SankeyLinkDatum>()
    .nodeWidth(NODE_WIDTH)
    .nodePadding(nodePadding)
    .nodeAlign(sankeyJustify)
    .extent([
      [0, 0],
      [width, height],
    ])({
    nodes: nodes.map((node) => ({ ...node })),
    links: links.map((link) => ({ ...link })),
  });

  const path = sankeyLinkHorizontal<SankeyNodeDatum, SankeyLinkDatum>();
  return {
    width,
    height,
    empty: false,
    nodes: graph.nodes.map((node) => ({
      key: node.key,
      kind: node.kind,
      label: node.label,
      x0: node.x0 ?? 0,
      x1: node.x1 ?? 0,
      y0: node.y0 ?? 0,
      y1: node.y1 ?? 0,
      value: node.value ?? 0,
    })),
    bands: graph.links.map((link) => ({
      source: endIndex(link.source),
      target: endIndex(link.target),
      direction: link.direction,
      value: link.value,
      width: link.width ?? 0,
      path: path(link) ?? "",
      holdings: link.holdings,
      largestCode: link.largestCode,
      largestPct: link.largestPct,
      notices: link.notices,
    })),
  };
}

/** The disclosed exposure flow: current interests, one band per kind and industry. */
export function positionFlows(
  rows: readonly FlowPositionRow[],
  width: number,
  height: number,
): FlowLayout {
  return buildFlow(
    rows.map((row) => ({
      kind: row.kind,
      sector: sectorOf(row.industry),
      value: row.exposureAud ?? 0,
      direction: null,
      holdings: row.holdings,
      largestCode: row.largestCode,
      largestPct: row.largestPct,
      notices: 0,
    })),
    width,
    height,
  );
}

/** The window's change flow: an increase band and a decrease band per kind and industry. */
export function changeFlows(
  rows: readonly FlowChangeRow[],
  width: number,
  height: number,
): FlowLayout {
  return buildFlow(
    rows.map((row) => ({
      kind: row.kind,
      sector: sectorOf(row.industry),
      value: row.exposureAud ?? 0,
      direction: row.direction,
      holdings: 0,
      largestCode: "",
      largestPct: null,
      notices: row.notices,
    })),
    width,
    height,
  );
}

/* ------------------------------------------------------------------ */
/* The fund window's list lives in fund-changes.ts; re-exported here   */
/* ------------------------------------------------------------------ */

export {
  partitionFundChanges,
  type FundChangeLists,
  type FundChangeRow,
  type FundChangeState,
} from "./fund-changes";
