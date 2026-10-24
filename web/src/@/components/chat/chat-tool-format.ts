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
// en-AU writes July in full, and September as "Sept", so every chat date names its month
// from these abbreviations, never from Intl's short month.
const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
// The day, month and year are read as numbers from the parts, and named above.
const sydneyDayParts = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "numeric",
  year: "numeric",
  timeZone: SYDNEY,
});
const utcDayParts = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "9 Oct 2026", or "9 Oct" without the year, from a formatter that prints the day, month and year as numbers. */
function shortDate(format: Intl.DateTimeFormat, t: number, withYear: boolean): string {
  const parts = format.formatToParts(t);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((piece) => piece.type === type)?.value ?? "";
  // en-AU pads a numeric day to two places ("08"), which a short date does not.
  const day = Number(part("day"));
  const head = `${day} ${MONTH_ABBREVIATIONS[Number(part("month")) - 1] ?? ""}`.trim();
  return withYear ? `${head} ${part("year")}`.trim() : head;
}

/** "12.34%", two decimals: a short position or a percentage reading. */
export function formatPercent(value: number): string {
  return `${percent2.format(value)}%`;
}

/** A change in percentage points, signed: "+1.23 pp", "-0.40 pp". */
export function formatPointsChange(value: number): string {
  return `${signedPoints.format(value)} pp`;
}

/** A percentage change, signed: "+3.73%", "-6.68%". */
export function formatSignedPercent(value: number): string {
  return `${signedPoints.format(value)}%`;
}

/**
 * How a series' unit reads beside its figures. `words` names the unit in a series'
 * subtitle. `prefix` sits against the figure ("$1,234.56", "US$1.09"), and `suffix` follows it,
 * spaced as written (" ML", "%"). A reading (a tooltip, a caption) carries all of it.
 * The ids are the ones the economy importers write (services/jobs/internal/jobs/economy),
 * and a test in __tests__ fails when an importer writes one this map does not name.
 */
interface UnitReading {
  words: string;
  prefix?: string;
  suffix?: string;
}

const UNIT_READINGS = new Map<string, UnitReading>([
  ["index", { words: "Index" }],
  ["percent", { words: "Percent", suffix: "%" }],
  ["aud", { words: "Australian dollars", prefix: "$" }],
  ["usd", { words: "US dollars", prefix: "US$" }],
  ["usd_millions", { words: "US dollars, millions", prefix: "US$", suffix: " million" }],
  ["usd_billions", { words: "US dollars, billions", prefix: "US$", suffix: " billion" }],
  ["usd_per_barrel", { words: "US dollars per barrel", prefix: "US$", suffix: " per barrel" }],
  ["usd_per_eur", { words: "US dollars per euro", prefix: "US$", suffix: " per euro" }],
  ["usd_per_gbp", { words: "US dollars per pound", prefix: "US$", suffix: " per pound" }],
  ["usd_per_nzd", { words: "US dollars per NZ dollar", prefix: "US$", suffix: " per NZ dollar" }],
  ["cny_per_usd", { words: "Chinese yuan per US dollar", suffix: " yuan per US$" }],
  ["jpy_per_usd", { words: "Japanese yen per US dollar", suffix: " yen per US$" }],
  ["krw_per_usd", { words: "Korean won per US dollar", suffix: " won per US$" }],
  ["inr_per_usd", { words: "Indian rupees per US dollar", suffix: " rupees per US$" }],
  ["sgd_per_usd", { words: "Singapore dollars per US dollar", suffix: " Singapore dollars per US$" }],
  ["cad_per_usd", { words: "Canadian dollars per US dollar", suffix: " Canadian dollars per US$" }],
  ["usd_per_metric_ton", { words: "US dollars per metric tonne", prefix: "US$", suffix: " per tonne" }],
  ["usd_per_kg", { words: "US dollars per kilogram", prefix: "US$", suffix: " per kilogram" }],
  ["usd_per_mmbtu", { words: "US dollars per million Btu", prefix: "US$", suffix: " per mmBtu" }],
  ["usd_per_troy_oz", { words: "US dollars per troy ounce", prefix: "US$", suffix: " per troy ounce" }],
  [
    "usd_per_dmtu",
    { words: "US dollars per dry metric tonne unit", prefix: "US$", suffix: " per dry metric tonne unit" },
  ],
  ["megalitres", { words: "Megalitres", suffix: " ML" }],
  ["persons", { words: "Persons", suffix: " people" }],
  ["units", { words: "Dwelling units", suffix: " dwellings" }],
  ["rate_per_100k", { words: "Rate per 100,000 people", suffix: " per 100,000" }],
]);

/**
 * The reading for a unit id, or undefined. An id the chat does not know reads with no
 * unit at all: the raw id is never printed beside a figure.
 */
function unitReading(unit: string | undefined): UnitReading | undefined {
  return unit ? UNIT_READINGS.get(unit.trim().toLowerCase()) : undefined;
}

/** The text that sits either side of a figure. */
interface Affixes {
  prefix?: string;
  suffix?: string;
}

/** A figure with its affixes. `digits` writes the absolute value. */
function affixed(
  value: number,
  affixes: Affixes | undefined,
  digits: (absolute: number) => string,
): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${affixes?.prefix ?? ""}${digits(Math.abs(value))}${affixes?.suffix ?? ""}`;
}

/**
 * The short form of a unit that an axis tick or the latest-value label prints: a currency
 * symbol before the figure, or "%" after it. Anything longer is left to the subtitle, which
 * names the unit once. "US$78 per barrel" on every tick is what this avoids.
 */
function briefAffixes(unit: string | undefined): Affixes {
  const reading = unitReading(unit);
  if (!reading) return {};
  return {
    prefix: reading.prefix,
    suffix: reading.suffix === "%" ? "%" : undefined,
  };
}

/**
 * A figure to two decimals, with its unit: "$1,234.56", "15.20%", "US$1.09 per euro".
 * An unknown unit adds nothing.
 */
export function formatNumber(value: number, unit?: string): string {
  const reading = unitReading(unit);
  return affixed(value, reading, (absolute) => plain2.format(absolute));
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

/** A market capitalisation, abbreviated: "$331B" (en-AU writes the Australian dollar as "$"). */
export function formatMarketCap(value: number): string {
  return audCompact.format(value);
}

/** A dollar amount, abbreviated to fit a narrow column: "$1.2M", "$950". */
export function formatCompactDollars(value: number): string {
  return audCompact.format(value);
}

/** A P/E ratio to one decimal. Negative or zero ratios are "not meaningful": the caller shows a dash. */
export function formatRatio(value: number): string {
  return oneDecimal.format(value);
}

/** "9 Oct 2026" in the Sydney calendar day. */
export function formatDay(t: number): string {
  return shortDate(sydneyDayParts, t, true);
}

/** "9 Oct" in the Sydney calendar day, for a column whose period the table already names. */
export function formatDayMonth(t: number): string {
  return shortDate(sydneyDayParts, t, false);
}

/**
 * A trade's date. A date-only value ("2026-09-11") is that calendar day, so it is
 * formatted in UTC, where it was written. Any other value that parses is shown in
 * the Sydney day. Text that does not parse is shown as it came.
 */
export function formatTradeDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const time = Date.parse(`${raw}T00:00:00Z`);
    return Number.isFinite(time) ? shortDate(utcDayParts, time, true) : raw;
  }
  const time = Date.parse(raw);
  return Number.isFinite(time) ? shortDate(sydneyDayParts, time, true) : raw;
}

const TRADE_TYPE_LABELS = new Map<string, string>([
  ["buy", "Buy"],
  ["sell", "Sell"],
  ["exercise_options", "Option exercise"],
  ["other", "Other"],
]);

/** The reader's word for a trade type. An unknown type reads as sentence-cased text. */
export function tradeTypeLabel(tradeType: string): string {
  return TRADE_TYPE_LABELS.get(tradeType) ?? sentence(tradeType);
}

const FAMILY_LABELS = new Map<string, string>([
  ["rates", "Rates"],
  ["cpi", "CPI"],
  ["labour", "Labour"],
  ["wages", "Wages"],
  ["commodities", "Commodities"],
  ["credit", "Credit"],
  ["markets", "Markets"],
  ["trade", "Trade"],
  ["spending", "Spending"],
  ["lending", "Lending"],
  ["business", "Business"],
  ["construction", "Construction"],
  ["crime", "Crime"],
  ["gdp", "GDP"],
  ["petroleum", "Petroleum"],
  ["population", "Population"],
  ["approvals", "Approvals"],
  ["retail", "Retail"],
]);

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
  const head = FAMILY_LABELS.get(family) ?? sentence(family);
  return [head, metric ? sentence(metric) : "", name ?? ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The unit and frequency of a series, read as words: "Percent · Monthly". A unit the
 * chat does not know is left out of the subtitle rather than printed as its id.
 */
export function seriesSubtitle(unit?: string, frequency?: string): string {
  return [unitReading(unit)?.words ?? "", frequency ? sentence(frequency) : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The formatter for a series' readings: a percentage, or a number with its unit. */
export function valueFormatter(unit?: string): (value: number) => string {
  if (unit?.trim().toLowerCase() === "percent") return formatPercent;
  return (value) => formatNumber(value, unit);
}

/**
 * A formatter for an axis's tick labels, built from the ticks the axis prints. The
 * decimals follow the tick step (see tickDecimals), so two adjacent ticks never print
 * the same label. A reading is formatted by valueFormatter, not this.
 */
export type TickFormatter = (ticks: readonly number[]) => (value: number) => string;

/**
 * The axis formatter for a unit: "15.92%" beside "15.93%", not "15.9%" twice. A unit
 * prints bare figures with its short symbol ("US$70", "$1.25", "15.9%"), so a long unit
 * such as "Singapore dollars per US$" is not repeated on every tick.
 */
export function axisFormatter(unit?: string): TickFormatter {
  const affixes = briefAffixes(unit);
  return (ticks) => {
    const digits = fixedDecimals(tickDecimals(ticks));
    return (value) => affixed(value, affixes, (absolute) => digits.format(absolute));
  };
}

/**
 * The latest-value label on a chart: the figure to two decimals with the unit's short
 * symbol, never its long words. "7.00%", "US$78.25", "1.35". The tooltip and the caption
 * print the whole reading (see valueFormatter).
 */
export function latestFormatter(unit?: string): (value: number) => string {
  if (unit?.trim().toLowerCase() === "percent") return formatPercent;
  const affixes = briefAffixes(unit);
  return (value) => affixed(value, affixes, (absolute) => plain2.format(absolute));
}

/**
 * The label of a time-axis tick. Months are short ("Oct", "9 Oct" for a week's tick),
 * and the year is written on the first tick and on each tick where the year changes,
 * so two Octobers on one axis can be told apart. The ticks are local-time midnights,
 * as d3 generates them. `ticks` is the list the axis draws, so a thinned axis compares
 * each tick with the one it draws before it.
 */
export function timeTickLabel(value: Date, index: number, ticks: readonly Date[]): string {
  const month = MONTH_ABBREVIATIONS[value.getMonth()] ?? "";
  const day = value.getDate();
  const head = day === 1 ? month : `${day} ${month}`;
  const previous = index > 0 ? ticks[index - 1] : undefined;
  const yearChanged = !previous || previous.getFullYear() !== value.getFullYear();
  return yearChanged ? `${head} ${value.getFullYear()}` : head;
}

/** Most decimals an axis label is given by the grid. A step needing more is printed in significant figures. */
const MAX_AXIS_DECIMALS = 12;
/** The most decimals any axis label is given, however fine its step (the Intl limit this code relies on). */
const MAX_FIXED_DECIMALS = 20;
const fixedFormats = new Map<number, Intl.NumberFormat>();

/** A number format with exactly `decimals` places, kept for reuse. */
function fixedDecimals(decimals: number): Intl.NumberFormat {
  let format = fixedFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    fixedFormats.set(decimals, format);
  }
  return format;
}

/**
 * The fewest decimals that print the step between adjacent ticks exactly. A step of
 * 0.005 needs three places, 0.25 two, 2 none. Without them adjacent ticks round to the
 * same label, as 15.92 and 15.93 both do at one decimal.
 *
 * The test is relative to the step's size, so a step of 2e-7 on a near-zero series needs
 * seven places, not none. A step too fine for MAX_AXIS_DECIMALS takes the places that
 * its own magnitude needs, so adjacent ticks still print apart.
 */
export function tickDecimals(ticks: readonly number[]): number {
  const sorted = ticks.filter(Number.isFinite).slice().sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const gap = b - a;
    // A gap within float noise of zero is the same tick twice, not a step.
    if (gap > Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE) * 1e-12 && gap < step) {
      step = gap;
    }
  }
  if (!Number.isFinite(step)) return 0;
  for (let decimals = 0; decimals <= MAX_AXIS_DECIMALS; decimals++) {
    // Whole in units of the step, to float noise relative to the step itself.
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 * scaled) return decimals;
  }
  // The step is finer than the grid's places: one more place than its order of magnitude.
  return Math.min(MAX_FIXED_DECIMALS, Math.ceil(-Math.log10(step)) + 1);
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
