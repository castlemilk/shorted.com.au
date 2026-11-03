/**
 * The index fund window's two snapshot dates (spec 13.5): two handles over the
 * dates the tracked funds have, the later never at or before the earlier.
 *
 * EACH HANDLE IS A SLIDER. Two role="slider" elements carry their own value and
 * their date as aria-valuetext, so a screen reader hears "2026-10-31" and the
 * arrow keys move one snapshot at a time. Home and End go to the end of the range
 * a handle may take. The pointer captures a handle and drags it to the nearest
 * snapshot.
 *
 * NO STATE HERE. The pair is the props and every change is `onChange`, so the
 * server's default view and the island draw the same markup. Without `onChange`
 * the handles are read-only and leave the tab order.
 *
 * A PURE MODULE beside the component: `movePair` and `snapshotIndex` hold the
 * rules the handles obey, and the tests pin them without a browser.
 */

import type { KeyboardEvent, PointerEvent } from "react";

/** The two handles as indices into the snapshot dates, the earlier first. */
export interface SnapshotPair {
  from: number;
  to: number;
}

export type SnapshotHandle = "from" | "to";

/**
 * The pair after a handle is asked to move to `index`. The earlier handle stays
 * at or before the later one less a step, and the later stays after the earlier
 * plus a step, so a window always spans at least two snapshots.
 */
export function movePair(
  count: number,
  pair: SnapshotPair,
  handle: SnapshotHandle,
  index: number,
): SnapshotPair {
  if (count < 2) return pair;
  if (handle === "from") {
    return { from: clamp(index, 0, pair.to - 1), to: pair.to };
  }
  return { from: pair.from, to: clamp(index, pair.from + 1, count - 1) };
}

/**
 * The index of a date in the snapshot dates. A date that is not one of them
 * (a link from before a snapshot was dropped) takes the newest snapshot on or
 * before it, or the oldest when every snapshot is later.
 */
export function snapshotIndex(dates: readonly string[], date: string): number {
  const exact = dates.indexOf(date);
  if (exact !== -1) return exact;
  let index = 0;
  dates.forEach((d, i) => {
    if (d <= date) index = i;
  });
  return index;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** The position of a snapshot on the track, as a percentage from its left edge. */
function percentAt(index: number, count: number): number {
  return count > 1 ? (index / (count - 1)) * 100 : 0;
}

const KEY_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
};

export interface DateSliderProps {
  /** The snapshot dates, oldest first, as YYYY-MM-DD. Fewer than two draw nothing. */
  dates: readonly string[];
  /** The earlier and later dates chosen. Each is read to its snapshot. */
  from: string;
  to: string;
  /** The group's accessible name. */
  label: string;
  /** Called with the new pair. Absent: the handles are read-only. */
  onChange?: (from: string, to: string) => void;
}

/**
 * The pair the handles show for a pair of indices. A pair read from a link can
 * arrive inverted, and one that names a single snapshot widens to the next, so a
 * window always spans two. The one rule the slider and its caption both read.
 */
export function shownPair(count: number, pair: SnapshotPair): SnapshotPair {
  // A pair read from a link can arrive inverted; the handles keep the order the rules need.
  const low = Math.min(pair.from, pair.to);
  const high = Math.max(pair.from, pair.to);
  return low === high ? { from: low, to: Math.min(low + 1, count - 1) } : { from: low, to: high };
}

/**
 * The two dates the slider shows for a link's dates, so a caption can print the
 * window the rows are for. A link with no dates, or fewer than two snapshots, is
 * returned as it is.
 */
export function shownSnapshotDates(dates: readonly string[], from: string, to: string): { from: string; to: string } {
  if (dates.length < 2 || from === "" || to === "") return { from, to };
  const shown = shownPair(dates.length, { from: snapshotIndex(dates, from), to: snapshotIndex(dates, to) });
  return { from: dates[shown.from] ?? from, to: dates[shown.to] ?? to };
}

export function DateSlider({ dates, from, to, label, onChange }: DateSliderProps) {
  const count = dates.length;
  if (count < 2) return null;
  const interactive = onChange !== undefined;
  const shown = shownPair(count, { from: snapshotIndex(dates, from), to: snapshotIndex(dates, to) });

  const emit = (next: SnapshotPair) => {
    if (!onChange) return;
    if (next.from === shown.from && next.to === shown.to) return;
    onChange(dates[next.from]!, dates[next.to]!);
  };

  const onKeyDown = (handle: SnapshotHandle, event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const current = handle === "from" ? shown.from : shown.to;
    let index: number | undefined;
    const step = Object.hasOwn(KEY_STEP, event.key) ? KEY_STEP[event.key] : undefined;
    if (step !== undefined) index = current + step;
    else if (event.key === "Home") index = handle === "from" ? 0 : shown.from + 1;
    else if (event.key === "End") index = handle === "from" ? shown.to - 1 : count - 1;
    if (index === undefined) return;
    event.preventDefault();
    emit(movePair(count, shown, handle, index));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  };

  const onPointerMove = (handle: SnapshotHandle, event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const track = event.currentTarget.closest<HTMLElement>("[data-date-track]");
    if (!track) return;
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return;
    const fraction = clamp((event.clientX - box.left) / box.width, 0, 1);
    emit(movePair(count, shown, handle, Math.round(fraction * (count - 1))));
  };

  const fromPercent = percentAt(shown.from, count);
  const toPercent = percentAt(shown.to, count);

  const handle = (name: SnapshotHandle, index: number, aria: string, percent: number) => (
    <div
      role="slider"
      aria-label={aria}
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={index}
      aria-valuetext={dates[index]}
      aria-disabled={interactive ? undefined : true}
      tabIndex={interactive ? 0 : -1}
      data-handle={name}
      onKeyDown={(event) => onKeyDown(name, event)}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => onPointerMove(name, event)}
      style={{ left: `${percent}%` }}
      className={
        "absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 touch-none rounded-sm border border-input bg-background " +
        (interactive
          ? "cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          : "")
      }
    />
  );

  return (
    <div role="group" aria-label={label} className="space-y-1.5">
      <div data-date-track="" className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden="true" />
        {dates.map((date, index) => (
          <span
            key={date}
            aria-hidden="true"
            style={{ left: `${percentAt(index, count)}%` }}
            className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground"
          />
        ))}
        <div
          aria-hidden="true"
          style={{ left: `${fromPercent}%`, width: `${toPercent - fromPercent}%` }}
          className="absolute top-1/2 h-1 -translate-y-1/2 bg-primary"
        />
        {handle("from", shown.from, "Earlier snapshot", fromPercent)}
        {handle("to", shown.to, "Later snapshot", toPercent)}
      </div>
    </div>
  );
}
