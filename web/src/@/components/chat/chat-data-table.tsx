"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/@/lib/utils";
import { formatWhole } from "./chat-tool-format";

export interface ChatDataTableColumn<Row> {
  id: string;
  header: string;
  /** A number column: right-aligned, tabular figures. */
  numeric?: boolean;
  /** The first cell of each row names the row (a th with scope="row"). */
  rowHeader?: boolean;
  cell: (row: Row) => ReactNode;
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
}

/**
 * Tables up to this many rows are drawn in full. A longer one is held to a window
 * and scrolls down as well as across, so a 50-row answer does not fill the chat.
 */
const FULL_HEIGHT_ROWS = 10;

/**
 * A table of tool results for the chat. Semantic markup throughout: a caption,
 * column headers with scope="col", row headers where a column has rowHeader, and
 * numbers right-aligned. The header stays in view while the rows scroll, and the
 * table scrolls sideways inside the bubble on a narrow screen. The scroll region
 * takes a tab stop, so a keyboard user can reach a table wider than the bubble. A
 * fade on an edge shows that there is more of the table past it: the right edge
 * while the table runs wider than the bubble, the bottom while a long table
 * scrolls, which an overlay scrollbar (macOS, iOS, Android) does not show.
 */
export function ChatDataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  notShown = 0,
}: ChatDataTableProps<Row>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ right: false, below: false });

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
  // the region resizes with the bubble, and the table with its content.
  useEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure, rows, columns]);

  return (
    <div className="w-full">
      <div className="relative w-full">
        <div
          ref={scroller}
          role="region"
          aria-label={caption}
          onScroll={measure}
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
          <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
            <caption className="caption-top px-2 py-2 text-left text-xs font-medium text-foreground">
              {caption}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-10 whitespace-nowrap border-b border-border/70 bg-background px-2 py-1.5 font-medium text-muted-foreground",
                      column.numeric ? "text-right" : "text-left",
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className={rowClassName?.(row)}>
                  {columns.map((column) => {
                    const className = cellClass(column.numeric);
                    return column.rowHeader ? (
                      <th
                        key={column.id}
                        scope="row"
                        className={cn(className, "font-medium")}
                      >
                        {column.cell(row)}
                      </th>
                    ) : (
                      <td key={column.id} className={className}>
                        {column.cell(row)}
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
                    colSpan={columns.length}
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
      {overflow.below && (
        <p className="mt-1 text-[11px] text-muted-foreground">Scroll to see more rows.</p>
      )}
    </div>
  );
}

function cellClass(numeric: boolean | undefined): string {
  return cn(
    "border-b border-border/50 px-2 py-1.5 align-middle",
    numeric ? "text-right tabular-nums" : "text-left",
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
