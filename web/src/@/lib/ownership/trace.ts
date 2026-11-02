/**
 * Holder Lanes: one lane per holder, drawn from the notices behind it.
 *
 * Pure geometry, no React. components/ownership/holder-lanes.tsx draws the
 * paths this returns, and every figure a lane shows is also text beside it,
 * so the Notices table is the data behind the picture. The constants are the
 * drawing's contract rather than tuning: a lane is VIEW_W wide and VIEW_H
 * tall, the band runs from y 3 to y 23, and the 5% threshold is the band's
 * bottom edge. A cessation (Form 605) ends at that edge, because a holder
 * under 5% is not a holder of zero.
 */

import type { SubstantialHolding, SubstantialNotice } from "~/gen/shorts/v1alpha1/ownership_pb";
import { ageLabel, dateOf, dayOf } from "./age";
import { formLabel, formatPointChange, formatVotingPower, holderHref } from "./kinds";

export const VIEW_W = 1000;
export const VIEW_H = 28;

const BAND_TOP = 3;
/** The 5% threshold, which is the band's bottom edge. */
const THRESHOLD = 23;
const END_STOP_TOP = 20;
const END_STOP_BOTTOM = 26;
/** The dotted run before a first notice that states the figure it changed from. */
const LEAD_IN = 40;
/** The threshold run a lone cessation draws, so it has a length to read. */
const STUB = 12;
const TICK_HALF = 3;
/** Ticks closer than this read as one tick. */
const TICK_GAP = 8;
/** A register whose notices fall on one day would otherwise stretch that day across the lane. */
const MIN_SPAN_DAYS = 180;
/** Every lane's scale starts at the threshold. */
const SCALE_LO = 5;
const SCALE_MIN_HI = 8;
const UNNAMED = "Unnamed holder";

export interface LanePaths {
  threshold: string;
  solid: string[];
  dotted: string[];
  ticks: string[];
  ends: string[];
}

export interface HolderLane {
  holderKey: string;
  name: string;
  /** Where the name links, or "" for a holder off the map. */
  href: string;
  kind: string;
  /** On the register now: its latest notice is a substantial one. */
  current: boolean;
  /** Off the register now: the lane is what its notices read. */
  ceased: boolean;
  /** Drawn from its current row alone, because its notices are older than the history window. */
  seeded: boolean;
  figure: string;
  asAt: string;
  age: string;
  change: string;
  url: string;
  /** The top of this lane's own scale, in percent. */
  scaleHi: number;
  paths: LanePaths;
  /** Notices read for this holder in the history window. */
  notices: number;
  /** Notices that state no figure and are not cessations: drawn as nothing. */
  withoutFigure: number;
}

export interface YearLabel {
  x: number;
  label: string;
}

export interface HolderLanes {
  lanes: HolderLane[];
  /** The first and last day the axis covers, or "" when nothing is drawn. */
  from: string;
  to: string;
  /** Each 1 January on the axis. */
  yearLabels: YearLabel[];
  /** The history is the newest slice of more notices than it holds. */
  truncated: boolean;
}

export interface HolderLanesInput {
  holders: readonly SubstantialHolding[];
  /** Newest first, as the API sends it. */
  history: readonly SubstantialNotice[];
  asOf: string;
  historyTotal: number;
}

/** A notice or a current row, read down to what a lane needs. */
interface Reading {
  /** The date the holding changed, else the release date. */
  asAt: string;
  /** asAt as a day, or null when it does not read. */
  day: number | null;
  ceased: boolean;
  /** The figure the notice states; null when it states none. */
  present: number | null;
  /** The figure it changed from, when the notice says so. */
  previous: number | null;
  form: string;
  kind: string;
  name: string;
  slug: string;
  url: string;
}

type Placed = Reading & { day: number };

interface Scale {
  lo: number;
  hi: number;
}

interface Source {
  key: string;
  /** What the lane's name, figure, change and date come from. */
  summary: Reading;
  /** Every reading the lane may draw, in read order. */
  readings: Reading[];
  current: boolean;
  seeded: boolean;
  notices: number;
}

interface Drawn {
  paths: LanePaths;
  withoutFigure: number;
}

/** The fields a notice and a current row share, which is all the read order needs. */
type Dated = Pick<SubstantialNotice, "eventDate" | "announcedOn" | "announcementUrl">;

/**
 * The order a lane reads its notices in: the date the holding changed, then the
 * release date, then the notice's own URL, so two notices never trade places.
 */
function byReadOrder(a: Dated, b: Dated): number {
  return (
    compareText(a.eventDate || a.announcedOn, b.eventDate || b.announcedOn) ||
    compareText(a.announcedOn, b.announcedOn) ||
    compareText(a.announcementUrl, b.announcementUrl)
  );
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function readingOfNotice(n: SubstantialNotice): Reading {
  const asAt = n.eventDate || n.announcedOn;
  return {
    asAt,
    day: dayOf(asAt),
    ceased: n.ceased,
    present: n.hasPresent ? n.presentPct : null,
    previous: n.hasPrevious ? n.previousPct : null,
    form: n.form,
    kind: n.kind,
    name: n.holderName,
    slug: n.institutionSlug,
    url: n.announcementUrl,
  };
}

/** A current row always states its figure: the register lists only holders at 5% or more. */
function readingOfHolding(h: SubstantialHolding): Reading {
  const asAt = h.eventDate || h.announcedOn;
  return {
    asAt,
    day: dayOf(asAt),
    ceased: false,
    present: h.votingPowerPct,
    previous: h.hasPrevious ? h.previousPct : null,
    form: h.form,
    kind: h.kind,
    name: h.holderName,
    slug: h.institutionSlug,
    url: h.announcementUrl,
  };
}

function placed(readings: readonly Reading[]): Placed[] {
  return readings.filter((r): r is Placed => r.day !== null);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** A coordinate as a path prints it: two decimals, no trailing zeros. */
function coord(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * Ten per cent above the lane's highest figure, rounded up to the half point,
 * and never below 8%. The snap drops float dust: 25 * 1.1 is 27.500000000000004,
 * which must read 27.5 and not 28.
 */
function scaleTop(laneMax: number): number {
  const doubled = Math.round(laneMax * 1.1 * 2 * 1e9) / 1e9;
  return Math.max(SCALE_MIN_HI, Math.ceil(doubled) / 2);
}

/**
 * The scale covers every figure the lane draws: the present figure of each
 * notice that states one, and the figure a line starts from where it opens
 * with a lead-in. It follows the same open-line rule drawLane does.
 */
function scaleOf(points: readonly Placed[]): Scale {
  let laneMax = 0;
  let open = false;
  for (const p of points) {
    if (p.ceased) {
      open = false;
    } else if (p.present !== null) {
      laneMax = Math.max(laneMax, p.present);
      if (!open && p.previous !== null) laneMax = Math.max(laneMax, p.previous);
      open = true;
    }
  }
  return { lo: SCALE_LO, hi: scaleTop(laneMax) };
}

/** The height of a figure on a lane's scale. A figure past either edge stops at it. */
function yOf(figure: number, scale: Scale): number {
  const at = clamp(figure, scale.lo, scale.hi);
  return THRESHOLD - ((at - scale.lo) / (scale.hi - scale.lo)) * (THRESHOLD - BAND_TOP);
}

/**
 * Draws a lane's readings in read order (section 2's path rules). A line is open
 * from a figure until a cessation ends it. An open line at the end gets a dotted
 * tail to the right edge, because the holding is still as last read.
 */
function drawLane(points: readonly Placed[], xOf: (day: number) => number, scale: Scale): Drawn {
  const solid: string[] = [];
  const dotted: string[] = [];
  const ticks: string[] = [];
  const ends: string[] = [];
  // The solid run the line is on, while it is open.
  let run: string | null = null;
  let last: { x: number; y: number } | null = null;
  let lastTick = Number.NEGATIVE_INFINITY;
  let withoutFigure = 0;

  for (const p of points) {
    const x = xOf(p.day);
    if (p.ceased) {
      if (run === null) {
        dotted.push(`M${coord(Math.max(0, x - STUB))} ${THRESHOLD}H${coord(x)}`);
      } else {
        solid.push(`${run}H${coord(x)}V${THRESHOLD}`);
        run = null;
      }
      ends.push(`M${coord(x)} ${END_STOP_TOP}V${END_STOP_BOTTOM}`);
      continue;
    }
    if (p.present === null) {
      withoutFigure += 1;
      continue;
    }
    const y = yOf(p.present, scale);
    if (run !== null) {
      run += `H${coord(x)}V${coord(y)}`;
    } else if (p.previous !== null) {
      const before = yOf(p.previous, scale);
      dotted.push(`M${coord(Math.max(0, x - LEAD_IN))} ${coord(before)}H${coord(x)}`);
      run = `M${coord(x)} ${coord(before)}V${coord(y)}`;
    } else {
      run = `M${coord(x)} ${THRESHOLD}V${coord(y)}`;
    }
    if (x - lastTick >= TICK_GAP) {
      ticks.push(`M${coord(x)} ${coord(y - TICK_HALF)}V${coord(y + TICK_HALF)}`);
      lastTick = x;
    }
    last = { x, y };
  }

  if (run !== null) {
    solid.push(run);
    if (last !== null) dotted.push(`M${coord(last.x)} ${coord(last.y)}H${VIEW_W}`);
  }
  return {
    paths: { threshold: `M0 ${THRESHOLD}H${VIEW_W}`, solid, dotted, ticks, ends },
    withoutFigure,
  };
}

/** The figure a row prints: "under 5%" for a cessation, else the figure the reading states. */
function figureOf(r: Reading): string {
  return r.ceased ? "under 5%" : formatVotingPower(r.present);
}

/** The change a row prints: the point change where the notice states both figures, else its form. */
function changeOf(r: Reading): string {
  if (r.ceased) return formLabel(r.form, true);
  if (r.previous !== null && r.present !== null) return formatPointChange(r.previous, r.present);
  return formLabel(r.form, false);
}

function laneOf(
  source: Source,
  points: readonly Placed[],
  xOf: (day: number) => number,
  asOf: string,
): HolderLane {
  const scale = scaleOf(points);
  const { paths, withoutFigure } = drawLane(points, xOf, scale);
  const { summary } = source;
  return {
    holderKey: source.key,
    name: summary.name || UNNAMED,
    href: holderHref(summary.slug, source.key) ?? "",
    kind: summary.kind,
    current: source.current,
    ceased: !source.current,
    seeded: source.seeded,
    figure: figureOf(summary),
    asAt: summary.asAt,
    age: ageLabel(summary.asAt, asOf),
    change: changeOf(summary),
    url: summary.url,
    scaleHi: scale.hi,
    paths,
    notices: source.notices,
    withoutFigure,
  };
}

export function buildHolderLanes({ holders, history, asOf, historyTotal }: HolderLanesInput): HolderLanes {
  // Notices grouped by holder_key, each group in read order. Keys, never names:
  // two holders can share a name, and one holder can file under two.
  const groups = new Map<string, { newest: SubstantialNotice; notices: SubstantialNotice[] }>();
  for (const n of [...history].sort(byReadOrder)) {
    const group = groups.get(n.holderKey);
    if (group) {
      group.notices.push(n);
      group.newest = n;
    } else {
      groups.set(n.holderKey, { newest: n, notices: [n] });
    }
  }

  const sources: Source[] = [];
  const currentKeys = new Set<string>();
  for (const h of holders) {
    if (currentKeys.has(h.holderKey)) continue;
    currentKeys.add(h.holderKey);
    const row = readingOfHolding(h);
    const notices = groups.get(h.holderKey)?.notices ?? [];
    sources.push({
      key: h.holderKey,
      summary: row,
      // Its notices are older than the history window, so its row is all there is to draw.
      readings: notices.length > 0 ? notices.map(readingOfNotice) : [row],
      current: true,
      seeded: notices.length === 0,
      notices: notices.length,
    });
  }

  // A key with notices and no current row has ceased. Ordered by each holder's
  // newest notice, most recent first.
  const ceasedGroups = [...groups]
    .filter(([key]) => !currentKeys.has(key))
    .sort(([, a], [, b]) => byReadOrder(b.newest, a.newest));
  for (const [key, group] of ceasedGroups) {
    sources.push({
      key,
      summary: readingOfNotice(group.newest),
      readings: group.notices.map(readingOfNotice),
      current: false,
      seeded: false,
      notices: group.notices.length,
    });
  }

  const placedLanes = sources.map((source) => ({ source, points: placed(source.readings) }));

  // The axis runs from the first drawn reading to the as-at date, and is at
  // least MIN_SPAN_DAYS wide. A reading that states no figure does not stretch it.
  const drawnDays = placedLanes.flatMap(({ points }) =>
    points.filter((p) => p.ceased || p.present !== null).map((p) => p.day),
  );
  const asOfDay = dayOf(asOf);
  const toDay = asOfDay ?? (drawnDays.length > 0 ? Math.max(...drawnDays) : null);
  let fromDay = drawnDays.length > 0 ? Math.min(...drawnDays) : toDay;
  if (fromDay !== null && toDay !== null && toDay - fromDay < MIN_SPAN_DAYS) {
    fromDay = toDay - MIN_SPAN_DAYS;
  }

  // With nothing drawn there is no axis, and nothing asks for a coordinate.
  const axis =
    fromDay !== null && toDay !== null ? { from: fromDay, to: toDay } : { from: 0, to: MIN_SPAN_DAYS };
  const xOf = (day: number): number => clamp((day - axis.from) / (axis.to - axis.from), 0, 1) * VIEW_W;

  const yearLabels: YearLabel[] = [];
  if (fromDay !== null && toDay !== null) {
    const firstYear = Number(dateOf(fromDay).slice(0, 4));
    const lastYear = Number(dateOf(toDay).slice(0, 4));
    for (let year = firstYear; year <= lastYear; year += 1) {
      const day = dayOf(`${year}-01-01`);
      if (day !== null && day >= fromDay && day <= toDay) {
        yearLabels.push({ x: xOf(day), label: String(year) });
      }
    }
  }

  return {
    lanes: placedLanes.map(({ source, points }) => laneOf(source, points, xOf, asOf)),
    from: fromDay === null ? "" : dateOf(fromDay),
    to: toDay === null ? "" : dateOf(toDay),
    yearLabels,
    truncated: historyTotal > history.length,
  };
}
