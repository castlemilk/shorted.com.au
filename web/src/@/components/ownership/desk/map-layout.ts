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
import { FOLDED_SECTOR_LABEL } from "~/@/lib/ownership/kinds";
import type { DeskLens, DeskSort } from "./desk-state";

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
  /**
   * The sector's net change under the change order: the market-cap-weighted figure of its stocks
   * that state one, or null when none does. Absent when the layout is not ordered by change.
   */
  change?: number | null;
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
  /**
   * The order. "largest" (or absent) is by area. "changed" orders the sectors by the magnitude of
   * their net change and the stocks inside a sector by the magnitude of their own figure, under a
   * lens that states a change (`hasChangeMeasure`); any other lens keeps the order by area. The
   * sizes stay the Size's either way.
   */
  sort?: DeskSort;
  /**
   * The rows the sector change is weighted by: the stocks with their own market caps, whatever the
   * Size draws. The caller passes the same rows the phone map weights by, so the two maps state the
   * same net change for a sector. Absent, the layout's own stocks weight it.
   */
  weights?: readonly MapStockRow[];
}

/**
 * The lenses that state a change, so the map can order by it: the flow in percentage points and
 * the index funds' change. The other lenses state levels, and the map keeps its order by area.
 */
export function hasChangeMeasure(lens: DeskLens): boolean {
  return lens === "flow" || lens === "index_flow";
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
 * positive. Sorted largest first the cells are nearest square; in any other order
 * they still tile the box exactly, with less square cells. Each row is laid along
 * the box's shorter side, and the row grows while its worst aspect ratio does not
 * get worse.
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

/** A figure's magnitude, or null when it is not one (a hatched stock or sector). */
function magnitudeOf(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.abs(value);
}

/**
 * Largest first, with the figures that are null after every figure that is. Zero means
 * a tie, and the caller falls through to its next key.
 */
function largestFirst(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
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
  // The change order: each sector's net change is the same market-cap-weighted figure the phone map
  // states for it (phoneSectors, given the same rows to weight by), so the two maps agree on which
  // sector moved most whatever the Size draws.
  const byChange = options.sort === "changed" && hasChangeMeasure(lens);
  const sectorChange = byChange
    ? new Map(phoneSectors(options.weights ?? stocks, stocks, lens).map((entry) => [entry.sector, entry.figure] as const))
    : null;

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
      // The stocks inside a sector: by the magnitude of their own figure under the change order,
      // then by area, so a sector's biggest mover is its top-left cell.
      const sorted = [...members].sort((a, b) => {
        if (byChange) {
          const moved = largestFirst(magnitudeOf(lensFigure(a, lens)), magnitudeOf(lensFigure(b, lens)));
          if (moved !== 0) return moved;
        }
        return areaOf(b) - areaOf(a) || byCode(a, b);
      });
      const total = sorted.reduce((sum, stock) => sum + areaOf(stock), 0);
      return { name, members: sorted, total, change: sectorChange?.get(name) ?? null };
    })
    .sort((a, b) => {
      if (byChange) {
        const moved = largestFirst(magnitudeOf(a.change), magnitudeOf(b.change));
        if (moved !== 0) return moved;
      }
      return b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });

  const sectorBoxes = squarify(
    ordered.map((group) => group.total),
    { x0: 0, y0: 0, x1: width, y1: height },
  );

  const sectors: MapSector[] = [];
  const cells: MapCell[] = [];
  ordered.forEach((group, i) => {
    const box = sectorBoxes[i]!;
    sectors.push({
      sector: group.name,
      ...box,
      stocks: group.members.length,
      ...(byChange ? { change: group.change } : {}),
    });
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

/*
 * THE PHONE MAP (spec 13.2, D1). Below sm the drawing is a square of sectors, not the
 * full treemap, whose 1000 x 560 units print no readable cell on a 390 px screen. The
 * square has two columns: a sector is one cell, and a sector's cell is only ever
 * drawn at least `minCell` tall, so its name and figure fit. The sectors too small for
 * that fold into one cell, so the phone never prints a sector too thin to read. A zoomed
 * sector's stocks are laid out by the same rule (`phoneStockLayout`).
 */

/**
 * The smallest cell the phone map draws, in the square's units: a 32 px row, above the 24 px hit
 * floor (DESIGN.md, The Two Floors Rule) and tall enough for a one-line name over its figure. At 44
 * the live market drew three sectors and folded twenty-three (Materials and Banks are half of it),
 * which was three cells, not a map; at 32 a sector of about 4.5% of the market is drawn.
 */
export const PHONE_MIN_CELL = 32;

/** A sector on the phone map, as `phoneSectors` states it. */
export interface PhoneSector {
  sector: string;
  /** The sector's area: the Size lens's sum over its stocks. Relative: only the ratios draw. */
  area: number;
  /** The stocks the sector holds on the map. */
  stocks: number;
  /** How many of them state a figure for the colour. */
  figured: number;
  /** How many of them have no market cap of their own, so their area and weight take the median. */
  estimated: number;
  /** The market-cap-weighted mean of those figures; null when none of the stocks states one. */
  figure: number | null;
  /** The market caps the figure is weighted by: the sum over the figured stocks. */
  figuredCap: number;
}

/** A cell of the phone map: one sector, or the fold cell that holds the smallest sectors. */
export interface PhoneCell extends PhoneSector, Box {
  /** The sectors a fold cell holds, largest first; empty for a sector's own cell. */
  folded: readonly string[];
}

export interface PhoneLayout {
  /** The side of the square the cells tile. */
  size: number;
  cells: PhoneCell[];
}

/**
 * A stock on a zoomed sector's phone map: the stock's own cell, or the fold cell (code "")
 * that holds the smallest stocks, which is drawn last and lists them in `folded`.
 */
export interface PhoneStock extends MapCell {
  /** The codes a fold cell holds, largest first; empty for a stock's own cell. */
  folded: readonly string[];
  /** How many of the cell's stocks state a figure: 0 or 1 for a stock's own cell. */
  figured: number;
}

/**
 * The sectors of the phone map for one set of stocks. The area is the Size lens's, summed
 * over the stocks as the full map sums them (`sized`, the rows the layout is given), so a
 * sector's cell is the same share of the market as its box on the full map. The figure is
 * the market-cap-weighted mean over the stocks that state one (`rows`, the stocks with their
 * market caps, whatever the Size draws); a stock with no market cap takes the median, as
 * the layout does, and is counted in `estimated`. A figure no stock states is null, never zero.
 */
export function phoneSectors(
  rows: readonly MapStockRow[],
  sized: readonly MapStockRow[],
  lens: DeskLens,
): PhoneSector[] {
  const areaFallback = median(sized.filter((s) => isMarketCap(s.marketCap)).map((s) => s.marketCap!)) ?? 1;
  const capFallback = median(rows.filter((s) => isMarketCap(s.marketCap)).map((s) => s.marketCap!)) ?? 1;
  const byCodeRow = new Map(rows.map((row) => [row.code, row] as const));
  const groups = new Map<
    string,
    { sector: string; area: number; stocks: number; figured: number; estimated: number; figuredCap: number; weighted: number }
  >();
  for (const stock of sized) {
    const name = sectorOf(stock.industry);
    let group = groups.get(name);
    if (!group) {
      group = { sector: name, area: 0, stocks: 0, figured: 0, estimated: 0, figuredCap: 0, weighted: 0 };
      groups.set(name, group);
    }
    group.area += isMarketCap(stock.marketCap) ? stock.marketCap : areaFallback;
    group.stocks += 1;
    const row = byCodeRow.get(stock.code) ?? stock;
    if (!isMarketCap(row.marketCap)) group.estimated += 1;
    const figure = lensFigure(row, lens);
    if (figure !== null && Number.isFinite(figure)) {
      const cap = isMarketCap(row.marketCap) ? row.marketCap : capFallback;
      group.figured += 1;
      group.figuredCap += cap;
      group.weighted += figure * cap;
    }
  }
  return [...groups.values()].map((group) => ({
    sector: group.sector,
    area: group.area,
    stocks: group.stocks,
    figured: group.figured,
    estimated: group.estimated,
    figuredCap: group.figuredCap,
    figure: group.figuredCap > 0 ? group.weighted / group.figuredCap : null,
  }));
}

/**
 * Places areas in two columns of a square `size` on a side. Each area goes to the column
 * with the smaller total so far (the first to the left), and each column is stacked with
 * heights proportional to its areas, scaled to the full height. A single area fills the
 * square. Returns one box per area, in input order.
 */
function twoColumnBoxes(areas: readonly number[], size: number): Box[] {
  if (areas.length === 1) return [{ x0: 0, y0: 0, x1: size, y1: size }];
  const totals = [0, 0];
  const columns: { index: number; area: number }[][] = [[], []];
  areas.forEach((area, index) => {
    const column = totals[1]! < totals[0]! ? 1 : 0;
    columns[column]!.push({ index, area });
    totals[column] = totals[column]! + area;
  });
  const half = size / 2;
  const boxes: Box[] = new Array<Box>(areas.length);
  columns.forEach((column, c) => {
    let y = 0;
    for (const { index, area } of column) {
      const height = (area / totals[c]!) * size;
      boxes[index] = { x0: c * half, y0: y, x1: (c + 1) * half, y1: y + height };
      y += height;
    }
  });
  return boxes;
}

/**
 * The fold (D1), shared by the sectors and a zoomed sector's stocks. The items are sorted
 * largest first; the largest `count` are drawn and the rest fold into one item, placed last.
 * `count` falls until every box, the fold's too, is at least `minCell` tall, so the loop ends
 * at the latest with everything folded into one box that fills the square. Returns the drawn
 * items, the folded ones, and the boxes: one per drawn item, then the fold's when some fold.
 */
function foldToFit<T extends { area: number }>(
  ordered: readonly T[],
  size: number,
  minCell: number,
): { drawn: T[]; folded: T[]; boxes: Box[] } {
  let count = ordered.length;
  for (;;) {
    const drawn = ordered.slice(0, count);
    const folded = ordered.slice(count);
    const areas = drawn.map((item) => item.area);
    if (folded.length > 0) areas.push(folded.reduce((sum, item) => sum + item.area, 0));
    const boxes = twoColumnBoxes(areas, size);
    if (count === 0 || boxes.every((box) => box.y1 - box.y0 >= minCell)) return { drawn, folded, boxes };
    count -= 1;
  }
}

/** The fold cell's sector: the folded sectors' areas, counts and market-cap-weighted figure, summed. */
function foldedSector(folded: readonly PhoneSector[]): PhoneSector {
  let figuredCap = 0;
  let weighted = 0;
  let area = 0;
  let stocks = 0;
  let figured = 0;
  let estimated = 0;
  for (const sector of folded) {
    area += sector.area;
    stocks += sector.stocks;
    figured += sector.figured;
    estimated += sector.estimated;
    figuredCap += sector.figuredCap;
    if (sector.figure !== null) weighted += sector.figure * sector.figuredCap;
  }
  return {
    sector: FOLDED_SECTOR_LABEL,
    area,
    stocks,
    figured,
    estimated,
    figuredCap,
    figure: figuredCap > 0 ? weighted / figuredCap : null,
  };
}

/**
 * The phone map's cells (D1). Sectors are sorted largest first and laid out in two columns
 * (`twoColumnBoxes`). A sector whose cell would be under `minCell` tall folds, smallest first,
 * into one fold cell, and the layout is laid out again, until every drawn cell (the fold
 * cell too) is at least `minCell`. A sector with no area is not drawn. Deterministic.
 */
export function phoneLayout(sectors: readonly PhoneSector[], size: number, minCell: number): PhoneLayout {
  const ordered = sectors
    .filter((sector) => Number.isFinite(sector.area) && sector.area > 0)
    .sort((a, b) => b.area - a.area || (a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : 0));
  if (!(size > 0) || ordered.length === 0) return { size, cells: [] };
  const { drawn, folded, boxes } = foldToFit(ordered, size, minCell);
  const cells: PhoneCell[] = drawn.map((sector, index) => ({ ...sector, folded: [], ...boxes[index]! }));
  if (folded.length > 0) {
    cells.push({ ...foldedSector(folded), folded: folded.map((sector) => sector.sector), ...boxes[drawn.length]! });
  }
  return { size, cells };
}

/** One stock's cell on a zoomed sector's phone map: its own area, figure and notices. */
function stockCell(stock: MapStockRow, sector: string, lens: DeskLens, box: Box): PhoneStock {
  const value = lensFigure(stock, lens);
  return {
    code: stock.code,
    name: stock.name,
    sector,
    ...box,
    marketCap: isMarketCap(stock.marketCap) ? stock.marketCap : null,
    areaEstimated: !isMarketCap(stock.marketCap),
    value,
    hatched: value === null,
    notices: stock.notices,
    folded: [],
    figured: value !== null && Number.isFinite(value) ? 1 : 0,
  };
}

/**
 * The fold cell of a zoomed sector's stocks (code ""): its value is the mean of the folded
 * stocks' figures weighted by their areas (the Size's), null when none states one.
 */
function foldedStockCell(entries: readonly { stock: MapStockRow; area: number }[], sector: string, lens: DeskLens, box: Box): PhoneStock {
  let weighted = 0;
  let weight = 0;
  let figured = 0;
  let notices = 0;
  for (const { stock, area } of entries) {
    notices += stock.notices;
    const value = lensFigure(stock, lens);
    if (value !== null && Number.isFinite(value)) {
      figured += 1;
      weighted += value * area;
      weight += area;
    }
  }
  const value = weight > 0 ? weighted / weight : null;
  return {
    code: "",
    name: `Other stocks (${entries.length})`,
    sector,
    ...box,
    marketCap: null,
    areaEstimated: false,
    value,
    hatched: value === null,
    notices,
    folded: entries.map(({ stock }) => stock.code),
    figured,
  };
}

/**
 * The stocks of one sector on the phone map, when the sector is zoomed: the same two-column
 * layout, each stock's area its market cap (the Size's, from `sized`). The stocks too thin to
 * draw at `minCell` fold into one fold cell placed last (`PhoneStock.folded`), so every drawn
 * cell is at least `minCell` tall. The fallback for a missing market cap is the median of the
 * whole list, as `layoutMap` takes it.
 */
export function phoneStockLayout(
  sized: readonly MapStockRow[],
  sector: string,
  lens: DeskLens,
  size: number,
  minCell: number = PHONE_MIN_CELL,
): PhoneStock[] {
  if (!(size > 0)) return [];
  const fallback = median(sized.filter((s) => isMarketCap(s.marketCap)).map((s) => s.marketCap!)) ?? 1;
  const areaOf = (stock: MapStockRow) => (isMarketCap(stock.marketCap) ? stock.marketCap : fallback);
  const members = sized
    .filter((stock) => sectorOf(stock.industry) === sector)
    .sort((a, b) => areaOf(b) - areaOf(a) || byCode(a, b));
  if (members.length === 0) return [];
  const { drawn, folded, boxes } = foldToFit(
    members.map((stock) => ({ stock, area: areaOf(stock) })),
    size,
    minCell,
  );
  const cells: PhoneStock[] = drawn.map(({ stock }, index) => stockCell(stock, sector, lens, boxes[index]!));
  if (folded.length > 0) cells.push(foldedStockCell(folded, sector, lens, boxes[drawn.length]!));
  return cells;
}
