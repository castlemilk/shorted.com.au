/**
 * Parsers for the chat's tool results. Each takes the result string the chat
 * service returned (`ToolExecutor.Execute`, carried in `data-shorted-final`) and
 * returns the typed view a table or chart draws, or null when the result has no
 * shape we draw, so the message falls back to the raw text it already shows.
 *
 * Every parser is defensive: an unknown or missing field is left out, a value
 * that is not a finite number is dropped, and an ASX code is kept only when it
 * matches ASX_CODE_PATTERN. None of them throws.
 *
 * The shapes are the recorded fixtures in __fixtures__/tool-results (see its
 * README). This module imports neither React nor the charts, so it stays in the
 * eager chat bundle.
 */

export type JsonRecord = Record<string, unknown>;

/** A point in time (epoch milliseconds) and the value read there. */
export interface Reading {
  t: number;
  v: number;
}

/** ASX codes as the API stores them: 2 to 6 upper-case letters or digits. */
export const ASX_CODE_PATTERN = /^[A-Z0-9]{2,6}$/;

/** The most rows a table draws. The tools cap their own answers at 50. */
export const MAX_TABLE_ROWS = 50;

/** The most economic series drawn. Any further series are counted, not drawn. */
export const MAX_ECONOMIC_SERIES = 4;

/** Readings read from one series. Far above any answer the tools give. */
const MAX_READINGS = 500;

/** Keys a short-position reading may carry its percentage under. */
const SHORT_VALUE_KEYS = [
  "shortPosition",
  "short_position",
  "percentageShorted",
  "shortPercent",
] as const;

export interface TopShortRow {
  /** Position in the tool's answer, 1-based. */
  rank: number;
  code: string;
  name?: string;
  latest?: number;
  points: Reading[];
}

export interface TopShortsView {
  rows: TopShortRow[];
  /** Stocks the tool left out of the answer ("omittedStocks", plus any past the table cap). */
  notShown: number;
}

export interface ShortPositionsView {
  code: string;
  name?: string;
  latest?: number;
  points: Reading[];
  /** Every reading the period holds, when the tool thinned the series. */
  totalObservations?: number;
  downsampled: boolean;
}

export interface PeerRow {
  code: string;
  name?: string;
  shortPercent?: number;
  marketCap?: number;
  peRatio?: number;
  dividendYield?: number;
  priceChange1m?: number;
}

export interface PeersView {
  subjectCode?: string;
  industry?: string;
  /** The stock the peers are compared with, drawn first. It has the same fields a peer has. */
  subject?: PeerRow;
  rows: PeerRow[];
}

export interface DirectorTradeRow {
  /** The trade's own id from the API, or its position in the answer when it has none. */
  id: string;
  director: string;
  /** The raw tradeType: "buy", "exercise_options", "other", or whatever the API sends. */
  tradeType: string;
  /** The raw tradeDate, usually "YYYY-MM-DD". */
  tradeDate?: string;
  shares?: number;
  pricePerShare?: number;
  totalValue?: number;
  announcementUrl?: string;
}

export interface DirectorTradesView {
  trades: DirectorTradeRow[];
  /** Trades the tool counted but did not draw: dropped to fit the budget, or past the table's cap. */
  notShown: number;
}

export interface EconomicSeriesView {
  key: string;
  name?: string;
  unit?: string;
  frequency?: string;
  points: Reading[];
}

export interface EconomicSeriesResult {
  series: EconomicSeriesView[];
  /** Usable series beyond MAX_ECONOMIC_SERIES. */
  notShown: number;
}

export function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

/** A finite number, or a string holding one. The string form is strict: "12abc" is not 12. */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && NUMBER_TEXT.test(value.trim())) {
    const number = Number(value.trim());
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

const NUMBER_TEXT = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** A whole, non-negative count, or undefined. */
export function nonNegativeInt(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.floor(number) : undefined;
}

/** A trimmed, non-empty text value, capped in length. */
export function textValue(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** An ASX code exactly as the API writes it, or undefined. */
export function validCode(value: unknown): string | undefined {
  return typeof value === "string" && ASX_CODE_PATTERN.test(value)
    ? value
    : undefined;
}

/** The stock code a tool was called with, upper-cased, when it is a valid code. */
export function codeFromArguments(args: string): string | undefined {
  const record = asRecord(parseJSON(args));
  const code = textValue(record?.stock_code, 12);
  return validCode(code?.toUpperCase());
}

/**
 * The root object of a result, or null when the result is not an object or is an
 * error ({"error": "..."}). A failed call is shown by the message, not drawn.
 */
export function resultRecord(result: string): JsonRecord | null {
  const record = asRecord(parseJSON(result));
  if (!record) return null;
  if (typeof record.error === "string") return null;
  return record;
}

/**
 * The timestamp a reading is dated by: an ISO string, a date-only string, or
 * protobuf's {seconds}. Undefined when it is none of these, or when it is outside
 * the range a Date holds: Intl throws on those, and a throw would take the message
 * with it.
 */
function timeValue(value: unknown): number | undefined {
  if (typeof value === "string") {
    return dateInRange(Date.parse(value));
  }
  const record = asRecord(value);
  if (record) {
    const seconds = finiteNumber(record.seconds);
    return seconds === undefined ? undefined : dateInRange(seconds * 1000);
  }
  return undefined;
}

/** `t` (epoch milliseconds) when a Date holds it, which is within ±8.64e15, else undefined. */
function dateInRange(t: number): number | undefined {
  return Number.isFinite(new Date(t).getTime()) ? t : undefined;
}

/** Readings from a list of {timestamp|period|date, value}, ascending by time. Bad items are skipped. */
function readings(value: unknown, valueKeys: readonly string[]): Reading[] {
  const out: Reading[] = [];
  for (const item of arrayValue(value).slice(0, MAX_READINGS)) {
    const record = asRecord(item);
    if (!record) continue;
    const t = timeValue(record.timestamp ?? record.period ?? record.date);
    const v = numberValue(...valueKeys.map((key) => record[key]));
    if (t === undefined || v === undefined) continue;
    out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

function firstRecord(value: unknown): JsonRecord | null {
  for (const item of arrayValue(value)) {
    const record = asRecord(item);
    if (record) return record;
  }
  return null;
}

/** The most-shorted table: `timeSeries` rows, each with a sparkline of up to 8 readings. */
export function parseTopShorts(result: string): TopShortsView | null {
  const root = resultRecord(result);
  if (!root || !Array.isArray(root.timeSeries)) return null;

  const items = root.timeSeries as unknown[];
  const rows: TopShortRow[] = [];
  items.slice(0, MAX_TABLE_ROWS).forEach((item, index) => {
    const record = asRecord(item);
    const code = validCode(record?.productCode);
    if (!record || !code) return;
    const points = readings(record.points, SHORT_VALUE_KEYS);
    rows.push({
      rank: index + 1,
      code,
      name: textValue(record.name, 120),
      latest: finiteNumber(record.latestShortPosition) ?? points.at(-1)?.v,
      points,
    });
  });

  const cut = Math.max(0, items.length - MAX_TABLE_ROWS);
  return {
    rows,
    notShown: (nonNegativeInt(root.omittedStocks) ?? 0) + cut,
  };
}

/**
 * One stock's short-position series. Needs two readings to draw a line; fewer
 * (or no points at all) returns null so the raw text shows instead.
 */
export function parseShortPositions(
  result: string,
  args: string,
): ShortPositionsView | null {
  const root = resultRecord(result);
  if (!root) return null;

  const series = firstRecord(root.timeSeries) ?? root;
  const points = readings(series.points, SHORT_VALUE_KEYS);
  if (points.length < 2) return null;

  const code =
    validCode(textValue(series.productCode, 12)?.toUpperCase()) ??
    codeFromArguments(args);
  if (!code) return null;

  const last = points[points.length - 1]!;
  return {
    code,
    name: textValue(series.name, 120) ?? textValue(series.companyName, 120),
    latest: finiteNumber(series.latestShortPosition) ?? last.v,
    points,
    totalObservations: nonNegativeInt(series.totalObservations),
    downsampled: series.downsampled === true,
  };
}

/** One stock's figures from a peers answer, or undefined when it has no valid code. */
function peerRow(record: JsonRecord | null): PeerRow | undefined {
  const code = validCode(record?.stockCode);
  if (!record || !code) return undefined;
  return {
    code,
    name: textValue(record.companyName, 120),
    shortPercent: finiteNumber(record.shortPositionPercent),
    marketCap: finiteNumber(record.marketCap),
    peRatio: finiteNumber(record.peRatio),
    dividendYield: finiteNumber(record.dividendYield),
    priceChange1m: finiteNumber(record.priceChange1m),
  };
}

/**
 * The peers table: `subject` (optional, drawn first) and `peers`. Null when there is
 * no peers list. A peer that repeats the subject's code is left out, so the subject
 * appears once.
 */
export function parsePeers(result: string): PeersView | null {
  const root = resultRecord(result);
  if (!root || !Array.isArray(root.peers)) return null;

  const subjectRecord = asRecord(root.subject);
  const subject = peerRow(subjectRecord);
  const rows: PeerRow[] = [];
  for (const item of arrayValue(root.peers).slice(0, MAX_TABLE_ROWS)) {
    const row = peerRow(asRecord(item));
    if (!row || row.code === subject?.code) continue;
    rows.push(row);
  }

  return {
    subjectCode: subject?.code,
    industry: textValue(root.industry, 80) ?? textValue(subjectRecord?.industry, 80),
    subject,
    rows,
  };
}

/**
 * Director trades. An answer with no `trades` key is the documented empty case
 * ({}), which is an empty view, not a failure. A `trades` value that is not a
 * list is malformed, so it returns null.
 */
export function parseDirectorTrades(result: string): DirectorTradesView | null {
  const root = resultRecord(result);
  if (!root) return null;
  if (root.trades !== undefined && !Array.isArray(root.trades)) return null;

  const sent = arrayValue(root.trades);
  const trades: DirectorTradeRow[] = [];
  sent.slice(0, MAX_TABLE_ROWS).forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    trades.push({
      id: textValue(record.id, 80) ?? `trade-${index}`,
      director: textValue(record.directorName, 120) ?? "Not named",
      tradeType: textValue(record.tradeType, 40) ?? "other",
      tradeDate: textValue(record.tradeDate, 40),
      shares: finiteNumber(record.sharesTraded),
      pricePerShare: finiteNumber(record.pricePerShare),
      totalValue: finiteNumber(record.totalValue),
      announcementUrl: textValue(record.announcementUrl, 2000),
    });
  });

  // Trades the tool did not send: the rows it dropped to fit the budget (omittedTrades)
  // and the trades the API counted beyond the rows sent (totalCount). Both count the
  // same trades when the budget cut, so the larger is the count, not their sum. Rows
  // past the table's cap are counted as well.
  const total = nonNegativeInt(root.totalCount) ?? 0;
  const omitted = nonNegativeInt(root.omittedTrades) ?? 0;
  const pastCap = Math.max(0, sent.length - MAX_TABLE_ROWS);
  return {
    trades,
    notShown: Math.max(omitted, total - sent.length) + pastCap,
  };
}

/**
 * Economic series. Each series carries its readings at the top level (no info
 * wrapper). A series needs a key and two readings to draw. An empty `series`
 * list is an empty result; a list with nothing drawable returns null.
 */
export function parseEconomicSeries(result: string): EconomicSeriesResult | null {
  const root = resultRecord(result);
  if (!root || !Array.isArray(root.series)) return null;

  const items = root.series as unknown[];
  if (items.length === 0) return { series: [], notShown: 0 };

  const usable: EconomicSeriesView[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const key = textValue(record.key, 120);
    const points = readings(record.observations, ["value"]);
    if (!key || points.length < 2) continue;
    usable.push({
      key,
      name: textValue(record.name, 120),
      unit: textValue(record.unit, 40),
      frequency: textValue(record.frequency, 40),
      points,
    });
  }

  if (usable.length === 0) return null;
  const series = usable.slice(0, MAX_ECONOMIC_SERIES);
  return { series, notShown: usable.length - series.length };
}
