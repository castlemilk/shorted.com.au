import type { ReactNode } from "react";

/** One selected item: its key for the caller, and the label its chip shows. */
export interface SelectionTrayItem {
  key: string;
  label: string;
}

export interface SelectionTrayProps {
  /** The region's accessible name. */
  label: string;
  items: readonly SelectionTrayItem[];
  /** The most items the caller allows. A selection past it is a caller bug, flagged in development. */
  max: number;
  /** The count's noun: the singular for one item, the plural otherwise. */
  noun: readonly [one: string, other: string];
  onRemove: (key: string) => void;
  /** A line under the chips, such as what a comparison reads. */
  note?: ReactNode;
  /** Ends the row, such as a link to the next step. */
  cta?: ReactNode;
}

/**
 * The selection tray (spec 14.1): a sticky strip at the foot of a list that names
 * what is selected, with a chip per item to remove it. It draws nothing when no
 * item is selected. The caller owns the selection (its URL, its state) and the
 * limit, and a selection past `max` is flagged in development.
 */
export function SelectionTray({ label, items, max, noun, onRemove, note, cta }: SelectionTrayProps) {
  if (process.env.NODE_ENV !== "production" && items.length > max) {
    console.warn(`SelectionTray "${label}" holds ${items.length} items, past its limit of ${max}.`);
  }
  if (items.length === 0) return null;
  return (
    <div
      role="region"
      aria-label={label}
      className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 font-mono text-sm"
    >
      <p>
        {items.length} {items.length === 1 ? noun[0] : noun[1]} selected
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              aria-label={`Remove ${item.label}`}
              onClick={() => onRemove(item.key)}
              className="rounded-[var(--radius)] border border-border px-2 py-0.5 text-xs hover:border-primary"
            >
              {item.label} ×
            </button>
          </li>
        ))}
      </ul>
      {note}
      {cta}
    </div>
  );
}
