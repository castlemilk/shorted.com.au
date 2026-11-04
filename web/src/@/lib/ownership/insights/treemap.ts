/**
 * The market map's geometry: a squarified treemap of sectors and their stocks
 * (d3-hierarchy), pure and in pixels, so the drawing only paints rectangles.
 *
 * The top view nests stocks inside their sectors, each sector with a header band
 * when it is big enough to label. A focused sector fills the map with its stocks
 * alone. A sector's stocks past the API's cap are one remainder tile, so the
 * sector's area is its whole value either way. A stock with nothing on the size
 * measure has no area and is not drawn; the tables list it.
 *
 * Loaded only by the lazy chart chunk: d3-hierarchy never reaches the page's
 * first load.
 */

import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";

import { sectorLabel } from "./format";
import type { InsightMeasure, InsightRemainderRow, InsightSectorRow, InsightStockRow } from "./types";

/** The gap between tiles: the surface shows through, no border is drawn. */
export const TILE_GAP = 2;
/** A sector's header band, drawn when the sector is at least this tall and wide. */
export const HEADER_HEIGHT = 18;
const HEADER_MIN_WIDTH = 64;
const HEADER_MIN_HEIGHT = 44;

export interface MapTile {
  kind: "stock" | "rest";
  /** The stock's code, or `rest:<sector>`. */
  id: string;
  code: string;
  name: string;
  sector: string;
  value: number;
  /** The change the colour shows, in the measure's own units; null when not held. */
  change: number | null;
  /** A remainder's stock count. */
  stocks: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MapGroup {
  sector: string;
  label: string;
  value: number;
  change: number | null;
  /** Whether the header band is drawn (and so the sector is labelled in place). */
  header: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MarketMapLayout {
  groups: MapGroup[];
  tiles: MapTile[];
  total: number;
}

interface MapInput {
  sectors: readonly InsightSectorRow[];
  stocks: readonly InsightStockRow[];
  remainders: readonly InsightRemainderRow[];
  measure: InsightMeasure;
  width: number;
  height: number;
  /** A sector to fill the map with; null for every sector. */
  focus: string | null;
}

/** A stock's size on the measure: its index funds' value, or its disclosed value. */
export function stockSize(stock: InsightStockRow, measure: InsightMeasure): number {
  const v = measure === "funds" ? stock.fundValue : stock.disclosedValue;
  return v != null && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The change a stock's colour shows: its index funds' change in shares (null
 * when no fund compared it), or the net change in voting power the window's
 * notices state (0 when no notice did: no stated change, not an unknown).
 */
export function stockChange(stock: InsightStockRow, measure: InsightMeasure): number | null {
  return measure === "funds" ? stock.fundChangePct : stock.noticeNetPp;
}

export function sectorChange(sector: InsightSectorRow | undefined, measure: InsightMeasure): number | null {
  if (!sector) return null;
  return measure === "funds" ? sector.fundChangePct : sector.noticeNetPp;
}

function remainderSize(r: InsightRemainderRow, measure: InsightMeasure): number {
  const v = measure === "funds" ? r.fundValue : r.disclosedValue;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Whether a sector's box is big enough for its header band. */
function hasHeader(node: { x0: number; y0: number; x1: number; y1: number }): boolean {
  return node.x1 - node.x0 >= HEADER_MIN_WIDTH && node.y1 - node.y0 >= HEADER_MIN_HEIGHT;
}

interface Datum {
  id: string;
  sector: string;
  value: number;
  tile?: Omit<MapTile, "x0" | "y0" | "x1" | "y1">;
  children?: Datum[];
}

export function layoutMarketMap({ sectors, stocks, remainders, measure, width, height, focus }: MapInput): MarketMapLayout {
  if (width <= 0 || height <= 0) return { groups: [], tiles: [], total: 0 };
  const bySector = new Map<string, Datum[]>();
  const push = (sector: string, d: Datum) => {
    const list = bySector.get(sector) ?? [];
    list.push(d);
    bySector.set(sector, list);
  };
  for (const s of stocks) {
    if (focus !== null && s.sector !== focus) continue;
    const value = stockSize(s, measure);
    if (value <= 0) continue;
    push(s.sector, {
      id: s.code,
      sector: s.sector,
      value,
      tile: {
        kind: "stock",
        id: s.code,
        code: s.code,
        name: s.name,
        sector: s.sector,
        value,
        change: stockChange(s, measure),
        stocks: 1,
      },
    });
  }
  for (const r of remainders) {
    if (focus !== null && r.sector !== focus) continue;
    const value = remainderSize(r, measure);
    if (value <= 0) continue;
    push(r.sector, {
      id: `rest:${r.sector}`,
      sector: r.sector,
      value,
      tile: {
        kind: "rest",
        id: `rest:${r.sector}`,
        code: "",
        name: `${r.stocks.toLocaleString("en-AU")} more`,
        sector: r.sector,
        value,
        change: null,
        stocks: r.stocks,
      },
    });
  }
  const sectorInfo = new Map(sectors.map((s) => [s.sector, s]));
  const groupsData: Datum[] = [...bySector.entries()].map(([sector, children]) => ({
    id: `sector:${sector}`,
    sector,
    value: 0,
    children,
  }));
  const root = hierarchy<Datum>({ id: "root", sector: "", value: 0, children: groupsData }, (d) => d.children)
    .sum((d) => (d.children ? 0 : d.value))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.data.id.localeCompare(b.data.id));
  const total = root.value ?? 0;
  if (total <= 0) return { groups: [], tiles: [], total: 0 };

  const nested = focus === null;
  treemap<Datum>()
    .tile(treemapSquarify.ratio(1.4))
    .size([width, height])
    .round(true)
    .paddingInner(TILE_GAP)
    .paddingOuter(nested ? TILE_GAP / 2 : 0)
    .paddingTop((node) => {
      if (!nested || node.depth !== 1) return 0;
      // d3 positions a node before it pads its children, so the box is final here.
      return hasHeader(node) ? HEADER_HEIGHT : TILE_GAP / 2;
    })(root);

  const groups: MapGroup[] = [];
  const tiles: MapTile[] = [];
  for (const node of (root as HierarchyRectangularNode<Datum>).descendants()) {
    if (node.depth === 1) {
      const info = sectorInfo.get(node.data.sector);
      groups.push({
        sector: node.data.sector,
        label: sectorLabel(node.data.sector),
        value: node.value ?? 0,
        change: sectorChange(info, measure),
        header: nested && hasHeader(node),
        x0: node.x0,
        y0: node.y0,
        x1: node.x1,
        y1: node.y1,
      });
    } else if (node.depth === 2 && node.data.tile) {
      if (node.x1 - node.x0 < 1 || node.y1 - node.y0 < 1) continue;
      tiles.push({ ...node.data.tile, x0: node.x0, y0: node.y0, x1: node.x1, y1: node.y1 });
    }
  }
  return { groups, tiles, total };
}

/**
 * Reading order for the keyboard: top to bottom, then left to right, by each
 * tile's top-left corner, so the arrow keys walk the map as a reader scans it.
 */
export function readingOrder<T extends { x0: number; y0: number; id: string }>(tiles: readonly T[]): T[] {
  return [...tiles].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.id.localeCompare(b.id));
}

/** How much a tile can say: nothing, its code, or its code and its change. */
export function tileLabelLevel(tile: { x0: number; y0: number; x1: number; y1: number }): 0 | 1 | 2 {
  const w = tile.x1 - tile.x0;
  const h = tile.y1 - tile.y0;
  if (w >= 52 && h >= 34) return 2;
  if (w >= 30 && h >= 16) return 1;
  return 0;
}
