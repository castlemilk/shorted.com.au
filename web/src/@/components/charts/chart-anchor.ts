import { CHART_PERIOD_PHRASE, type ChartPeriod } from "./chart-views";

/**
 * A chart pinned to the day it was posted, so it shows the same window and
 * the same figures however long afterwards someone looks at it or changes its
 * period ("as posted"). Without one a chart is live: its window ends at the
 * newest data.
 *
 * Two dates, because the two series end at different days: ASIC publishes
 * short positions four trading days late, so a chart posted on 4 Nov shows
 * prices to 3 Nov and short positions to 28 Oct. Reports for 29 Oct to 3 Nov
 * arrive in the following days, and a chart that kept only the posting day
 * would draw them on its next redraw, and print a different latest short
 * position from the one posted.
 *
 * Prices end the day BEFORE the posting day. A day's close is loaded around
 * 9pm Sydney, so a chart posted at 10am showed prices to the day before, and
 * one that ended on the posting day would gain that close on its next redraw
 * and print a different price. The first drawing and every redraw read the
 * same window, so they are the same picture; the cost is that a chart posted
 * late in the evening leaves out that day's close.
 *
 * Pure and browser-safe: the Discord bot, the chart card, the share page and
 * the Activity all read it.
 */
export interface ChartAnchor {
  /**
   * The day the chart was posted (Sydney), YYYY-MM-DD. Prices end the day
   * before (see above).
   */
  day: string;
  /**
   * The newest ASIC report the chart showed, YYYY-MM-DD, never after `day`.
   * The short series ends here.
   */
  shorts: string;
}

/** An inclusive date range, YYYY-MM-DD; no `from` runs from the first data. */
export interface DateWindow {
  from?: string;
  to: string;
}

/** The share page's, the card's and the embed's query parameters. */
export const ANCHOR_DAY_PARAM = "asof";
export const ANCHOR_SHORTS_PARAM = "shorts";

/** Nothing on the site predates this; an older "day" is a typo. */
const EARLIEST_DAY = "2000-01-01";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_DAY = /^(\d{4})(\d{2})(\d{2})$/;

/** A real calendar day written YYYY-MM-DD ("2026-02-30" is not). */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * An anchor from its two parts, or null when the day is missing or invalid
 * (the chart is then live). A missing or invalid `shorts` is the day itself,
 * and one after the day is pulled back to it.
 */
export function parseChartAnchor(
  day: string | null | undefined,
  shorts?: string | null,
): ChartAnchor | null {
  const d = day?.trim();
  if (!isIsoDay(d) || d < EARLIEST_DAY) return null;
  const s = shorts?.trim();
  return { day: d, shorts: isIsoDay(s) && s <= d ? s : d };
}

/** An anchor from a URL's query (`?asof=2026-11-04&shorts=2026-10-29`). */
export function readChartAnchor(params: {
  get(name: string): string | null;
}): ChartAnchor | null {
  return parseChartAnchor(
    params.get(ANCHOR_DAY_PARAM),
    params.get(ANCHOR_SHORTS_PARAM),
  );
}

/** An anchor as query parameters; `shorts` is left out when it is the day. */
export function anchorQuery(
  anchor: ChartAnchor | null | undefined,
): Record<string, string | undefined> {
  if (!anchor) return {};
  return {
    [ANCHOR_DAY_PARAM]: anchor.day,
    [ANCHOR_SHORTS_PARAM]:
      anchor.shorts === anchor.day ? undefined : anchor.shorts,
  };
}

/** "2026-11-04" as "20261104", for a Discord custom_id (100 characters). */
export function compactDay(day: string): string {
  return day.replace(/-/g, "");
}

/** "20261104" as "2026-11-04", or null when it is not a real day. */
export function expandDay(compact: string | undefined): string | null {
  const m = COMPACT_DAY.exec(compact ?? "");
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDay(day) ? day : null;
}

const sydneyDayFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Australia/Sydney",
});

/** The calendar day in Sydney at `now`, YYYY-MM-DD: the day a chart is posted. */
export function sydneyDay(now: Date): string {
  return sydneyDayFmt.format(now);
}

const labelFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-11-04" as "4 Nov 2026", as the site prints a date. */
export function formatAnchorDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return labelFmt.format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Months each chart period looks back; MAX has no start. */
const PERIOD_MONTHS: Record<ChartPeriod, number | null> = {
  "1m": 1,
  "3m": 3,
  "6m": 6,
  "1y": 12,
  "2y": 24,
  max: null,
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The window a period covers when it ends on `to`: the day after the same
 * date `months` earlier, through `to`. That is the live chart's window, which
 * runs from just after (newest - interval) to the newest data, so a chart
 * drawn the day it is posted is the same picture anchored or not. A month
 * end clamps ("2026-03-31" less a month starts on 1 Mar, after 28 Feb).
 */
export function periodWindow(period: ChartPeriod, to: string): DateWindow {
  const months = PERIOD_MONTHS[period];
  if (months === null) return { to };
  const [y, m, d] = to.split("-").map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 - months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d!, lastDay) + 1);
  return { from: isoDay(target), to };
}

/** The calendar day before `day`, YYYY-MM-DD. */
export function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y!, m! - 1, d! - 1)));
}

/**
 * Each series' window for a period on an anchored chart: prices to the day
 * before the posting day, short positions to the newest report it showed.
 */
export function anchoredWindows(
  period: ChartPeriod,
  anchor: ChartAnchor,
): { prices: DateWindow; shorts: DateWindow } {
  return {
    prices: periodWindow(period, dayBefore(anchor.day)),
    shorts: periodWindow(period, anchor.shorts),
  };
}

const PERIOD_SPAN: Record<ChartPeriod, string> = {
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  "2y": "2 years",
  max: "all history",
};

/**
 * A chart's period in words: "past 3 months" live, and "3 months to 4 Nov
 * 2026" kept as posted, where "past" would be wrong a week later.
 */
export function chartPeriodPhrase(
  period: ChartPeriod,
  anchor?: ChartAnchor | null,
): string {
  return anchor
    ? `${PERIOD_SPAN[period]} to ${formatAnchorDay(anchor.day)}`
    : CHART_PERIOD_PHRASE[period];
}
