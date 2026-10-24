import type { ReactNode } from "react";
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
  /** Rows the tool reported but did not send. Named in the footer when above zero. */
  notShown?: number;
}

/**
 * A table of tool results for the chat. Semantic markup throughout: a caption,
 * column headers with scope="col", row headers where a column has rowHeader, and
 * numbers right-aligned. The header stays in view while the rows scroll, and the
 * table scrolls sideways inside the bubble on a narrow screen. The scroll region
 * takes a tab stop, so a keyboard user can reach a table wider than the bubble.
 */
export function ChatDataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  notShown = 0,
}: ChatDataTableProps<Row>) {
  return (
    <div
      role="region"
      aria-label={caption}
      // A scrollable region must be focusable to be scrolled from the keyboard
      // (WAI-ARIA APG, "scrollable region must have keyboard access").
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="max-h-72 w-full overflow-auto rounded-md border border-border/70 bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
        <caption className="caption-top px-2.5 py-2 text-left text-xs font-medium text-foreground">
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  "sticky top-0 z-10 whitespace-nowrap border-b border-border/70 bg-background px-2.5 py-1.5 font-medium text-muted-foreground",
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
            <tr key={rowKey(row)}>
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
                className="border-t border-border/70 px-2.5 py-1.5 text-muted-foreground"
              >
                {formatWhole(notShown)} more not shown
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function cellClass(numeric: boolean | undefined): string {
  return cn(
    "border-b border-border/50 px-2.5 py-1.5 align-middle",
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
