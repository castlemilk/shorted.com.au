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
import { FOLDED_SECTOR_LABEL, kindInfo, kindRank } from "~/@/lib/ownership/kinds";
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
  /** The band's largest holders, at most ten, largest first (spec 14.10). */
  topHolders: FlowHolderRow[];
}

/** One holder of a band: its page's slug, its name, its estimated exposure and its holdings. */
export interface FlowHolderRow {
  slug: string;
  name: string;
  /** Null when the holder's exposure cannot be estimated (a company with no market cap). */
  exposureAud: number | null;
  holdings: number;
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

/** The kind a holder node names when it is the remainder: drawn last, whatever its size (spec B6). */
const REMAINDER_KIND = "unclassified";

export function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** The node keys a column ends with, whatever their size: the unclassified holders and the sectors' fold. */
const REMAINDER_KEYS: ReadonlySet<string> = new Set([
  `holder:${REMAINDER_KIND}`,
  `sector:${FOLDED_SECTOR_LABEL}`,
]);

/**
 * The columns' order: by exposure, largest first, with the remainders at the bottom whatever
 * their size: the unclassified holders (what the map could not name, spec B6) and the
 * "Other sectors" fold, which is what the drawing did not name. The order is fixed here, not
 * left to d3's breadth relaxation: a column given a sort keeps it.
 */
function byExposureRemainderLast(a: GraphNode, b: GraphNode): number {
  const remainderA = REMAINDER_KEYS.has(a.key);
  const remainderB = REMAINDER_KEYS.has(b.key);
  if (remainderA !== remainderB) return remainderA ? 1 : -1;
  return (b.value ?? 0) - (a.value ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
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

  // Holders first, in the kind rank. The columns are then ordered by nodeSort, so the
  // order the bands arrive in does not set the layout.
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
    .nodeSort(byExposureRemainderLast)
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
/* Labels: the gutters hold them, a phone wraps them (spec B6)         */
/* ------------------------------------------------------------------ */

/**
 * A label's advance per character, as a share of its font size. The labels are mono,
 * whose advance is about 0.60em; 0.62 keeps a little room for the face the browser
 * falls back to.
 */
export const LABEL_CHAR_EM = 0.62;
/** The clearance between a label and the column it names. */
export const LABEL_GAP = 6;
/** A label's line height, as a share of its font size. */
export const LABEL_LINE_EM = 1.2;

function charCount(text: string): number {
  return [...text].length;
}

/** The width a label takes at a font size, from its characters (the labels are mono). */
export function labelWidth(text: string, font: number): number {
  return charCount(text) * LABEL_CHAR_EM * font;
}

/**
 * A label split over two lines at the one space that leaves the wider line the
 * narrower, or null when there is no space to break at. Neither line is cut.
 */
export function splitLabel(text: string): [string, string] | null {
  const words = text.trim().split(/\s+/);
  let best: [string, string] | null = null;
  let bestLength = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    // A connective never opens the second line: "Durables &" / "apparel", not "Durables" / "& apparel".
    if (words[i] === "&") continue;
    const first = words.slice(0, i).join(" ");
    const second = words.slice(i).join(" ");
    const length = Math.max(charCount(first), charCount(second));
    if (length < bestLength) {
      best = [first, second];
      bestLength = length;
    }
  }
  return best;
}

/** The lines a label is drawn on in a room of `room` units: one when it fits, else two at a space. */
export function labelLines(text: string, font: number, room: number): string[] {
  if (labelWidth(text, font) <= room) return [text];
  return splitLabel(text) ?? [text];
}

/** The narrowest a label can be drawn in: its width on one line, or the wider half of its best two-line split. */
function narrowestLabel(text: string, font: number, wrap: boolean): number {
  const whole = labelWidth(text, font);
  if (!wrap) return whole;
  const split = splitLabel(text);
  return split === null ? whole : Math.min(whole, Math.max(labelWidth(split[0], font), labelWidth(split[1], font)));
}

/** The floor a gutter starts from, and whether its labels may wrap to two lines. */
export interface FlowGutterFloor {
  left: number;
  right: number;
  font: number;
  /** The phone: a right label wraps before its gutter grows to hold it on one line. */
  wrapRight: boolean;
}

/**
 * The two gutters of a sankey, grown from the labels drawn in them (spec B6): each
 * starts at the floor and widens to the widest label plus its clearance. A right label
 * on a wrapping floor needs only its narrowest two-line width, so it wraps before it
 * widens the gutter; a single word wider than the floor still widens it, never cut.
 */
export function flowGutters(
  leftLabels: readonly string[],
  rightLabels: readonly string[],
  floor: FlowGutterFloor,
): { left: number; right: number } {
  const need = (labels: readonly string[], wrap: boolean) =>
    labels.reduce((widest, text) => Math.max(widest, narrowestLabel(text, floor.font, wrap) + LABEL_GAP), 0);
  return {
    left: Math.max(floor.left, Math.ceil(need(leftLabels, false))),
    right: Math.max(floor.right, Math.ceil(need(rightLabels, floor.wrapRight))),
  };
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
