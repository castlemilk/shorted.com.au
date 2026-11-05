// StrategyService response -> plain rows (./types.ts).
//
// ONE mapper for every surface (docs/plans/fundamentals-coverage.md §7.2): the
// server actions call it on protobuf-es messages, and the /strategies sort island
// calls it on the protojson a browser POST gets back. So its input types are
// STRUCTURAL, ALL-OPTIONAL and JSON-COMPATIBLE, and this file imports nothing
// from the generated modules (not even types): a message satisfies these
// shapes, and so does Connect's JSON, which omits every default-valued field
// (a false has_* flag, an empty string, a zero) and writes a non-finite
// double as the STRING "NaN" or "Infinity".
//
// This is the ONE place proto3's "0 means missing" is resolved. Fields with a
// has_* flag honour it, so a measured zero survives (flat growth, a stock
// exactly in line with the index, an ASIC row reporting no position); fields
// without one are nulled where 0 is not a real value (a pivot, a base length,
// a volume multiple). Every numeric read goes through a typeof check, so a
// JSON "NaN" can never become a number, and an omitted double is the 0 it
// stands for, so the flag decides, exactly as it does for a message.

import type {
  GrowthBasis,
  MarketRegimeView,
  PicksSignals,
  PickFundamentalsView,
  PickRow,
  PickStatus,
  RegimeLabel,
  RuleResultRow,
  RuleStatus,
  StatusCountsView,
  StrategyDef,
  StrategyRuleDef,
  StrategyVersionDef,
  StrategyVersionDetailView,
} from "./types";

/** A protojson double: a number, or "NaN" / "Infinity" / "-Infinity". */
export type WireDouble = number | string;

export interface StrategyRuleInput {
  id?: string;
  title?: string;
  ruleText?: string;
  evaluation?: string;
  core?: boolean;
  dataSource?: string;
  trigger?: boolean;
  weight?: WireDouble;
  threshold?: WireDouble;
  hasThreshold?: boolean;
  unit?: string;
  comparator?: string;
}

export interface StrategyMetadataInput {
  style?: string;
  holdingPeriod?: string;
  riskPosture?: string;
  universe?: string;
  refreshCadence?: string;
  ruleCount?: number;
}

export interface StrategyInput {
  id?: string;
  name?: string;
  author?: string;
  tagline?: string;
  descriptionParagraphs?: readonly string[];
  rules?: readonly StrategyRuleInput[];
  metadata?: StrategyMetadataInput | null;
  caveats?: readonly string[];
  sources?: readonly string[];
  version?: StrategyVersionInput | null;
}

export interface StrategyVersionDetailInput {
  version?: StrategyVersionInput | null;
  policies?: readonly string[];
  changes?: readonly string[];
  knownIssues?: readonly string[];
  supersededOn?: string;
  retiredOn?: string;
}

export interface MarketRegimeInput {
  indexCode?: string;
  asOf?: string;
  regime?: string;
  close?: WireDouble;
  sma50?: WireDouble;
  sma200?: WireDouble;
  pctOff52wHigh?: WireDouble;
  verdict?: string;
}

export interface RuleResultInput {
  ruleId?: string;
  status?: string;
  detail?: string;
  value?: WireDouble;
  hasValue?: boolean;
  reason?: string;
  proximity?: WireDouble;
  hasProximity?: boolean;
  waiting?: boolean;
}

export interface StatusCountsInput {
  triggered?: number;
  setup?: number;
  watch?: number;
  unknown?: number;
}

export interface StrategyVersionInput {
  strategyId?: string;
  label?: string;
  rulesHash?: string;
  engineVersion?: string;
  featureSet?: string;
  status?: string;
  liveFrom?: string;
  kind?: string;
  variantId?: string;
}

export interface PickFundamentalsInput {
  revenueBasisPeriodType?: string;
  revenuePeriodEnd?: string;
  epsBasisPeriodType?: string;
  epsPeriodEnd?: string;
  currency?: string;
  fetchedAt?: string;
  revenueBasisSource?: string;
  epsBasisSource?: string;
  netMarginPct?: WireDouble;
  hasNetMarginPct?: boolean;
  roePct?: WireDouble;
  hasRoePct?: boolean;
  fcfMarginPct?: WireDouble;
  hasFcfMarginPct?: boolean;
  netDebtToEbitda?: WireDouble;
  hasNetDebtToEbitda?: boolean;
  peRatio?: WireDouble;
  hasPeRatio?: boolean;
  isFinancial?: boolean;
  netIncomePositive?: boolean;
  notMeaningful?: readonly string[];
}

export interface StrategyPickInput {
  rank?: number;
  stockCode?: string;
  companyName?: string;
  industry?: string;
  status?: string;
  score?: WireDouble;
  rules?: readonly RuleResultInput[];
  close?: WireDouble;
  asOf?: string;
  volumeRatio50d?: WireDouble;
  baseDepthPct?: WireDouble;
  baseLengthDays?: number;
  pivot?: WireDouble;
  revenueYoyPct?: WireDouble;
  hasRevenueYoy?: boolean;
  epsYoyPct?: WireDouble;
  hasEpsYoy?: boolean;
  rs3mPct?: WireDouble;
  shortPct?: WireDouble;
  marketCap?: WireDouble;
  logoUrl?: string;
  hasRs3mPct?: boolean;
  hasShortPct?: boolean;
  hasMarketCap?: boolean;
  hasClose?: boolean;
  fundamentals?: PickFundamentalsInput | null;
  pctOff52wHigh?: WireDouble;
  hasPctOff52wHigh?: boolean;
  daysToCover?: WireDouble;
  hasDaysToCover?: boolean;
  rs6mPct?: WireDouble;
  hasRs6mPct?: boolean;
  rs6mPercentile?: WireDouble;
  hasRs6mPercentile?: boolean;
  dollarVolume20d?: WireDouble;
  hasDollarVolume20d?: boolean;
  breakoutDate?: string;
  shortReportDate?: string;
  shortAvailableDate?: string;
  shortStatus?: string;
  caSuspectDate?: string;
}

/** The GetStrategyPicks response fields the picker reads. */
export interface StrategyPicksResponseInput {
  strategy?: StrategyInput | null;
  regime?: MarketRegimeInput | null;
  picks?: readonly StrategyPickInput[];
  statusCounts?: StatusCountsInput | null;
  sessionDate?: string;
  shortReportDate?: string;
  shortAvailableDate?: string;
  stale?: boolean;
  rsQuantileThreshold?: WireDouble;
  hasRsQuantileThreshold?: boolean;
  universeLabel?: string;
  version?: StrategyVersionInput | null;
  totalCount?: number;
  universeCount?: number;
  fundamentalsCoverageCount?: number;
  fundamentalsRowsCount?: number;
  asOf?: string;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * A wire double as a finite number, or null. An ABSENT value is proto3's
 * default, 0: protojson omits a zero, so a flagged zero (a measured 0% short
 * position) arrives as has_short_pct:true with no short_pct at all, and must
 * read exactly as the message's 0 does. A string is protojson's "NaN" or
 * "Infinity", never a number.
 */
function finiteOrNull(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/** A value only when its has_* flag says it is real. */
function flagged(value: unknown, has: boolean | undefined): number | null {
  return has === true ? finiteOrNull(value) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A count: a non-negative integer, 0 otherwise. */
function count(value: unknown): number {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? Math.trunc(n) : 0;
}

function strings(value: readonly string[] | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function toRuleStatus(value: unknown): RuleStatus {
  return value === "pass" || value === "fail" ? value : "unknown";
}

function toPickStatus(value: unknown): PickStatus {
  return value === "triggered" || value === "setup" ? value : "watch";
}

function toRegimeLabel(value: unknown): RegimeLabel {
  return value === "uptrend" || value === "neutral" || value === "downtrend"
    ? value
    : "";
}

function toGrowthBasis(value: unknown): GrowthBasis | null {
  const basis = str(value).trim().toLowerCase();
  return basis === "annual" || basis === "half" || basis === "ttm" ? basis : null;
}

/** A YYYY-MM-DD prefix, or "". */
function isoDate(value: unknown): string {
  const text = str(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

/** A YYYY-MM-DD date, or null when the value is absent or not a date. */
export function isoDateOrNull(value: unknown): string | null {
  return isoDate(value) || null;
}

/** The one decimal every picker ratio prints; formatting it again is a no-op. */
function oneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * Rounds down to a display step. A figure read against a cut-off (the
 * rs_leader percentile, the liquidity floor) must not print at the cut-off
 * when it sits just under it, so the step never moves a value up.
 */
function floorTo(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.floor(value * scale) / scale;
}

let sydneyParts: Intl.DateTimeFormat | null = null;

/**
 * The date in Sydney of an RFC 3339 instant, as YYYY-MM-DD (a fetch at 20:00
 * UTC on the 27th is the 28th for an ASX reader, the same rule as
 * lib/fundamentals/format.ts formatAsOf). "" when it does not parse.
 */
export function sydneyIsoDate(rfc3339: unknown): string {
  const text = str(rfc3339).trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) return "";
  if (!sydneyParts) {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    };
    try {
      sydneyParts = new Intl.DateTimeFormat("en-AU", {
        ...options,
        timeZone: "Australia/Sydney",
      });
    } catch {
      // A runtime without zone data costs the Sydney date, never the row.
      sydneyParts = new Intl.DateTimeFormat("en-AU", { ...options, timeZone: "UTC" });
    }
  }
  const parts = sydneyParts.formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = part("year");
  const month = part("month").padStart(2, "0");
  const day = part("day").padStart(2, "0");
  return /^\d{4}$/.test(year) ? `${year}-${month}-${day}` : "";
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function mapStrategy(strategy: StrategyInput): StrategyDef {
  const metadata = strategy.metadata;
  const rules = strategy.rules ?? [];
  const version = mapStrategyVersion(strategy.version);
  return {
    id: str(strategy.id),
    name: str(strategy.name),
    author: str(strategy.author),
    tagline: str(strategy.tagline),
    descriptionParagraphs: strings(strategy.descriptionParagraphs),
    rules: rules.map((rule) => ({
      id: str(rule.id),
      title: str(rule.title),
      ruleText: str(rule.ruleText),
      evaluation: str(rule.evaluation),
      core: rule.core === true,
      dataSource: str(rule.dataSource),
      ...mapRuleSignals(rule),
    })),
    metadata: metadata
      ? {
          style: str(metadata.style),
          holdingPeriod: str(metadata.holdingPeriod),
          riskPosture: str(metadata.riskPosture),
          universe: str(metadata.universe),
          refreshCadence: str(metadata.refreshCadence),
          ruleCount: count(metadata.ruleCount) || rules.length,
        }
      : null,
    caveats: strings(strategy.caveats),
    sources: strings(strategy.sources),
    ...(version ? { version } : {}),
  };
}

/** One published rules version for the changelog, or null when it names no version. */
export function mapStrategyVersionDetail(
  input: StrategyVersionDetailInput,
): StrategyVersionDetailView | null {
  const version = mapStrategyVersion(input.version);
  if (!version) return null;
  return {
    version,
    policies: strings(input.policies),
    changes: strings(input.changes),
    knownIssues: strings(input.knownIssues),
    supersededOn: isoDateOrNull(input.supersededOn) ?? "",
    retiredOn: isoDateOrNull(input.retiredOn) ?? "",
  };
}

export function mapRegime(
  regime: MarketRegimeInput | null | undefined,
): MarketRegimeView | null {
  if (!regime) return null;
  const label = toRegimeLabel(regime.regime);
  return {
    indexCode: str(regime.indexCode) || "XJO",
    asOf: str(regime.asOf),
    regime: label,
    // An unreadable regime carries zeros; none of them is a real level.
    close: label ? positiveOrNull(regime.close) : null,
    sma50: label ? positiveOrNull(regime.sma50) : null,
    sma200: label ? positiveOrNull(regime.sma200) : null,
    pctOff52wHigh: label ? finiteOrNull(regime.pctOff52wHigh) : null,
    verdict: str(regime.verdict),
  };
}

/** A rule's definition signals: the trigger flag, weight and the threshold it tests. */
function mapRuleSignals(rule: StrategyRuleInput): Partial<StrategyRuleDef> {
  const out: Partial<StrategyRuleDef> = {
    trigger: rule.trigger === true,
    weight: finiteOrNull(rule.weight) ?? 0,
    unit: str(rule.unit),
    comparator: str(rule.comparator),
  };
  const threshold = flagged(rule.threshold, rule.hasThreshold);
  if (threshold !== null) out.threshold = threshold;
  return out;
}

/**
 * One rule result. The value, proximity and reason are present only when the
 * API sends them, so a rule with no value has no value key, not a zero.
 */
export function mapRuleResult(result: RuleResultInput): RuleResultRow {
  const row: RuleResultRow = {
    ruleId: str(result.ruleId),
    status: toRuleStatus(result.status),
    detail: str(result.detail),
  };
  // The value keeps the API's precision: a threshold test is read from it,
  // and a rounded value could print on the wrong side of its threshold.
  const value = flagged(result.value, result.hasValue);
  if (value !== null) row.value = value;
  const reason = str(result.reason).trim();
  if (reason) row.reason = reason;
  const proximity = flagged(result.proximity, result.hasProximity);
  if (proximity !== null) row.proximity = Math.round(proximity * 100) / 100;
  if (result.waiting === true) row.waiting = true;
  return row;
}

/** A pick's signal fields, present only where the has_* flag or the value says so. */
function mapPickSignals(pick: StrategyPickInput): Partial<PickRow> {
  const out: Record<string, unknown> = {};
  const percentile = flagged(pick.rs6mPercentile, pick.hasRs6mPercentile);
  const turnover = flagged(pick.dollarVolume20d, pick.hasDollarVolume20d);
  const numbers: Array<[keyof PickRow, number | null]> = [
    ["pctOff52wHigh", flagged(pick.pctOff52wHigh, pick.hasPctOff52wHigh)],
    ["daysToCover", flagged(pick.daysToCover, pick.hasDaysToCover)],
    ["rs6mPct", flagged(pick.rs6mPct, pick.hasRs6mPct)],
    // Top quartile is 75 or more: one decimal, rounded down, so 74.96 is not 75.0.
    ["rs6mPercentile", percentile === null ? null : floorTo(percentile, 1)],
    // The A$250k liquidity floor: whole dollars, rounded down.
    ["dollarVolume20d", turnover === null ? null : floorTo(turnover, 0)],
  ];
  for (const [key, value] of numbers) {
    if (value !== null) out[key] = value;
  }
  const dates: Array<[keyof PickRow, unknown]> = [
    ["breakoutDate", pick.breakoutDate],
    ["shortReportDate", pick.shortReportDate],
    ["shortAvailableDate", pick.shortAvailableDate],
    ["caSuspectDate", pick.caSuspectDate],
  ];
  for (const [key, value] of dates) {
    const date = isoDateOrNull(value);
    if (date !== null) out[key] = date;
  }
  const shortStatus = str(pick.shortStatus).trim();
  if (shortStatus) out.shortStatus = shortStatus;
  return out as Partial<PickRow>;
}

function mapStatusCounts(
  input: StatusCountsInput | null | undefined,
): StatusCountsView | null {
  if (!input) return null;
  return {
    triggered: count(input.triggered),
    setup: count(input.setup),
    watch: count(input.watch),
    unknown: count(input.unknown),
  };
}

/** The rules version, or null when the API names none. */
function mapStrategyVersion(
  input: StrategyVersionInput | null | undefined,
): StrategyVersionDef | null {
  if (!input) return null;
  const version: StrategyVersionDef = {
    strategyId: str(input.strategyId),
    label: str(input.label),
    rulesHash: str(input.rulesHash),
    engineVersion: str(input.engineVersion),
    featureSet: str(input.featureSet),
    status: str(input.status),
    liveFrom: str(input.liveFrom),
    kind: str(input.kind),
    variantId: str(input.variantId),
  };
  return version.label || version.rulesHash ? version : null;
}

/** The response-level signals; each present only when the API carries it. */
function mapPicksSignals(response: StrategyPicksResponseInput): PicksSignals {
  // stale is set only when the API says so: the index has closed a session the
  // prices have not reached. An absent flag is not a claim of freshness.
  const out: PicksSignals = {};
  if (response.stale === true) out.stale = true;
  const counts = mapStatusCounts(response.statusCounts);
  if (counts) out.statusCounts = counts;
  const sessionDate = isoDateOrNull(response.sessionDate);
  if (sessionDate) out.sessionDate = sessionDate;
  const shortReportDate = isoDateOrNull(response.shortReportDate);
  if (shortReportDate) out.shortReportDate = shortReportDate;
  const shortAvailableDate = isoDateOrNull(response.shortAvailableDate);
  if (shortAvailableDate) out.shortAvailableDate = shortAvailableDate;
  const threshold = flagged(
    response.rsQuantileThreshold,
    response.hasRsQuantileThreshold,
  );
  if (threshold !== null) out.rsQuantileThreshold = threshold;
  const universeLabel = str(response.universeLabel).trim();
  if (universeLabel) out.universeLabel = universeLabel;
  const version = mapStrategyVersion(response.version);
  if (version) out.version = version;
  return out;
}

/** The ratios the row shows that the API can withhold as not meaningful. */
const PICK_NOT_MEANINGFUL = new Set(["fcf_margin_pct", "net_debt_to_ebitda"]);

/**
 * StrategyPick.fundamentals -> the fields the row renders, nulls omitted.
 * Undefined when the message carries none (no fundamentals row, or an API
 * that predates the field).
 */
export function mapPickFundamentals(
  input: PickFundamentalsInput | null | undefined,
): PickFundamentalsView | undefined {
  if (!input) return undefined;
  const view: PickFundamentalsView = {};

  const revenueBasis = toGrowthBasis(input.revenueBasisPeriodType);
  if (revenueBasis) {
    view.revenueBasis = revenueBasis;
    const end = isoDate(input.revenuePeriodEnd);
    if (end) view.revenueEnd = end;
    if (str(input.revenueBasisSource) === "filing") view.revenueFiling = true;
  }
  const epsBasis = toGrowthBasis(input.epsBasisPeriodType);
  if (epsBasis) {
    view.epsBasis = epsBasis;
    const end = isoDate(input.epsPeriodEnd);
    if (end) view.epsEnd = end;
    if (str(input.epsBasisSource) === "filing") view.epsFiling = true;
  }

  const currency = str(input.currency).trim().toUpperCase();
  if (currency && currency !== "AUD") view.currency = currency;
  const fetchedOn = sydneyIsoDate(input.fetchedAt);
  if (fetchedOn) view.fetchedOn = fetchedOn;

  const ratios: Array<[keyof PickFundamentalsView, number | null]> = [
    ["netMarginPct", flagged(input.netMarginPct, input.hasNetMarginPct)],
    ["roePct", flagged(input.roePct, input.hasRoePct)],
    ["fcfMarginPct", flagged(input.fcfMarginPct, input.hasFcfMarginPct)],
    ["netDebtToEbitda", flagged(input.netDebtToEbitda, input.hasNetDebtToEbitda)],
    ["peRatio", flagged(input.peRatio, input.hasPeRatio)],
  ];
  for (const [key, value] of ratios) {
    if (value !== null) (view as Record<string, unknown>)[key] = oneDecimal(value);
  }

  const notMeaningful = strings(input.notMeaningful)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => PICK_NOT_MEANINGFUL.has(name));
  if (notMeaningful.length > 0) view.notMeaningful = Array.from(new Set(notMeaningful));

  return view;
}

export function mapPick(pick: StrategyPickInput): PickRow {
  const rules = pick.rules ?? [];
  const baseLengthDays = count(pick.baseLengthDays);
  const row: PickRow = {
    rank: count(pick.rank),
    code: str(pick.stockCode),
    name: str(pick.companyName),
    industry: str(pick.industry),
    status: toPickStatus(pick.status),
    score: finiteOrNull(pick.score) ?? 0,
    rules: rules.map(mapRuleResult),
    close: pick.hasClose === true ? positiveOrNull(pick.close) : null,
    asOf: str(pick.asOf),
    pivot: positiveOrNull(pick.pivot),
    // A base needs at least one session, so length 0 means no base was read,
    // and its depth is then meaningless too.
    baseDepthPct: baseLengthDays > 0 ? finiteOrNull(pick.baseDepthPct) : null,
    baseLengthDays: baseLengthDays > 0 ? baseLengthDays : null,
    volumeRatio: positiveOrNull(pick.volumeRatio50d),
    revenueYoyPct: flagged(pick.revenueYoyPct, pick.hasRevenueYoy),
    epsYoyPct: flagged(pick.epsYoyPct, pick.hasEpsYoy),
    rs3mPct: flagged(pick.rs3mPct, pick.hasRs3mPct),
    shortPct: flagged(pick.shortPct, pick.hasShortPct),
    // A reported market cap of 0 is not a company size; treat it as unknown.
    marketCap: pick.hasMarketCap === true ? positiveOrNull(pick.marketCap) : null,
    logoUrl: str(pick.logoUrl),
  };
  Object.assign(row, mapPickSignals(pick));
  const fundamentals = mapPickFundamentals(pick.fundamentals);
  if (fundamentals) row.fundamentals = fundamentals;
  return row;
}

/** The rows and counts of one GetStrategyPicks response. */
export interface MappedPicks extends PicksSignals {
  picks: PickRow[];
  totalCount: number;
  universeCount: number;
  fundamentalsCoverageCount: number;
  fundamentalsRowsCount: number;
  asOf: string;
}

/** Everything but the strategy and regime: what both the page and the sort island read. */
export function mapPicksResponse(response: StrategyPicksResponseInput): MappedPicks {
  return {
    picks: (response.picks ?? []).map(mapPick),
    totalCount: count(response.totalCount),
    universeCount: count(response.universeCount),
    fundamentalsCoverageCount: count(response.fundamentalsCoverageCount),
    fundamentalsRowsCount: count(response.fundamentalsRowsCount),
    asOf: str(response.asOf),
    ...mapPicksSignals(response),
  };
}
