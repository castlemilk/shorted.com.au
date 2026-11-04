/**
 * The sort control (backlog C3): "Largest" or "Changed", one labelled select in an instrument's
 * toolbar row. The map (under a diverging lens), the heatmap, and the holders and fund pages (C3b)
 * share it, so the words and the link parameter are one thing.
 *
 * A labelled select, not a segmented control: the row is one line at 1440 (spec 14.9), and a
 * segmented control with its two words does not fit beside the map's other selects. The select is
 * the toolbar's own (ToolbarSelect), so its label and height match the row.
 *
 * A PLAIN MODULE, like window-select.tsx: the server's default view draws it disabled (no
 * handler), and an island passes `onChange`, which writes the link in place. The in-place
 * write is the one the window select uses (replaceState, which useSearchParams observes), so
 * the control makes no request of its own.
 */

import { DESK_SORTS, readDeskState, writeDeskParams, type DeskSort } from "../desk/desk-state";
import { ToolbarSelect } from "./toolbar";

/**
 * The visible words of each sort. The link carries `largest` and `changed`; the reader sees these.
 * "Changed" rather than "Most changed": the select's width is the longest option's, and the map's
 * row has no room for the longer word at 1440.
 */
export const SORT_LABELS: Readonly<Record<DeskSort, string>> = {
  largest: "Largest",
  changed: "Changed",
};

/**
 * Writes a sort into the current link in place, keeping every other parameter. The replaceState
 * is the one the window select uses, so the island reads the new sort from useSearchParams.
 */
export function writeSortInPlace(next: DeskSort): void {
  const writer = new URLSearchParams(window.location.search);
  writeDeskParams(writer, { ...readDeskState(writer), sort: next });
  const url = new URL(window.location.href);
  url.search = writer.toString();
  window.history.replaceState(null, "", url);
}

export interface SortControlProps {
  /** The sort the instrument is drawing in. */
  active: DeskSort;
  /** Called with the chosen sort. Absent on the server's default view, where the select is drawn disabled. */
  onChange?: (next: DeskSort) => void;
}

export function SortControl({ active, onChange }: SortControlProps) {
  return (
    <ToolbarSelect
      label="Sort"
      value={active}
      onChange={onChange === undefined ? undefined : (value) => onChange(value as DeskSort)}
    >
      {DESK_SORTS.map((sort) => (
        <option key={sort} value={sort}>
          {SORT_LABELS[sort]}
        </option>
      ))}
    </ToolbarSelect>
  );
}
