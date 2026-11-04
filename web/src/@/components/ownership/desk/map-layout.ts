/**
 * The map's layout (spec 13.2): stocks grouped by industry, each cell's area its
 * market cap, drawn as a squarified treemap. Pure: the server computes it for the
 * default view so the HTML carries the SVG, and the island computes it again for a
 * zoom or a lens change, from the same rows.
 *
 * AREA. A stock with no market cap takes the universe's median, and the cell says
 * so (`areaEstimated`); the median is taken over every stock the caller passes,
 * not the zoomed sector, so a zoom never changes a cell's size relative to the
 * market. A stock with no figure for the lens is `hatched`, never zero.
 *
 * THE SQUARIFY IS LOCAL. The spec names d3-hierarchy's treemapSquarify. That
 * package ships as ES modules only, and the jest transform in package.json does
 * not list it, so a test that imports it cannot load. This is the same algorithm
 * (Bruls, Huizing and van Wijk; d3's golden-ratio aspect bound), with no padding,
 * so the cells tile the box exactly.
 */

import { industryLabel } from "~/@/lib/industry-placeholder";
import type { DeskLens } from "./desk-state";

/** The placeholder every stock with no industry is grouped under. */
export const OTHER_SECTOR = "Other";

/** A stock on the map, as the loader maps it: a null is a figure the API did not state. */
export interface MapStockRow {
  code: string;
  name: string;
  /** The raw industry from company metadata; a placeholder is grouped under OTHER_SECTOR. */
  industry: string;
  marketCap: number | null;
  disclosedPct: number;
  institutionalPct: number;
  hedgePct: number;
  indexPct: number | null;
  shortPct: number | null;
  flowPp: number | null;
  /** The tracked index funds' holdings of the stock at the window's end, in AUD; null when none holds it. */
  fundValueAud: number | null;
  /** The change in the index funds' holdings of the stock in AUD, valued at the end file's price; null when none is compared. */
  fundFlowAud: number | null;
  /**
   * The change in the index funds' shares across the fund window, as a percentage of
   * their starting shares; null when no fund is compared or the stock is in none of them.
   */
  fundChangePct: number | null;
  notices: number;
}

export interface MapCell {
  code: string;
  name: string;
  sector: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  marketCap: number | null;
  /** True when the cell's area is the universe's median, not the stock's market cap. */
  areaEstimated: boolean;
  /** The lens figure, or null when the stock has none for this lens. */
  value: number | null;
  /** True when there is no lens figure: the cell is drawn hatched, never as zero. */
  hatched: boolean;
  notices: number;
}

export interface MapSector {
  sector: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stocks: number;
}

export interface MapLayout {
  width: number;
  height: number;
  /** True when the layout is one sector, zoomed. */
  zoomed: boolean;
  sectors: MapSector[];
  cells: MapCell[];
}

export interface MapLayoutOptions {
  width: number;
  height: number;
  lens: DeskLens;
  /** An industry name to zoom to; "" or absent is the whole market. */
  sector?: string;
}

/** The sector a stock is grouped under: its industry, or OTHER_SECTOR for a placeholder. */
export function sectorOf(industry: string): string {
  return industryLabel(industry) || OTHER_SECTOR;
}

/** The figure a lens draws for a stock, or null when the stock has none. */
export function lensFigure(stock: MapStockRow, lens: DeskLens): number | null {
  switch (lens) {
    case "disclosed":
      return stock.disclosedPct;
    case "institutional":
      return stock.institutionalPct;
    case "hedge":
      return stock.hedgePct;
    case "index":
      return stock.indexPct;
    case "short":
      return stock.shortPct;
    case "flow":
      return stock.flowPp;
    case "index_flow":
      return stock.fundChangePct;
  }
}

function isMarketCap(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** The median of a list of numbers, or undefined for an empty one. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The golden ratio: d3's default bound on a cell's aspect ratio. */
const SQUARIFY_RATIO = (1 + Math.sqrt(5)) / 2;

/**
 * Tiles `box` with one rectangle per area, in input order. The areas must be
 * positive and sorted largest first, which keeps the cells near square. Each row
 * is laid along the box's shorter side, and the row grows while its worst aspect
 * ratio does not get worse.
 */
function squarify(areas: readonly number[], box: Box): Box[] {
  const out: Box[] = new Array<Box>(areas.length);
  let remaining = areas.reduce((total, area) => total + area, 0);
  let { x0, y0 } = box;
  const { x1, y1 } = box;
  let start = 0;
  while (start < areas.length) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let end = start;
    let sum = areas[end++]!;
    let min = sum;
    let max = sum;
    const alpha = Math.max(dy / dx, dx / dy) / (remaining * SQUARIFY_RATIO);
    let beta = sum * sum * alpha;
    let worst = Math.max(max / beta, beta / min);
    for (; end < areas.length; end++) {
      const area = areas[end]!;
      const grown = sum + area;
      const grownMin = Math.min(min, area);
      const grownMax = Math.max(max, area);
      const grownBeta = grown * grown * alpha;
      const next = Math.max(grownMax / grownBeta, grownBeta / grownMin);
      if (next > worst) break;
      sum = grown;
      min = grownMin;
      max = grownMax;
      beta = grownBeta;
      worst = next;
    }
    if (dx < dy) {
      // A row across the full width, its height its share of the remaining height.
      const bottom = y0 + (dy * sum) / remaining;
      let x = x0;
      for (let i = start; i < end; i++) {
        const w = (areas[i]! / sum) * dx;
        out[i] = { x0: x, y0, x1: x + w, y1: bottom };
        x += w;
      }
      y0 = bottom;
    } else {
      // A column down the full height, its width its share of the remaining width.
      const right = x0 + (dx * sum) / remaining;
      let y = y0;
      for (let i = start; i < end; i++) {
        const h = (areas[i]! / sum) * dy;
        out[i] = { x0, y0: y, x1: right, y1: y + h };
        y += h;
      }
      x0 = right;
    }
    remaining -= sum;
    start = end;
  }
  return out;
}

/** The stocks as the layout places them: sorted by code first, so ties never move. */
function byCode(a: MapStockRow, b: MapStockRow): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * The map for one set of stocks and one window. The sector groups are laid out
 * largest first, then each group's stocks inside its own box. A zoom keeps the
 * same areas, so the zoomed sector fills the box with its share of the market
 * scaled to the whole.
 */
export function layoutMap(stocks: readonly MapStockRow[], options: MapLayoutOptions): MapLayout {
  const { width, height, lens } = options;
  const sector = options.sector ?? "";
  const zoomed = sector !== "";
  const empty: MapLayout = { width, height, zoomed, sectors: [], cells: [] };
  if (!(width > 0 && height > 0)) return empty;

  const fallback = median(stocks.filter((s) => isMarketCap(s.marketCap)).map((s) => s.marketCap!));
  const areaOf = (stock: MapStockRow) => (isMarketCap(stock.marketCap) ? stock.marketCap : (fallback ?? 1));

  const groups = new Map<string, MapStockRow[]>();
  for (const stock of [...stocks].sort(byCode)) {
    const name = sectorOf(stock.industry);
    if (zoomed && name !== sector) continue;
    const members = groups.get(name);
    if (members) members.push(stock);
    else groups.set(name, [stock]);
  }
  if (groups.size === 0) return empty;

  const ordered = [...groups.entries()]
    .map(([name, members]) => {
      const sorted = [...members].sort((a, b) => areaOf(b) - areaOf(a) || byCode(a, b));
      const total = sorted.reduce((sum, stock) => sum + areaOf(stock), 0);
      return { name, members: sorted, total };
    })
    .sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const sectorBoxes = squarify(
    ordered.map((group) => group.total),
    { x0: 0, y0: 0, x1: width, y1: height },
  );

  const sectors: MapSector[] = [];
  const cells: MapCell[] = [];
  ordered.forEach((group, i) => {
    const box = sectorBoxes[i]!;
    sectors.push({ sector: group.name, ...box, stocks: group.members.length });
    const memberBoxes = squarify(group.members.map(areaOf), box);
    group.members.forEach((stock, j) => {
      const cell = memberBoxes[j]!;
      const value = lensFigure(stock, lens);
      cells.push({
        code: stock.code,
        name: stock.name,
        sector: group.name,
        ...cell,
        marketCap: isMarketCap(stock.marketCap) ? stock.marketCap : null,
        areaEstimated: !isMarketCap(stock.marketCap),
        value,
        hatched: value === null,
        notices: stock.notices,
      });
    });
  });

  return { width, height, zoomed, sectors, cells };
}
