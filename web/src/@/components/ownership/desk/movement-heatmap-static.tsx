import Link from "next/link";
import type { ReactNode } from "react";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { formatPointChange } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";
import type { IndustryWeekRow, OwnershipActivityPage } from "~/app/actions/ownershipDesk";
import { netFill } from "./desk-scales";
import { isIsoDate, shiftDate } from "./desk-state";
import { OTHER_SECTOR, sectorOf } from "./map-layout";
import {
  WindowChips,
  WindowPhrase,
  hrefWithParams,
  noticeWindowDates,
  noticeWindowHref,
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

/** The inclusive index range of the weeks a window covers. */
export interface WeekRange {
  first: number;
  last: number;
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
 * window). A sector with no notice in the weeks shown is no row. A week's net is
 * stated only when every notice that week has a figure: a partial sum would read as
 * a change the notices do not state.
 */
export function heatRows(
  rows: readonly IndustryWeekRow[],
  weeks: readonly string[],
  range: WeekRange | null,
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
  sectors.sort((a, b) => b.total - a.total || (a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : 0));
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

/** The feed filtered to one sector and one week. The sector is left out for the placeholder group. */
export function heatFeedHref(sector: string, weekStart: string): string {
  const params = new URLSearchParams();
  if (sector !== OTHER_SECTOR) params.set("industry", sector);
  params.set("since", weekStart);
  params.set("until", shiftDate(weekStart, 6));
  return hrefWithParams(FEED_PATH, params);
}

function noticeWord(count: number): string {
  return `${count} ${count === 1 ? "notice" : "notices"}`;
}

const SR_NAME = "Movement by sector and week";

interface GridProps {
  rows: readonly HeatRow[];
  weeks: readonly string[];
  range: WeekRange | null;
  variant: "phone" | "full";
  reach: number;
}

/**
 * One grid: a label column of sector names and an SVG of cells. The SVG stretches
 * to its column with `preserveAspectRatio="none"`, which only changes the width of a
 * rectangle, so the rows stay aligned with the labels beside them. Cells are links
 * with `tabIndex` -1: the sr-only table carries the keyboard path to each one.
 */
function HeatGrid({ rows, weeks, range, variant, reach }: GridProps) {
  const offset = variant === "phone" ? Math.max(0, weeks.length - HEAT_PHONE_WEEKS) : 0;
  const shown = weeks.slice(offset);
  const cell = variant === "phone" ? PHONE_CELL : FULL_CELL;
  const idPrefix = `movement-${variant}`;
  const width = Math.max(shown.length, 1) * cell;
  const height = rows.length * HEAT_ROW_PX;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2",
        variant === "phone" ? "sm:hidden" : "hidden sm:grid",
      )}
    >
      <ol className="flex flex-col" style={{ height }}>
        {rows.map((row) => (
          <li
            key={row.sector}
            title={row.sector}
            className="flex items-center truncate text-[11px] leading-none text-muted-foreground"
            style={{ height: HEAT_ROW_PX }}
          >
            {row.sector}
          </li>
        ))}
      </ol>
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
              const index = column + offset;
              const dim = range === null || index < range.first || index > range.last;
              const fill = netFill(item.netPp, reach) ?? `url(#${idPrefix}-hatch)`;
              const mark = (
                <>
                  <rect
                    x={column * cell + 0.5}
                    y={0.5}
                    width={Math.max(cell - 1, 0.5)}
                    height={HEAT_ROW_PX - 1}
                    fill={fill}
                  />
                  <title>{cellTitle(row.sector, item)}</title>
                </>
              );
              // The phone grid is a picture: the sr-only table carries every link, so
              // a cell links only on the desktop grid. The placeholder group has no
              // sector to filter the feed by, so its cells never link.
              const linked = variant === "full" && row.sector !== OTHER_SECTOR;
              return (
                <g key={item.weekStart} opacity={dim ? 0.35 : 1}>
                  {linked ? (
                    <Link
                      href={heatFeedHref(row.sector, item.weekStart)}
                      prefetch={false}
                      rel="nofollow"
                      tabIndex={-1}
                      aria-hidden="true"
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
      </svg>
    </div>
  );
}

/** The sr-only table: one row per sector and week that has notices, each count a link to the feed. */
export function HeatTable({ rows }: { rows: readonly HeatRow[] }) {
  const lines = rows.flatMap((row) =>
    row.cells.filter((item) => item.notices > 0).map((item) => ({ row, item })),
  );
  return (
    <ScreenReaderTable ariaLabel={SR_NAME}>
      <caption>{SR_NAME}</caption>
      <thead>
        <tr>
          <th scope="col">Sector</th>
          <th scope="col">Week beginning</th>
          <th scope="col">Notices</th>
          <th scope="col">Net change in disclosed voting power</th>
        </tr>
      </thead>
      <tbody>
        {lines.map(({ row, item }) => (
          <tr key={`${row.sector}-${item.weekStart}`}>
            <th scope="row">{row.sector}</th>
            <td>
              <time dateTime={item.weekStart}>{item.weekStart}</time>
            </td>
            <td>
              {row.sector === OTHER_SECTOR ? (
                noticeWord(item.notices)
              ) : (
                <Link href={heatFeedHref(row.sector, item.weekStart)} prefetch={false} rel="nofollow">
                  {noticeWord(item.notices)}
                </Link>
              )}
            </td>
            <td>{item.netPp === null ? NOT_AVAILABLE : formatPointChange(0, item.netPp)}</td>
          </tr>
        ))}
      </tbody>
    </ScreenReaderTable>
  );
}

export interface MovementHeatmapViewProps {
  page: OwnershipActivityPage;
  /** The window the grid shades and sorts by. The island passes its brushed window while a brush is held. */
  state: NoticeWindow;
  /** The path the window chips link to. */
  basePath: string;
  /** The reader's other parameters, kept on every window link. */
  params: URLSearchParams;
  /** The brush strip the island adds under the desktop grid. Absent on the server. */
  brush?: ReactNode;
}

/**
 * The movement as drawn: the window chips, the caption, the grids (the newest 26
 * weeks below sm, all 52 from sm up), the brush strip when given, a legend and the
 * sr-only table. The server draws it as the default view; the island draws it again
 * for a brushed window.
 */
export function MovementHeatmapView({ page, state, basePath, params, brush = null }: MovementHeatmapViewProps) {
  if (!page.ok) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        The movement could not be read just now. Nothing here is missing from the register: this is our end.
      </p>
    );
  }
  const weeks = weekList(page.fromWeek, page.toWeek);
  const range = selectedWeekRange(state, page.asOf, weeks);
  const rows = heatRows(page.rows, weeks, range);
  const reach = heatReach(rows);
  return (
    <div className="space-y-4">
      <WindowChips
        label="Window of change"
        active={state}
        hrefFor={(next) => noticeWindowHref(basePath, params, next)}
      />
      <p className="text-sm text-muted-foreground">
        Window <WindowPhrase state={state} asOf={page.asOf} />. Sectors are sorted by the notices released in
        the whole weeks the window touches. Each cell is the net change in disclosed voting power over that
        week&apos;s notices, in percentage points, summed from what the notices disclose and not a share of the
        company. Ink is a fall, amber a rise, and a hatched cell has notices that state no figure.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notices read in these weeks.</p>
      ) : (
        <div className="space-y-1.5">
          <HeatGrid rows={rows} weeks={weeks} range={range} variant="phone" reach={reach} />
          <HeatGrid rows={rows} weeks={weeks} range={range} variant="full" reach={reach} />
          {brush}
          <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm bg-foreground" />
              Fall in disclosed voting power
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" />
              Rise in disclosed voting power
            </li>
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
        </div>
      )}
      <HeatTable rows={rows} />
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
  return <MovementHeatmapView page={page} state={state} basePath={basePath} params={new URLSearchParams()} />;
}
