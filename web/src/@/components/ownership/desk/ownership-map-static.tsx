/**
 * The map's drawing (spec 13.2): the treemap's SVG, its sr-only table, its chips,
 * legend and caption. No state and no directive, so the server draws the default
 * view (OwnershipMapStatic) and the island draws the same markup from the same
 * props. The HTML the server sends is the markup the island hydrates.
 *
 * WHAT THE ISLAND ADDS, AND ONLY THAT. Handlers (a cell's click and keys, a
 * sector's zoom, a hover), a roving focus, a zoom pose and an overlay arrive as
 * props. Rendered without them, the cells are images with their titles, and the
 * sector labels are not buttons.
 *
 * EVERY CELL IS IN THE TABLE. The sr-only table lists every cell with its figure
 * and its notices, so the drawing is never the only record of a figure.
 */

import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { Fragment, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { normalizedLogoUrl } from "@/lib/logo";
import { SectorIcon } from "../workspace/sector-icon";

import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { cn } from "~/@/lib/utils";
import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";
import {
  PHONE_MIN_CELL,
  hasChangeMeasure,
  layoutMap,
  lensFigure,
  phoneLayout,
  phoneSectors,
  phoneStockLayout,
  sectorOf,
  type MapCell,
  type MapLayout,
  type MapSector,
  type MapStockRow,
  type PhoneCell,
  type PhoneLayout,
  type PhoneStock,
} from "./map-layout";
import { binOf, labelOnBin, lensFill, lensScale, type LensScale } from "./desk-scales";
import { FOLDED_SECTOR_LABEL, shortSector } from "~/@/lib/ownership/kinds";
import { DEFAULT_DESK_LENS, DEFAULT_DESK_SORT, DEFAULT_DESK_STATE, type DeskSort, type DeskState } from "./desk-state";
import { fundComparisonLine } from "./fund-comparison";
import {
  DESK_DEFAULT_WINDOW_STATE,
  hrefWithParams,
  type NoticeWindow,
} from "./window-chips";
import {
  DeskLink,
  LENS_LABELS,
  LensLegend,
  LensSelect,
  formatLensFigure,
  mapCaption,
} from "./lens-legend";
import { Toolbar, type ToolbarFold } from "../workspace/toolbar";
import { WindowSelect } from "../workspace/window-select";
import { SortControl } from "../workspace/sort-control";

/**
 * What a cell's area is (spec 14.3, Market map's Size): the market cap, or the estimated
 * disclosed exposure, which is the disclosed share of the market cap. The layout sizes by
 * market cap alone, so the exposure size passes the same layout rows with each stock's
 * estimated exposure as its relative area (areas are relative, so only the ratios draw).
 * A stock with no market cap takes the universe's median, as the layout does. A stock with
 * no interest keeps a sliver of area, so it is drawn and named.
 */
export type MapSize = "market_cap" | "disclosed" | "index_fund";
/** The area of a stock with no interest, as a share of the smallest stock that has one (spec 14.7). */
export const DISCLOSED_AREA_FLOOR = 0.05;

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The stocks a Size draws. The index fund size draws only the stocks a tracked fund holds
 * (their AUD holding is the area); a stock with none is not drawn at that size, and the
 * map's coverage line says how many were left out (`undrawnAtSize`).
 */
export function sizedRows(rows: readonly MapStockRow[], size: MapSize | undefined): readonly MapStockRow[] {
  if (size === "index_fund") {
    return rows.flatMap((row) =>
      row.fundValueAud !== null && row.fundValueAud > 0 ? [{ ...row, marketCap: row.fundValueAud }] : [],
    );
  }
  if (size !== "disclosed") return rows;
  const caps = rows.flatMap((row) => (row.marketCap !== null && row.marketCap > 0 ? [row.marketCap] : []));
  const median = medianOf(caps);
  const exposures = rows.map((row) => {
    const cap = row.marketCap !== null && row.marketCap > 0 ? row.marketCap : median;
    return (row.disclosedPct / 100) * cap;
  });
  // The floor scales with the data: AUD exposures run to 1e11, so a fixed sliver vanishes.
  const positive = exposures.filter((exposure) => exposure > 0);
  const floor = positive.length > 0 ? Math.min(...positive) * DISCLOSED_AREA_FLOOR : 1;
  return rows.map((row, index) => ({ ...row, marketCap: exposures[index]! > 0 ? exposures[index]! : floor }));
}

/**
 * The stale state drawn over a layout the last answer gave: each cell's figure is null and hatched,
 * each sector's change null, so its title reads "Net change n/a". The boxes and the order stay where
 * they were, so a window change draws nothing new until the answer lands. Pure, and the identity
 * when the map is not stale.
 */
export function staleOverlay(layout: MapLayout, stale: boolean, lens: DeskState["lens"]): MapLayout {
  if (!stale) return layout;
  // Only a lens whose figure is a change depends on the window: a level (the disclosed share, a short
  // position) is the same whatever window is read, so its cells keep their figures.
  const changes = hasChangeMeasure(lens);
  return {
    ...layout,
    sectors: layout.sectors.map((sector) => (sector.change === undefined ? sector : { ...sector, change: null })),
    cells: changes ? layout.cells.map((cell) => ({ ...cell, value: null, hatched: true })) : layout.cells,
  };
}

/** The stocks the index fund Size leaves out: no tracked fund holds them, so they have no area to draw. */
export function undrawnAtSize(rows: readonly MapStockRow[], size: MapSize | undefined): number {
  if (size !== "index_fund") return 0;
  return rows.filter((row) => row.fundValueAud === null || !(row.fundValueAud > 0)).length;
}

/** The stocks whose area is estimated from the median, as the Size chosen draws them (spec 13.8). */
export function estimatedAreaCodes(rows: readonly MapStockRow[]): Set<string> {
  return new Set(rows.filter((row) => row.marketCap === null || !(row.marketCap > 0)).map((row) => row.code));
}

/** The drawing's coordinate space. The SVG scales to its box; the layout never sees a pixel. */
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 560;

/**
 * The compact pane fills its fixed height from lg (backlog B2): each wrapper on the way to the drawing is
 * a flex column that gives the rest of its height down, so the drawing's svg can take `h-full`. Below lg the
 * pane is its natural height and nothing here applies.
 */
const COMPACT_FILL = "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col";

/** The hatch every cell with no figure for the lens is drawn in. One map per page, so one id. */
export const HATCH_ID = "ownership-desk-hatch";

/** How long a request runs before the screen says it is slow (the register list's figure). */
export const OUTAGE_AFTER_MS = 10_000;

/** What a list prints while a request it has no rows to dim is in flight (explorer.loading). */
export const LOADING_COPY = "Loading…";

/** The map's own outage, never the notice feed's: nothing is missing from the register. */
export const MAP_OUTAGE_COPY =
  "The map could not be read just now. Nothing here is missing from the register: this is our end.";

/** The map holds no stock: the universe is empty, so no window can be read onto it. */
export const MAP_EMPTY_COPY = "No stock is on the map just now.";

/** The coverage line of the index fund Size: how many stocks it leaves out, and that no fund holds them. */
export function undrawnAtSizeCopy(undrawn: number, total: number): string {
  return `Index fund holdings: ${undrawn.toLocaleString("en-AU")} of ${total.toLocaleString("en-AU")} stocks are not drawn at this size, because no tracked index fund holds them.`;
}

/** A lens that no stock on the map has a figure for: the legend has no scale to print. */
export const NO_FIGURE_COPY = "No stock on the map has a figure for this colour.";

/** A zoomed sector that holds no stock on the map (a hand-edited link). The crumb's Market is the way out. */
export function sectorEmptyCopy(sector: string): string {
  return `No stock on the map is in ${sector}.`;
}



/** The desk parameters a chip or a crumb writes: the lens and the zoomed sector. */
export type DeskPatch = Pick<Partial<DeskState>, "lens" | "sector">;

/**
 * The reader's link with a patch written into it. The lens and the sector are the
 * map's; the window, its dates and every other parameter stay as the reader has them,
 * so a lens chip does not drop a brushed window the heatmap set.
 */
export function patchDeskParams(current: URLSearchParams, patch: DeskPatch): URLSearchParams {
  const params = new URLSearchParams(current);
  if (patch.lens !== undefined) {
    if (patch.lens === DEFAULT_DESK_LENS) params.delete("lens");
    else params.set("lens", patch.lens);
  }
  if (patch.sector !== undefined) {
    if (patch.sector === "") params.delete("sector");
    else params.set("sector", patch.sector);
  }
  return params;
}

/** Where a lens chip or a crumb points: the page, with the patch written into the reader's link. */
export function deskHref(basePath: string, current: URLSearchParams, patch: DeskPatch): string {
  return hrefWithParams(basePath, patchDeskParams(current, patch));
}

/**
 * A cell's label colour (spec 14.9): the ink on the paper and the light steps, the paper
 * on the two deepest steps (the ink is lost on a full fill of ink or amber). A hatched
 * cell has no bin, so it keeps the ink.
 */
export function labelColourFor(value: number | null, scale: LensScale): string {
  return labelOnBin(binOf(value, scale), scale);
}

/**
 * A cell's ticker size, from the cell (spec 14.9): the code is display type, clamped to
 * 12 to 64 px, and never wider than a fifth of the cell or taller than a quarter of it.
 */
export function tickerSize(width: number, height: number): number {
  return Math.min(64, Math.max(12, Math.min(width / 5, height / 4)));
}

/** A cell's figure size, from its ticker (spec 14.9): about half the code, 11 to 28 px. */
export function figureSizeFor(ticker: number): number {
  return Math.min(28, Math.max(11, Math.round(ticker * 0.45)));
}

/** The arrow keys' move: the nearest cell in the arrow's direction, preferring one in the same row or column. */
export function nextCellIndex(cells: readonly MapCell[], index: number, key: string): number {
  const from = cells[index];
  if (!from) return index;
  const fx = (from.x0 + from.x1) / 2;
  const fy = (from.y0 + from.y1) / 2;
  let best = -1;
  let bestScore = Infinity;
  cells.forEach((cell, i) => {
    if (i === index) return;
    const dx = (cell.x0 + cell.x1) / 2 - fx;
    const dy = (cell.y0 + cell.y1) / 2 - fy;
    let along: number;
    let across: number;
    switch (key) {
      case "ArrowRight":
        along = dx;
        across = Math.abs(dy);
        break;
      case "ArrowLeft":
        along = -dx;
        across = Math.abs(dy);
        break;
      case "ArrowDown":
        along = dy;
        across = Math.abs(dx);
        break;
      case "ArrowUp":
        along = -dy;
        across = Math.abs(dx);
        break;
      default:
        return;
    }
    if (along <= 0) return;
    const score = along + 2 * across;
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best < 0 ? index : best;
}

/**
 * The transform a zoom starts from, in the drawing's own units, so the next frame
 * can animate it to none. "in": the zoomed sector's layout fills the whole map, so
 * it starts at the sector's box in the whole market. "out": the whole market
 * starts scaled so the sector's box fills the map, and comes back to its place.
 * Null for a degenerate box, which has nothing to scale from.
 */
export function zoomPose(
  box: Pick<MapSector, "x0" | "y0" | "x1" | "y1">,
  direction: "in" | "out",
  width = MAP_WIDTH,
  height = MAP_HEIGHT,
): string | null {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  if (!(bw > 0 && bh > 0)) return null;
  if (direction === "in") {
    return `translate(${box.x0}px, ${box.y0}px) scale(${bw / width}, ${bh / height})`;
  }
  return `scale(${width / bw}, ${height / bh}) translate(${-box.x0}px, ${-box.y0}px)`;
}

/**
 * The group's style for a zoom. A pose set without a transition jumps to it; the
 * pose cleared lets the class's 200 ms transition carry it to none. Transform
 * origin is the drawing's corner, so the pose's numbers are the drawing's.
 */
export function zoomStyle(pose: string | null): CSSProperties {
  const base: CSSProperties = { transformOrigin: "0 0", transformBox: "view-box" };
  return pose === null ? base : { ...base, transform: pose, transition: "none" };
}

/** The handlers an island passes. Absent, the drawing is static. */
export interface MapHandlers {
  onCellClick: (code: string) => void;
  onCellKey: (code: string, key: string) => void;
  onCellHover: (code: string | null) => void;
  onSectorZoom: (sector: string) => void;
}

const ARROWS = new Set(["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]);

/** The logo's box and the cell it needs (spec 14.2), and the figure's cell (spec 14.3). */
const LOGO_MIN_SIZE = 16;
const LOGO_MAX_SIZE = 40;
const LOGO_MIN_WIDTH = 72;
const LOGO_MIN_HEIGHT = 48;
const FIGURE_MIN_WIDTH = 96;
const FIGURE_MIN_HEIGHT = 56;

const MARKET_CAP_AREA = "Area is market cap; a stock with no market cap takes the median and is marked estimated.";
const EXPOSURE_AREA =
  "Area is estimated disclosed exposure, the disclosed share of market cap; a stock with no market cap takes the median and is marked estimated.";
const FUND_AREA =
  "Area is the holding of the tracked index funds, in AUD at the window's end file; a stock no tracked fund holds is not drawn at this size.";

/** The map's caption for the Size chosen: the caption's area sentence follows the size (spec 13.8). */
function areaCaption(lens: DeskState["lens"], size: MapSize | undefined): string {
  const caption = mapCaption(lens);
  if (size === "index_fund") return caption.replace(MARKET_CAP_AREA, FUND_AREA);
  return size === "disclosed" ? caption.replace(MARKET_CAP_AREA, EXPOSURE_AREA) : caption;
}

function cellTitle(cell: MapCell, lens: DeskState["lens"], size: MapSize = "market_cap"): string {
  const estimate =
    size === "disclosed"
      ? " Estimated disclosed exposure: the disclosed share of market cap."
      : size === "index_fund"
        ? " Held by the tracked index funds, in AUD."
        : cell.areaEstimated
          ? " Market cap estimated from the median."
          : "";
  return `${cell.code}, ${cell.name}, ${cell.sector}. ${LENS_LABELS[lens]}: ${formatLensFigure(lens, cell.value)}.${estimate}`;
}

/**
 * The band a sector's name is printed in, at the top of its box. A name sits over
 * the cells in the top row, so their own labels give way to it (see bandedCodes).
 */
const SECTOR_BAND = 20;

/** A sector name's width, estimated from its characters: the labels are never measured. */
function sectorNameWidth(name: string): number {
  return shortSector(name).length * 6.6 + 8;
}

/** The cells whose label a sector's name would print over: the top row of every named sector. */
function bandedCodes(layout: MapLayout): Set<string> {
  const codes = new Set<string>();
  for (const sector of layout.sectors) {
    if (sector.x1 - sector.x0 < 72) continue;
    const right = sector.x0 + sectorNameWidth(sector.sector);
    for (const cell of layout.cells) {
      if (cell.sector === sector.sector && cell.y0 < sector.y0 + SECTOR_BAND && cell.x0 < right && cell.x1 > sector.x0) {
        codes.add(cell.code);
      }
    }
  }
  return codes;
}

/** A cell's hatch or fill, and its label when the cell is large enough to hold one. */
function CellShape({
  cell,
  lens,
  scale,
  selected,
  focused,
  banded,
  handlers,
  size,
}: {
  cell: MapCell;
  lens: DeskState["lens"];
  size?: MapSize;
  scale: LensScale;
  selected: boolean;
  focused: boolean;
  /** True where a sector's name is printed over the cell's top: the label moves under the band. */
  banded: boolean;
  handlers?: MapHandlers;
}) {
  const width = cell.x1 - cell.x0;
  const height = cell.y1 - cell.y0;
  const fill = cell.hatched ? `url(#${HATCH_ID})` : (lensFill(cell.value, scale) ?? `url(#${HATCH_ID})`);
  const title = cellTitle(cell, lens, size);
  // Below sm the labels are not printed: a 4 px code is no label, and the title and the table carry it.
  // Under a sector's name band the label starts below the band (a cell that fills its sector once
  // lost its code altogether); a cell too short to hold both prints none.
  const bandOffset = banded ? SECTOR_BAND : 0;
  const showLabel = width >= 40 && height >= 22 + bandOffset;
  const fontSize = tickerSize(width, height - bandOffset);
  // The code's baseline; the figure sits beneath it, top left, so both read as one stacked label.
  const codeY = cell.y0 + bandOffset + fontSize + 2;
  // The figure scales with the ticker (about half of it, 11 to 28 px), so a large cell's figure reads beside its code.
  const figureSize = figureSizeFor(fontSize);
  const figureY = codeY + figureSize + 4;
  // The stock's logo from 72 x 48, top left, before the code (spec 14.2); a logo that fails is blank.
  const showLogo = width >= LOGO_MIN_WIDTH && height >= LOGO_MIN_HEIGHT && showLabel;
  // The logo scales with the ticker (about four fifths of it), so a large cell's logo is not a speck beside its code.
  const logoSize = Math.min(LOGO_MAX_SIZE, Math.max(LOGO_MIN_SIZE, Math.round(fontSize * 0.8)));
  const labelX = cell.x0 + (showLogo ? logoSize + 12 : 4);
  const ink = labelColourFor(cell.value, scale);
  // The figure under the code from 96 x 56, in the lens's own words (spec 14.3, Market map).
  const showFigure =
    width >= FIGURE_MIN_WIDTH && height >= FIGURE_MIN_HEIGHT && cell.value !== null && showLabel && figureY <= cell.y1 - 4;
  const interactive = handlers !== undefined;
  const interaction = interactive
    ? {
        role: "button" as const,
        tabIndex: focused ? 0 : -1,
        "aria-label": title,
        "aria-pressed": selected,
        "aria-keyshortcuts": "z",
        onClick: () => handlers?.onCellClick(cell.code),
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === "Enter" || event.key === " " || ARROWS.has(event.key)) {
            event.preventDefault();
            handlers?.onCellKey(cell.code, event.key);
          } else if (event.key === "z" && !event.altKey && !event.ctrlKey && !event.metaKey) {
            // z zooms to this cell's sector: the sectors are not tab stops, so the cell is the way in.
            handlers?.onCellKey(cell.code, "z");
          }
        },
        onPointerEnter: () => handlers?.onCellHover(cell.code),
        onPointerLeave: () => handlers?.onCellHover(null),
        onFocus: () => handlers?.onCellHover(cell.code),
        onBlur: () => handlers?.onCellHover(null),
      }
    : { role: "img" as const, "aria-label": title };
  return (
    <g
      data-code={cell.code}
      {...interaction}
      className={cn(
        interactive && "cursor-pointer focus:outline-none focus-visible:[&>rect]:stroke-[hsl(var(--ring))] focus-visible:[&>rect]:[stroke-width:3]",
      )}
    >
      <title>{title}</title>
      <rect
        x={cell.x0}
        y={cell.y0}
        width={width}
        height={height}
        fill={fill}
        stroke={selected ? "hsl(var(--foreground))" : "hsl(var(--background))"}
        strokeWidth={selected ? 2.5 : 1}
      />
      {showLogo ? (
        <image
          href={normalizedLogoUrl(cell.code)}
          x={cell.x0 + 4}
          y={cell.y0 + bandOffset + 4}
          width={logoSize}
          height={logoSize}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          className="pointer-events-none hidden sm:inline"
        />
      ) : null}
      {showLabel ? (
        <text
          x={labelX}
          y={codeY}
          fontSize={fontSize}
          fill={ink}
          className="pointer-events-none hidden font-mono font-semibold tabular-nums sm:inline"
        >
          {cell.code}
        </text>
      ) : null}
      {showFigure ? (
        <text
          x={labelX}
          y={figureY}
          fontSize={figureSize}
          fill={ink}
          className="pointer-events-none hidden font-mono tabular-nums sm:inline"
        >
          {formatLensFigure(lens, cell.value)}
        </text>
      ) : null}
    </g>
  );
}

/**
 * A sector's outline and its name, which is the zoom's handle while the market is
 * whole. The name sits on a band of the page's own background, so it reads over any
 * fill. The band's first 20 units are the handle's pointer target: a click there
 * zooms, and nowhere else in the sector does. Below sm the name is not printed; the
 * chips the map draws for a phone are the way in.
 */
function SectorShape({
  sector,
  zoomed,
  lens,
  handlers,
}: {
  sector: MapSector;
  zoomed: boolean;
  lens: DeskState["lens"];
  handlers?: MapHandlers;
}) {
  const width = sector.x1 - sector.x0;
  const height = sector.y1 - sector.y0;
  const label = sector.sector;
  const zoom = handlers !== undefined && !zoomed && width >= 24 && height >= 24 ? handlers : undefined;
  const showText = width >= 72;
  // The sector's icon leads its name from 120 px wide (spec 14.2); the name follows it.
  const iconOffset = width >= SECTOR_ICON_MIN_WIDTH ? SECTOR_ICON_SIZE + 6 : 0;
  const bandWidth = Math.min(width, sectorNameWidth(label) + iconOffset);
  // The name is cut to its box: "Equity Real Estate Investment Trusts (REITs)" once ran over three
  // sectors to its right. The full name stays in the title and the zoom's label.
  // The band prints the short name (spec 14.9); the title and the zoom's label keep the full one.
  const short = shortSector(label);
  const fitChars = Math.floor((width - 8 - iconOffset) / 6.6);
  const printed = short.length > fitChars ? `${short.slice(0, Math.max(1, fitChars - 1))}…` : short;
  const bandHeight = Math.min(SECTOR_BAND, height);
  return (
    <g data-sector={sector.sector}>
      <title>{sectorTitle(sector, lens)}</title>
      <rect
        x={sector.x0}
        y={sector.y0}
        width={width}
        height={height}
        fill="none"
        stroke="hsl(var(--foreground))"
        strokeWidth={1.5}
        pointerEvents="none"
      />
      {showText ? (
        <rect
          x={sector.x0}
          y={sector.y0}
          width={bandWidth}
          height={bandHeight}
          fill="hsl(var(--background))"
          pointerEvents="none"
        />
      ) : null}
      {zoom ? (
        <g
          role="button"
          // Not a tab stop: a sector zoom is one Tab per sector otherwise. The cells' z key and the phone's chips reach it.
          tabIndex={-1}
          aria-label={`Zoom to ${label}`}
          className="cursor-pointer focus:outline-none focus-visible:[&>rect]:fill-[hsl(var(--ring))]"
          onClick={() => zoom.onSectorZoom(label)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              zoom.onSectorZoom(label);
            }
          }}
        >
          <rect
            x={sector.x0}
            y={sector.y0}
            width={bandWidth}
            height={bandHeight}
            fill="transparent"
            pointerEvents="all"
          />
          {showText ? (
            <text
              x={sector.x0 + 4 + iconOffset}
              y={sector.y0 + 13}
              fontSize={11}
              className="pointer-events-none hidden font-mono sm:inline"
              fill="hsl(var(--foreground))"
            >
              {printed}
            </text>
          ) : null}
          {iconOffset > 0 ? <SectorBandIcon x={sector.x0 + 4} y={sector.y0 + 2} industry={label} /> : null}
        </g>
      ) : showText ? (
        <g>
          <text
            x={sector.x0 + 4 + iconOffset}
            y={sector.y0 + 13}
            fontSize={11}
            className="pointer-events-none hidden font-mono sm:inline"
            fill="hsl(var(--foreground))"
          >
            {printed}
          </text>
          {iconOffset > 0 ? <SectorBandIcon x={sector.x0 + 4} y={sector.y0 + 2} industry={label} /> : null}
        </g>
      ) : null}
    </g>
  );
}

/**
 * A sector band's title. Under the change order (backlog C3) it also states the sector's net change in
 * the lens's own unit, and "n/a" when no stock of the sector states one: a missing change is never a zero.
 */
export function sectorTitle(sector: MapSector, lens: DeskState["lens"]): string {
  const count = `${sector.stocks} ${sector.stocks === 1 ? "stock" : "stocks"}`;
  if (sector.change === undefined) return `${sector.sector}, ${count}`;
  return `${sector.sector}, ${count}. Net change ${formatLensFigure(lens, sector.change)}`;
}

/** A sector's icon in its band, drawn in a foreign object so the sprite's own markup is used. */
export const SECTOR_ICON_SIZE = 16;
export const SECTOR_ICON_MIN_WIDTH = 120;
function SectorBandIcon({ x, y, industry }: { x: number; y: number; industry: string }) {
  return (
    <foreignObject x={x} y={y} width={SECTOR_ICON_SIZE} height={SECTOR_ICON_SIZE} className="pointer-events-none hidden overflow-visible sm:block">
      <SectorIcon industry={industry} size={SECTOR_ICON_SIZE} />
    </foreignObject>
  );
}

/** The drawing: the sectors' outlines, every cell, the hatch. */
export function DeskMapFigure({
  layout,
  lens,
  scale,
  selected,
  focusCode,
  handlers,
  groupStyle,
  size,
  fill = false,
}: {
  layout: MapLayout;
  lens: DeskState["lens"];
  size?: MapSize;
  scale: LensScale;
  selected?: string;
  focusCode?: string;
  handlers?: MapHandlers;
  groupStyle?: CSSProperties;
  /** The compact pane: the drawing takes the pane's height from lg, centred in its box. */
  fill?: boolean;
}) {
  // The roving stop is the focused cell while it is on this layout. A zoom to another
  // sector drops it, and then the first cell takes the stop, so the drawing stays reachable.
  const roving = focusCode !== undefined && layout.cells.some((cell) => cell.code === focusCode) ? focusCode : layout.cells[0]?.code;
  const banded = bandedCodes(layout);
  return (
    <svg
      role="group"
      aria-label={`Sectors and stocks, coloured by ${LENS_LABELS[lens]}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio={fill ? "xMidYMid meet" : undefined}
      className={cn("block w-full select-none", fill ? "h-auto lg:h-full" : "h-auto")}
    >
      <defs>
        <pattern id={HATCH_ID} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={6} height={6} fill="hsl(var(--background))" />
          <line x1={0} y1={0} x2={0} y2={6} stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} />
        </pattern>
      </defs>
      <g
        style={groupStyle}
        className="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
      >
        {layout.cells.map((cell) => (
          <CellShape
            key={cell.code}
            cell={cell}
            lens={lens}
            size={size}
            scale={scale}
            selected={cell.code === selected}
            focused={handlers !== undefined && cell.code === roving}
            banded={banded.has(cell.code)}
            handlers={handlers}
          />
        ))}
        {layout.sectors.map((sector) => (
          <SectorShape key={sector.sector} sector={sector} zoomed={layout.zoomed} lens={lens} handlers={handlers} />
        ))}
      </g>
    </svg>
  );
}

/** Every cell as a row: the table is the record, the drawing is the way in. */
export function DeskMapTable({
  layout,
  lens,
  noticesKnown = true,
}: {
  layout: MapLayout;
  lens: DeskState["lens"];
  /** False while the map holds the last good answer for another window: its counts belong to that window. */
  noticesKnown?: boolean;
}) {
  return (
    // The clip is the wrapper's: sr-only on a display:table box does not constrain its width, and
    // the phone scrolled sideways to this table (801 px at 390). The table keeps its caption as its name.
    <ScreenReaderTable ariaLabel={`Sectors and stocks, by ${LENS_LABELS[lens]}`}>
      <thead>
        <tr>
          <th scope="col">Stock</th>
          <th scope="col">Sector</th>
          <th scope="col">{LENS_LABELS[lens]}</th>
          <th scope="col">Notices</th>
        </tr>
      </thead>
      <tbody>
        {layout.cells.map((cell) => (
          <tr key={cell.code}>
            <th scope="row">{`${cell.code} ${cell.name}`}</th>
            <td>{cell.sector}</td>
            <td className="tabular-nums">{formatLensFigure(lens, cell.value)}</td>
            <td className="tabular-nums">{noticesKnown ? cell.notices : NOT_AVAILABLE}</td>
          </tr>
        ))}
      </tbody>
    </ScreenReaderTable>
  );
}

/* The phone map (D1). Below sm the drawing is this square of sectors; from sm the full treemap. */

/** The phone map's square: its coordinate space. The layouts tile it, and no drawn cell is under PHONE_MIN_CELL. */
export const PHONE_MAP_SIZE = 360;

/**
 * The hatch of a phone cell with no figure. Its own id: the full map's drawing is display:none below
 * sm, and a pattern inside a display:none svg is not drawn in every browser.
 */
const PHONE_HATCH_ID = "ownership-desk-phone-hatch";

/** A phone cell's text: 11 px mono, a line every 11 units. The width of a character is estimated, never measured. */
const PHONE_TEXT = 11;
const PHONE_LINE = 11;
const PHONE_CHAR_WIDTH = 6.6;

/** The caption under the sectors' phone map: how a sector is coloured, and the way in. */
export const PHONE_CAPTION =
  "Each sector is coloured by the market-cap-weighted mean of its stocks' figures. Tap a sector for its stocks.";
/** The caption under a zoomed sector's phone map: its stocks are coloured by their own figures. */
export const PHONE_STOCKS_CAPTION = "Each stock is coloured by its own figure. Tap a stock to select it.";
/** The ids of the details a phone map's fold cell opens in place, under the square. */
const PHONE_SECTOR_FOLD_ID = "ownership-desk-phone-fold";
const PHONE_STOCK_FOLD_ID = "ownership-desk-phone-stock-fold";

/** The Size's name in a phone cell's title. */
const SIZE_NAMES: Readonly<Record<MapSize, string>> = {
  market_cap: "market cap",
  disclosed: "disclosed exposure",
  index_fund: "index fund holdings",
};

/**
 * A name in at most two lines, broken at a space; the second line is cut with an ellipsis when it
 * still does not fit, and a name with no space is cut to one line. A short name is one line.
 */
export function wrapPhoneLabel(text: string, maxChars: number): string[] {
  const limit = Math.max(4, Math.floor(maxChars));
  if (text.length <= limit) return [text];
  const cut = text.lastIndexOf(" ", limit);
  if (cut > 0) {
    const rest = text.slice(cut + 1);
    return [text.slice(0, cut), rest.length <= limit ? rest : `${rest.slice(0, limit - 1)}…`];
  }
  return [`${text.slice(0, limit - 1)}…`];
}

/** The characters a phone cell's name can hold across its width, with its 4 px padding each side. */
function phoneCharsFor(width: number): number {
  return Math.floor((width - 8) / PHONE_CHAR_WIDTH);
}

/** The count with its noun: "1 stock", "2 stocks". */
function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * A phone sector's title: the sector, its figure, the market-cap-weighted mean of how many stocks,
 * and the Size's area. A figure no stock states is "n/a", never zero.
 */
export function phoneSectorTitle(cell: PhoneCell, lens: DeskState["lens"], size: MapSize = "market_cap"): string {
  const name = cell.sector === FOLDED_SECTOR_LABEL ? `${FOLDED_SECTOR_LABEL} (${cell.folded.length})` : cell.sector;
  const area = `area: ${SIZE_NAMES[size]}${estimatedClause(cell.estimated)}`;
  if (cell.figure === null) {
    return `${name}: ${NOT_AVAILABLE}, none of its ${plural(cell.stocks, "stock")} states a figure; ${area}`;
  }
  return `${name}: ${formatLensFigure(lens, cell.figure)}, the market-cap-weighted mean of ${cell.figured} of ${plural(cell.stocks, "stock")}; ${area}`;
}

/** The clause that says how many market caps are estimated from the median; empty when none is. */
function estimatedClause(count: number): string {
  return count > 0 ? `, ${count} ${count === 1 ? "market cap" : "market caps"} estimated from the median` : "";
}

/**
 * A zoomed sector's fold cell title: the mean of the folded stocks' figures, weighted by their areas
 * (the Size's), how many of them state one, and the Size. A figure no stock states is "n/a", never zero.
 */
export function phoneStockFoldTitle(cell: PhoneStock, lens: DeskState["lens"], size: MapSize = "market_cap"): string {
  const name = `Other stocks (${cell.folded.length})`;
  const area = `area: ${SIZE_NAMES[size]}`;
  const stocks = plural(cell.folded.length, "stock");
  if (cell.value === null) return `${name}: ${NOT_AVAILABLE}, none of its ${stocks} states a figure; ${area}`;
  return `${name}: ${formatLensFigure(lens, cell.value)}, the mean of ${cell.figured} of ${stocks}, weighted by area; ${area}`;
}

/**
 * A link on the phone map. With `onPick` (the island's desk patch) it is the desk's own link, a
 * replace with no scroll; without it (the compact pane's link to the full map) it pushes a page.
 * Every one is nofollow, as the full map's chips are: the sector variants are not for the index.
 * Inside an svg the anchor draws its children, so a cell's rect is its direct child.
 */
function PhoneLink({
  href,
  onPick,
  label,
  className,
  children,
}: {
  href: string;
  onPick?: () => void;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const onClick = onPick
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        onPick();
      }
    : undefined;
  return (
    <Link
      href={href}
      replace={onPick !== undefined}
      scroll={onPick === undefined ? undefined : false}
      prefetch={false}
      rel="nofollow"
      role="link"
      aria-label={label}
      onClick={onClick}
      className={className}
    >
      {children}
    </Link>
  );
}

/** The ring a focused phone cell draws, the same as the full map's. */
const PHONE_CELL_FOCUS =
  "cursor-pointer focus:outline-none focus-visible:[&>rect]:stroke-[hsl(var(--ring))] focus-visible:[&>rect]:[stroke-width:3]";

/** The body of a phone cell: its rect, its name (two lines at most) and its figure, with its title. */
function PhoneCellBody({
  cell,
  name,
  figure,
  fill,
  ink,
  title,
  detail,
}: {
  cell: { x0: number; y0: number; x1: number; y1: number };
  name: string;
  figure: string;
  fill: string;
  ink: string;
  title: string;
  /** A line under the figure, e.g. the fold's largest members; drawn only where the cell has the room. */
  detail?: string;
}) {
  const width = cell.x1 - cell.x0;
  const height = cell.y1 - cell.y0;
  // A cell at the minimum height holds one name line over its figure: a name is never wrapped there.
  const lines = height < PHONE_MIN_CELL + PHONE_LINE ? [name] : wrapPhoneLabel(name, phoneCharsFor(width));
  const figureY = cell.y0 + 14 + (lines.length - 1) * PHONE_LINE + 13;
  const detailLines = detail === undefined ? [] : wrapPhoneLabel(detail, phoneCharsFor(width)).slice(0, 2);
  const showDetail = detailLines.length > 0 && figureY + 4 + detailLines.length * PHONE_LINE <= cell.y1 - 2;
  return (
    <>
      <title>{title}</title>
      <rect
        x={cell.x0}
        y={cell.y0}
        width={width}
        height={cell.y1 - cell.y0}
        fill={fill}
        stroke="hsl(var(--background))"
        strokeWidth={1}
      />
      {lines.map((line, index) => (
        <text
          key={index}
          x={cell.x0 + 4}
          y={cell.y0 + 14 + index * PHONE_LINE}
          fontSize={PHONE_TEXT}
          fill={ink}
          className="pointer-events-none font-mono"
        >
          {line}
        </text>
      ))}
      <text
        x={cell.x0 + 4}
        y={figureY}
        fontSize={PHONE_TEXT}
        fill={ink}
        className="pointer-events-none font-mono tabular-nums"
      >
        {figure}
      </text>
      {showDetail
        ? detailLines.map((line, index) => (
            <text
              key={`detail-${index}`}
              x={cell.x0 + 4}
              y={figureY + 4 + (index + 1) * PHONE_LINE}
              fontSize={PHONE_TEXT - 1}
              fill={ink}
              opacity={0.75}
              className="pointer-events-none font-mono"
            >
              {line}
            </text>
          ))
        : null}
    </>
  );
}

/**
 * What the fold cell says of its members: the three largest by short name, then how many more, so
 * the fold reads as the sectors it holds and not as a blank. The members arrive largest first.
 */
export function foldDetail(folded: readonly string[]): string {
  const named = folded.slice(0, 3).map((sector) => shortSector(sector));
  const rest = folded.length - named.length;
  return rest > 0 ? `${named.join(", ")} +${rest}` : named.join(", ");
}

/**
 * A sector's cell on the phone map: its name (two lines at most) and its figure, filled from the lens's
 * scale. The fold cell is a plain anchor to the details under the square that list its sectors.
 */
function PhoneSectorCell({
  cell,
  lens,
  scale,
  size,
  link,
}: {
  cell: PhoneCell;
  lens: DeskState["lens"];
  scale: LensScale;
  size?: MapSize;
  /** The sector's link; absent for the fold cell, whose way in is the details below the drawing. */
  link?: { href: string; onPick?: () => void };
}) {
  const fill = cell.figure === null ? `url(#${PHONE_HATCH_ID})` : (lensFill(cell.figure, scale) ?? `url(#${PHONE_HATCH_ID})`);
  const ink = labelColourFor(cell.figure, scale);
  const folds = cell.folded.length > 0;
  const name = folds ? `${FOLDED_SECTOR_LABEL} (${cell.folded.length})` : shortSector(cell.sector);
  const figure = formatLensFigure(lens, cell.figure);
  const label = `${name}, ${figure}`;
  const body = (
    <PhoneCellBody
      cell={cell}
      name={name}
      figure={figure}
      fill={fill}
      ink={ink}
      title={phoneSectorTitle(cell, lens, size)}
      detail={folds ? foldDetail(cell.folded) : undefined}
    />
  );
  if (folds) {
    // A plain anchor, not a PhoneLink: a fragment to the details, which opens them in place (no replace, no nofollow).
    return (
      <g data-phone-sector={cell.sector}>
        <a href={`#${PHONE_SECTOR_FOLD_ID}`} aria-label={label} className={PHONE_CELL_FOCUS}>
          {body}
        </a>
      </g>
    );
  }
  if (link === undefined) {
    return (
      <g role="img" aria-label={label} data-phone-sector={cell.sector}>
        {body}
      </g>
    );
  }
  return (
    <g data-phone-sector={cell.sector}>
      <PhoneLink href={link.href} onPick={link.onPick} label={label} className={PHONE_CELL_FOCUS}>
        {body}
      </PhoneLink>
    </g>
  );
}

/** A stock's cell on a zoomed sector's phone map: its ticker and its own figure, a tap selects it. */
function PhoneStockCell({
  cell,
  lens,
  scale,
  size,
  selected,
  handlers,
}: {
  cell: MapCell;
  lens: DeskState["lens"];
  size?: MapSize;
  scale: LensScale;
  selected: boolean;
  handlers?: MapHandlers;
}) {
  const width = cell.x1 - cell.x0;
  const height = cell.y1 - cell.y0;
  const fill = cell.hatched ? `url(#${PHONE_HATCH_ID})` : (lensFill(cell.value, scale) ?? `url(#${PHONE_HATCH_ID})`);
  const ink = labelColourFor(cell.value, scale);
  const title = cellTitle(cell, lens, size);
  // A ticker takes what the cell gives it; a cell too thin to hold it prints none, and the title and the table carry it.
  const ticker = tickerSize(width, height);
  const showCode = width >= 24 && height >= ticker + 4;
  const codeY = cell.y0 + ticker + 2;
  const figureSize = figureSizeFor(ticker);
  const figureY = codeY + figureSize + 3;
  const showFigure = showCode && cell.value !== null && width >= 56 && figureY <= cell.y1 - 3;
  const interactive = handlers !== undefined;
  // Every stock is a tab stop: the phone map has at most the cells the fold rule allows, and the
  // full map's roving stop is display:none below sm.
  return (
    <g
      data-phone-code={cell.code}
      role={interactive ? "button" : "img"}
      tabIndex={interactive ? 0 : undefined}
      aria-label={title}
      aria-pressed={interactive ? selected : undefined}
      onClick={interactive ? () => handlers?.onCellClick(cell.code) : undefined}
      onKeyDown={
        interactive
          ? (event: KeyboardEvent<SVGGElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handlers?.onCellKey(cell.code, event.key);
              }
            }
          : undefined
      }
      className={cn(interactive && PHONE_CELL_FOCUS)}
    >
      <title>{title}</title>
      <rect
        x={cell.x0}
        y={cell.y0}
        width={width}
        height={height}
        fill={fill}
        stroke={selected ? "hsl(var(--foreground))" : "hsl(var(--background))"}
        strokeWidth={selected ? 2.5 : 1}
      />
      {showCode ? (
        <text x={cell.x0 + 4} y={codeY} fontSize={ticker} fill={ink} className="pointer-events-none font-mono font-semibold tabular-nums">
          {cell.code}
        </text>
      ) : null}
      {showFigure ? (
        <text x={cell.x0 + 4} y={figureY} fontSize={figureSize} fill={ink} className="pointer-events-none font-mono tabular-nums">
          {formatLensFigure(lens, cell.value)}
        </text>
      ) : null}
    </g>
  );
}

/**
 * A zoomed sector's fold cell: the mean of its stocks, an anchor to the details under the square that
 * list them. Not a button: a tap opens the details, and a stock in them is the tap target.
 */
function PhoneStockFoldCell({
  cell,
  lens,
  scale,
  size,
}: {
  cell: PhoneStock;
  lens: DeskState["lens"];
  scale: LensScale;
  size?: MapSize;
}) {
  const fill = cell.hatched ? `url(#${PHONE_HATCH_ID})` : (lensFill(cell.value, scale) ?? `url(#${PHONE_HATCH_ID})`);
  const ink = labelColourFor(cell.value, scale);
  const name = `Other stocks (${cell.folded.length})`;
  const figure = formatLensFigure(lens, cell.value);
  return (
    <a
      href={`#${PHONE_STOCK_FOLD_ID}`}
      aria-label={`${name}, ${figure}`}
      data-phone-stock-fold=""
      className={PHONE_CELL_FOCUS}
    >
      <PhoneCellBody
        cell={cell}
        name={name}
        figure={figure}
        fill={fill}
        ink={ink}
        title={phoneStockFoldTitle(cell, lens, size)}
      />
    </a>
  );
}

/**
 * The phone map's drawing: the sectors (each a link, the fold cell an anchor to its details), or a zoomed
 * sector's stocks (each a button, the fold cell an anchor). Always drawn with its own hatch; the caller
 * shows it below sm only.
 */
export function PhoneMapFigure({
  label,
  lens,
  scale,
  size,
  sectors,
  stocks,
  sectorLink,
  selected,
  handlers,
}: {
  label: string;
  lens: DeskState["lens"];
  scale: LensScale;
  size?: MapSize;
  /** The sectors' overview: one cell per sector, and the fold cell when some fold. */
  sectors?: PhoneLayout;
  /** A zoomed sector's stocks, in the same square, with their fold cell (`PhoneStock.folded`). */
  stocks?: readonly PhoneStock[];
  /** A sector's link: the desk's patch on the full map, the full map's link on the compact pane. */
  sectorLink: (sector: string) => { href: string; onPick?: () => void };
  selected?: string;
  handlers?: MapHandlers;
}) {
  return (
    <svg
      role="group"
      aria-label={label}
      viewBox={`0 0 ${PHONE_MAP_SIZE} ${PHONE_MAP_SIZE}`}
      className="block aspect-square h-auto w-full select-none"
    >
      <defs>
        <pattern id={PHONE_HATCH_ID} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={6} height={6} fill="hsl(var(--background))" />
          <line x1={0} y1={0} x2={0} y2={6} stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} />
        </pattern>
      </defs>
      {stocks !== undefined
        ? stocks.map((cell) =>
            cell.folded.length > 0 ? (
              <PhoneStockFoldCell key="fold" cell={cell} lens={lens} scale={scale} size={size} />
            ) : (
              <PhoneStockCell
                key={cell.code}
                cell={cell}
                lens={lens}
                size={size}
                scale={scale}
                selected={cell.code === selected}
                handlers={handlers}
              />
            ),
          )
        : (sectors?.cells ?? []).map((cell) => (
            <PhoneSectorCell
              key={cell.sector}
              cell={cell}
              lens={lens}
              scale={scale}
              size={size}
              link={cell.folded.length > 0 ? undefined : sectorLink(cell.sector)}
            />
          ))}
    </svg>
  );
}

/**
 * One clause of the map's coverage line (backlog B1: the captions above the map said one thing
 * four ways, so they say it once). A clause is text; a `time` is the date it ends with, drawn as
 * a <time>; an `href` makes it a link; a `stale` clause is a held fund comparison while a read is
 * in flight, drawn faded and marked.
 */
export interface CoverageClause {
  text: string;
  time?: string;
  href?: string;
  stale?: boolean;
}

/**
 * The window clause: "the last 91 days" for the chips, "from X to Y" for a brushed pair. A brushed
 * pair is always both dates, so the brushed form never prints a missing one.
 */
export function windowClause(state: NoticeWindow): string {
  return state.since === "" ? `the last ${state.window} days` : `from ${state.since} to ${state.until}`;
}

/**
 * The map's coverage line (full variant): the notices' read-to date, the window of change, the
 * index fund comparison (when the answer carries one, under any lens) and the Coverage link. A
 * missing date drops its clause; the fund comparison is the one `fundComparisonLine` states, and
 * a held one while a read is in flight carries its "Updating" mark.
 */
export function coverageLine({
  asOf,
  window,
  fund,
  stale,
}: {
  asOf: string;
  window: NoticeWindow;
  /** The fund comparison the answer states (fundComparisonLine), or null when it states none. */
  fund: string | null;
  /** The answer is held while a window is read: its fund comparison is marked. */
  stale: boolean;
}): CoverageClause[] {
  const clauses: CoverageClause[] = [];
  if (asOf !== "") clauses.push({ text: "Notices read to", time: asOf });
  clauses.push({ text: windowClause(window) });
  // The mark is a colon, not a middle dot: the line joins its clauses with a middle dot, and a dot
  // here would read as a clause of its own.
  if (fund !== null) clauses.push(stale ? { text: `Updating: ${fund}`, stale: true } : { text: fund });
  clauses.push({ text: "Coverage", href: "/ownership#coverage" });
  return clauses;
}

/** One clause of the coverage line: a link, a faded held comparison, or its text with its date. */
function CoverageClauseView({ clause }: { clause: CoverageClause }) {
  if (clause.href !== undefined) {
    return (
      <Link href={clause.href} prefetch={false} className="text-primary underline-offset-4 hover:underline">
        {clause.text}
      </Link>
    );
  }
  return (
    <span data-stale={clause.stale ? "true" : undefined} className={cn(clause.stale && "opacity-60")}>
      {clause.text}
      {clause.time === undefined ? null : (
        <>
          {" "}
          <time dateTime={clause.time}>{clause.time}</time>
        </>
      )}
    </span>
  );
}

/** The coverage line, its clauses joined by a middle dot. */
function CoverageLine({ clauses }: { clauses: readonly CoverageClause[] }) {
  return (
    <p className="text-xs text-muted-foreground">
      {clauses.map((clause, index) => (
        <Fragment key={index}>
          {index > 0 ? " · " : null}
          <CoverageClauseView clause={clause} />
        </Fragment>
      ))}
    </p>
  );
}

export interface OwnershipMapViewProps {
  page: OwnershipMapPage;
  desk: DeskState;
  /** The window of change the link names: the chips' state, and the caption's. */
  notice?: NoticeWindow;
  /** The reader's link, which the chips and the crumb keep. The server's default view has none. */
  params?: URLSearchParams;
  /** "loading" while a window is being read, "error" when the last read failed. */
  status: "idle" | "loading" | "error";
  slow: boolean;
  basePath: string;
  selected?: string;
  focusCode?: string;
  handlers?: MapHandlers;
  groupStyle?: CSSProperties;
  /** The island's tooltip, drawn over the drawing. */
  overlay?: ReactNode;
  /** The stock panel, drawn beside the map from the large breakpoint, under it below. */
  panel?: ReactNode;
  rootRef?: Ref<HTMLDivElement>;
  onRootKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** A chip or crumb the island takes: it receives the patch to the desk's state. */
  onPick?: (patch: DeskPatch) => void;
  /**
   * `full` (the market map page) carries the window, the colour, the size and the
   * zoom controls; `compact` (the Overview's pane) is the drawing, its legend and
   * the table, with the page's record link beneath. Absent is `full`.
   */
  variant?: "compact" | "full";
  /** The area measure the layout draws; absent is the market cap. */
  size?: MapSize;
  /** The island's own controls (the Source, Size and Colour set), drawn in the chip row. */
  controls?: ReactNode;
  /** The selected stock's code, so its sector can be zoomed to. */
  selectedCode?: string;
  /** The island's phone fold of the toolbar; absent on the server, where the row is drawn as it is. */
  toolbarFold?: ToolbarFold;
  /** Writes the window in place (the Window select). Absent on the server, where the select is drawn disabled. */
  onWindowChange?: (next: NoticeWindow) => void;
  /** The order the sectors are drawn in (backlog C3); absent is by area. */
  sort?: DeskSort;
  /** Writes the sort in place (the Sort control, drawn only under a diverging lens). Absent on the server, where it is disabled. */
  onSortChange?: (next: DeskSort) => void;
}

/**
 * The desk's map as the reader sees it: the chips, the legend, the crumb, the
 * drawing, the table and the caption. The server's default view and the island
 * both draw this.
 */
export function OwnershipMapView({
  page,
  desk,
  notice = DESK_DEFAULT_WINDOW_STATE,
  params = new URLSearchParams(),
  status,
  slow,
  basePath,
  selected,
  focusCode,
  handlers,
  groupStyle,
  overlay,
  panel,
  rootRef,
  onRootKeyDown,
  onPick,
  variant = "full",
  size,
  controls,
  selectedCode = "",
  toolbarFold,
  onWindowChange,
  sort = DEFAULT_DESK_SORT,
  onSortChange,
}: OwnershipMapViewProps) {
  const compact = variant === "compact";
  const failed = status === "error" || (status === "idle" && !page.ok);
  // A read in flight or one that failed keeps the last good answer on the screen, so a
  // failed window does not take the whole map with it. Its flow and its notice counts
  // belong to the window it was read for, so they are hatched and n/a until a new read lands.
  const stale = page.ok && status !== "idle";
  const held = page.ok ? page.stocks : [];
  // A held answer's changes belong to the window it was read for, so a new window hatches them too.
  const rows = stale ? held.map((stock) => ({ ...stock, flowPp: null, fundChangePct: null })) : held;
  const undrawn = undrawnAtSize(rows, size);
  const fundLine = fundComparisonLine(page);
  // The comparison's line, marked while a read is in flight: it describes the answer the island holds.
  const fundCaption = fundLine === null ? undefined : stale ? `Updating · ${fundLine}` : fundLine;
  const loading = status === "loading" && rows.length === 0;
  const empty = status === "idle" && page.ok && page.stocks.length === 0;
  const busy = status === "loading";
  const drawnRows = sizedRows(rows, size);
  // The treemap is laid out from the held rows, not the nulled ones: a null change would fall the
  // order back to area and re-tile the map now, and again when the answer lands. The stale state is
  // drawn over the layout the last answer gave (staleOverlay), so the map is tiled once, on the answer.
  const sized = staleOverlay(
    layoutMap(sizedRows(held, size), {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      lens: desk.lens,
      sector: desk.sector,
      sort,
      // The sector change is weighted by the stocks' own market caps, as the phone square weights it (phoneSectors below).
      weights: held,
    }),
    stale,
    desk.lens,
  );
  // The exposure size replaces each area, so the estimate flag is read from the market caps here.
  const estimated = size === "disclosed" ? estimatedAreaCodes(rows) : null;
  const layout =
    estimated === null
      ? sized
      : { ...sized, cells: sized.cells.map((cell) => ({ ...cell, areaEstimated: estimated.has(cell.code) })) };
  const scale = lensScale(desk.lens, rows.map((stock) => lensFigure(stock, desk.lens)));
  const figured = rows.some((stock) => {
    const figure = lensFigure(stock, desk.lens);
    return figure !== null && Number.isFinite(figure);
  });
  // A zoomed sector that no stock on the map is in (a link edited by hand): the crumb is the way out.
  const unknownSector = desk.sector !== "" && rows.length > 0 && layout.cells.length === 0;
  const chip = (patch: DeskPatch) => ({
    href: deskHref(basePath, params, patch),
    onPick: onPick ? () => onPick(patch) : undefined,
  });
  // The phone map (D1): the sectors' square below sm. The full map's compact pane has no desk to
  // patch, so its sector links open the full map at that sector, as its zoom does.
  const zoomedPhone = !compact && desk.sector !== "";
  const phone = phoneLayout(phoneSectors(rows, drawnRows, desk.lens), PHONE_MAP_SIZE, PHONE_MIN_CELL);
  const phoneSectorLink = (sector: string): { href: string; onPick?: () => void } =>
    compact ? { href: hrefWithParams("/ownership/map", new URLSearchParams({ sector })) } : chip({ sector });
  const foldCell = phone.cells.find((cell) => cell.sector === FOLDED_SECTOR_LABEL);
  // A zoomed sector's stocks in the same square; its fold (when some stocks fold) is listed under the square.
  const phoneStocks = zoomedPhone ? phoneStockLayout(drawnRows, desk.sector, desk.lens, PHONE_MAP_SIZE) : undefined;
  const stockFold = phoneStocks?.find((cell) => cell.folded.length > 0);
  const stockNames = stockFold === undefined ? undefined : new Map(drawnRows.map((row) => [row.code, row.name] as const));

  return (
    <div ref={rootRef} onKeyDown={onRootKeyDown} className={cn("space-y-4", compact && COMPACT_FILL)}>
      {compact ? null : (
        // The one coverage line above the toolbar and the drawing (backlog B1): the read-to date, the
        // window, the fund comparison it draws, and the link to what is covered.
        <CoverageLine
          clauses={coverageLine({ asOf: page.asOf, window: notice, fund: fundLine, stale })}
        />
      )}

      {compact ? null : (
        // One toolbar row (spec 14.9): the search and the sources from the island, then the
        // colour and the window, labelled, under one "Adjust view" disclosure below sm.
        <Toolbar fold={toolbarFold}>
          {controls}
          <LensSelect lens={desk.lens} onPick={onPick ? (lens) => onPick({ lens }) : undefined} />
          <WindowSelect active={notice} onWindowChange={onWindowChange} />
          {/* The sort orders by a change, so it is offered only where the lens states one (backlog C3). */}
          {hasChangeMeasure(desk.lens) ? <SortControl active={sort} onChange={onSortChange} /> : null}
        </Toolbar>
      )}
      {compact || rows.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {selectedCode !== "" && (sectorOfCode(rows, selectedCode) ?? "") !== "" && desk.sector === "" ? (
            <DeskLink
              {...chip({ sector: sectorOfCode(rows, selectedCode) ?? "" })}
              className="text-primary underline-offset-4 hover:underline"
            >
              {`Zoom to ${sectorOfCode(rows, selectedCode)}`}
            </DeskLink>
          ) : null}
          {desk.sector !== "" ? (
            <DeskLink {...chip({ sector: "" })} className="text-primary underline-offset-4 hover:underline">
              Reset zoom
            </DeskLink>
          ) : null}
          <Link href="/ownership/stocks" prefetch={false} className="text-primary underline-offset-4 hover:underline">
            View as list
          </Link>
        </div>
      )}

      {compact || undrawn === 0 ? null : (
        <p className="text-[11px] text-muted-foreground">{undrawnAtSizeCopy(undrawn, rows.length)}</p>
      )}

      {rows.length > 0 ? (
        figured ? (
          // The index flow's legend states the files it compares (spec 14.10). The full map's coverage
          // line states them already, so only the compact pane's legend repeats them.
          <LensLegend
            lens={desk.lens}
            scale={scale}
            caption={compact && desk.lens === "index_flow" ? fundCaption : undefined}
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">{NO_FIGURE_COPY}</p>
        )
      ) : null}

      {compact ? null : (
      <nav aria-label="Map location" className="text-[11px] text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            {/* Always a link, so the crumb keeps focus when it is the one the reader took. */}
            <DeskLink
              {...chip({ sector: "" })}
              aria-current={desk.sector === "" ? "location" : undefined}
              className={desk.sector === "" ? "text-foreground" : "text-primary underline-offset-4 hover:underline"}
            >
              Market
            </DeskLink>
          </li>
          {desk.sector !== "" ? (
            <li aria-current="location" className="flex items-center gap-1 text-foreground">
              <span aria-hidden="true">{">"}</span>
              {desk.sector}
            </li>
          ) : null}
        </ol>
      </nav>
      )}

      {!compact && rows.length > 0 && !unknownSector && desk.sector === "" ? (
        // The keyboard's and the screen reader's way into a sector: the phone map (below sm) and the
        // full map (from sm) are the drawing; these links stay in the DOM at every width, visually
        // hidden, and show when one of them has focus.
        <nav aria-label="Sectors" className="sr-only flex flex-wrap gap-1.5 focus-within:not-sr-only">
          {layout.sectors.map((sector) => (
            <DeskLink
              key={sector.sector}
              {...chip({ sector: sector.sector })}
              className="hit-target rounded-sm border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              {sector.sector}
            </DeskLink>
          ))}
        </nav>
      ) : null}

      {failed || slow ? (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {MAP_OUTAGE_COPY}
        </p>
      ) : null}

      {/* With no panel this wrapper is the link between the view root and the drawing, so it carries the fill
          chain too: a plain block would make the drawing's height:100% resolve to auto. */}
      <div
        className={cn(
          panel !== undefined && "lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6",
          compact && panel === undefined && COMPACT_FILL,
        )}
      >
        <div className={cn("min-w-0", compact && COMPACT_FILL)}>
          {rows.length > 0 && !unknownSector ? (
            <div aria-busy={busy} className={cn("relative", status !== "idle" && "opacity-60", compact && COMPACT_FILL)}>
              <div className={cn("relative hidden sm:block", compact && COMPACT_FILL)}>
                <DeskMapFigure
                  fill={compact}
                  layout={layout}
                  lens={desk.lens}
                  scale={scale}
                  selected={selected}
                  focusCode={focusCode}
                  handlers={handlers}
                  groupStyle={groupStyle}
                  size={size}
                />
                {overlay}
              </div>
              <div className="sm:hidden">
                {zoomedPhone ? (
                  <>
                    <PhoneMapFigure
                      label={`Stocks in ${desk.sector}, coloured by ${LENS_LABELS[desk.lens]}`}
                      lens={desk.lens}
                      scale={scale}
                      size={size}
                      stocks={phoneStocks}
                      sectorLink={phoneSectorLink}
                      selected={selected}
                      handlers={handlers}
                    />
                    {stockFold === undefined || stockNames === undefined ? null : (
                      // The fold cell opens in place: its stocks are listed under the square, and a tap on one
                      // selects it as its cell does (read-only on the server, where there are no handlers).
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-primary underline-offset-4 hover:underline">
                          {`Other stocks (${stockFold.folded.length})`}
                        </summary>
                        {/* The fragment target is a descendant, so the fragment navigation opens this details; scroll-mt clears the sticky bars. */}
                        <div id={PHONE_STOCK_FOLD_ID} className="mt-2 flex flex-wrap gap-1.5 scroll-mt-36">
                          {stockFold.folded.map((code) => {
                            const label = `${code}, ${stockNames.get(code) ?? code}`;
                            return handlers === undefined ? (
                              <span
                                key={code}
                                className="rounded-sm border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                              >
                                {label}
                              </span>
                            ) : (
                              <button
                                key={code}
                                type="button"
                                aria-pressed={code === selected}
                                onClick={() => handlers?.onCellClick(code)}
                                className="hit-target rounded-sm border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </details>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">{PHONE_STOCKS_CAPTION}</p>
                  </>
                ) : (
                  <>
                    <PhoneMapFigure
                      label={`Sectors, coloured by ${LENS_LABELS[desk.lens]}`}
                      lens={desk.lens}
                      scale={scale}
                      size={size}
                      sectors={phone}
                      sectorLink={phoneSectorLink}
                    />
                    {foldCell === undefined ? null : (
                      // The fold cell opens in place: its sectors are the chips below the drawing, the one place
                      // the chips show. A link there is a link like any sector's.
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-primary underline-offset-4 hover:underline">
                          {`Other sectors (${foldCell.folded.length})`}
                        </summary>
                        {/* The fragment target is a descendant, so the fragment navigation opens this details; scroll-mt clears the sticky bars. */}
                        <div id={PHONE_SECTOR_FOLD_ID} className="mt-2 flex flex-wrap gap-1.5 scroll-mt-36">
                          {foldCell.folded.map((sector) => {
                            const link = phoneSectorLink(sector);
                            return (
                              <PhoneLink
                                key={sector}
                                href={link.href}
                                onPick={link.onPick}
                                className="hit-target rounded-sm border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                              >
                                {shortSector(sector)}
                              </PhoneLink>
                            );
                          })}
                        </div>
                      </details>
                    )}
                    {compact ? null : <p className="mt-2 text-xs text-muted-foreground">{PHONE_CAPTION}</p>}
                  </>
                )}
              </div>
            </div>
          ) : loading ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading"
              className="flex min-h-[10rem] items-center justify-center rounded-md border border-dashed p-3 text-sm text-muted-foreground"
            >
              {LOADING_COPY}
            </div>
          ) : null}
          {empty ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{MAP_EMPTY_COPY}</p>
          ) : null}
          {unknownSector ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {sectorEmptyCopy(desk.sector)}
            </p>
          ) : null}
          {rows.length > 0 && !unknownSector ? (
            <>
              <DeskMapTable layout={layout} lens={desk.lens} noticesKnown={!stale} />
              {compact ? null : <p className="mt-2 text-[11px] text-muted-foreground">{areaCaption(desk.lens, size)}</p>}
            </>
          ) : null}
        </div>
        {panel}
      </div>
    </div>
  );
}

/** The sector a stock on the map is in, by its code; null when it is not on the map. */
function sectorOfCode(rows: readonly { code: string; industry: string }[], code: string): string | null {
  const stock = rows.find((row) => row.code === code);
  return stock === undefined ? null : sectorOf(stock.industry);
}

/**
 * The default view, rendered on the server into the ISR HTML: the window of 91
 * days, the disclosed lens and the whole market, from the page's own answer. A
 * default view the server could not read is the outage line, never an empty map.
 */
export function OwnershipMapStatic({
  initial,
  basePath = "/ownership",
  variant,
  controls,
  sort = DEFAULT_DESK_SORT,
}: {
  initial: OwnershipMapPage;
  basePath?: string;
  variant?: "compact" | "full";
  controls?: ReactNode;
  /** The order the sectors are drawn in (backlog C3); the hub's compact pane passes "changed". */
  sort?: DeskSort;
}) {
  return (
    <OwnershipMapView
      variant={variant}
      controls={controls}
      sort={sort}
      page={initial}
      desk={DEFAULT_DESK_STATE}
      notice={DESK_DEFAULT_WINDOW_STATE}
      status={initial.ok ? "idle" : "error"}
      slow={false}
      basePath={basePath}
    />
  );
}
