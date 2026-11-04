import type { ReactNode } from "react";

/**
 * A long list's first rows, with the rest behind "Show all N" (backlog B5). The rest is in the
 * HTML: a closed details keeps its content in the DOM, so crawlers and the page's text read
 * every row, and a reader who opens the disclosure does not wait for a request.
 *
 * `children` is the section's own table or list with its first `limit` rows; `rest` is the same
 * markup with the remainder. A list of `limit` or fewer draws no disclosure at all.
 *
 * A plain module, server-safe: no "use client", no Connect, no generated code.
 */
export function ShowAll({
  total,
  limit,
  children,
  rest,
}: {
  /** Every row the section has, the first `limit` drawn and the rest in `rest`. */
  total: number;
  limit: number;
  children: ReactNode;
  rest: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {children}
      {total > limit ? (
        <details className="group">
          <summary className="hit-target cursor-pointer py-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
            <span className="group-open:hidden">{`Show all ${total}`}</span>
            <span className="hidden group-open:inline">{`Showing all ${total}`}</span>
          </summary>
          <div className="mt-3 space-y-3">{rest}</div>
        </details>
      ) : null}
    </div>
  );
}
