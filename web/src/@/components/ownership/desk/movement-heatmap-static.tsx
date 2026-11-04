import Link from "next/link";
import type { ReactNode } from "react";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { formatPointChange } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";
import type { IndustryWeekRow, OwnershipActivityPage } from "~/app/actions/ownershipDesk";
import { binOf, countScale, labelOnBin, lensFill, netScale } from "./desk-scales";
import { LensLegend } from "./lens-legend";
import { Toolbar, type ToolbarFold } from "../workspace/toolbar";
import { WindowSelect } from "../workspace/window-select";
import { shortSector } from "~/@/lib/ownership/kinds";
import { DEFAULT_DESK_SORT, isIsoDate, shiftDate, type DeskSort } from "./desk-state";
import { parseSelection } from "../workspace/selection";
import { OTHER_SECTOR, sectorOf } from "./map-layout";
import {
  WindowPhrase,
  hrefWithParams,
  noticeWindowDates,
  type NoticeWindow,
} from "./window-chips";

// The movement heatmap's pure layer and its server drawing (spec 13.4). Rows are
// sectors, columns are Monday-started weeks, and a cell is the net change in
// disclosed voting power over the notices released that week, in percentage
// points. A PLAIN MODULE: no "use client", no hooks, so the server renders the
// default view into the HTML and the island draws the same grid for a brush.
//
// A cell with no notice is blank. A cell with notices that states no figure is
// hatched, never painted as zero: a week of notices we could not read a change
// from is not a week that did not move.

/** The phone drawing's weeks: the newest 26, the spec's phone window. */
export const HEAT_PHONE_WEEKS = 26;
/** The height of one sector row, in CSS pixels. The label column holds the same height. */
export const HEAT_ROW_PX = 18;
const PHONE_CELL = 10;
/**
 * The most weeks a grid prints its figures across (spec 14.7). A cell of a longer window
 * is narrower than a figure, so the figure is left to the title and the inspector.
 */
export const HEAT_FIGURE_MAX_WEEKS = 26;
/** The Overview's compact pane: the newest weeks it draws (spec 14.3). */
export const HEAT_PANE_WEEKS = 10;
/**
 * The Overview's compact pane: the sectors it names before the rest fold into one row. Eleven sectors and the
 * folded row make twelve rows, which with the legend fit the pane's fixed 320px from lg (backlog B2).
 */
export const HEAT_PANE_SECTORS = 11;
/** The compact pane's folded row: every sector past the most active. Never linked, never selected. */
export const HEAT_FOLDED_ROW = "Other sectors";
/** The desktop grid's cell width, in its own units. The brush reads the same width. */
export const HEAT_FULL_CELL = 12;
const FULL_CELL = HEAT_FULL_CELL;
const FEED_PATH = "/ownership/notices";

export type HeatEvent = "became" | "increased" | "decreased" | "changed" | "ceased" | "nz";

const EVENT_WORDS: readonly (readonly [HeatEvent, string])[] = [
  ["became", "became substantial"],
  ["increased", "increased"],
  ["decreased", "decreased"],
  ["changed", "changed"],
  ["ceased", "ceased"],
  ["nz", "NZ disclosures"],
];

export interface HeatCell {
  weekStart: string;
  /** Every notice released in the week, every event counted. */
  notices: number;
  counts: Readonly<Record<HeatEvent, number>>;
  /** The net change in percentage points; null when there are no notices, or one states no figure. */
  netPp: number | null;
}

export interface HeatRow {
  sector: string;
  /** Notices in the window (or in every week, when no window is given). */
  total: number;
  /** One cell per displayed week, oldest first. */
  cells: HeatCell[];
}

/**
 * The compact pane's rows: the `keep` sectors with the most notices in the window (the rows arrive in that
 * order), and the rest summed into one row. A folded week's net is stated only when every notice the week
 * folds states a figure, as heatRows states it for a sector: a partial sum would read as a change.
 */
export function foldHeatRows(rows: readonly HeatRow[], keep: number): HeatRow[] {
  if (rows.length <= keep) return [...rows];
  const head = rows.slice(0, keep);
  const tail = rows.slice(keep);
  const first = tail[0];
  if (first === undefined) return [...rows];
  const cells: HeatCell[] = first.cells.map((base, index) => {
    const parts = tail
      .map((row) => row.cells[index])
      .filter((cell): cell is HeatCell => cell !== undefined && cell.notices > 0);
    const counts: Record<HeatEvent, number> = { became: 0, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0 };
    let net = 0;
    let stated = true;
    for (const cell of parts) {
      for (const event of Object.keys(counts) as HeatEvent[]) counts[event] += cell.counts[event];
      if (cell.netPp === null) stated = false;
      else net += cell.netPp;
    }
    const notices = parts.reduce((sum, cell) => sum + cell.notices, 0);
    return { weekStart: base.weekStart, notices, counts, netPp: notices > 0 && stated ? net : null };
  });
  const total = tail.reduce((sum, row) => sum + row.total, 0);
  return [...head, { sector: HEAT_FOLDED_ROW, total, cells }];
}

/**
 * The compact pane's order under the "changed" sort: by the magnitude of each row's net change over the
 * window, a fall as much as a rise, so the sectors the pane keeps are the ones that moved most. A row with
 * no stated net is last, then the more notices first. The full page keeps rises first (heatRows).
 */
export function magnitudeHeatRows(rows: readonly HeatRow[], range: WeekRange | null): HeatRow[] {
  const size = (row: HeatRow) => {
    const net = windowNetPp(row, range);
    return net === null ? -1 : Math.abs(net);
  };
  return [...rows].sort((a, b) => {
    const moved = size(b) - size(a);
    if (moved !== 0) return moved;
    return b.total - a.total || (a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : 0);
  });
}

/** A row's label: the short sector name, or the folded row's own name. */
export function heatRowLabel(sector: string): string {
  return sector === HEAT_FOLDED_ROW ? HEAT_FOLDED_ROW : shortSector(sector);
}

/** The inclusive index range of the weeks a window covers. */
export interface WeekRange {
  first: number;
  last: number;
}

/**
 * A row's net change over the window: the sum of the stated net of each week in the range (every week when
 * there is no range). Null when no week in the range states one, so a row with no figure is n/a, never zero;
 * and null when a week with notices in the range states no figure, because the sum of the other weeks would
 * read as a change the notices do not state (the same rule heatRows applies to a single week).
 */
export function windowNetPp(row: HeatRow, range: WeekRange | null): number | null {
  let net = 0;
  let stated = false;
  let partial = false;
  row.cells.forEach((cell, index) => {
    if (range !== null && (index < range.first || index > range.last)) return;
    if (cell.netPp === null) {
      if (cell.notices > 0) partial = true;
      return;
    }
    net += cell.netPp;
    stated = true;
  });
  return stated && !partial ? net : null;
}

/** Rises first, then falls, and a row with no figure last. Zero means a tie: the caller's next key decides. */
function riseFirst(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** The notices released in each week, summed over every industry: the brush's bars (spec 14.3). */
export function weekTotals(rows: readonly IndustryWeekRow[], weeks: readonly string[]): number[] {
  const indexOf = new Map(weeks.map((week, index) => [week, index]));
  const totals = weeks.map(() => 0);
  for (const row of rows) {
    const index = indexOf.get(row.weekStart);
    if (index === undefined) continue;
    totals[index] += row.became + row.increased + row.decreased + row.changed + row.ceased + row.nz;
  }
  return totals;
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A week's header in the grid: its Monday as "26 Oct" (spec 14.3). */
export function weekDateLabel(weekStart: string): string {
  const [, month, day] = weekStart.split("-");
  const name = SHORT_MONTHS[Number(month) - 1];
  if (name === undefined || day === undefined) return weekStart;
  return `${Number(day)} ${name}`;
}

/** The Monday a date falls in, as YYYY-MM-DD. The date must be valid. */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return shiftDate(date, -((day + 6) % 7));
}

/** Every Monday from `from` to `to`, both included. Empty for a span that is not one. */
export function weekList(from: string, to: string): string[] {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return [];
  const weeks: string[] = [];
  for (let week = from; week <= to && weeks.length < 400; week = shiftDate(week, 7)) {
    weeks.push(week);
  }
  return weeks;
}

/**
 * The weeks a window covers: every week whose Monday falls on or after the Monday
 * of the window's first day and on or before its last. Null when the window has no
 * date or no week is shown.
 */
export function selectedWeekRange(
  state: NoticeWindow,
  asOf: string,
  weeks: readonly string[],
): WeekRange | null {
  const span = noticeWindowDates(state, asOf);
  if (span === null || weeks.length === 0) return null;
  const firstMonday = mondayOf(span.from);
  let first = -1;
  let last = -1;
  weeks.forEach((week, index) => {
    if (week < firstMonday || week > span.to) return;
    if (first < 0) first = index;
    last = index;
  });
  return first < 0 ? null : { first, last };
}

interface Accumulator {
  notices: number;
  counts: Record<HeatEvent, number>;
  net: number;
  hasNet: boolean;
  missing: boolean;
}

function emptyAccumulator(): Accumulator {
  return {
    notices: 0,
    counts: { became: 0, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0 },
    net: 0,
    hasNet: false,
    missing: false,
  };
}

/**
 * The sector rows of the movement: the rows of every industry in one sector
 * summed by week, sorted by the notices in the window (every week when there is no
 * window), or, under the "changed" sort (backlog C3), by the window's net change, rises first.
 * A sector with no notice in the weeks shown is no row. A week's net is
 * stated only when every notice that week has a figure: a partial sum would read as
 * a change the notices do not state.
 */
export function heatRows(
  rows: readonly IndustryWeekRow[],
  weeks: readonly string[],
  range: WeekRange | null,
  sort: DeskSort = DEFAULT_DESK_SORT,
): HeatRow[] {
  const indexOf = new Map(weeks.map((week, index) => [week, index]));
  const bySector = new Map<string, Accumulator[]>();
  for (const row of rows) {
    const index = indexOf.get(row.weekStart);
    if (index === undefined) continue;
    const sector = sectorOf(row.industry);
    let cells = bySector.get(sector);
    if (cells === undefined) {
      cells = weeks.map(emptyAccumulator);
      bySector.set(sector, cells);
    }
    const cell = cells[index]!;
    const notices =
      row.became + row.increased + row.decreased + row.changed + row.ceased + row.nz;
    cell.notices += notices;
    cell.counts.became += row.became;
    cell.counts.increased += row.increased;
    cell.counts.decreased += row.decreased;
    cell.counts.changed += row.changed;
    cell.counts.ceased += row.ceased;
    cell.counts.nz += row.nz;
    if (notices > 0) {
      if (row.netPp === null || !Number.isFinite(row.netPp)) cell.missing = true;
      else {
        cell.net += row.netPp;
        cell.hasNet = true;
      }
    }
  }

  const sectors: HeatRow[] = [...bySector].map(([sector, cells]) => {
    const built: HeatCell[] = cells.map((cell, index) => ({
      weekStart: weeks[index]!,
      notices: cell.notices,
      counts: { ...cell.counts },
      netPp: cell.notices > 0 && !cell.missing && cell.hasNet ? cell.net : null,
    }));
    const total = built.reduce(
      (sum, cell, index) =>
        range === null || (index >= range.first && index <= range.last) ? sum + cell.notices : sum,
      0,
    );
    return { sector, total, cells: built };
  });
  sectors.sort((a, b) => {
    if (sort === "changed") {
      const moved = riseFirst(windowNetPp(a, range), windowNetPp(b, range));
      if (moved !== 0) return moved;
    }
    return b.total - a.total || (a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : 0);
  });
  return sectors.filter((row) => row.cells.some((cell) => cell.notices > 0));
}

/** The largest net change in any cell, in percentage points, the scale of the colours. */
export function heatReach(rows: readonly HeatRow[]): number {
  let reach = 0;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.netPp !== null) reach = Math.max(reach, Math.abs(cell.netPp));
    }
  }
  return reach;
}

/** A cell's figures as its tooltip and its accessible name state them. */
export function cellTitle(sector: string, cell: HeatCell): string {
  const when = `${sector}, week of ${cell.weekStart}`;
  if (cell.notices === 0) return `${when}: no notices read`;
  const parts = EVENT_WORDS.filter(([event]) => cell.counts[event] > 0).map(
    ([event, word]) => `${cell.counts[event]} ${word}`,
  );
  const noun = cell.notices === 1 ? "notice" : "notices";
  const net =
    cell.netPp === null
      ? "net change in disclosed voting power n/a"
      : `net change in disclosed voting power ${formatPointChange(0, cell.netPp)}`;
  return `${when}: ${cell.notices} ${noun} (${parts.join(", ")}); ${net}`;
}

/** The direction glyph a row carries under the "changed" sort (backlog C3): a rise, a fall, or an en dash for no stated change. */
export function rowGlyph(net: number | null): string {
  // The threshold is the one formatPointChange prints as "0.00 pp": a figure that prints as zero is no direction.
  if (net === null || Math.abs(net) < 0.005) return EN_DASH;
  return net > 0 ? UP_TRIANGLE : DOWN_TRIANGLE;
}

/** A row's title under the "changed" sort: its net over the window, or that none is stated. */
export function rowNetTitle(sector: string, net: number | null): string {
  return `${sector}, ${rowNetPhrase(net)}`;
}

/** A row's net over the window as words, without the sector: the title and the screen reader table say the same. */
export function rowNetPhrase(net: number | null): string {
  return net === null ? "no net change stated over the window" : `${formatPointChange(0, net)} over the window`;
}

/** The feed filtered to one sector and one week. The sector is left out for the placeholder group. */
export function heatFeedHref(sector: string, weekStart: string, kind = ""): string {
  const params = new URLSearchParams();
  if (sector !== OTHER_SECTOR) params.set("industry", sector);
  // The cell's holder type travels with it (spec 14.7): the feed counts the grid's kind, not every kind.
  if (kind !== "") params.set("kind", kind);
  params.set("since", weekStart);
  params.set("until", shiftDate(weekStart, 6));
  return hrefWithParams(FEED_PATH, params);
}

function noticeWord(count: number): string {
  return `${count} ${count === 1 ? "notice" : "notices"}`;
}

const SR_NAME = "Movement by sector and week";

/** The grid's measure: the net change in percentage points (the default), or the count of notices. */
export type HeatMeasure = "pp" | "count";

interface GridProps {
  rows: readonly HeatRow[];
  weeks: readonly string[];
  /** The window's weeks, drawn as a hairline under the columns it covers (never as a dim of the stops). */
  range: WeekRange | null;
  variant: "phone" | "full";
  reach: number;
  measure?: HeatMeasure;
  /** The most notices in one cell, which the count shades against. */
  countReach?: number;
  /** A desktop cell's selection (the workspace's inspector); absent, the cell links to the feed. */
  onCellSelect?: (sector: string, weekStart: string) => void;
  /** The selected cell, outlined so the grid shows what the inspector names. */
  selectedCell?: { sector: string; weekStart: string } | null;
  /** Print each cell's figure in an HTML overlay (the workspace's Activity page only). */
  figures?: boolean;
  /** The holder type the grid counts; "" for every kind. Carried by each cell's link. */
  kind?: string;
  /** The order the rows came in (backlog C3). Under "changed" each label carries its direction glyph. */
  sort?: DeskSort;
}

/** The figure a cell's colour is drawn from: its notice count, or its net change in percentage points. */
function cellValue(item: HeatCell, measure: HeatMeasure): number | null {
  return measure === "count" ? item.notices : item.netPp;
}

/** The minus sign the figures print, U+2212, so a fall reads as a true minus (spec 7.1). */
const TRUE_MINUS = String.fromCharCode(0x2212);
const EN_DASH = String.fromCharCode(0x2013);
const UP_TRIANGLE = String.fromCharCode(0x25b2);
const DOWN_TRIANGLE = String.fromCharCode(0x25bc);

/**
 * A cell's printed figure (spec 14.3, Activity): the count of notices, or the net change in
 * percentage points with a true minus. A zero net is a dash, and a cell that states no figure
 * prints nothing (it is hatched). Null when the cell is drawn without a figure.
 */
export function cellFigure(item: HeatCell, measure: HeatMeasure): string | null {
  if (measure === "count") return String(item.notices);
  if (item.netPp === null) return null;
  // The rounded figure decides the dash: a net of 0.03 prints as zero, never "+0.0".
  const rounded = Math.round(Math.abs(item.netPp) * 10) / 10;
  if (rounded === 0) return EN_DASH;
  return `${item.netPp > 0 ? "+" : TRUE_MINUS}${rounded.toFixed(1)}`;
}

/**
 * One grid: a label column of sector names and an SVG of cells. The SVG stretches
 * to its column with `preserveAspectRatio="none"`, which only changes the width of a
 * rectangle, so the rows stay aligned with the labels beside them. Cells are links
 * with `tabIndex` -1: the sr-only table carries the keyboard path to each one.
 */
function HeatGrid({
  rows,
  weeks,
  range,
  variant,
  reach,
  measure = "pp",
  countReach = 0,
  onCellSelect,
  selectedCell = null,
  figures = false,
  kind = "",
  sort = DEFAULT_DESK_SORT,
}: GridProps) {
  const offset = variant === "phone" ? Math.max(0, weeks.length - HEAT_PHONE_WEEKS) : 0;
  const shown = weeks.slice(offset);
  const cell = variant === "phone" ? PHONE_CELL : FULL_CELL;
  const idPrefix = `movement-${variant}`;
  const width = Math.max(shown.length, 1) * cell;
  const height = rows.length * HEAT_ROW_PX;
  // Figures are HTML, not SVG text: the SVG stretches to its column, which would stretch the glyphs.
  const printFigures = figures && variant === "full" && shown.length <= HEAT_FIGURE_MAX_WEEKS;
  // The cells' scale: whole-notice bins for a count, diverging bins around zero for a net change (spec 14.9).
  const cellScale = measure === "count" ? countScale(countReach) : netScale(reach);
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2",
        variant === "phone" ? "sm:hidden" : "hidden sm:grid",
      )}
    >
      <ol className="flex flex-col" style={{ height }}>
        {rows.map((row) => {
          // Under the "changed" sort the label names the window's direction in the foreground ink, and its title the net.
          const net = sort === "changed" ? windowNetPp(row, range) : undefined;
          return (
            <li
              key={row.sector}
              title={net === undefined ? row.sector : rowNetTitle(row.sector, net)}
              className="flex items-center truncate text-[11px] leading-none text-muted-foreground"
              style={{ height: HEAT_ROW_PX }}
            >
              {net === undefined ? null : (
                <span aria-hidden="true" className="mr-1 text-foreground">
                  {rowGlyph(net)}
                </span>
              )}
              {heatRowLabel(row.sector)}
            </li>
          );
        })}
      </ol>
      <div className="relative min-w-0">
        <svg
          viewBox={`0 0 ${width} ${Math.max(height, 1)}`}
          preserveAspectRatio="none"
          focusable="false"
          className="block w-full"
          style={{ height }}
        >
          <defs>
            <pattern
              id={`${idPrefix}-hatch`}
              width={4}
              height={4}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1={0} y1={0} x2={0} y2={4} stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} />
            </pattern>
          </defs>
          {rows.map((row, rowIndex) => (
            <g key={row.sector} transform={`translate(0 ${rowIndex * HEAT_ROW_PX})`}>
              {row.cells.slice(offset).map((item, column) => {
                if (item.notices === 0) return null;
                const fill = lensFill(cellValue(item, measure), cellScale) ?? `url(#${idPrefix}-hatch)`;
                const isSelected = selectedCell !== null && selectedCell.sector === row.sector && selectedCell.weekStart === item.weekStart;
                const mark = (
                  <>
                    <rect
                      x={column * cell + 0.5}
                      y={0.5}
                      width={Math.max(cell - 1, 0.5)}
                      height={HEAT_ROW_PX - 1}
                      fill={fill}
                      stroke={isSelected ? "hsl(var(--foreground))" : undefined}
                      strokeWidth={isSelected ? 1.5 : undefined}
                    />
                    <title>{cellTitle(row.sector, item)}</title>
                  </>
                );
                // The phone grid is a picture: the sr-only table carries every link, so
                // a cell links only on the desktop grid. The placeholder group has no
                // sector to filter the feed by, so its cells never link.
                const linked = variant === "full" && row.sector !== OTHER_SECTOR && row.sector !== HEAT_FOLDED_ROW;
                // A workspace cell selects (spec 14.9): a click or Enter writes its sel, and the feed
                // link is the inspector's and the table's, not the drawing's.
                const select =
                  onCellSelect === undefined || variant !== "full" || row.sector === HEAT_FOLDED_ROW
                    ? null
                    : () => onCellSelect(row.sector, item.weekStart);
                return (
                  <g key={item.weekStart}>
                    {select !== null ? (
                      <g
                        role="button"
                        tabIndex={-1}
                        aria-label={cellTitle(row.sector, item)}
                        aria-pressed={isSelected}
                        data-sector={row.sector}
                        data-week={item.weekStart}
                        className="cursor-pointer"
                        onClick={select}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            select();
                          }
                        }}
                      >
                        {mark}
                      </g>
                    ) : linked ? (
                      <Link
                        href={heatFeedHref(row.sector, item.weekStart, kind)}
                        prefetch={false}
                        rel="nofollow"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={
                          onCellSelect === undefined
                            ? undefined
                            : (event) => {
                                // A workspace cell selects for the inspector; the link stays in the table.
                                event.preventDefault();
                                onCellSelect(row.sector, item.weekStart);
                              }
                        }
                      >
                        {mark}
                      </Link>
                    ) : (
                      mark
                    )}
                  </g>
                );
              })}
            </g>
          ))}
          {/* The window is a mark under its columns, never a dim of the stops (A2): a stop reads the same inside and outside it. */}
          {range !== null && range.last >= offset && range.first < weeks.length && (range.first > offset || range.last < weeks.length - 1) ? (
            <line
              x1={(Math.max(range.first, offset) - offset) * cell}
              x2={(Math.min(range.last, weeks.length - 1) - offset + 1) * cell}
              y1={height - 0.5}
              y2={height - 0.5}
              stroke="hsl(var(--foreground))"
              strokeWidth={1}
            />
          ) : null}
        </svg>
      {printFigures ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col">
          {rows.map((row) => (
            <div
              key={row.sector}
              className="grid items-center"
              style={{ height: HEAT_ROW_PX, gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
            >
              {row.cells.slice(offset).map((item) => {
                // A zero week is a muted dash; a week with notices but no stated figure prints nothing.
                const text = item.notices === 0 ? EN_DASH : (cellFigure(item, measure) ?? "");
                // The figure takes its stop's own ink (desk-scales, the theme's --desk-*-ink tokens, AA at 11px; spec 14.9, A2).
                const ink = labelOnBin(binOf(cellValue(item, measure), cellScale), cellScale);
                return (
                  <span
                    key={item.weekStart}
                    className={cn(
                      "truncate text-center font-mono text-[11px] leading-none tabular-nums",
                      item.notices === 0 && "text-muted-foreground",
                    )}
                    style={item.notices === 0 ? undefined : { color: ink }}
                  >
                    {text}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      </div>
    </div>
  );
}

/**
 * The sr-only table: one row per sector and week that has notices, each count a link to the feed.
 * In the workspace (`onCellSelect`), each row carries a Select control, so the inspector fills by keyboard (spec 14.7).
 */
export function HeatTable({
  rows,
  onCellSelect,
  kind = "",
  range = null,
  sort = DEFAULT_DESK_SORT,
}: {
  rows: readonly HeatRow[];
  onCellSelect?: (sector: string, weekStart: string) => void;
  kind?: string;
  /** The weeks the window covers; the row's net is summed over them under the "changed" sort. */
  range?: WeekRange | null;
  sort?: DeskSort;
}) {
  const lines = rows.flatMap((row) =>
    row.cells.filter((item) => item.notices > 0).map((item) => ({ row, item })),
  );
  const contents = (
    <>
      <caption>{SR_NAME}</caption>
      <thead>
        <tr>
          <th scope="col">Sector</th>
          <th scope="col">Week beginning</th>
          <th scope="col">Notices</th>
          <th scope="col">Net change in disclosed voting power</th>
          {onCellSelect === undefined ? null : <th scope="col">Select</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map(({ row, item }) => (
          <tr key={`${row.sector}-${item.weekStart}`}>
            <th scope="row">
              {row.sector}
              {/* The grid's direction glyph is drawn for sight only; the window's net is said here for a screen reader. */}
              {sort === "changed" ? <span className="sr-only">, {rowNetPhrase(windowNetPp(row, range))}</span> : null}
            </th>
            <td>
              <time dateTime={item.weekStart}>{item.weekStart}</time>
            </td>
            <td>
              {row.sector === OTHER_SECTOR || row.sector === HEAT_FOLDED_ROW ? (
                noticeWord(item.notices)
              ) : (
                <Link href={heatFeedHref(row.sector, item.weekStart, kind)} prefetch={false} rel="nofollow">
                  {noticeWord(item.notices)}
                </Link>
              )}
            </td>
            <td>{item.netPp === null ? NOT_AVAILABLE : formatPointChange(0, item.netPp)}</td>
            {onCellSelect === undefined ? null : row.sector === HEAT_FOLDED_ROW ? (
              <td />
            ) : (
              <td>
                <button
                  type="button"
                  aria-label={`Select ${row.sector}, week of ${item.weekStart}`}
                  className="rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  onClick={() => onCellSelect(row.sector, item.weekStart)}
                >
                  Select
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </>
  );
  // The workspace's table is the keyboard path to a cell (spec 14.9): its Select buttons are the only
  // focusable way to fill the inspector, so the table shows itself while one of them has focus. Without
  // a selection it stays the screen reader's clipped table, as ScreenReaderTable draws it.
  if (onCellSelect === undefined) return <ScreenReaderTable ariaLabel={SR_NAME}>{contents}</ScreenReaderTable>;
  return (
    <div className="sr-only focus-within:not-sr-only focus-within:my-4">
      <table aria-label={SR_NAME}>{contents}</table>
    </div>
  );
}

export interface MovementHeatmapViewProps {
  /** The island's phone fold of the toolbar; absent on the server, where the row is drawn as it is. */
  toolbarFold?: ToolbarFold;
  /** Writes the window in place (the Window select). Absent on the server, where the select is drawn disabled. */
  onWindowChange?: (next: NoticeWindow) => void;
  page: OwnershipActivityPage;
  /** The window the grid shades and sorts by. The island passes its brushed window while a brush is held. */
  state: NoticeWindow;
  /** The path the window chips link to. */
  basePath: string;
  /** The reader's other parameters, kept on every window link. */
  params: URLSearchParams;
  /** The brush strip the island adds under the desktop grid. Absent on the server. */
  brush?: ReactNode;
  /** The island's measure and holder type, drawn above the grid (workspace only). */
  controls?: ReactNode;
  measure?: HeatMeasure;
  onCellSelect?: (sector: string, weekStart: string) => void;
  /** The holder type the grid counts; "" for every kind (spec 14.7). */
  kind?: string;
  /** The Overview's compact pane (backlog B2): its most active sectors and a folded row, no legend caption. */
  compact?: boolean;
  /** The order the sectors are drawn in (backlog C3): by notices, or by the window's net change. */
  sort?: DeskSort;
  /**
   * The Activity page (spec 14.3). Off, this is the Overview's compact pane: no window chips,
   * no caption and no figures, as the wireframe draws it.
   */
  workspace?: boolean;
}

/**
 * The movement as drawn: the window chips, the caption, the grids (the newest 26
 * weeks below sm, all 52 from sm up), the brush strip when given, a legend and the
 * sr-only table. The server draws it as the default view; the island draws it again
 * for a brushed window.
 */
export function MovementHeatmapView({
  page,
  state,
  params,
  brush = null,
  controls,
  measure = "pp",
  onCellSelect,
  workspace = false,
  kind = "",
  compact = false,
  toolbarFold,
  onWindowChange,
  sort = DEFAULT_DESK_SORT,
}: MovementHeatmapViewProps) {
  const selection = parseSelection(params.get("sel") ?? "");
  // A cell outlines only in the holder type the grid is showing: the inspector names that kind's cell.
  const selectedCell =
    selection?.kind === "cell" && (selection.holderKind ?? "") === kind
      ? { sector: selection.sector, weekStart: selection.date }
      : null;
  if (!page.ok) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        The movement could not be read just now. Nothing here is missing from the register: this is our end.
      </p>
    );
  }
  const allWeeks = weekList(page.fromWeek, page.toWeek);
  // The Overview's pane is the newest ten weeks (spec 14.3); the workspace draws every week it holds.
  const weeks = workspace ? allWeeks : allWeeks.slice(-HEAT_PANE_WEEKS);
  const range = selectedWeekRange(state, page.asOf, weeks);
  // The compact pane names its most active sectors and folds the rest into one row (backlog B2).
  // Under the changed sort the pane keeps the eleven that moved most by magnitude, not the first eleven of
  // the rises-first order, which folded every faller away once eleven sectors rose.
  const paneRows = (list: HeatRow[], span: WeekRange | null) =>
    compact
      ? foldHeatRows(sort === "changed" ? magnitudeHeatRows(list, span) : list, HEAT_PANE_SECTORS)
      : list;
  const phoneRows = paneRows(heatRows(page.rows, weeks, range, sort), range);
  // The workspace's desktop grid draws the window's own weeks, 13 columns at the default 91 days, so its
  // figures print in the cells (spec 14.3). The brush below still spans every week.
  const shownWeeks = workspace && range !== null ? weeks.slice(range.first, range.last + 1) : weeks;
  const shownRange = selectedWeekRange(state, page.asOf, shownWeeks);
  const rows = paneRows(heatRows(page.rows, shownWeeks, shownRange, sort), shownRange);
  const reach = heatReach([...phoneRows, ...rows]);
  const countReach = [...phoneRows, ...rows].reduce(
    (most, row) => row.cells.reduce((m, c) => Math.max(m, c.notices), most),
    0,
  );
  return (
    <div className="space-y-4">
      {/* One toolbar row (spec 14.9): the page's controls and the window, labelled, under "Adjust view" below sm. */}
      {workspace || controls !== undefined ? (
        <Toolbar fold={toolbarFold}>
          {controls}
          {workspace ? <WindowSelect active={state} onWindowChange={onWindowChange} /> : null}
        </Toolbar>
      ) : null}
      {workspace ? (
        <p className="text-sm text-muted-foreground">
          Window <WindowPhrase state={state} asOf={page.asOf} />.{" "}
          {sort === "changed"
            ? "Sectors are sorted by their net change over the window, rises first."
            : "Sectors are sorted by the notices released in the whole weeks the window touches."}{" "}
          {measure === "count"
            ? "Each cell is the number of notices released that week, deeper where there are more."
            : "Each cell is the net change in disclosed voting power over that week's notices, in percentage points, summed from what the notices disclose and not a share of the company. Ink is a fall, amber a rise, and a hatched cell has notices that state no figure."}
        </p>
      ) : null}
      {phoneRows.length === 0 && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notices read in these weeks.</p>
      ) : (
        <div className="space-y-1.5">
          {workspace && shownWeeks.length <= HEAT_FIGURE_MAX_WEEKS ? (
            <div aria-hidden="true" className="hidden grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 sm:grid">
              <span />
              <div
                className="grid text-[10px] tabular-nums text-muted-foreground"
                style={{ gridTemplateColumns: `repeat(${shownWeeks.length}, minmax(0, 1fr))` }}
              >
                {shownWeeks.map((week) => (
                  <span key={week} className="truncate text-center">
                    {weekDateLabel(week)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <HeatGrid rows={phoneRows} weeks={weeks} range={range} variant="phone" reach={reach} measure={measure} countReach={countReach} selectedCell={selectedCell} kind={kind} sort={sort} />
          <HeatGrid
            rows={rows}
            weeks={shownWeeks}
            range={shownRange}
            variant="full"
            reach={reach}
            measure={measure}
            countReach={countReach}
            onCellSelect={onCellSelect}
            selectedCell={selectedCell}
            figures={workspace}
            kind={kind}
            sort={sort}
          />
          {brush}
          {measure === "count" ? (
            <div className="pt-1">
              <LensLegend
                lens="disclosed"
                name="Notices in one week"
                scale={countScale(countReach)}
                format={(edge) => String(Math.round(edge))}
              />
            </div>
          ) : (
            <div className="space-y-2 pt-1">
              <LensLegend lens="flow" scale={netScale(reach)} />
              {compact ? null : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-sm border border-muted-foreground"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(45deg, hsl(var(--muted-foreground)) 0 1px, transparent 1px 4px)",
                  }}
                />
                Notices with no figure stated
              </li>
              </ul>
              )}
            </div>
          )}
        </div>
      )}
      <HeatTable rows={rows} onCellSelect={onCellSelect} kind={kind} range={shownRange} sort={sort} />
    </div>
  );
}

/** The server's default view: the newest notice window, no brush. */
export function MovementHeatmapStatic({
  page,
  state,
  basePath,
}: {
  page: OwnershipActivityPage;
  state: NoticeWindow;
  basePath: string;
}) {
  return (
    <MovementHeatmapView page={page} state={state} basePath={basePath} params={new URLSearchParams()} workspace />
  );
}
