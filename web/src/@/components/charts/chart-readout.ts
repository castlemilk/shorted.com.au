/**
 * The chart's readout, as data (spec D5).
 *
 * Pure: no React, no DOM, no pointer state. The readout strip renders these
 * models, and `StockChart` builds them from the series it already rendered, so
 * the numbers, the dates and the "which series ended on another day" notes are
 * decided in one tested place instead of inside JSX.
 *
 * The strip's height is a function of the chart's width alone and is never read
 * back from the DOM, so a reading changing from one state to another cannot
 * move the plot.
 */
import { nearest } from "./chart-tooltip";
import type { ChartPoint, ChartSeriesSpec } from "./types";

/** At this width and above the strip is one row; below it, two. */
export const READOUT_ONE_ROW_MIN_WIDTH = 640;
/** At this width and above a price reading also shows open, high, low, close. */
export const READOUT_OHLC_MIN_WIDTH = 900;
export const READOUT_ROW_H_ONE = 28;
export const READOUT_ROW_H_TWO = 44;
/** The least plot height (px) worth drawing under a strip. */
export const READOUT_MIN_PLOT = 160;

export type ReadoutTone = "up" | "down" | "flat";

export interface ReadoutDelta {
  /** Rounded to the digits shown, so it agrees with `text` and `tone`. Never -0. */
  value: number;
  /** "+3.1%" for a relative change, "+0.21 pp" for an absolute one. */
  text: string;
  tone: ReadoutTone;
  /**
   * Whether red and green may colour this change. Only a relative change is
   * market direction; a percentage-point change in short interest stays plain.
   */
  colored: boolean;
}

export interface ReadoutEntry {
  id: string;
  label: string;
  color: string;
  /** Null when the series has no point to show. */
  value: string | null;
  /** The latest and measure states only; null elsewhere. */
  change: ReadoutDelta | null;
  /** "5 Oct" when this point is on another Sydney day than the headline. */
  dateNote: string | null;
  ohlc: { open: string; high: string; low: string; close: string } | null;
}

export type ReadoutState = "latest" | "hover" | "pinned" | "measure";

export interface ReadoutModel {
  state: ReadoutState;
  headline: string;
  entries: ReadoutEntry[];
}

/** Formats one series' value the way its axis does. */
export type ReadoutFormat = (series: ChartSeriesSpec, v: number) => string;

// Built once: constructing an Intl.DateTimeFormat is far dearer than using one,
// and a hover rebuilds the readout on every pointer move.
const TIME_ZONE = "Australia/Sydney";
const dateFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: TIME_ZONE,
});
const shortDateFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  timeZone: TIME_ZONE,
});
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TIME_ZONE,
});

/** "9 Oct 2026". */
export function formatReadoutDate(t: number): string {
  return dateFmt.format(t);
}

/** "9 Oct". */
export function formatReadoutShortDate(t: number): string {
  return shortDateFmt.format(t);
}

/**
 * The Sydney calendar day of `t`, "2026-10-09". Two points are "the same day"
 * when their keys match. Built from the parts, not from the formatted string,
 * so it does not depend on the locale's date pattern.
 */
export function readoutDayKey(t: number): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of dayKeyFmt.formatToParts(t)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * The change from `a` to `b` on `series`, the one piece of delta maths that the
 * drag-to-measure card and the strip's latest reading share.
 *
 * - relative (default): percent change, one decimal, "+3.1%". From a zero base
 *   there is nothing to divide by, so it reads 0.
 * - absolute: the raw difference, two decimals, then the series' unit,
 *   "+0.21 pp". For a series already expressed in percent.
 */
export function seriesDelta(
  series: ChartSeriesSpec,
  a: ChartPoint,
  b: ChartPoint,
): ReadoutDelta {
  const absolute = series.measureMode === "absolute";
  const digits = absolute ? 2 : 1;
  const relative = a.v !== 0 ? ((b.v - a.v) / a.v) * 100 : 0;
  const raw = absolute ? b.v - a.v : relative;
  // Round first so sign, tone and digits always agree, and "-0.0" can never
  // appear: Number("-0.0") is -0, which is falsy, so `|| 0` makes it 0.
  const value = Number(raw.toFixed(digits)) || 0;
  const tone: ReadoutTone = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const sign = tone === "up" ? "+" : tone === "down" ? "-" : "";
  const measureUnit = series.measureUnit ? ` ${series.measureUnit}` : "";
  const unit = absolute ? measureUnit : "%";
  return {
    value,
    text: `${sign}${Math.abs(value).toFixed(digits)}${unit}`,
    tone,
    colored: !absolute,
  };
}

const isNum = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Open, high, low and close, only when the point carries all four. */
function ohlcOf(p: ChartPoint): ReadoutEntry["ohlc"] {
  const { open, high, low, close } = p;
  if (!isNum(open) || !isNum(high) || !isNum(low) || !isNum(close)) return null;
  return {
    open: open.toFixed(2),
    high: high.toFixed(2),
    low: low.toFixed(2),
    close: close.toFixed(2),
  };
}

/** A series with nothing to show keeps its row, so the strip never reflows. */
function emptyEntry(s: ChartSeriesSpec): ReadoutEntry {
  return {
    id: s.id,
    label: s.label,
    color: s.color,
    value: null,
    change: null,
    dateNote: null,
    ohlc: null,
  };
}

/**
 * The resting reading: each series' newest visible value and its change over
 * the visible range. The headline is the newest date across the series; a
 * series that ends on another Sydney day carries its own date.
 *
 * A normalised view has no change to show (every series starts at zero), and
 * neither has a series with a single point. With no point anywhere there is no
 * date to name, so the headline is empty.
 */
export function buildLatestReadout(a: {
  series: ChartSeriesSpec[];
  zoomed: boolean;
  viewMode: "absolute" | "normalized";
  format: ReadoutFormat;
}): ReadoutModel {
  const { series, zoomed, viewMode, format } = a;

  let headlineT = -Infinity;
  for (const s of series) {
    const last = s.points[s.points.length - 1];
    if (last && last.t > headlineT) headlineT = last.t;
  }
  const hasPoint = Number.isFinite(headlineT);
  const headlineDay = hasPoint ? readoutDayKey(headlineT) : "";
  const date = hasPoint ? formatReadoutDate(headlineT) : "";

  const entries = series.map((s): ReadoutEntry => {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    if (!first || !last) return emptyEntry(s);
    return {
      id: s.id,
      label: s.label,
      color: s.color,
      value: format(s, last.v),
      change:
        viewMode === "normalized" || s.points.length < 2
          ? null
          : seriesDelta(s, first, last),
      dateNote:
        readoutDayKey(last.t) !== headlineDay
          ? formatReadoutShortDate(last.t)
          : null,
      ohlc: ohlcOf(last),
    };
  });

  return {
    state: "latest",
    headline: hasPoint && !zoomed ? `Latest · ${date}` : date,
    entries,
  };
}

/**
 * A reading at the pointer, or a pinned one. One row per series in `series`
 * order; a series with no point at that time keeps its row, empty. The headline
 * is the first entry's date, and a point on another day carries its own.
 */
export function buildPointReadout(a: {
  series: ChartSeriesSpec[];
  entries: { series: ChartSeriesSpec; point: ChartPoint }[];
  pinned: boolean;
  format: ReadoutFormat;
}): ReadoutModel {
  const { series, entries, pinned, format } = a;
  const lead = entries[0];
  const leadDay = lead ? readoutDayKey(lead.point.t) : "";

  const rows = series.map((s): ReadoutEntry => {
    const hit = entries.find((e) => e.series.id === s.id);
    if (!hit) return emptyEntry(s);
    const { point } = hit;
    return {
      id: s.id,
      label: s.label,
      color: s.color,
      value: format(s, point.v),
      change: null,
      dateNote:
        readoutDayKey(point.t) !== leadDay
          ? formatReadoutShortDate(point.t)
          : null,
      ohlc: ohlcOf(point),
    };
  });

  return {
    state: pinned ? "pinned" : "hover",
    headline: lead ? formatReadoutDate(lead.point.t) : "",
    entries: rows,
  };
}

/**
 * The drag-to-measure reading: each series' change between the points nearest
 * `ta` and `tb`. It names no value, only the change; a series with no point at
 * either end keeps its row without one.
 */
export function buildMeasureReadout(a: {
  series: ChartSeriesSpec[];
  ta: number;
  tb: number;
}): ReadoutModel {
  const { series, ta, tb } = a;
  return {
    state: "measure",
    headline: `${formatReadoutDate(ta)} → ${formatReadoutDate(tb)}`,
    entries: series.map((s): ReadoutEntry => {
      const pa = nearest(s.points, ta);
      const pb = nearest(s.points, tb);
      return {
        ...emptyEntry(s),
        change: pa && pb ? seriesDelta(s, pa, pb) : null,
      };
    }),
  };
}

/** One row from 640px wide, two below. Depends on the width and nothing else. */
export function readoutStripHeight(width: number): number {
  return width >= READOUT_ONE_ROW_MIN_WIDTH
    ? READOUT_ROW_H_ONE
    : READOUT_ROW_H_TWO;
}

/**
 * The strip when it was asked for and the plot keeps its room, else the
 * floating tooltip. `reservedH` is everything in `height` that is not plot or
 * strip: the margins, the brush band and the oscillator panel.
 */
export function resolveReadoutMode(a: {
  requested: "strip" | "tooltip";
  width: number;
  height: number;
  reservedH: number;
}): "strip" | "tooltip" {
  if (a.requested === "tooltip") return "tooltip";
  const plotH = a.height - readoutStripHeight(a.width) - a.reservedH;
  return plotH < READOUT_MIN_PLOT ? "tooltip" : "strip";
}
