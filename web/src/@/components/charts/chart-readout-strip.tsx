import React from "react";
import {
  READOUT_OHLC_MIN_WIDTH,
  READOUT_ONE_ROW_MIN_WIDTH,
  readoutStripHeight,
  type ReadoutDelta,
  type ReadoutEntry,
  type ReadoutModel,
} from "./chart-readout";

// Market direction and nothing else (DESIGN.md, the Semantic Quarantine Rule):
// the two hexes the floating measure card has always used.
const UP = "#16a34a";
const DOWN = "#dc2626";

// Two rows share READOUT_ROW_H_TWO. The first carries the Pinned chip, whose
// release button needs a 24px target (the WCAG 2.5.8 floor), so it takes 24px
// and the entries row takes the rest.
const FIRST_ROW_H_OF_TWO = 24;

const RELEASE_TITLE = "Tap the chart to move the reading; tap it again to release";

// On one row the entries follow the headline, so a headline that changes width
// moves them: "Latest · 1 June 2026" to "29 Mar 2026" on entering the plot, or
// "9 Oct" to "10 Oct" as a scrub crosses a day. Holding the room of the widest
// one stops that. "Latest · 29 Sept 2026" is 21 characters and "29 Sept 2026 →
// 29 Sept 2026" is 27. (On two rows the headline has a row to itself.)
const HEADLINE_MIN_CH = { reading: 21, measure: 27 } as const;

/** Red or green only for a change that is market direction; else the text colour. */
function directionColor(change: ReadoutDelta): string | undefined {
  if (!change.colored) return undefined;
  return change.tone === "up" ? UP : change.tone === "down" ? DOWN : undefined;
}

function Change({ change }: { change: ReadoutDelta }) {
  const color = directionColor(change);
  // A change that is not market direction (percentage points) takes no colour,
  // so an arrow says which way it went. The sign in the text says it too, which
  // is why the arrow is hidden from assistive technology.
  const arrow = change.colored
    ? ""
    : change.tone === "up"
      ? "▲"
      : change.tone === "down"
        ? "▼"
        : "";
  return (
    <span
      data-readout-change
      className="inline-flex shrink-0 items-center gap-x-0.5"
    >
      {arrow && <span aria-hidden="true">{arrow}</span>}
      <span style={color ? { color } : undefined}>{change.text}</span>
    </span>
  );
}

// Where there is room (one row, from 640px) each entry keeps the width of its
// widest usual value and change, so the resting reading, a hover and a pin lay
// out alike: a pointer entering the plot must not shift the entries that
// follow. On a phone the two rows are too short of room for empty slots (they
// cost the labels), so only the value keeps a minimum.
const VALUE_MIN_CH = { room: 6, tight: 5 } as const;
/** "▲+2.84 pp", the widest change a series usually names. */
const CHANGE_SLOT_CH = 9;

function EntryView({
  entry,
  measuring,
  roomy,
}: {
  entry: ReadoutEntry;
  measuring: boolean;
  roomy: boolean;
}) {
  return (
    <span data-readout-entry={entry.id} className="flex min-w-0 items-center gap-x-1">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: entry.color }}
      />
      {/* The label gives way first when the row is short of room, so a value, a
          change and a date note are never the thing that is cut. */}
      <span className="min-w-0 truncate text-muted-foreground">{entry.label}</span>
      {/* A measure names the change between two dates, not a value. */}
      {!measuring && (
        <span
          data-readout-value
          className="shrink-0 text-foreground"
          style={{ minWidth: `${roomy ? VALUE_MIN_CH.room : VALUE_MIN_CH.tight}ch` }}
        >
          {entry.value ?? "—"}
        </span>
      )}
      {entry.change ? (
        <span
          className="shrink-0"
          style={roomy ? { minWidth: `${CHANGE_SLOT_CH}ch` } : undefined}
        >
          <Change change={entry.change} />
        </span>
      ) : measuring ? (
        <span className="shrink-0 text-foreground">—</span>
      ) : roomy ? (
        // No change in this state: hold the room it takes in the others.
        <span aria-hidden="true" className="shrink-0" style={{ minWidth: `${CHANGE_SLOT_CH}ch` }} />
      ) : null}
      {entry.dateNote && (
        <span data-readout-date-note className="shrink-0 text-muted-foreground">
          · {entry.dateNote}
        </span>
      )}
    </span>
  );
}

function PinnedChip({ onRelease }: { onRelease: () => void }) {
  return (
    <span data-readout-chip className="ml-auto inline-flex shrink-0 items-center gap-x-0.5">
      <span className="text-muted-foreground">Pinned</span>
      <button
        type="button"
        aria-label="Release pinned reading"
        title={RELEASE_TITLE}
        onClick={onRelease}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-sm leading-none text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span aria-hidden="true">×</span>
      </button>
    </span>
  );
}

function Row({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <div
      data-readout-row
      className="flex min-w-0 items-center gap-x-3"
      style={{ height }}
    >
      {children}
    </div>
  );
}

export interface ChartReadoutStripProps {
  model: ReadoutModel;
  /** The chart's width: it alone picks the height, one row or two, and OHLC. */
  width: number;
  pinned: boolean;
  /** Releases the pin. Must be stable, or the memo below buys nothing. */
  onRelease: () => void;
}

/**
 * The readout above the plot (spec D5): the latest values, or the hovered,
 * pinned or measured ones. Its height comes from `width` alone and is never read
 * back from the DOM, and it holds nothing that could move the plot: no floating
 * layer, no wrapping, and a clipped overflow.
 *
 * It holds no SVG on purpose: the chart's own svg is the first `svg` in the
 * canvas, which stories and tests look it up by.
 */
export const ChartReadoutStrip = React.memo(function ChartReadoutStrip({
  model,
  width,
  pinned,
  onRelease,
}: ChartReadoutStripProps) {
  const height = readoutStripHeight(width);
  const oneRow = width >= READOUT_ONE_ROW_MIN_WIDTH;
  const measuring = model.state === "measure";
  // Open, high, low and close of the price point shown, wide charts only.
  const ohlc =
    width >= READOUT_OHLC_MIN_WIDTH
      ? (model.entries.find((e) => e.ohlc)?.ohlc ?? null)
      : null;

  const headline = model.headline ? (
    <span
      data-readout-headline
      className="shrink-0 text-muted-foreground"
      style={
        oneRow
          ? { minWidth: `${measuring ? HEADLINE_MIN_CH.measure : HEADLINE_MIN_CH.reading}ch` }
          : undefined
      }
    >
      {model.headline}
    </span>
  ) : null;
  const entries = (
    <div
      data-readout-entries
      className={`flex min-w-0 items-center overflow-hidden ${oneRow ? "gap-x-3" : "gap-x-2"}`}
    >
      {model.entries.map((e) => (
        <EntryView key={e.id} entry={e} measuring={measuring} roomy={oneRow} />
      ))}
    </div>
  );
  const chip = pinned ? <PinnedChip onRelease={onRelease} /> : null;

  return (
    <div
      data-chart-readout
      data-readout-state={model.state}
      data-pinned={pinned ? "" : undefined}
      data-chart={measuring ? "measure-readout" : undefined}
      aria-live="off"
      className="overflow-hidden whitespace-nowrap px-1 font-mono text-xs tabular-nums"
      style={{ height }}
    >
      {oneRow ? (
        <Row height={height}>
          {headline}
          {entries}
          {ohlc && (
            <span data-readout-ohlc className="shrink-0 text-muted-foreground">
              O {ohlc.open} H {ohlc.high} L {ohlc.low} C {ohlc.close}
            </span>
          )}
          {chip}
        </Row>
      ) : (
        <>
          <Row height={FIRST_ROW_H_OF_TWO}>
            {headline}
            {chip}
          </Row>
          <Row height={height - FIRST_ROW_H_OF_TWO}>{entries}</Row>
        </>
      )}
    </div>
  );
});

/**
 * The sentence a screen reader gets when a reading is pinned, built from the
 * same model the strip shows: "Pinned 6 Oct 2026: Price $43.21, Short % 3.20%".
 * A value on another day says so, as the strip does.
 */
export function pinnedAnnouncement(model: ReadoutModel): string {
  const parts = model.entries
    .filter((e) => e.value !== null)
    .map((e) => `${e.label} ${e.value}${e.dateNote ? ` on ${e.dateNote}` : ""}`);
  return `Pinned ${model.headline}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}
