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
import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from "react";

import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { cn } from "~/@/lib/utils";
import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";
import {
  layoutMap,
  lensFigure,
  type MapCell,
  type MapLayout,
  type MapSector,
} from "./map-layout";
import { lensFill, lensScale, type LensScale } from "./desk-scales";
import { DEFAULT_DESK_LENS, DEFAULT_DESK_STATE, type DeskState } from "./desk-state";
import {
  DESK_DEFAULT_WINDOW_STATE,
  WindowChips,
  WindowPhrase,
  hrefWithParams,
  noticeWindowHref,
  type NoticeWindow,
} from "./window-chips";
import {
  DeskChip,
  DeskLink,
  LENS_LABELS,
  LENS_ORDER,
  LensLegend,
  formatLensFigure,
  mapCaption,
} from "./lens-legend";

/** The drawing's coordinate space. The SVG scales to its box; the layout never sees a pixel. */
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 560;

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

/** A lens that no stock on the map has a figure for: the legend has no scale to print. */
export const NO_FIGURE_COPY = "No stock on the map has a figure for this colour.";

/** A zoomed sector that holds no stock on the map (a hand-edited link). The crumb's Market is the way out. */
export function sectorEmptyCopy(sector: string): string {
  return `No stock on the map is in ${sector}.`;
}


const WINDOW_LABEL = "Window of change";
const LENS_GROUP_LABEL = "Colour by";

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

/** The label colour for a cell's fill: the page's own background on a strong fill, the foreground on a weak one. */
export function labelColourFor(value: number | null, scale: LensScale): string {
  if (value === null || !Number.isFinite(value)) return "hsl(var(--foreground))";
  const span = scale.hi - scale.lo;
  const reach = Math.max(Math.abs(scale.lo), Math.abs(scale.hi));
  const t =
    scale.mode === "diverging"
      ? reach > 0
        ? Math.abs(value) / reach
        : 0
      : span > 0
        ? (value - scale.lo) / span
        : 1;
  return t > 0.55 ? "hsl(var(--background))" : "hsl(var(--foreground))";
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

function cellTitle(cell: MapCell, lens: DeskState["lens"]): string {
  const estimate = cell.areaEstimated ? " Market cap estimated from the median." : "";
  return `${cell.code}, ${cell.name}, ${cell.sector}. ${LENS_LABELS[lens]}: ${formatLensFigure(lens, cell.value)}.${estimate}`;
}

/**
 * The band a sector's name is printed in, at the top of its box. A name sits over
 * the cells in the top row, so their own labels give way to it (see bandedCodes).
 */
const SECTOR_BAND = 20;

/** A sector name's width, estimated from its characters: the labels are never measured. */
function sectorNameWidth(name: string): number {
  return name.length * 6.6 + 8;
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
}: {
  cell: MapCell;
  lens: DeskState["lens"];
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
  const title = cellTitle(cell, lens);
  // Below sm the labels are not printed: a 4 px code is no label, and the title and the table carry it.
  // Under a sector's name band the label starts below the band (a cell that fills its sector once
  // lost its code altogether); a cell too short to hold both prints none.
  const bandOffset = banded ? SECTOR_BAND : 0;
  const showLabel = width >= 40 && height >= 22 + bandOffset;
  const fontSize = Math.min(12, (height - bandOffset) * 0.3);
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
      {showLabel ? (
        <text
          x={cell.x0 + 4}
          y={cell.y0 + bandOffset + fontSize + 3}
          fontSize={fontSize}
          fill={labelColourFor(cell.value, scale)}
          className="pointer-events-none hidden font-mono tabular-nums sm:inline"
        >
          {cell.code}
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
  handlers,
}: {
  sector: MapSector;
  zoomed: boolean;
  handlers?: MapHandlers;
}) {
  const width = sector.x1 - sector.x0;
  const height = sector.y1 - sector.y0;
  const label = sector.sector;
  const zoom = handlers !== undefined && !zoomed && width >= 24 && height >= 24 ? handlers : undefined;
  const showText = width >= 72;
  const bandWidth = Math.min(width, sectorNameWidth(label));
  const bandHeight = Math.min(SECTOR_BAND, height);
  return (
    <g data-sector={sector.sector}>
      <title>{`${label}, ${sector.stocks} ${sector.stocks === 1 ? "stock" : "stocks"}`}</title>
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
              x={sector.x0 + 4}
              y={sector.y0 + 13}
              fontSize={11}
              className="pointer-events-none hidden font-mono sm:inline"
              fill="hsl(var(--foreground))"
            >
              {label}
            </text>
          ) : null}
        </g>
      ) : showText ? (
        <text
          x={sector.x0 + 4}
          y={sector.y0 + 13}
          fontSize={11}
          className="pointer-events-none hidden font-mono sm:inline"
          fill="hsl(var(--foreground))"
        >
          {label}
        </text>
      ) : null}
    </g>
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
}: {
  layout: MapLayout;
  lens: DeskState["lens"];
  scale: LensScale;
  selected?: string;
  focusCode?: string;
  handlers?: MapHandlers;
  groupStyle?: CSSProperties;
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
      className="block h-auto w-full select-none"
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
            scale={scale}
            selected={cell.code === selected}
            focused={handlers !== undefined && cell.code === roving}
            banded={banded.has(cell.code)}
            handlers={handlers}
          />
        ))}
        {layout.sectors.map((sector) => (
          <SectorShape key={sector.sector} sector={sector} zoomed={layout.zoomed} handlers={handlers} />
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
}: OwnershipMapViewProps) {
  const failed = status === "error" || (status === "idle" && !page.ok);
  // A read in flight or one that failed keeps the last good answer on the screen, so a
  // failed window does not take the whole map with it. Its flow and its notice counts
  // belong to the window it was read for, so they are hatched and n/a until a new read lands.
  const stale = page.ok && status !== "idle";
  const held = page.ok ? page.stocks : [];
  const rows = stale ? held.map((stock) => ({ ...stock, flowPp: null })) : held;
  const loading = status === "loading" && rows.length === 0;
  const empty = status === "idle" && page.ok && page.stocks.length === 0;
  const busy = status === "loading";
  const layout = layoutMap(rows, {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    lens: desk.lens,
    sector: desk.sector,
  });
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

  return (
    <div ref={rootRef} onKeyDown={onRootKeyDown} className="space-y-4">
      {page.asOf !== "" ? (
        <p className="text-xs text-muted-foreground">
          Notices read to <time dateTime={page.asOf}>{page.asOf}</time>
        </p>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">{WINDOW_LABEL}</span>
          <WindowChips
            label={WINDOW_LABEL}
            active={notice}
            hrefFor={(next) => noticeWindowHref(basePath, params, next)}
          />
        </div>
        <div role="group" aria-label={LENS_GROUP_LABEL} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">{LENS_GROUP_LABEL}</span>
          {LENS_ORDER.map((lens) => {
            const picked = chip({ lens });
            return (
              <DeskChip
                key={lens}
                href={picked.href}
                onPick={picked.onPick}
                active={desk.lens === lens}
                label={LENS_LABELS[lens]}
              />
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        The net change and the notice counts cover the notices released <WindowPhrase state={notice} asOf={page.asOf} />.
      </p>

      {rows.length > 0 ? (
        figured ? (
          <LensLegend lens={desk.lens} scale={scale} />
        ) : (
          <p className="text-[11px] text-muted-foreground">{NO_FIGURE_COPY}</p>
        )
      ) : null}

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

      {rows.length > 0 && !unknownSector && desk.sector === "" ? (
        // The phone's way into a sector: the drawing's name is not printed below sm, and a
        // sector's box is too small to press with a thumb. Each chip is a link, so it is a stop.
        // From sm the chips are visually hidden but stay in the tab order, and show when focused.
        <nav aria-label="Sectors" className="flex flex-wrap gap-1.5 sm:sr-only sm:focus-within:not-sr-only">
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

      <div className={cn(panel !== undefined && "lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6")}>
        <div className="min-w-0">
          {rows.length > 0 && !unknownSector ? (
            <div aria-busy={busy} className={cn("relative", status !== "idle" && "opacity-60")}>
              <DeskMapFigure
                layout={layout}
                lens={desk.lens}
                scale={scale}
                selected={selected}
                focusCode={focusCode}
                handlers={handlers}
                groupStyle={groupStyle}
              />
              {overlay}
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
              <p className="mt-2 text-[11px] text-muted-foreground">{mapCaption(desk.lens)}</p>
            </>
          ) : null}
        </div>
        {panel}
      </div>
    </div>
  );
}

/**
 * The default view, rendered on the server into the ISR HTML: the window of 91
 * days, the disclosed lens and the whole market, from the page's own answer. A
 * default view the server could not read is the outage line, never an empty map.
 */
export function OwnershipMapStatic({
  initial,
  basePath = "/ownership",
}: {
  initial: OwnershipMapPage;
  basePath?: string;
}) {
  return (
    <OwnershipMapView
      page={initial}
      desk={DEFAULT_DESK_STATE}
      notice={DESK_DEFAULT_WINDOW_STATE}
      status={initial.ok ? "idle" : "error"}
      slow={false}
      basePath={basePath}
    />
  );
}
