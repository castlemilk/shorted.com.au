import React from "react";
import {
  READOUT_LINE_H,
  READOUT_OHLC_MIN_WIDTH,
  READOUT_ONE_ROW_MIN_WIDTH,
  type ReadoutDelta,
  type ReadoutEntry,
  type ReadoutModel,
  type ReadoutVolume,
} from "./chart-readout";
import { chartTheme } from "./chart-theme";

// Market direction and nothing else (DESIGN.md, the Semantic Quarantine Rule):
// the two hexes the floating measure card has always used.
const UP = "#16a34a";
const DOWN = "#dc2626";

// DESIGN.md, the Tabular Rule: a figure we do not hold reads "n/a", never a dash.
const NOT_AVAILABLE = "n/a";

const RELEASE_TITLE = "Tap the chart to move the reading; tap it again to release";

// On one row the entries follow the headline, so a headline that changes width
// moves them: "Latest · 1 June 2026" to "29 Mar 2026" on entering the plot, or
// "9 Oct" to "10 Oct" as a scrub crosses a day. Holding the room of the widest
// one stops that. "Latest · 29 Sept 2026" is 21 characters and "29 Sept 2026 →
// 29 Sept 2026" is 27. (On a phone the headline has a row to itself.)
const HEADLINE_MIN_CH = { reading: 21, measure: 27 } as const;

/** Red or green only for a change that is market direction; else the text colour. */
function directionColor(change: ReadoutDelta): string | undefined {
  if (!change.colored) return undefined;
  return change.tone === "up" ? UP : change.tone === "down" ? DOWN : undefined;
}

// The glyphs of a percentage-point change, which takes no colour here: the same
// three the stock header prints beside its 30-day change (stock-header.tsx,
// describeChange, which also colours it), so one figure reads one way. U+2013
// for no change is written as an escape, because it looks like a hyphen.
const POINTS_GLYPH: Record<ReadoutDelta["tone"], string> = {
  up: "▲",
  down: "▼",
  flat: "\u2013",
};

function Change({ change }: { change: ReadoutDelta }) {
  const color = directionColor(change);
  // A change that is not market direction (percentage points) takes no colour,
  // so a glyph says which way it went, then a space and the signed value, as the
  // header does: "▲ +0.62 pp", "▼ −0.31 pp", "– 0.00 pp". The sign says it too,
  // which is why the glyph is hidden from assistive technology. A price change
  // is coloured instead and has no glyph: "+3.1%".
  const glyph = change.colored ? "" : POINTS_GLYPH[change.tone];
  return (
    <span data-readout-change>
      {glyph && (
        <>
          <span aria-hidden="true">{glyph}</span>{" "}
        </>
      )}
      <span style={color ? { color } : undefined}>{change.text}</span>
    </span>
  );
}

// Where there is room (one row, from 640px) each entry keeps the width of its
// widest usual value and change, so the resting reading, a hover and a pin lay
// out alike: a pointer entering the plot must not shift the entries that
// follow. A value keeps the room of the widest one its series can show
// (`valueChars`) where that is more than the usual six, so a scrub across a
// digit boundary, $99.99 to $100.00, moves nothing either. On a phone every
// series has a row to itself, so no entry sits beside another to be moved, and
// no room is held: the whole row is the label's.
const VALUE_MIN_CH = 6;
/** "▲ +2.84 pp", the widest change a series usually names. */
const CHANGE_SLOT_CH = 10;

function EntryView({
  entry,
  measuring,
  roomy,
  valueChars,
}: {
  entry: ReadoutEntry;
  measuring: boolean;
  /** One row for all the entries, so each keeps the room of its widest reading. */
  roomy: boolean;
  /** The most characters this series' value can take, when the chart knows. */
  valueChars?: number;
}) {
  const valueMinCh = Math.max(VALUE_MIN_CH, valueChars ?? 0);
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
          style={roomy ? { minWidth: `${valueMinCh}ch` } : undefined}
        >
          {entry.value ?? NOT_AVAILABLE}
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
        <span className="shrink-0 text-foreground">{NOT_AVAILABLE}</span>
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

/**
 * What the grey bars are, for anyone who wonders: the strip's Vol reading
 * carries it as a title, and the hover card names the row in full.
 */
export const VOLUME_EXPLAINER =
  "Volume: shares traded on the ASX in the session. The grey bars at the foot of the chart, on a scale of their own.";

/** "123.45B", the widest volume `formatVolume` prints ("999.9M" is six). */
const VOLUME_VALUE_CH = 7;

/**
 * The volume swatch: the bars' own colour, at a strength that reads at 8px. A
 * square, where a series has a dot, because the bars are not a series.
 */
export function VolumeSwatch() {
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-[1px]"
      style={{ background: chartTheme.volume, opacity: 0.6 }}
    />
  );
}

function VolumeView({ volume, roomy }: { volume: ReadoutVolume; roomy: boolean }) {
  return (
    <span
      data-readout-volume
      title={VOLUME_EXPLAINER}
      className="flex shrink-0 items-center gap-x-1"
    >
      <VolumeSwatch />
      <span className="text-muted-foreground">Vol</span>
      <span
        data-readout-volume-value
        className="text-foreground"
        style={roomy ? { minWidth: `${VOLUME_VALUE_CH}ch` } : undefined}
      >
        {volume.value ?? NOT_AVAILABLE}
      </span>
      {volume.dateNote && (
        <span className="text-muted-foreground">· {volume.dateNote}</span>
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
  /**
   * The chart's width: it picks one row or a row for each series, and whether
   * OHLC shows.
   */
  width: number;
  /**
   * The strip's height. The chart decides it once, from its width and its number
   * of series, and takes it off the svg beneath, so the two cannot add up to
   * anything but its own height.
   */
  height: number;
  pinned: boolean;
  /**
   * The most characters each series' value can take, by series id (see
   * `widestValueChars`). On one row a value keeps that much room.
   */
  valueChars?: Readonly<Record<string, number>>;
  /**
   * The series rows a phone strip lays out: one for each entry, and when this is
   * more, the rest are held empty for series that have not arrived (`StockChart`'s
   * `readoutReserveSeries`). `height` already counts them, so the strip is as
   * tall before they land as after, and the headline row is what they leave.
   * Nothing on one row, where every series shares it.
   */
  seriesRows?: number;
  /** Releases the pin. Must be stable, or the memo below buys nothing. */
  onRelease: () => void;
}

/**
 * The readout above the plot (spec D5): the latest values, or the hovered,
 * pinned or measured ones. From 640px wide it is one row. Below that it is a
 * headline row, with the Pinned chip at its right, and then one row for each
 * series, so a label is never short of room and one entry never moves another.
 * The session's volume, where the chart draws it, follows the series on one row
 * and the headline on a phone, so it never adds a row.
 *
 * Its height is given, from the chart's width and number of series, and is never
 * read back from the DOM, and it holds nothing that could move the plot: no
 * floating layer, no wrapping, and a clipped overflow.
 *
 * It holds no SVG on purpose: the chart's own svg is the first `svg` in the
 * canvas, which stories and tests look it up by.
 */
export const ChartReadoutStrip = React.memo(function ChartReadoutStrip({
  model,
  width,
  height,
  pinned,
  valueChars,
  seriesRows,
  onRelease,
}: ChartReadoutStripProps) {
  const oneRow = width >= READOUT_ONE_ROW_MIN_WIDTH;
  // A phone strip's rows: an entry each, or more when rows are held for series
  // to come. Anything that is not a count holds none.
  const rows = Math.max(
    model.entries.length,
    typeof seriesRows === "number" && Number.isFinite(seriesRows) ? Math.floor(seriesRows) : 0,
  );
  const heldRows = rows - model.entries.length;
  const measuring = model.state === "measure";
  const volume = !measuring && model.volume ? model.volume : null;
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
          <div
            data-readout-entries
            className="flex min-w-0 items-center gap-x-3 overflow-hidden"
          >
            {model.entries.map((e) => (
              <EntryView
                key={e.id}
                entry={e}
                measuring={measuring}
                roomy
                valueChars={valueChars?.[e.id]}
              />
            ))}
            {volume && <VolumeView volume={volume} roomy />}
          </div>
          {ohlc && (
            <span data-readout-ohlc className="shrink-0 text-muted-foreground">
              O {ohlc.open} H {ohlc.high} L {ohlc.low} C {ohlc.close}
            </span>
          )}
          {chip}
        </Row>
      ) : (
        <>
          {/* The series rows are a line each; the headline row has what is left,
              which is room for the release button's 24px target. */}
          <Row height={Math.max(0, height - READOUT_LINE_H * rows)}>
            {headline}
            {volume && <VolumeView volume={volume} roomy={false} />}
            {chip}
          </Row>
          <div data-readout-entries>
            {model.entries.map((e) => (
              <Row key={e.id} height={READOUT_LINE_H}>
                <EntryView entry={e} measuring={measuring} roomy={false} />
              </Row>
            ))}
            {/* The row of a series still to come: nothing in it, and nothing
                for a screen reader, but its 18px, so that the series arriving
                moves nothing. It is not a `data-readout-row`: it holds no entry. */}
            {Array.from({ length: heldRows }, (_, i) => (
              <div
                key={`held-${i}`}
                data-readout-reserved
                aria-hidden="true"
                style={{ height: READOUT_LINE_H }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
});

/**
 * The sentence a screen reader gets when a reading is pinned, built from the
 * same model the strip shows: "Pinned 6 Oct 2026: Price $43.21, Short % 3.20%,
 * Volume 1.2M". A value on another day says so, as the strip does.
 */
export function pinnedAnnouncement(model: ReadoutModel): string {
  const parts = model.entries
    .filter((e) => e.value !== null)
    .map((e) => `${e.label} ${e.value}${e.dateNote ? ` on ${e.dateNote}` : ""}`);
  const v = model.volume;
  if (v?.value) {
    parts.push(`Volume ${v.value}${v.dateNote ? ` on ${v.dateNote}` : ""}`);
  }
  return `Pinned ${model.headline}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}
