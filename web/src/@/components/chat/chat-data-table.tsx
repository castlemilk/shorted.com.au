"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "~/@/lib/utils";
import { tableTierFor, tierAtLeast, type TableTier } from "./chat-layout";
import { formatWhole } from "./chat-tool-format";

export interface ChatDataTableColumn<Row> {
  id: string;
  header: string;
  /** A number column: right-aligned, tabular figures. */
  numeric?: boolean;
  /** The header drawn at the compact tier, where a long one would widen the column. The full header is still the name. */
  compactHeader?: string;
  /** The first cell of each row names the row (a th with scope="row"). */
  rowHeader?: boolean;
  /**
   * The narrowest tier the column is drawn at. A column with none is drawn at every
   * width. A table at a narrower width leaves the column out, rather than scroll it.
   */
  minTier?: TableTier;
  /**
   * The column takes the width the other columns leave, and its cells truncate rather than
   * widen the table. Used for a name, which is the one text that can be as long as it likes.
   */
  fill?: boolean;
  /** The cell. `tier` is the tier the table is drawn at, so a cell can size itself to it. */
  cell: (row: Row, tier: TableTier) => ReactNode;
}

export interface ChatDataTableProps<Row> {
  /** The table's visible caption, and its accessible name. */
  caption: string;
  columns: readonly ChatDataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Extra classes for a row, such as the highlight on a subject stock. */
  rowClassName?: (row: Row) => string | undefined;
  /** Rows the tool reported but did not send. Named in the footer when above zero. */
  notShown?: number;
  /**
   * A note under the table, such as which rows its figures cover. It is given the tier the
   * table is drawn at, since the columns it names depend on it. Omitted when it returns nothing.
   */
  footnote?: (tier: TableTier) => string | undefined;
}

/**
 * Tables up to this many rows are drawn in full. A longer one is held to a window
 * and scrolls down as well as across, so a 50-row answer does not fill the chat.
 */
const FULL_HEIGHT_ROWS = 10;
/**
 * The height of the fade on a long table's foot (h-6). A row focused near the foot is
 * scrolled clear of it, so the fade does not cover its link or its focus ring.
 */
const FOOT_FADE_PX = 24;

/**
 * A table of tool results for the chat. Semantic markup throughout: a caption,
 * column headers with scope="col", row headers where a column has rowHeader, and
 * numbers right-aligned.
 *
 * The table measures its own width and draws the columns that fit it (see
 * chat-layout.ts): at the sidebar's width the figures a reader needs, and at the
 * /chat page's width every column. A table still wider than its region scrolls
 * sideways, and says so with a fade on its right edge. The header stays in view
 * while the rows scroll, and a row that takes keyboard focus is scrolled to just
 * under the header, not beneath it. The scroll region takes a tab stop, so a keyboard
 * user can reach a table wider than the bubble. A fade on the bottom shows that a long
 * table scrolls, which an overlay scrollbar (macOS, iOS, Android) does not show.
 */
export function ChatDataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  notShown = 0,
  footnote,
}: ChatDataTableProps<Row>) {
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLTableSectionElement>(null);
  const [overflow, setOverflow] = useState({ right: false, below: false });
  const [width, setWidth] = useState(0);
  const [headHeight, setHeadHeight] = useState(0);
  // A long table scrolls down, and its window takes a gutter for the scrollbar, so the
  // width the table is drawn to is the same whether or not the scrollbar shows.
  const gutter = rows.length > FULL_HEIGHT_ROWS;

  // The tier is read before paint, so the columns do not flash in and out, and it is
  // read again as the bubble resizes. It is the scroll region's own client width: the
  // table fits that, and a classic scrollbar (which the region's client width leaves out)
  // would otherwise leave a table just over the tier's floor scrolling sideways.
  const tier = tableTierFor(width);
  const note = footnote?.(tier);
  const shown = useMemo(
    () => columns.filter((column) => tierAtLeast(tier, column.minTier)),
    [columns, tier],
  );
  // A fill column's width is a share of the table, and a table that takes a minimum width
  // from its content would make that share unbounded (Chromium draws it a million pixels
  // wide). So a table with a fill column is drawn to the width its region has, and its
  // fill column truncates rather than widening it.
  const filled = shown.some((column) => column.fill);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const read = () => setWidth(element.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The header's height is the room a focused row needs above it: the scroll region is
  // told to stop short of the header, so the row lands clear of it.
  useLayoutEffect(() => {
    const element = head.current;
    if (!element) return;
    const read = () => setHeadHeight(element.offsetHeight);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setOverflow((previous) =>
      previous.right === right && previous.below === below ? previous : { right, below },
    );
  }, []);

  // The fades depend on the widths of the region and the table, so both are watched:
  // the region resizes with the bubble, and the table with its content and columns.
  useEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure, rows, shown]);

  return (
    <div className="w-full">
      <div className="relative w-full">
        <div
          ref={scroller}
          role="region"
          aria-label={caption}
          onScroll={measure}
          // Focus scrolls a row to the edge of the region. This stops it short of the
          // sticky header, which covers the top of the region, and short of the fade on
          // the foot while more of the table lies below, so a focused row is never under
          // either.
          style={{
            scrollPaddingTop: headHeight || undefined,
            scrollPaddingBottom: overflow.below ? FOOT_FADE_PX : undefined,
            scrollbarGutter: gutter ? "stable" : undefined,
          }}
          // A scrollable region must be focusable to be scrolled from the keyboard
          // (WAI-ARIA APG, "scrollable region must have keyboard access").
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          // `relative` makes the region the containing block of the screen-reader text
          // inside its cells. Without it that text is positioned against the wrapper
          // around the region, and it widens the page's scrollable area.
          className={cn(
            "relative w-full overflow-auto rounded-md border border-border/70 bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            rows.length > FULL_HEIGHT_ROWS && "max-h-72",
          )}
        >
          {/*
            The table is at least as wide as its widest content, so a wider table scrolls
            rather than squeezing its columns. At the compact tier it may shrink instead:
            its columns are narrow enough already, and a reader's date may wrap under the
            change, so the figures fit the phone's width without a sideways scroll.
          */}
          <table
            className={cn(
              "w-full border-separate border-spacing-0 text-xs",
              tier !== "compact" && !filled && "min-w-max",
            )}
          >
            <caption className="caption-top px-2 py-2 text-left text-xs font-medium text-foreground">
              {caption}
            </caption>
            <thead ref={head}>
              <tr>
                {shown.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    // A short header names the column in full for a screen reader.
                    aria-label={
                      tier === "compact" && column.compactHeader ? column.header : undefined
                    }
                    className={cn(
                      "sticky top-0 z-10 whitespace-nowrap border-b border-border/70 bg-background py-1.5 font-medium text-muted-foreground",
                      tier === "compact" ? "px-1.5" : "px-2",
                      column.numeric ? "text-right" : "text-left",
                    )}
                  >
                    {tier === "compact" && column.compactHeader ? (
                      <abbr title={column.header} className="no-underline">
                        {column.compactHeader}
                      </abbr>
                    ) : (
                      column.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={rowClassName?.(row)}
                  style={{ scrollMarginTop: headHeight || undefined }}
                >
                  {shown.map((column) => {
                    const className = cellClass(column.numeric, tier, column.fill);
                    return column.rowHeader ? (
                      <th
                        key={column.id}
                        scope="row"
                        className={cn(className, "font-medium")}
                      >
                        {column.cell(row, tier)}
                      </th>
                    ) : (
                      <td key={column.id} className={className}>
                        {column.cell(row, tier)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {notShown > 0 && (
              <tfoot>
                <tr>
                  <td
                    colSpan={Math.max(1, shown.length)}
                    className="border-t border-border/70 px-2 py-1.5 text-muted-foreground"
                  >
                    {formatWhole(notShown)} more not shown
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {overflow.right && (
          <div
            aria-hidden="true"
            data-testid="chat-table-more"
            className="pointer-events-none absolute inset-y-0 right-0 w-4 rounded-r-md bg-gradient-to-l from-background to-transparent"
          />
        )}
        {overflow.below && (
          <div
            aria-hidden="true"
            data-testid="chat-table-more-below"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-background to-transparent"
          />
        )}
      </div>
      {note && <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
      {overflow.below && (
        <p className="mt-1 text-[11px] text-muted-foreground">Scroll to see more rows.</p>
      )}
    </div>
  );
}

function cellClass(
  numeric: boolean | undefined,
  tier: TableTier,
  fill: boolean | undefined,
): string {
  return cn(
    "border-b border-border/50 py-1.5 align-middle",
    // The compact table is the narrowest, so its cells give up a little of their padding.
    tier === "compact" ? "px-1.5" : "px-2",
    numeric ? "text-right tabular-nums" : "text-left",
    // A fill column takes the table's leftover width, and its text is cut off inside it. A
    // zero max width is what lets the column shrink below its text (the cell's content
    // truncates), so the figures beside it keep their room.
    fill && "w-full max-w-0",
  );
}

/**
 * A missing value. The dash is hidden from a screen reader, which reads "Not
 * available" instead, so a table of gaps is not a run of "dash" announcements.
 */
export function Dash() {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        —
      </span>
      <span className="sr-only">Not available</span>
    </>
  );
}
