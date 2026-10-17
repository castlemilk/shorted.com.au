// Shared display vocabulary for company fundamentals, used by the stock page's
// Financials tab and by the stock picker (docs/plans/fundamentals-coverage.md
// §7.0). One vocabulary, so the same figure reads the same on both surfaces.
//
// Dependency-free on purpose: no imports at all, so it is safe on both sides
// of the RSC boundary and can never drag ~/gen, @bufbuild, @connectrpc,
// app/actions or React into a bundle.
//
// House rules (DESIGN.md):
//   - "n/a" means we do not hold the figure. Never 0, never a dash.
//   - "n/m" means the figure is held (or derivable) but not meaningful: a ratio
//     withheld for a bank or insurer, or growth outside +500% / -95%.
//   - Amounts stay in the company's REPORTING currency. "$" is written only for
//     AUD; a table mixing currencies prefixes non-AUD amounts with the ISO code
//     ("USD 4.29B"); prose writes "US$58.8B".
//   - Negatives use a true minus (U+2212) so signed columns align.
//   - Every caller renders the result in a `tabular-nums` cell.
//   - No em dashes in any output string.

/** A figure we do not hold: "n/a". */
export const NOT_AVAILABLE = "n/a";

/** A figure that is not meaningful for this company or this range: "n/m". */
export const NOT_MEANINGFUL = "n/m";

/** Title (tooltip) on an "n/m" ratio withheld because the company is a financial. */
export const NOT_MEANINGFUL_TITLE =
  "Not meaningful for banks, insurers and other financials";

/** True minus sign (U+2212), used for every negative figure. */
export const MINUS = "−";

/** Multiplication sign (U+00D7) suffixing ratios and multiples, as the picker's existing multiples do. */
export const MULTIPLE_SUFFIX = "×";

/** Growth above this percentage renders "n/m" (the raw figure goes in the title). */
export const GROWTH_NOT_MEANINGFUL_ABOVE = 500;

/** Growth below this percentage renders "n/m" (the raw figure goes in the title). */
export const GROWTH_NOT_MEANINGFUL_BELOW = -95;

/** Interest cover above this renders ">100×". */
export const INTEREST_COVER_CAP = 100;

/**
 * The ratios the API withholds for banks, insurers and other financials
 * (contract §2.7), as they appear in `not_meaningful` on the wire.
 */
export const NOT_MEANINGFUL_RATIOS: readonly string[] = Object.freeze([
  "gross_margin_pct",
  "operating_margin_pct",
  "fcf_margin_pct",
  "fcf_conversion",
  "net_debt",
  "net_debt_to_ebitda",
  "net_debt_to_equity",
  "current_ratio",
  "interest_cover",
]);

/** Label for a positive net debt figure (leases are excluded, contract §2.7). */
export const NET_DEBT_LABEL = "Net debt (excl. leases)";

/** Label for a negative net debt figure, shown as a positive net cash amount. */
export const NET_CASH_LABEL = "Net cash (excl. leases)";

/** A formatted value with an optional title (tooltip) that explains it. */
export interface FormattedValue {
  text: string;
  title?: string;
}

/** The "n/m" result of ratioOrNotMeaningful. */
export interface NotMeaningfulValue {
  text: typeof NOT_MEANINGFUL;
  title: string;
}

/** Options for amounts and per-share figures. */
export interface CurrencyFormatOptions {
  /**
   * The surrounding card or table mixes currencies: non-AUD values carry the
   * ISO code ("USD 4.29B"). Without it a non-AUD value is bare, because the
   * currency is stated once for the whole table.
   */
  mixed?: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normaliseCurrency(currency: string | null | undefined): string {
  return typeof currency === "string" ? currency.trim().toUpperCase() : "";
}

/** "1234567.5" -> "1,234,567.5". Deterministic (no ICU), so SSR and client agree. */
function groupThousands(fixed: string): string {
  const [whole, fraction] = fixed.split(".");
  const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Fixed-point magnitude with grouping, plus whether it rounds to zero. */
function fixedMagnitude(
  value: number,
  digits: number,
): { text: string; isZero: boolean } {
  const fixed = Math.abs(value).toFixed(digits);
  return { text: groupThousands(fixed), isZero: Number(fixed) === 0 };
}

interface CompactUnit {
  divisor: number;
  suffix: string;
  digits: number;
}

// Same precision as the stock page's original formatter: two decimals for
// billions and trillions, one for millions and thousands, none below that.
const COMPACT_UNITS: readonly CompactUnit[] = [
  { divisor: 1, suffix: "", digits: 0 },
  { divisor: 1e3, suffix: "K", digits: 1 },
  { divisor: 1e6, suffix: "M", digits: 1 },
  { divisor: 1e9, suffix: "B", digits: 2 },
  { divisor: 1e12, suffix: "T", digits: 2 },
];

/**
 * Compact magnitude of |value|: "4.29B", "412.3M", "85.2K", "512". A value
 * that rounds up to 1000 of its unit moves to the next ("1.0M", never
 * "1000.0K"). `unitDigits` overrides the K..T precision (prose uses 1).
 */
function compactMagnitude(
  value: number,
  unitDigits?: number,
): { text: string; isZero: boolean } {
  const abs = Math.abs(value);
  let index = COMPACT_UNITS.length - 1;
  while (index > 0 && abs < COMPACT_UNITS[index]!.divisor) index--;
  for (;;) {
    const unit = COMPACT_UNITS[index]!;
    const digits = index === 0 ? 0 : (unitDigits ?? unit.digits);
    const fixed = (abs / unit.divisor).toFixed(digits);
    if (Number(fixed) >= 1000 && index < COMPACT_UNITS.length - 1) {
      index++;
      continue;
    }
    return {
      text: `${groupThousands(fixed)}${unit.suffix}`,
      isZero: Number(fixed) === 0,
    };
  }
}

function signOf(value: number, isZero: boolean): string {
  return value < 0 && !isZero ? MINUS : "";
}

/** Joins a currency-aware magnitude: "$4.29B", "USD 4.29B", "4.29B". */
function withCurrency(
  value: number,
  magnitude: { text: string; isZero: boolean },
  currency: string | null | undefined,
  opts: CurrencyFormatOptions | undefined,
): string {
  const sign = signOf(value, magnitude.isZero);
  const code = normaliseCurrency(currency);
  if (code === "AUD") return `${sign}$${magnitude.text}`;
  if (opts?.mixed && code) return `${code} ${sign}${magnitude.text}`;
  return `${sign}${magnitude.text}`;
}

// Fixed three-letter months: Intl's en-AU short month varies by ICU build
// ("Jun" vs "June", "Sep" vs "Sept"), and a label should not.
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A YYYY-MM-DD (or longer ISO string) as a UTC midnight Date, or null. */
function parseIsoDate(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject rollovers such as 2026-02-31 (Date would silently make it 3 Mar).
  if (parsed.toISOString().slice(0, 10) !== iso.slice(0, 10)) return null;
  return parsed;
}

function dayMonthYear(date: Date): string {
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// A 52/53-week period ending in the first days of a month belongs to the month
// before (a year to Sunday 2 July 2023 is the June 2023 year). Same fold as
// the jobs module's fiscal-year derivation (picks/rows.go effectiveMonthShift).
const EFFECTIVE_SHIFT_DAYS = -7;

function effectiveDate(end: Date): Date {
  return new Date(end.getTime() + EFFECTIVE_SHIFT_DAYS * 86_400_000);
}

function addUtcMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function twoDigitYear(year: number): string {
  return String(year).slice(-2).padStart(2, "0");
}

function toSnakeCase(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** True when the reporting currency is AUD (case-insensitive). */
export function isAud(currency: string | null | undefined): boolean {
  return normaliseCurrency(currency) === "AUD";
}

/**
 * Compact amount in the reporting currency for tables and cards: "$4.29B"
 * (AUD), "4.29B" (non-AUD in a single-currency table), "USD 4.29B" (non-AUD
 * with `mixed`), "−$412.3M" for a negative, "n/a" when not held.
 */
export function formatAmount(
  value: number | null | undefined,
  currency: string | null | undefined,
  opts?: CurrencyFormatOptions,
): string {
  if (!isFiniteNumber(value)) return NOT_AVAILABLE;
  return withCurrency(value, compactMagnitude(value), currency, opts);
}

// Prose currency marks. Anything not listed is written as its ISO code.
const PROSE_SYMBOLS: Readonly<Record<string, string>> = {
  AUD: "A$",
  USD: "US$",
  NZD: "NZ$",
  CAD: "C$",
  HKD: "HK$",
  SGD: "S$",
  GBP: "£",
  EUR: "€",
};

/**
 * Amount for a sentence, always marked so it cannot be misread as AUD:
 * "US$58.8B", "NZ$1.2B", "A$3.1B", "ZAR 1.2B" for an unlisted code, bare
 * when the currency is unknown, "n/a" when not held.
 */
export function formatProseAmount(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (!isFiniteNumber(value)) return NOT_AVAILABLE;
  const magnitude = compactMagnitude(value, 1);
  const sign = signOf(value, magnitude.isZero);
  const code = normaliseCurrency(currency);
  if (!code) return `${sign}${magnitude.text}`;
  const symbol = PROSE_SYMBOLS[code];
  return symbol
    ? `${sign}${symbol}${magnitude.text}`
    : `${sign}${code} ${magnitude.text}`;
}

/**
 * Per-share amount (EPS, DPS) in dollars, never cents: "$0.94" (AUD), "2.74"
 * (non-AUD, single-currency table), "USD 2.74" (non-AUD with `mixed`). Two
 * decimals, three under ten cents ("−$0.045") so small EPS keeps its signal.
 */
export function formatPerShare(
  value: number | null | undefined,
  currency: string | null | undefined,
  opts?: CurrencyFormatOptions,
): string {
  if (!isFiniteNumber(value)) return NOT_AVAILABLE;
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.1 ? 3 : 2;
  return withCurrency(value, fixedMagnitude(value, digits), currency, opts);
}

/** Share count, compact and without a currency: "1.23B", "n/a" when not held. */
export function formatShares(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return NOT_AVAILABLE;
  const magnitude = compactMagnitude(value);
  return `${signOf(value, magnitude.isZero)}${magnitude.text}`;
}

/**
 * Net debt as the row a reader expects: a positive figure is "Net debt (excl.
 * leases)", a negative one is "Net cash (excl. leases)" with the magnitude
 * shown positive. "n/a" text (under the net debt label) when not held.
 */
export function formatNetDebt(
  value: number | null | undefined,
  currency: string | null | undefined,
  opts?: CurrencyFormatOptions,
): { label: string; text: string } {
  if (!isFiniteNumber(value))
    return { label: NET_DEBT_LABEL, text: NOT_AVAILABLE };
  if (value < 0) {
    return {
      label: NET_CASH_LABEL,
      text: formatAmount(-value, currency, opts),
    };
  }
  return { label: NET_DEBT_LABEL, text: formatAmount(value, currency, opts) };
}

// ---------------------------------------------------------------------------
// Percentages and growth
// ---------------------------------------------------------------------------

/** Options for formatPct. */
export interface PctFormatOptions {
  /** Leading "+" on positives (growth, changes). Negatives always carry a minus. */
  signed?: boolean;
  /** Decimal places, default 1. */
  digits?: number;
}

/**
 * Percentage: "12.4%", "−3.0%"; with `signed` "+41.2%" / "−3.0%" (the
 * picker's formatSigned). Zero never carries a sign. "n/a" when not held.
 */
export function formatPct(
  value: number | null | undefined,
  opts?: PctFormatOptions,
): string {
  if (!isFiniteNumber(value)) return NOT_AVAILABLE;
  const digits = opts?.digits ?? 1;
  const magnitude = fixedMagnitude(value, digits);
  if (magnitude.isZero) return `${(0).toFixed(digits)}%`;
  const sign = value < 0 ? MINUS : opts?.signed ? "+" : "";
  return `${sign}${magnitude.text}%`;
}

/**
 * True when a growth figure is inside the displayed range (-95% to +500%,
 * inclusive). Outside it the figure renders "n/m" and sorts after every
 * measured figure but before unknowns.
 */
export function isGrowthMeaningful(value: number | null | undefined): boolean {
  return (
    isFiniteNumber(value) &&
    value <= GROWTH_NOT_MEANINGFUL_ABOVE &&
    value >= GROWTH_NOT_MEANINGFUL_BELOW
  );
}

/** Options for formatGrowthPct. */
export interface GrowthFormatOptions {
  /**
   * Put the raw figure in the "n/m" title (default true). False gives the
   * explanation alone, for a caller that shows the raw figure elsewhere.
   */
  rawTitle?: boolean;
  /** Decimal places, default 1. */
  digits?: number;
}

const GROWTH_RANGE_NOTE = `not meaningful above +${GROWTH_NOT_MEANINGFUL_ABOVE}% or below ${MINUS}${Math.abs(GROWTH_NOT_MEANINGFUL_BELOW)}%`;

/**
 * Year-on-year growth: {text: "+41.2%"} inside the range, {text: "n/m",
 * title: "+812.4% year on year, not meaningful above +500% or below −95%"}
 * outside it, {text: "n/a"} when not held.
 */
export function formatGrowthPct(
  value: number | null | undefined,
  opts?: GrowthFormatOptions,
): FormattedValue {
  if (!isFiniteNumber(value)) return { text: NOT_AVAILABLE };
  const digits = opts?.digits ?? 1;
  if (isGrowthMeaningful(value)) {
    return { text: formatPct(value, { signed: true, digits }) };
  }
  if (opts?.rawTitle === false) {
    return {
      text: NOT_MEANINGFUL,
      title: `Growth ${GROWTH_RANGE_NOTE}`,
    };
  }
  const raw = formatPct(value, { signed: true, digits });
  return {
    text: NOT_MEANINGFUL,
    title: `${raw} year on year, ${GROWTH_RANGE_NOTE}`,
  };
}

// ---------------------------------------------------------------------------
// Ratios and multiples
// ---------------------------------------------------------------------------

/** Ratio with a "×" suffix: "1.8×" (current ratio), "−0.4×"; "n/a" when not held. */
export function formatRatio(
  value: number | null | undefined,
  digits = 1,
): string {
  if (!isFiniteNumber(value)) return NOT_AVAILABLE;
  const magnitude = fixedMagnitude(value, digits);
  return `${signOf(value, magnitude.isZero)}${magnitude.text}${MULTIPLE_SUFFIX}`;
}

/** Valuation or leverage multiple (P/E, P/B, net debt / EBITDA): "12.4×". */
export function formatMultiple(value: number | null | undefined): string {
  return formatRatio(value, 1);
}

/** Interest cover: "8.2×", ">100×" above 100 (a near-zero interest bill). */
export function formatInterestCover(value: number | null | undefined): string {
  if (isFiniteNumber(value) && value > INTEREST_COVER_CAP) {
    return `>${INTEREST_COVER_CAP}${MULTIPLE_SUFFIX}`;
  }
  return formatRatio(value, 1);
}

/**
 * True when `name` is listed in the API's `not_meaningful`. Compared in
 * snake_case, so a camelCase field name ("grossMarginPct") matches too.
 */
export function isNotMeaningful(
  name: string,
  notMeaningful: readonly string[] | undefined,
): boolean {
  if (!notMeaningful || notMeaningful.length === 0) return false;
  const wanted = toSnakeCase(name);
  return notMeaningful.some((entry) => toSnakeCase(entry) === wanted);
}

/**
 * A ratio, or {text: "n/m", title} when the API withheld it for a financial.
 * `fmt` renders the value otherwise (formatPct, formatMultiple, ...). An
 * absent `notMeaningful` (an older API) withholds nothing.
 */
export function ratioOrNotMeaningful<T = string>(
  name: string,
  value: number | null | undefined,
  notMeaningful: readonly string[] | undefined,
  fmt: (value: number | null | undefined) => T,
): T | NotMeaningfulValue {
  if (isNotMeaningful(name, notMeaningful)) {
    return { text: NOT_MEANINGFUL, title: NOT_MEANINGFUL_TITLE };
  }
  return fmt(value);
}

/**
 * Why a valuation figure is absent, from `valuation_note`: "n/a (reports in
 * USD)" for a non-AUD reporter, "n/a (listed unit is not one ordinary
 * share)", "n/a (no share count we can vouch for)", "n/a (no recent price)", else "n/a".
 * An empty note with a non-AUD currency still reads "reports in <code>".
 */
export function valuationNotAvailable(
  currency: string | null | undefined,
  note: string | null | undefined,
): string {
  const code = normaliseCurrency(currency);
  const reason = typeof note === "string" ? note.trim().toLowerCase() : "";
  switch (reason) {
    case "non-aud":
      return code && code !== "AUD"
        ? `${NOT_AVAILABLE} (reports in ${code})`
        : `${NOT_AVAILABLE} (not reported in AUD)`;
    case "listed-unit":
      return `${NOT_AVAILABLE} (listed unit is not one ordinary share)`;
    case "no-shares":
      return `${NOT_AVAILABLE} (no share count we can vouch for)`;
    case "no-price":
      return `${NOT_AVAILABLE} (no recent price)`;
    default:
      return code && code !== "AUD"
        ? `${NOT_AVAILABLE} (reports in ${code})`
        : NOT_AVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Periods and dates
// ---------------------------------------------------------------------------

/** The short basis tags the growth cells and statements use. */
export type BasisLabel = "TTM" | "FY" | "HY" | "";

/** "TTM" (ttm), "FY" (annual), "HY" (half), "" for anything else. */
export function basisLabel(basis: string | null | undefined): BasisLabel {
  switch (typeof basis === "string" ? basis.trim().toLowerCase() : "") {
    case "ttm":
      return "TTM";
    case "annual":
      return "FY";
    case "half":
      return "HY";
    default:
      return "";
  }
}

/**
 * Title text for a basis: "12 months to 30 Jun 2026", "Year to 30 Jun 2026",
 * "Half year to 31 Dec 2025", "Balance sheet at 30 Sep 2025" (quarter
 * snapshot). Without a valid date, the basis alone ("Trailing 12 months").
 * "" for an unknown basis.
 */
export function basisDescription(
  basis: string | null | undefined,
  periodEnd: string | null | undefined,
): string {
  const date = formatDate(periodEnd);
  switch (typeof basis === "string" ? basis.trim().toLowerCase() : "") {
    case "ttm":
      return date ? `12 months to ${date}` : "Trailing 12 months";
    case "annual":
      return date ? `Year to ${date}` : "Financial year";
    case "half":
      return date ? `Half year to ${date}` : "Half year";
    case "quarter":
      return date ? `Balance sheet at ${date}` : "Balance sheet";
    default:
      return "";
  }
}

/**
 * Statement column header: "FY26", "HY26", "TTM Jun 26", "Sep 25" (quarter
 * snapshot). `fiscalYear` (0 or absent when unknown) is the API's, derived
 * from the company's balance date, and wins. Without it: an annual is named
 * by the year it ends in, a half by the year of the financial year it opens
 * (ASX halves are first halves: Dec 2025 is HY26 for a June balance date,
 * Jun 2026 is HY26 for a December one). Falls back to the raw period end,
 * or "n/a", when the date does not parse.
 */
export function periodColumnLabel(
  periodType: string | null | undefined,
  periodEnd: string | null | undefined,
  fiscalYear?: number | null,
): string {
  const type =
    typeof periodType === "string" ? periodType.trim().toLowerCase() : "";
  const hasFiscalYear = isFiniteNumber(fiscalYear) && fiscalYear > 0;
  const end = parseIsoDate(periodEnd);
  const effective = end ? effectiveDate(end) : null;

  if (type === "annual" || type === "half") {
    const prefix = type === "annual" ? "FY" : "HY";
    if (hasFiscalYear) return `${prefix}${twoDigitYear(fiscalYear)}`;
    if (effective) {
      const year =
        type === "annual"
          ? effective.getUTCFullYear()
          : addUtcMonths(effective, 6).getUTCFullYear();
      return `${prefix}${twoDigitYear(year)}`;
    }
  } else if (effective) {
    const monthYear = `${SHORT_MONTHS[effective.getUTCMonth()]} ${twoDigitYear(effective.getUTCFullYear())}`;
    return type === "ttm" ? `TTM ${monthYear}` : monthYear;
  }
  return typeof periodEnd === "string" && periodEnd ? periodEnd : NOT_AVAILABLE;
}

/** "30 Jun 2026" from "2026-06-30"; "" when empty or invalid, so callers omit the clause. */
export function formatDate(iso: string | null | undefined): string {
  const date = parseIsoDate(iso);
  return date ? dayMonthYear(date) : "";
}

let sydneyDate: Intl.DateTimeFormat | null = null;

// Built on first use, not at import: a runtime without the zone data throws,
// and that must cost the Sydney date (falling back to UTC), never the module.
function sydneyDateFormat(): Intl.DateTimeFormat {
  if (sydneyDate) return sydneyDate;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  };
  try {
    sydneyDate = new Intl.DateTimeFormat("en-AU", {
      ...options,
      timeZone: "Australia/Sydney",
    });
  } catch {
    sydneyDate = new Intl.DateTimeFormat("en-AU", {
      ...options,
      timeZone: "UTC",
    });
  }
  return sydneyDate;
}

/**
 * "28 Sep 2026" from an RFC 3339 timestamp, as the date in Sydney (a fetch at
 * 20:00 UTC on the 27th is the 28th for an ASX reader). A bare YYYY-MM-DD is
 * taken as that date. "" when empty or invalid.
 */
export function formatAsOf(rfc3339: string | null | undefined): string {
  if (typeof rfc3339 !== "string" || rfc3339.trim() === "") return "";
  const input = rfc3339.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return formatDate(input);
  const instant = new Date(input);
  if (Number.isNaN(instant.getTime())) return "";
  const parts = sydneyDateFormat().formatToParts(instant);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const day = part("day");
  const month = part("month");
  const year = part("year");
  if (!day || !month || !year) return "";
  return `${day} ${SHORT_MONTHS[month - 1]} ${year}`;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  "yahoo-timeseries": "Yahoo Finance",
  "markit-key-statistics": "ASX (Markit)",
  "asx-filing-extraction": "Company filing (extracted)",
  "derived:fcf-minus-capex": "Derived: free cash flow minus capex",
  "derived:ttm-at-fye": "Derived: trailing 12 months at year end",
};

/** Reader-facing label for a row `source` or a `field_sources` value; unknown ids pass through. */
export function sourceLabel(source: string): string {
  const id = typeof source === "string" ? source.trim() : "";
  return SOURCE_LABELS[id] ?? id;
}

/** The distinct reader-facing labels of `sources`, in first appearance order, empties skipped. */
export function distinctSourceLabels(sources: readonly string[]): string[] {
  const labels: string[] = [];
  for (const source of sources) {
    const label = sourceLabel(source);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * The distinct sources behind a set of quoted figures, as one phrase:
 * "Yahoo Finance", "Company filing (extracted) and Yahoo Finance", "Yahoo
 * Finance, ASX (Markit) and Company filing (extracted)". "" when none.
 */
export function sourceListLabel(sources: readonly string[]): string {
  const labels = distinctSourceLabels(sources);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
