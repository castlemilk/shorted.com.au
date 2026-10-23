/**
 * The chart's readout, as data (spec D5).
 *
 * Pure: no React, no DOM, no pointer state. The readout strip renders these
 * models, and `StockChart` builds them from the series it already rendered, so
 * the numbers, the dates and the "which series ended on another day" notes are
 * decided in one tested place instead of inside JSX.
 *
 * The strip's height is a function of the chart's width and how many series it
 * shows, and nothing else. It is never read back from the DOM, so a reading
 * changing from one state to another cannot move the plot.
 */
import { formatShares } from "@/lib/fundamentals/format";
import { nearest } from "./nearest";
import type { ChartPoint, ChartSeriesSpec } from "./types";

/**
 * At this width and above the strip is one row; below it, a headline row and
 * then one row for each series.
 */
export const READOUT_ONE_ROW_MIN_WIDTH = 640;
/** At this width and above a price reading also shows open, high, low, close. */
export const READOUT_OHLC_MIN_WIDTH = 900;
/** The height (px) of the strip's one row, from READOUT_ONE_ROW_MIN_WIDTH. */
export const READOUT_ROW_H_ONE = 28;
/** Padding (px) a phone strip holds in all, over and above its lines. */
export const READOUT_PAD = 8;
/** The height (px) of one line of a phone strip: the headline, or one series. */
export const READOUT_LINE_H = 18;
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
  /** Null when the series has no point to show; the strip reads that as "n/a". */
  value: string | null;
  /** The latest and measure states only; null elsewhere. */
  change: ReadoutDelta | null;
  /** "5 Oct" when this point is on another Sydney day than the headline. */
  dateNote: string | null;
  ohlc: { open: string; high: string; low: string; close: string } | null;
}

export type ReadoutState = "latest" | "hover" | "pinned" | "measure";

/**
 * The session's traded volume: the grey bars at the foot of the plot. It is not
 * a series (it has no axis and no change), so it is read beside them, and only
 * where the chart draws it.
 */
export interface ReadoutVolume {
  /** "1.2M" shares; null when no session's volume is held. */
  value: string | null;
  /** "5 Oct" when this session is on another Sydney day than the headline. */
  dateNote: string | null;
}

export interface ReadoutModel {
  state: ReadoutState;
  headline: string;
  entries: ReadoutEntry[];
  /**
   * The volume of the session read: the newest on screen at rest, the one under
   * the pointer or the pin otherwise. Absent when the chart draws no volume, and
   * in a measure, which names changes and volume has none.
   */
  volume?: ReadoutVolume | null;
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

/** U+2212, the sign of a fall. Written as an escape: it looks like a hyphen. */
const MINUS = "\u2212";

/**
 * The change from `a` to `b` on `series`, the one piece of delta maths that the
 * drag-to-measure card and the strip's latest reading share.
 *
 * - relative (default): percent change, one decimal, "+3.1%". From a zero base
 *   there is nothing to divide by, so it reads 0.
 * - absolute: the raw difference, two decimals, then the series' unit,
 *   "+0.21 pp". For a series already expressed in percent.
 *
 * A fall is signed with a true minus (U+2212, "−3.1%" as printed), never the
 * ASCII hyphen-minus (DESIGN.md, the Tabular Rule).
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
  const sign = tone === "up" ? "+" : tone === "down" ? MINUS : "";
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

/** Shares traded, compact: "1.2M", "812.4K", "5.07B". */
export function formatVolume(v: number): string {
  return formatShares(v);
}

/**
 * The volume of the session nearest `t`, dated when it falls on another Sydney
 * day than `headlineDay`. Null when the chart draws no volume (`volume`
 * undefined or empty), so the strip and the card leave the reading out rather
 * than print "n/a" beside a chart without bars. `volume` must be the RAW points
 * on screen, not the decimated ones the bars are drawn from: a decimated set can
 * drop the very session the series' point is on.
 */
export function volumeReading(
  volume: ChartPoint[] | undefined,
  t: number | null,
  headlineDay: string,
): ReadoutVolume | null {
  if (!volume?.length) return null;
  const p = t === null ? null : nearest(volume, t);
  if (!p || !isNum(p.v)) return { value: null, dateNote: null };
  return {
    value: formatVolume(p.v),
    dateNote:
      readoutDayKey(p.t) !== headlineDay ? formatReadoutShortDate(p.t) : null,
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
  /** The volume on screen, raw; its newest session is read. */
  volume?: ChartPoint[];
}): ReadoutModel {
  const { series, zoomed, viewMode, format, volume } = a;

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

  const lastVolume = volume?.[volume.length - 1];
  return {
    state: "latest",
    headline: hasPoint && !zoomed ? `Latest · ${date}` : date,
    entries,
    volume: volumeReading(volume, lastVolume?.t ?? null, headlineDay),
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
  /** The volume on screen, raw; the session nearest the first entry is read. */
  volume?: ChartPoint[];
}): ReadoutModel {
  const { series, entries, pinned, format, volume } = a;
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
    volume: volumeReading(volume, lead?.point.t ?? null, leadDay),
  };
}

/**
 * The drag-to-measure reading: each series' change between the points nearest
 * `ta` and `tb`. It names no value, only the change; a series with no point at
 * either end keeps its row without one.
 *
 * The headline names the sessions compared, as a hover does: the dates of the
 * first series' points nearest `ta` and `tb`. `ta` and `tb` are instants under
 * the pointer, and between two sessions an instant is a weekend, or the day
 * before the session it is nearest to. Only a first series with no point leaves
 * the pointer's own times to name.
 */
export function buildMeasureReadout(a: {
  series: ChartSeriesSpec[];
  ta: number;
  tb: number;
}): ReadoutModel {
  const { series, ta, tb } = a;
  const lead = series[0]?.points ?? [];
  return {
    state: "measure",
    headline: `${formatReadoutDate(nearest(lead, ta)?.t ?? ta)} → ${formatReadoutDate(nearest(lead, tb)?.t ?? tb)}`,
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

/**
 * One 28px row from 640px wide. Below that, a headline row and a row for each
 * series, 18px a line, with 8px of padding: 44px for one series, 62px for two.
 * Depends on the width and the number of series the strip shows, and on nothing
 * the reading says, so no state of the reading can move the plot.
 */
export function readoutStripHeight(width: number, seriesCount: number): number {
  return width >= READOUT_ONE_ROW_MIN_WIDTH
    ? READOUT_ROW_H_ONE
    : READOUT_PAD + READOUT_LINE_H * (1 + seriesCount);
}

/**
 * The strip when it was asked for and the plot keeps its room, else the
 * floating tooltip. `seriesCount` is the number of series the strip would show
 * (a phone strip is a row taller for each). `reservedH` is everything in
 * `height` that is not plot or strip: the margins, the brush band and the
 * oscillator panel.
 */
export function resolveReadoutMode(a: {
  requested: "strip" | "tooltip";
  width: number;
  height: number;
  seriesCount: number;
  reservedH: number;
}): "strip" | "tooltip" {
  if (a.requested === "tooltip") return "tooltip";
  const plotH =
    a.height - readoutStripHeight(a.width, a.seriesCount) - a.reservedH;
  return plotH < READOUT_MIN_PLOT ? "tooltip" : "strip";
}

/**
 * The most characters a series' value can take, by series id: the wider of its
 * lowest and highest value, formatted as its axis formats them. A number with
 * more digits is nearer an end, so the two ends stand for all between them. The
 * strip holds that much room for the value on one row, so a scrub across a digit
 * boundary (99.99 to 100.00) moves nothing after it. A series with no finite
 * value has no entry.
 */
export function widestValueChars(
  series: ChartSeriesSpec[],
  format: ReadoutFormat,
): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const s of series) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of s.points) {
      if (!isNum(p.v)) continue;
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (lo > hi) continue;
    widths[s.id] = Math.max(format(s, lo).length, format(s, hi).length);
  }
  return widths;
}
