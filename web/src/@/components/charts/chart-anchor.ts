import { CHART_PERIOD_PHRASE, type ChartPeriod } from "./chart-views";

/**
 * A chart pinned to the day it was posted, so it shows the same window and
 * the same figures however long afterwards someone looks at it or changes its
 * period ("as posted"). Without one a chart is live: its window ends at the
 * newest data.
 *
 * Three dates, because each series ends on its own day and data keeps
 * arriving after a chart is posted:
 *
 *  - `shorts`, the newest ASIC report it showed. ASIC publishes four trading
 *    days late, so a chart posted on 4 Nov shows short positions to 28 Oct,
 *    and the reports for 29 Oct to 3 Nov land in the days after.
 *  - `prices`, the newest close it drew. The price sweep starts around 9pm
 *    Sydney and can run past 2am, so a chart posted at 1am may not have the
 *    previous day's close yet.
 *  - `day`, the day it was posted, which the chart is labelled with.
 *
 * The bot reads both dates before it draws a new post's card (the stock's
 * newest report, and its newest close on or before the day), so the first
 * drawing and every redraw read the same windows. A correction ASIC or the
 * price vendor makes later inside the window still shows; the figures the
 * bot printed above the chart never change (they are copied).
 *
 * Pure and browser-safe: the Discord bot, the chart card, the share page and
 * the Activity all read it.
 */
export interface ChartAnchor {
  /** The day the chart was posted (Sydney), YYYY-MM-DD. */
  day: string;
  /**
   * The newest ASIC report the chart showed, YYYY-MM-DD, never after `day`.
   * The short series ends here.
   */
  shorts: string;
  /**
   * The newest close the chart drew, YYYY-MM-DD, never after `day`. The
   * price series ends here.
   */
  prices: string;
}

/** An inclusive date range, YYYY-MM-DD; no `from` runs from the first data. */
export interface DateWindow {
  from?: string;
  to: string;
}

/** The share page's, the card's and the embed's query parameters. */
export const ANCHOR_DAY_PARAM = "asof";
export const ANCHOR_SHORTS_PARAM = "shorts";
export const ANCHOR_PRICES_PARAM = "prices";

/** ASIC's daily reports start in 2010; an earlier "day" is a typo. */
const EARLIEST_DAY = "2010-01-01";

/**
 * How far behind the day each date may be. The bot reads the newest close in
 * the month to the day (getNewestClose), and a stock's newest report is a
 * week behind it, or two around the new year. Anything further back is not a
 * date the bot writes, so a URL carrying one is read as the day, and the
 * number of anchors one stock can be drawn for stays bounded.
 */
export const ANCHOR_PRICES_MAX_LAG_DAYS = 31;
export const ANCHOR_SHORTS_MAX_LAG_DAYS = 60;

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

export interface AnchorParts {
  day?: string | null;
  shorts?: string | null;
  prices?: string | null;
}

/**
 * An anchor from its parts, or null when the day is missing, invalid, before
 * 2010, or (given `today`, Sydney) in the future: the chart is then live. A
 * missing or invalid `shorts` or `prices`, one after the day, or one further
 * behind it than its MAX_LAG_DAYS, is the day itself: everything up to the
 * day.
 */
export function parseChartAnchor(
  parts: AnchorParts,
  today?: string,
): ChartAnchor | null {
  const d = parts.day?.trim();
  if (!isIsoDay(d) || d < EARLIEST_DAY) return null;
  if (today !== undefined && d > today) return null;
  const upTo = (raw: string | null | undefined, maxLag: number): string => {
    const v = raw?.trim();
    return isIsoDay(v) && v >= daysBefore(d, maxLag) && v <= d ? v : d;
  };
  return {
    day: d,
    shorts: upTo(parts.shorts, ANCHOR_SHORTS_MAX_LAG_DAYS),
    prices: upTo(parts.prices, ANCHOR_PRICES_MAX_LAG_DAYS),
  };
}

/**
 * An anchor from a URL's query
 * (`?asof=2026-11-04&shorts=2026-10-28&prices=2026-11-03`); a day after
 * `today` (Sydney) is live.
 */
export function readChartAnchor(
  params: { get(name: string): string | null },
  today?: string,
): ChartAnchor | null {
  return parseChartAnchor(
    {
      day: params.get(ANCHOR_DAY_PARAM),
      shorts: params.get(ANCHOR_SHORTS_PARAM),
      prices: params.get(ANCHOR_PRICES_PARAM),
    },
    today,
  );
}

/**
 * An anchor as query parameters; `shorts` and `prices` are left out when
 * they are the day (the default).
 */
export function anchorQuery(
  anchor: ChartAnchor | null | undefined,
): Record<string, string | undefined> {
  if (!anchor) return {};
  const unlessDay = (v: string) => (v === anchor.day ? undefined : v);
  return {
    [ANCHOR_DAY_PARAM]: anchor.day,
    [ANCHOR_SHORTS_PARAM]: unlessDay(anchor.shorts),
    [ANCHOR_PRICES_PARAM]: unlessDay(anchor.prices),
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
  return labelFmt.format(new Date(Date.UTC(y!, m! - 1, d)));
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
 * drawn the day it is posted covers the same span anchored or not (a kept
 * chart's axis ends on the later of its two dates; see anchoredWindows). A
 * month end clamps ("2026-03-31" less a month starts on 1 Mar, after 28 Feb).
 */
export function periodWindow(period: ChartPeriod, to: string): DateWindow {
  const months = PERIOD_MONTHS[period];
  if (months === null) return { to };
  return monthsBefore(months, to);
}

/** `(to - months, to]`, a month end clamped as periodWindow describes. */
function monthsBefore(months: number, to: string): DateWindow {
  const [y, m, d] = to.split("-").map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 - months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d!, lastDay) + 1);
  return { from: isoDay(target), to };
}

/**
 * The live price read (market-data's GetHistoricalPrices) caps MAX at ten
 * years; short positions on MAX are all of them, back to 2010.
 */
const PRICE_MAX_MONTHS = 120;

/**
 * Each series' window for a period on an anchored chart. The period is
 * counted back from the later of the newest close and the newest report,
 * and both series start there, so the two share one time axis; prices end
 * on the newest close and short positions on the newest report. A series
 * whose data stopped before the period starts (a stock ASIC stopped
 * reporting, or one suspended from trading) is empty, as on the live chart,
 * rather than a window of its own that stretches the axis back to its last
 * point.
 */
export function anchoredWindows(
  period: ChartPeriod,
  anchor: ChartAnchor,
): { prices: DateWindow; shorts: DateWindow } {
  const end = anchor.prices > anchor.shorts ? anchor.prices : anchor.shorts;
  const span = periodWindow(period, end);
  const upTo = (to: string): DateWindow =>
    span.from ? { from: span.from, to } : { to };
  return {
    prices:
      period === "max"
        ? { from: monthsBefore(PRICE_MAX_MONTHS, end).from, to: anchor.prices }
        : upTo(anchor.prices),
    shorts: upTo(anchor.shorts),
  };
}

/**
 * Whether an anchor's data has stopped arriving, so its picture can be
 * cached for long: posted at least two days ago (the evening price sweep and
 * its retry are done), and its newest short report at least eight days ago
 * (ASIC's four trading days, with a weekend and a holiday in them).
 */
export function isSettledAnchor(anchor: ChartAnchor, today: string): boolean {
  return (
    anchor.day <= daysBefore(today, 2) && anchor.shorts <= daysBefore(today, 8)
  );
}

/** The calendar day `n` days before `day`, YYYY-MM-DD. */
export function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y!, m! - 1, d! - n)));
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
