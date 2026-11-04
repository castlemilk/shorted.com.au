"use client";

/**
 * A table row that opens in place (spec 14.9): a chevron button in its first cell
 * carries `aria-expanded`, and the detail is drawn under the row at the table's own
 * size, in a full-width cell beneath it. Closed, the detail is not in the document's
 * layout at all; the row's figures are the data's, the detail is its record.
 *
 * It is a client module, so the server's list (the fund page) and the exposure map
 * both use it. Its props are serialisable: the cells and the detail are nodes.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export interface ExpandableRowProps {
  /** The detail row's id, which the chevron controls. */
  id: string;
  /** The row's name for its chevron's accessible label, e.g. "BHP details". */
  label: string;
  /** The table's column count, the chevron's column included: the detail spans it. */
  colSpan: number;
  /** The data cells, after the chevron's cell. */
  children: ReactNode;
  /** The figures the row opens to. */
  detail: ReactNode;
  /** Opened on first render; closed by default. */
  defaultOpen?: boolean;
  /** The row is the one the page's selection names: aria-current and the page's own highlight. */
  current?: boolean;
  className?: string;
}

/** The chevron column's header label, shared by every table with expanders. */
export const EXPANDER_HEADER = "Details";

export function ExpandableRow({
  id,
  label,
  colSpan,
  children,
  detail,
  defaultOpen = false,
  current = false,
  className,
}: ExpandableRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <tr
        aria-current={current ? "true" : undefined}
        className={cn("border-b border-border", !open && "last:border-0", className)}
      >
        <td className="w-8 px-1 py-2 align-top">
          <button
            type="button"
            aria-expanded={open}
            // The detail row exists only while open, so the reference names nothing while closed.
            aria-controls={open ? id : undefined}
            aria-label={`${open ? "Hide" : "Show"} ${label}`}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              width={12}
              height={12}
              className={cn(open && "rotate-90")}
            >
              <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth={1.5} />
            </svg>
          </button>
        </td>
        {children}
      </tr>
      {open ? (
        <tr id={id} className="border-b border-border last:border-0">
          <td colSpan={colSpan} className="px-2 pb-3 pt-0">
            {detail}
          </td>
        </tr>
      ) : null}
    </>
  );
}
