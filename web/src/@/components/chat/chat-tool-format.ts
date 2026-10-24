/**
 * Number, date and text formatting for the chat's tables and charts. Pure, so it
 * is shared by the eager table code and the lazily loaded charts, and tested on
 * its own. Numbers go through Intl; dates are shown in the Sydney calendar day,
 * the way the stock page's chart readouts show them.
 */

import type { Reading } from "./chat-tool-data";

const LOCALE = "en-AU";
const SYDNEY = "Australia/Sydney";

const percent2 = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percent1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const signedPoints = new Intl.NumberFormat(LOCALE, {
  signDisplay: "exceptZero",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plain2 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const audCents = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const audWhole = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});
const audCompact = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "AUD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const dayFormat = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: SYDNEY,
});
const utcDayFormat = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "12.34%", two decimals: a short position or a percentage reading. */
export function formatPercent(value: number): string {
  return `${percent2.format(value)}%`;
}

/** "12.3%", one decimal: an axis tick. */
export function formatAxisPercent(value: number): string {
  return `${percent1.format(value)}%`;
}

/** A change in percentage points, signed: "+1.23 pp", "-0.40 pp". */
export function formatPointsChange(value: number): string {
  return `${signedPoints.format(value)} pp`;
}

/** A percentage change, signed: "+3.73%", "-6.68%". */
export function formatSignedPercent(value: number): string {
  return `${signedPoints.format(value)}%`;
}

/** A plain number to two decimals, with a unit after it when the unit is not a percentage. */
export function formatNumber(value: number, unit?: string): string {
  const number = plain2.format(value);
  return unit && unit !== "percent" ? `${number} ${unit}` : number;
}

/** A whole count: shares traded, or the rows left out. */
export function formatWhole(value: number): string {
  return whole.format(value);
}

/** A price per share in dollars and cents. */
export function formatPrice(value: number): string {
  return audCents.format(value);
}

/** A trade's value in whole dollars. */
export function formatDollars(value: number): string {
  return audWhole.format(value);
}

/** A market capitalisation, abbreviated: "A$331B". */
export function formatMarketCap(value: number): string {
  return audCompact.format(value);
}

/** A P/E ratio to one decimal. Negative or zero ratios are "not meaningful": the caller shows a dash. */
export function formatRatio(value: number): string {
  return oneDecimal.format(value);
}

/** "9 Oct 2026" in the Sydney calendar day. */
export function formatDay(t: number): string {
  return dayFormat.format(t);
}

/**
 * A trade's date. A date-only value ("2026-09-11") is that calendar day, so it is
 * formatted in UTC, where it was written. Any other value that parses is shown in
 * the Sydney day. Text that does not parse is shown as it came.
 */
export function formatTradeDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const time = Date.parse(`${raw}T00:00:00Z`);
    return Number.isFinite(time) ? utcDayFormat.format(time) : raw;
  }
  const time = Date.parse(raw);
  return Number.isFinite(time) ? dayFormat.format(time) : raw;
}

const TRADE_TYPE_LABELS: Readonly<Record<string, string>> = {
  buy: "Buy",
  sell: "Sell",
  exercise_options: "Option exercise",
  other: "Other",
};

/** The reader's word for a trade type. An unknown type reads as sentence-cased text. */
export function tradeTypeLabel(tradeType: string): string {
  return TRADE_TYPE_LABELS[tradeType] ?? sentence(tradeType);
}

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  rates: "Rates",
  cpi: "CPI",
  labour: "Labour",
  wages: "Wages",
  commodities: "Commodities",
  credit: "Credit",
  markets: "Markets",
  trade: "Trade",
  spending: "Spending",
  lending: "Lending",
  business: "Business",
  construction: "Construction",
  crime: "Crime",
  gdp: "GDP",
  petroleum: "Petroleum",
  population: "Population",
  approvals: "Approvals",
  retail: "Retail",
};

/** Upper-cases the first letter and turns underscores into spaces. */
export function sentence(text: string): string {
  const spaced = text.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A readable title for an economic series, from its key and name:
 * "Rates · Cash rate target · Australia". The key's family and metric are
 * named; the name tells two series apart when the same metric is given for
 * two places.
 */
export function seriesTitle(key: string, name?: string): string {
  const [family = "", metric = ""] = key.split(".");
  const head = FAMILY_LABELS[family] ?? sentence(family);
  return [head, metric ? sentence(metric) : "", name ?? ""]
    .filter(Boolean)
    .join(" · ");
}

/** The unit and frequency of a series, read as words: "Percent · Monthly". */
export function seriesSubtitle(unit?: string, frequency?: string): string {
  return [unit ? sentence(unit) : "", frequency ? sentence(frequency) : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The formatter for a series' readings: a percentage, or a number with its unit. */
export function valueFormatter(unit?: string): (value: number) => string {
  if (unit === "percent") return formatPercent;
  return (value) => formatNumber(value, unit);
}

/** The formatter for a series' axis ticks: percentage ticks carry one decimal. */
export function axisFormatter(unit?: string): (value: number) => string {
  if (unit === "percent") return formatAxisPercent;
  return (value) => plain2.format(value);
}

/**
 * The sentence that describes a series in words, for a screen reader and for the
 * figure's caption: first and latest reading, and the low and high of those shown.
 * Empty when there are no readings.
 */
export function readingSummary(
  points: readonly Reading[],
  format: (value: number) => string,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  let low = first;
  let high = first;
  for (const point of points) {
    if (point.v < low.v) low = point;
    if (point.v > high.v) high = point;
  }
  return (
    `First ${format(first.v)} on ${formatDay(first.t)}, ` +
    `latest ${format(last.v)} on ${formatDay(last.t)}. ` +
    `Low ${format(low.v)} on ${formatDay(low.t)}, ` +
    `high ${format(high.v)} on ${formatDay(high.t)}.`
  );
}

/** The short-position chart's caption: the readings, and how many of the period's were shown. */
export function shortPositionSummary(view: {
  points: readonly Reading[];
  totalObservations?: number;
  downsampled: boolean;
}): string {
  const summary = readingSummary(view.points, formatPercent);
  const total = view.totalObservations;
  if (view.downsampled && total !== undefined && total > view.points.length) {
    return `${summary} Showing ${whole.format(view.points.length)} of ${whole.format(total)} readings.`;
  }
  return summary;
}
