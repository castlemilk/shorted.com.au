// StrategyService's backtest reads -> plain rows (ListStrategyEvidence, GetBacktestRun,
// ListBacktestTrades). The contract is proto/shortedapi/shorts/v1alpha1/strategies.proto
// (design 8.2 as revised by PR-18).
//
// EXPORTS FOR THE EXPLORER AND COMPARE (PR-20 reads these; there is one set of names).
//   StrategyEvidenceView / StrategyEvidenceListView   ListStrategyEvidence, one strategy / all
//   StatusCountsView                                  today's counts (PR-20's `today`)
//   PaperTrackView                                    the recorded track (recordedFrom, engine segments)
//   BacktestRunView                                   GetBacktestRun
//   CompareStrategiesView, CompareEntryView, RuleDiffView, StrategyCorrelationView
//   mapStrategyEvidence, mapStrategyEvidenceList, mapCompareStrategies
// Units: every coverage figure in a view is a PERCENT (64.2 is 64.2%), as the API sends it.
// A consumer that draws a fraction divides at the drawing, never in the view.
//
// THE ONE PLACE the backtest's proto names live. Like map.ts, this file imports nothing
// from the generated modules: its input types are structural, all optional and
// JSON-compatible, so a protobuf-es message satisfies them and so does Connect's JSON.
// Components, pages and tests read the camelCase view types exported here.
//
// Where proto3 says "0 means missing", the has_* flag decides: a figure with a flag is
// null unless the flag is set, so a measured zero survives. Benchmark and reference
// levels are index levels, never zero, so zero is "not measured". A non-finite double
// (the JSON string "NaN") is never a number.

import { mapStrategyVersion, type StrategyVersionInput } from "./map";
import type { StrategyVersionDef } from "./types";

/** A protojson double: a number, or "NaN" / "Infinity" / "-Infinity". */
export type WireDouble = number | string;
/** An int64: protojson writes it as a string, protobuf-es as a bigint. */
export type WireInt64 = number | string | bigint;

// ---------------------------------------------------------------------------
// Inputs (protojson camelCase, all optional)
// ---------------------------------------------------------------------------

export interface WindowMetricsInput {
  window?: string;
  label?: string;
  note?: string;
  from?: string;
  to?: string;
  totalReturnPct?: WireDouble;
  hasTotalReturn?: boolean;
  cagrPct?: WireDouble;
  hasCagr?: boolean;
  benchmarkCagrPct?: WireDouble;
  hasBenchmark?: boolean;
  referenceCagrPct?: WireDouble;
  hasReference?: boolean;
  benchmarkTotalReturnPct?: WireDouble;
  hasBenchmarkTotalReturn?: boolean;
  referenceTotalReturnPct?: WireDouble;
  hasReferenceTotalReturn?: boolean;
  /** The last session the reference figures are measured to (YYYY-MM-DD); "" when there is no reference. */
  referenceTo?: string;
  maxDrawdownPct?: WireDouble;
  peakDate?: string;
  troughDate?: string;
  /** The session back at the peak; "not recovered" while it has not; "" when none. */
  recoveryDate?: string;
  sharpe?: WireDouble;
  sharpeSe?: WireDouble;
  hasSharpe?: boolean;
  closedTrades?: number;
  winRatePct?: WireDouble;
  hasWinRate?: boolean;
  exposurePct?: WireDouble;
  recordedTail?: boolean;
  notAnnualised?: boolean;
  sessions?: number;
  calendarDays?: number;
  volatilityPct?: WireDouble;
  hasVolatility?: boolean;
}

export interface AnnualReturnInput {
  year?: number;
  /** complete | partial | to_date. */
  state?: string;
  months?: string;
  strategyPct?: WireDouble;
  benchmarkPct?: WireDouble;
  hasBenchmark?: boolean;
  referencePct?: WireDouble;
  hasReference?: boolean;
  coveragePct?: WireDouble;
  coverageMeasurable?: boolean;
  /** qualifying_5pct_short | all_reported | not_measurable. */
  coverageMeasure?: string;
  approximate?: boolean;
}

export interface MonthlyReturnInput {
  year?: number;
  month?: number;
  /** complete | partial | to_date. Months that have not elapsed, or fall before the window, are absent. */
  state?: string;
  strategyPct?: WireDouble;
  benchmarkPct?: WireDouble;
  hasBenchmark?: boolean;
  referencePct?: WireDouble;
  hasReference?: boolean;
  label?: string;
}

export interface CoverageYearInput {
  year?: number;
  /** The qualifying measure (name-days of at least 5% short) has name-days in the year. */
  measurable?: boolean;
  qualifyingNameDays?: WireInt64;
  pricedNameDays?: WireInt64;
  coveragePct?: WireDouble;
  allReportedPct?: WireDouble;
  allReportedMeasurable?: boolean;
  allReportedNameDays?: WireInt64;
  allReportedPricedNameDays?: WireInt64;
  delistingExits?: number;
  caExits?: number;
}

export interface CoverageMonthInput {
  month?: string;
  coveragePct?: WireDouble;
  measurable?: boolean;
  allReportedPct?: WireDouble;
  allReportedMeasurable?: boolean;
}

export interface SurvivorshipInput {
  /** measured | partial | not_measurable. */
  measurement?: string;
  direction?: string;
  statement?: string;
  caveat?: string;
}

export interface SensitivityInput {
  id?: string;
  label?: string;
  cagrPct?: WireDouble;
  hasCagr?: boolean;
  excessVsBenchmarkPct?: WireDouble;
  hasExcess?: boolean;
  maxDrawdownPct?: WireDouble;
  fragile?: boolean;
  applies?: boolean;
  reason?: string;
  fragileChip?: string;
}

export interface SeriesPointInput {
  date?: string;
  equity?: WireDouble;
  benchmark?: WireDouble;
  reference?: WireDouble;
  drawdownPct?: WireDouble;
  exposurePct?: WireDouble;
  recorded?: boolean;
}

export interface RecipeLinesInput {
  recipeId?: string;
  entry?: string;
  exits?: readonly string[];
  sizing?: string;
  brokerage?: string;
  spread?: string;
  capacity?: string;
  dividends?: string;
  asicData?: string;
  delisting?: string;
  capital?: string;
  cash?: string;
  preface?: string;
}

export interface TradeSummaryInput {
  closed?: number;
  openAtEnd?: number;
  winRatePct?: WireDouble;
  hasWinRate?: boolean;
  avgHoldSessions?: WireDouble;
  hasAvgHold?: boolean;
  avgWinPct?: WireDouble;
  hasAvgWin?: boolean;
  avgLossPct?: WireDouble;
  hasAvgLoss?: boolean;
  bestPct?: WireDouble;
  hasBest?: boolean;
  worstPct?: WireDouble;
  hasWorst?: boolean;
  exitsByReason?: Readonly<Record<string, number>>;
}

export interface BacktestTradeInput {
  seq?: number;
  stockCode?: string;
  companyName?: string;
  signalDate?: string;
  entryDate?: string;
  entryPrice?: WireDouble;
  capturedPivot?: WireDouble;
  hasCapturedPivot?: boolean;
  entryScore?: WireDouble;
  exitSignalDate?: string;
  exitDate?: string;
  exitPrice?: WireDouble;
  exitReason?: string;
  sessionsHeld?: number;
  grossReturnPct?: WireDouble;
  netReturnPct?: WireDouble;
  flags?: readonly string[];
  open?: boolean;
}

export interface EngineSegmentInput {
  engineVersion?: string;
  firstSession?: string;
  lastSession?: string;
  sessions?: number;
}

export interface PaperTrackInput {
  since?: string;
  sessions?: number;
  closedTrades?: number;
  openPositions?: number;
  returnPct?: WireDouble;
  hasReturn?: boolean;
  tooShort?: boolean;
  recordedFrom?: string;
  engineSegments?: readonly EngineSegmentInput[];
}

export interface StrategyEvidenceInput {
  strategyId?: string;
  version?: StrategyVersionInput | null;
  state?: string;
  stateReason?: string;
  computableFrom?: string;
  fiscalLabel?: string;
  windows?: readonly WindowMetricsInput[];
  annual?: readonly AnnualReturnInput[];
  miniCurve?: readonly SeriesPointInput[];
  paper?: PaperTrackInput | null;
  survivorship?: string;
  runId?: WireInt64;
  latestScreen?: string;
  runningSince?: string;
  computableSharePct?: WireDouble;
  hasComputableShare?: boolean;
  today?: StatusCountsInput | null;
  /** asic_reported | asx_ordinary: the universe the live version screens (from the live version). */
  universeKind?: string;
}

export interface StatusCountsInput {
  triggered?: number;
  setup?: number;
  watch?: number;
  unknown?: number;
}

export interface ListStrategyEvidenceInput {
  strategies?: readonly StrategyEvidenceInput[];
  windowStart?: string;
  pricesThrough?: string;
  benchmarkName?: string;
  footnotes?: readonly string[];
}

export interface BacktestIdentityInput {
  runId?: WireInt64;
  runKey?: string;
  kind?: string;
  version?: StrategyVersionInput | null;
  recipeId?: string;
  recipeHash?: string;
  engineVersion?: string;
  windowStart?: string;
  windowEnd?: string;
  returns?: string;
  benchmark?: string;
  fundamentals?: string;
  pricesThrough?: string;
  asicReportThrough?: string;
  inSampleUntil?: string;
  finishedAt?: string;
  inputHash?: string;
  outputHash?: string;
  buildRevision?: string;
  riskFree?: string;
  referenceName?: string;
  runDate?: string;
}

export interface DataQualityInput {
  delistingExits?: number;
  corporateActionExits?: number;
  caSuspects?: number;
  fallbackClose?: number;
  priceReturnTrades?: number;
  capacityCapped?: number;
  staleMarkTrades?: number;
  delayedExits?: number;
  cancelledEntries?: Readonly<Record<string, number>>;
  dividendsCredited?: number;
  consolidationNote?: string;
}

export interface BacktestRunInput {
  state?: string;
  stateReason?: string;
  strategyId?: string;
  computableFrom?: string;
  fiscalLabel?: string;
  identity?: BacktestIdentityInput | null;
  windows?: readonly WindowMetricsInput[];
  annual?: readonly AnnualReturnInput[];
  monthly?: readonly MonthlyReturnInput[];
  series?: readonly SeriesPointInput[];
  coverage?: readonly CoverageYearInput[];
  coverageMonthly?: readonly CoverageMonthInput[];
  survivorship?: SurvivorshipInput | null;
  sensitivity?: readonly SensitivityInput[];
  recipe?: RecipeLinesInput | null;
  tradeSummary?: TradeSummaryInput | null;
  liveVersion?: StrategyVersionInput | null;
  rulesMatchLive?: boolean;
  engineMatchesLive?: boolean;
  replayAgreement?: string;
  inputChangeNote?: string;
  disclosures?: readonly string[];
  dataNotes?: readonly string[];
  runningSince?: string;
  seriesResolution?: string;
  computableSharePct?: WireDouble;
  hasComputableShare?: boolean;
  dataQuality?: DataQualityInput | null;
  windowId?: string;
  fundamentalsLabel?: string;
  paperStart?: string;
  paperEngineSegments?: readonly EngineSegmentInput[];
}

export interface GetBacktestRunInput {
  run?: BacktestRunInput | null;
}

export interface ListBacktestTradesInput {
  trades?: readonly BacktestTradeInput[];
  nextPageToken?: string;
  total?: number;
}

// ---------------------------------------------------------------------------
// Views (camelCase; nulls where a figure is not measured)
// ---------------------------------------------------------------------------

/** The states of a run or an evidence read. Anything else is "unavailable". */
export type BacktestState =
  | "published"
  | "approximate"
  | "run_required"
  | "running"
  | "not_computable"
  | "unavailable";

/** The window ids of 5.8, as the API names them. */
export type BacktestWindowId = "since_2019_05" | "since_2023" | "trailing_12m" | "live";

/**
 * A period's state. The API serves complete | partial | to_date; a period that has not
 * elapsed, or that falls before the window, is absent from the table and the page
 * derives its words (see backtest-tables.ts).
 */
export type PeriodState = "complete" | "partial" | "to_date" | "unknown";

export type CoverageMeasure = "qualifying_5pct_short" | "all_reported" | "not_measurable" | "";

export interface BacktestWindowView {
  window: string;
  label: string;
  note: string;
  from: string;
  to: string;
  /** Null when the API does not state it (has_total_return false). */
  totalReturnPct: number | null;
  /** Null unless the window is at least 365 calendar days (has_cagr). */
  cagrPct: number | null;
  notAnnualised: boolean;
  benchmarkCagrPct: number | null;
  referenceCagrPct: number | null;
  /** The last session the reference is measured to: its figures cover the overlap ending here; null when none. */
  referenceTo: string | null;
  /** XJT and the reference over the window, total return, shown for every window. */
  benchmarkTotalReturnPct: number | null;
  referenceTotalReturnPct: number | null;
  maxDrawdownPct: number;
  peakDate: string | null;
  troughDate: string | null;
  /** A session, "not recovered", or null when the curve never fell. */
  recoveryDate: string | null;
  sharpe: number | null;
  sharpeSe: number | null;
  closedTrades: number;
  winRatePct: number | null;
  exposurePct: number;
  recordedTail: boolean;
  sessions: number;
  calendarDays: number;
  volatilityPct: number | null;
}

export interface AnnualReturnView {
  year: number;
  state: PeriodState;
  /** "May-Dec" for a partial first year, "YTD" for the current one; "" for a whole year. */
  months: string;
  strategyPct: number | null;
  benchmarkPct: number | null;
  referencePct: number | null;
  coveragePct: number | null;
  coverageMeasurable: boolean;
  coverageMeasure: CoverageMeasure;
  approximate: boolean;
}

export interface MonthlyReturnView {
  year: number;
  month: number;
  state: PeriodState;
  strategyPct: number | null;
  benchmarkPct: number | null;
  referencePct: number | null;
  /** "from 1 May" for the first month, "MTD" for the current one; "" otherwise. */
  label: string;
}

export interface CoverageYearView {
  year: number;
  /**
   * The year is measurable under the run's measure: the qualifying measure has name-days in it, or
   * (an all-reported run) its annual row says so. False reads "not measurable".
   */
  measurable: boolean;
  /** Qualifying coverage, in percent. Null when not measurable. */
  coveragePct: number | null;
  qualifyingNameDays: number;
  pricedNameDays: number;
  allReportedPct: number | null;
  allReportedMeasurable: boolean;
  allReportedNameDays: number;
  allReportedPricedNameDays: number;
  delistingExits: number;
  caExits: number;
}

export interface CoverageMonthView {
  /** YYYY-MM. */
  month: string;
  coveragePct: number | null;
  measurable: boolean;
  allReportedPct: number | null;
  allReportedMeasurable: boolean;
}

export interface SurvivorshipView {
  /** measured | partial | not_measurable. */
  measurement: string;
  direction: string;
  statement: string;
  caveat: string;
}

export interface SensitivityView {
  id: string;
  label: string;
  applies: boolean;
  reason: string;
  cagrPct: number | null;
  excessVsBenchmarkPct: number | null;
  maxDrawdownPct: number;
  fragile: boolean;
  fragileChip: string;
}

export interface SeriesPointView {
  /** YYYY-MM-DD. */
  date: string;
  /** A$ on the chained curve, whole dollars. */
  equity: number;
  /** Index level, or null when not measured. */
  benchmark: number | null;
  reference: number | null;
  /** Negative or zero, in percent. */
  drawdownPct: number;
  exposurePct: number;
  recorded: boolean;
}

export interface RecipeLinesView {
  recipeId: string;
  preface: string;
  entry: string;
  exits: string[];
  sizing: string;
  brokerage: string;
  spread: string;
  capacity: string;
  dividends: string;
  asicData: string;
  delisting: string;
  capital: string;
  cash: string;
}

export interface TradeSummaryView {
  closed: number;
  openAtEnd: number;
  winRatePct: number | null;
  avgHoldSessions: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  exitsByReason: Record<string, number>;
}

export interface BacktestTradeView {
  seq: number;
  stockCode: string;
  companyName: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number | null;
  capturedPivot: number | null;
  entryScore: number | null;
  exitSignalDate: string;
  exitDate: string;
  exitPrice: number | null;
  exitReason: string;
  sessionsHeld: number;
  grossReturnPct: number | null;
  netReturnPct: number | null;
  flags: string[];
  open: boolean;
}

export interface EngineSegmentView {
  engineVersion: string;
  firstSession: string;
  lastSession: string;
  sessions: number;
}

export interface PaperTrackView {
  since: string;
  sessions: number;
  closedTrades: number;
  openPositions: number;
  returnPct: number | null;
  tooShort: boolean;
  /** The track's first recorded session: the freeze the recorded band starts at. */
  recordedFrom: string;
  engineSegments: EngineSegmentView[];
}

export interface DataQualityView {
  delistingExits: number;
  corporateActionExits: number;
  caSuspects: number;
  fallbackClose: number;
  priceReturnTrades: number;
  capacityCapped: number;
  staleMarkTrades: number;
  delayedExits: number;
  cancelledEntries: Record<string, number>;
  dividendsCredited: number;
  consolidationNote: string;
}

export interface BacktestIdentityView {
  runId: number;
  runKey: string;
  kind: string;
  version: StrategyVersionDef | null;
  recipeId: string;
  recipeHash: string;
  engineVersion: string;
  windowStart: string;
  windowEnd: string;
  returns: string;
  benchmark: string;
  fundamentals: string;
  pricesThrough: string;
  asicReportThrough: string;
  inSampleUntil: string;
  finishedAt: string;
  inputHash: string;
  outputHash: string;
  buildRevision: string;
  riskFree: string;
  referenceName: string;
  runDate: string;
}

export interface BacktestRunView {
  state: BacktestState;
  stateReason: string;
  strategyId: string;
  computableFrom: string | null;
  fiscalLabel: string | null;
  identity: BacktestIdentityView | null;
  windows: BacktestWindowView[];
  annual: AnnualReturnView[];
  monthly: MonthlyReturnView[];
  /** The served window's points, daily or weekly, as `seriesResolution` says. */
  series: SeriesPointView[];
  windowId: string;
  seriesResolution: string;
  coverageByYear: CoverageYearView[];
  coverageMonthly: CoverageMonthView[];
  survivorship: SurvivorshipView | null;
  sensitivity: SensitivityView[];
  recipe: RecipeLinesView | null;
  tradeSummary: TradeSummaryView | null;
  dataQuality: DataQualityView | null;
  liveVersion: StrategyVersionDef | null;
  rulesMatchLive: boolean;
  engineMatchesLive: boolean;
  replayAgreement: string;
  inputChangeNote: string;
  disclosures: string[];
  dataNotes: string[];
  runningSince: string;
  computableSharePct: number | null;
  fundamentalsLabel: string;
  /** The paper track's first recorded session: where the recorded band starts. "" when none. */
  paperStart: string;
  paperEngineSegments: EngineSegmentView[];
}

export interface StrategyEvidenceView {
  strategyId: string;
  version: StrategyVersionDef | null;
  state: BacktestState;
  stateReason: string;
  computableFrom: string | null;
  fiscalLabel: string | null;
  windows: BacktestWindowView[];
  annual: AnnualReturnView[];
  miniCurve: SeriesPointView[];
  paper: PaperTrackView | null;
  survivorship: string;
  runId: number;
  latestScreen: string | null;
  runningSince: string;
  computableSharePct: number | null;
  /** Today's status counts for the live version; null when they cannot be read. */
  today: StatusCountsView | null;
  /** asic_reported | asx_ordinary; "" when the API names none. */
  universeKind: UniverseKind | "";
}

/** The two universes a live version can screen (the contract's universe_kind). */
export type UniverseKind = "asic_reported" | "asx_ordinary";

export function toUniverseKind(value: unknown): UniverseKind | "" {
  return value === "asic_reported" || value === "asx_ordinary" ? value : "";
}

export interface StatusCountsView {
  triggered: number;
  setup: number;
  watch: number;
  unknown: number;
}

export interface StrategyEvidenceListView {
  strategies: StrategyEvidenceView[];
  windowStart: string;
  pricesThrough: string;
  benchmarkName: string;
  footnotes: string[];
}

export interface BacktestTradesPageView {
  trades: BacktestTradeView[];
  nextPageToken: string;
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A finite number, or null: NaN, Infinity, the strings "NaN" and absent values are all null. */
function numOrNull(value: unknown): number | null {
  // protobuf-es decodes int64 fields to bigint: a count of name-days is a number to the page.
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A finite number, or 0 when absent (a proto3 default). */
function num(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return numOrNull(value) ?? 0;
}

/** A finite positive number, or null: an index level of zero is "not measured". */
function positiveOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/** A figure read only when its has_* flag is set. */
function flagged(value: unknown, has: boolean | undefined): number | null {
  return has === true ? numOrNull(value) : null;
}

function int(value: unknown): number {
  const n = numOrNull(value);
  return n === null ? 0 : Math.trunc(n);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A YYYY-MM-DD prefix, or "". */
function ymd(value: unknown): string {
  const text = str(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function strings(value: readonly unknown[] | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function runIdOf(value: WireInt64 | undefined): number {
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** A recovery date: a session, the words "not recovered", or null when the field is empty. */
function recoveryOf(value: unknown): string | null {
  const text = str(value).trim();
  if (text === "") return null;
  return ymd(text) || text;
}

const KNOWN_STATES: readonly BacktestState[] = [
  "published",
  "approximate",
  "run_required",
  "running",
  "not_computable",
];

/** A state the page knows; anything else is "unavailable", never a guessed state. */
export function toBacktestState(value: unknown): BacktestState {
  return KNOWN_STATES.find((s) => s === value) ?? "unavailable";
}

function toPeriodState(value: unknown): PeriodState {
  return value === "complete" || value === "partial" || value === "to_date"
    ? value
    : "unknown";
}

const KNOWN_MEASURES: readonly CoverageMeasure[] = [
  "qualifying_5pct_short",
  "all_reported",
  "not_measurable",
];

function toCoverageMeasure(value: unknown): CoverageMeasure {
  return KNOWN_MEASURES.find((m) => m === value) ?? "";
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapWindowMetrics(input: WindowMetricsInput): BacktestWindowView {
  return {
    window: str(input.window),
    label: str(input.label),
    note: str(input.note),
    from: ymd(input.from),
    to: ymd(input.to),
    totalReturnPct: flagged(input.totalReturnPct, input.hasTotalReturn),
    cagrPct: flagged(input.cagrPct, input.hasCagr),
    notAnnualised: input.notAnnualised === true,
    benchmarkCagrPct: flagged(input.benchmarkCagrPct, input.hasBenchmark),
    referenceCagrPct: flagged(input.referenceCagrPct, input.hasReference),
    benchmarkTotalReturnPct: flagged(input.benchmarkTotalReturnPct, input.hasBenchmarkTotalReturn),
    referenceTotalReturnPct: flagged(input.referenceTotalReturnPct, input.hasReferenceTotalReturn),
    referenceTo: ymd(input.referenceTo) || null,
    maxDrawdownPct: num(input.maxDrawdownPct),
    peakDate: ymd(input.peakDate) || null,
    troughDate: ymd(input.troughDate) || null,
    recoveryDate: recoveryOf(input.recoveryDate),
    sharpe: flagged(input.sharpe, input.hasSharpe),
    sharpeSe: flagged(input.sharpeSe, input.hasSharpe),
    closedTrades: int(input.closedTrades),
    winRatePct: flagged(input.winRatePct, input.hasWinRate),
    exposurePct: num(input.exposurePct),
    recordedTail: input.recordedTail === true,
    sessions: int(input.sessions),
    calendarDays: int(input.calendarDays),
    volatilityPct: flagged(input.volatilityPct, input.hasVolatility),
  };
}

export function mapAnnualReturn(input: AnnualReturnInput): AnnualReturnView {
  const state = toPeriodState(input.state);
  return {
    year: int(input.year),
    state,
    months: str(input.months),
    strategyPct: numOrNull(input.strategyPct),
    benchmarkPct: flagged(input.benchmarkPct, input.hasBenchmark),
    referencePct: flagged(input.referencePct, input.hasReference),
    coveragePct: input.coverageMeasurable === true ? numOrNull(input.coveragePct) : null,
    coverageMeasurable: input.coverageMeasurable === true,
    coverageMeasure: toCoverageMeasure(input.coverageMeasure),
    approximate: input.approximate === true,
  };
}

export function mapMonthlyReturn(input: MonthlyReturnInput): MonthlyReturnView {
  return {
    year: int(input.year),
    month: int(input.month),
    state: toPeriodState(input.state),
    strategyPct: numOrNull(input.strategyPct),
    benchmarkPct: flagged(input.benchmarkPct, input.hasBenchmark),
    referencePct: flagged(input.referencePct, input.hasReference),
    label: str(input.label),
  };
}

export function mapCoverageYear(input: CoverageYearInput): CoverageYearView {
  const measurable = input.measurable === true;
  const allMeasurable = input.allReportedMeasurable === true;
  return {
    year: int(input.year),
    measurable,
    coveragePct: measurable ? numOrNull(input.coveragePct) : null,
    qualifyingNameDays: int(input.qualifyingNameDays),
    pricedNameDays: int(input.pricedNameDays),
    allReportedPct: allMeasurable ? numOrNull(input.allReportedPct) : null,
    allReportedMeasurable: allMeasurable,
    allReportedNameDays: int(input.allReportedNameDays),
    allReportedPricedNameDays: int(input.allReportedPricedNameDays),
    delistingExits: int(input.delistingExits),
    caExits: int(input.caExits),
  };
}

export function mapCoverageMonth(input: CoverageMonthInput): CoverageMonthView {
  const measurable = input.measurable === true;
  const allMeasurable = input.allReportedMeasurable === true;
  return {
    month: /^\d{4}-\d{2}$/.test(str(input.month)) ? str(input.month) : "",
    coveragePct: measurable ? numOrNull(input.coveragePct) : null,
    measurable,
    allReportedPct: allMeasurable ? numOrNull(input.allReportedPct) : null,
    allReportedMeasurable: allMeasurable,
  };
}

export function mapSurvivorship(input: SurvivorshipInput): SurvivorshipView {
  return {
    measurement: str(input.measurement),
    direction: str(input.direction),
    statement: str(input.statement),
    caveat: str(input.caveat),
  };
}

export function mapSensitivity(input: SensitivityInput): SensitivityView {
  return {
    id: str(input.id),
    label: str(input.label),
    applies: input.applies === true,
    reason: str(input.reason),
    cagrPct: flagged(input.cagrPct, input.hasCagr),
    excessVsBenchmarkPct: flagged(input.excessVsBenchmarkPct, input.hasExcess),
    maxDrawdownPct: num(input.maxDrawdownPct),
    fragile: input.fragile === true,
    fragileChip: str(input.fragileChip),
  };
}

export function mapSeriesPoint(input: SeriesPointInput): SeriesPointView {
  return {
    date: ymd(input.date),
    equity: num(input.equity),
    benchmark: positiveOrNull(input.benchmark),
    reference: positiveOrNull(input.reference),
    drawdownPct: num(input.drawdownPct),
    exposurePct: num(input.exposurePct),
    recorded: input.recorded === true,
  };
}

export function mapRecipeLines(input: RecipeLinesInput): RecipeLinesView {
  return {
    recipeId: str(input.recipeId),
    preface: str(input.preface),
    entry: str(input.entry),
    exits: strings(input.exits),
    sizing: str(input.sizing),
    brokerage: str(input.brokerage),
    spread: str(input.spread),
    capacity: str(input.capacity),
    dividends: str(input.dividends),
    asicData: str(input.asicData),
    delisting: str(input.delisting),
    capital: str(input.capital),
    cash: str(input.cash),
  };
}

export function mapTradeSummary(input: TradeSummaryInput): TradeSummaryView {
  const exits: Record<string, number> = {};
  for (const [reason, count] of Object.entries(input.exitsByReason ?? {})) {
    exits[reason] = int(count);
  }
  return {
    closed: int(input.closed),
    openAtEnd: int(input.openAtEnd),
    winRatePct: flagged(input.winRatePct, input.hasWinRate),
    avgHoldSessions: flagged(input.avgHoldSessions, input.hasAvgHold),
    avgWinPct: flagged(input.avgWinPct, input.hasAvgWin),
    avgLossPct: flagged(input.avgLossPct, input.hasAvgLoss),
    bestPct: flagged(input.bestPct, input.hasBest),
    worstPct: flagged(input.worstPct, input.hasWorst),
    exitsByReason: exits,
  };
}

export function mapBacktestTrade(input: BacktestTradeInput): BacktestTradeView {
  return {
    seq: int(input.seq),
    stockCode: str(input.stockCode),
    companyName: str(input.companyName),
    signalDate: ymd(input.signalDate),
    entryDate: ymd(input.entryDate),
    entryPrice: positiveOrNull(input.entryPrice),
    capturedPivot: flagged(input.capturedPivot, input.hasCapturedPivot),
    entryScore: numOrNull(input.entryScore),
    exitSignalDate: ymd(input.exitSignalDate),
    exitDate: ymd(input.exitDate),
    exitPrice: positiveOrNull(input.exitPrice),
    exitReason: str(input.exitReason),
    sessionsHeld: int(input.sessionsHeld),
    grossReturnPct: numOrNull(input.grossReturnPct),
    netReturnPct: numOrNull(input.netReturnPct),
    flags: strings(input.flags),
    open: input.open === true,
  };
}

export function mapEngineSegment(input: EngineSegmentInput): EngineSegmentView {
  return {
    engineVersion: str(input.engineVersion),
    firstSession: ymd(input.firstSession),
    lastSession: ymd(input.lastSession),
    sessions: int(input.sessions),
  };
}

export function mapPaperTrack(input: PaperTrackInput): PaperTrackView {
  return {
    since: ymd(input.since),
    sessions: int(input.sessions),
    closedTrades: int(input.closedTrades),
    openPositions: int(input.openPositions),
    returnPct: flagged(input.returnPct, input.hasReturn),
    tooShort: input.tooShort === true,
    recordedFrom: ymd(input.recordedFrom),
    engineSegments: (input.engineSegments ?? []).map(mapEngineSegment),
  };
}

export function mapDataQuality(input: DataQualityInput): DataQualityView {
  const cancelled: Record<string, number> = {};
  for (const [reason, count] of Object.entries(input.cancelledEntries ?? {})) {
    cancelled[reason] = int(count);
  }
  return {
    delistingExits: int(input.delistingExits),
    corporateActionExits: int(input.corporateActionExits),
    caSuspects: int(input.caSuspects),
    fallbackClose: int(input.fallbackClose),
    priceReturnTrades: int(input.priceReturnTrades),
    capacityCapped: int(input.capacityCapped),
    staleMarkTrades: int(input.staleMarkTrades),
    delayedExits: int(input.delayedExits),
    cancelledEntries: cancelled,
    dividendsCredited: int(input.dividendsCredited),
    consolidationNote: str(input.consolidationNote),
  };
}

function mapIdentity(input: BacktestIdentityInput): BacktestIdentityView {
  return {
    runId: runIdOf(input.runId),
    runKey: str(input.runKey),
    kind: str(input.kind),
    version: mapStrategyVersion(input.version),
    recipeId: str(input.recipeId),
    recipeHash: str(input.recipeHash),
    engineVersion: str(input.engineVersion),
    windowStart: ymd(input.windowStart),
    windowEnd: ymd(input.windowEnd),
    returns: str(input.returns),
    benchmark: str(input.benchmark),
    fundamentals: str(input.fundamentals),
    pricesThrough: ymd(input.pricesThrough),
    asicReportThrough: ymd(input.asicReportThrough),
    inSampleUntil: ymd(input.inSampleUntil),
    finishedAt: str(input.finishedAt),
    inputHash: str(input.inputHash),
    outputHash: str(input.outputHash),
    buildRevision: str(input.buildRevision),
    riskFree: str(input.riskFree),
    referenceName: str(input.referenceName),
    runDate: ymd(input.runDate),
  };
}

/** One canonical run as the page draws it. A run with no series still maps; the page decides what to show. */
/**
 * The per-year coverage with the annual table's boundary applied. The annual rows state which
 * measure each year uses: a year whose annual coverage_measure is not_measurable has no measurable
 * qualifying figure, whatever the coverage row's flag says (a partial run's pre-2025 years). The
 * annual rows are the authority for that boundary; the coverage rows' flags are not trusted for it.
 */
export function coverageWithAnnualBoundary(
  coverage: readonly CoverageYearInput[],
  annual: readonly AnnualReturnInput[],
): CoverageYearView[] {
  const notMeasurable = new Set(
    annual.filter((row) => row.coverageMeasure === "not_measurable").map((row) => int(row.year)),
  );
  // An all-reported run's annual row says the year is measurable under its own measure. The
  // qualifying flag on a coverage row is then unset, so the annual row supplies the boundary.
  const measuredAllReported = new Set(
    annual
      .filter((row) => row.coverageMeasurable === true && row.coverageMeasure === "all_reported")
      .map((row) => int(row.year)),
  );
  return coverage.map((row) => {
    const mapped = mapCoverageYear(row);
    if (notMeasurable.has(mapped.year)) return { ...mapped, measurable: false, coveragePct: null };
    if (measuredAllReported.has(mapped.year) && !mapped.measurable) return { ...mapped, measurable: true };
    return mapped;
  });
}

export function mapBacktestRun(input: BacktestRunInput): BacktestRunView {
  return {
    state: toBacktestState(input.state),
    stateReason: str(input.stateReason),
    strategyId: str(input.strategyId),
    computableFrom: ymd(input.computableFrom) || null,
    fiscalLabel: str(input.fiscalLabel) || null,
    identity: input.identity ? mapIdentity(input.identity) : null,
    windows: (input.windows ?? []).map(mapWindowMetrics),
    annual: (input.annual ?? []).map(mapAnnualReturn),
    monthly: (input.monthly ?? []).map(mapMonthlyReturn),
    series: (input.series ?? []).map(mapSeriesPoint),
    windowId: str(input.windowId),
    seriesResolution: str(input.seriesResolution) || "weekly",
    coverageByYear: coverageWithAnnualBoundary(input.coverage ?? [], input.annual ?? []),
    coverageMonthly: (input.coverageMonthly ?? []).map(mapCoverageMonth),
    survivorship: input.survivorship ? mapSurvivorship(input.survivorship) : null,
    sensitivity: (input.sensitivity ?? []).map(mapSensitivity),
    recipe: input.recipe ? mapRecipeLines(input.recipe) : null,
    tradeSummary: input.tradeSummary ? mapTradeSummary(input.tradeSummary) : null,
    dataQuality: input.dataQuality ? mapDataQuality(input.dataQuality) : null,
    liveVersion: mapStrategyVersion(input.liveVersion),
    rulesMatchLive: input.rulesMatchLive === true,
    engineMatchesLive: input.engineMatchesLive === true,
    replayAgreement: str(input.replayAgreement),
    inputChangeNote: str(input.inputChangeNote),
    disclosures: strings(input.disclosures),
    dataNotes: strings(input.dataNotes),
    runningSince: str(input.runningSince),
    computableSharePct: flagged(input.computableSharePct, input.hasComputableShare),
    fundamentalsLabel: str(input.fundamentalsLabel),
    paperStart: ymd(input.paperStart),
    paperEngineSegments: (input.paperEngineSegments ?? []).map(mapEngineSegment),
  };
}

export function mapStrategyEvidence(input: StrategyEvidenceInput): StrategyEvidenceView {
  return {
    strategyId: str(input.strategyId),
    version: mapStrategyVersion(input.version),
    state: toBacktestState(input.state),
    stateReason: str(input.stateReason),
    computableFrom: ymd(input.computableFrom) || null,
    fiscalLabel: str(input.fiscalLabel) || null,
    windows: (input.windows ?? []).map(mapWindowMetrics),
    annual: (input.annual ?? []).map(mapAnnualReturn),
    miniCurve: (input.miniCurve ?? []).map(mapSeriesPoint),
    paper: input.paper ? mapPaperTrack(input.paper) : null,
    survivorship: str(input.survivorship),
    runId: runIdOf(input.runId),
    latestScreen: ymd(input.latestScreen) || null,
    runningSince: str(input.runningSince),
    computableSharePct: flagged(input.computableSharePct, input.hasComputableShare),
    today: mapStatusCounts(input.today),
    universeKind: toUniverseKind(input.universeKind),
  };
}

function mapStatusCounts(input: StatusCountsInput | null | undefined): StatusCountsView | null {
  if (!input) return null;
  return {
    triggered: int(input.triggered),
    setup: int(input.setup),
    watch: int(input.watch),
    unknown: int(input.unknown),
  };
}

export function mapStrategyEvidenceList(
  input: ListStrategyEvidenceInput,
): StrategyEvidenceListView {
  return {
    strategies: (input.strategies ?? []).map(mapStrategyEvidence),
    windowStart: ymd(input.windowStart),
    pricesThrough: ymd(input.pricesThrough),
    benchmarkName: str(input.benchmarkName),
    footnotes: strings(input.footnotes),
  };
}

export function mapBacktestTradesPage(
  input: ListBacktestTradesInput,
): BacktestTradesPageView {
  return {
    trades: (input.trades ?? []).map(mapBacktestTrade),
    nextPageToken: str(input.nextPageToken),
    total: int(input.total),
  };
}

// ---------------------------------------------------------------------------
// Compare (CompareStrategies, signed-in): the compare page reads these.
// ---------------------------------------------------------------------------

export interface CompareStrategiesInput {
  windowId?: string;
  windowFrom?: string;
  windowTo?: string;
  entries?: ReadonlyArray<{
    strategyRef?: string;
    strategyId?: string;
    name?: string;
    state?: string;
    stateReason?: string;
    version?: StrategyVersionInput | null;
    window?: WindowMetricsInput | null;
    series?: readonly SeriesPointInput[];
  }>;
  ruleDiffs?: ReadonlyArray<{ a?: string; b?: string; field?: string; aValue?: string; bValue?: string }>;
  correlations?: ReadonlyArray<{ a?: string; b?: string; correlation?: WireDouble; hasCorrelation?: boolean; days?: number }>;
}

export interface RuleDiffView {
  a: string;
  b: string;
  field: string;
  aValue: string;
  bValue: string;
}

export interface CompareEntryView {
  strategyRef: string;
  strategyId: string;
  name: string;
  state: string;
  stateReason: string;
  version: StrategyVersionDef | null;
  window: BacktestWindowView | null;
  series: SeriesPointView[];
}

export interface StrategyCorrelationView {
  a: string;
  b: string;
  correlation: number | null;
  days: number;
}

export interface CompareStrategiesView {
  windowId: string;
  windowFrom: string;
  windowTo: string;
  entries: CompareEntryView[];
  ruleDiffs: RuleDiffView[];
  correlations: StrategyCorrelationView[];
}

export function mapCompareStrategies(input: CompareStrategiesInput): CompareStrategiesView {
  return {
    windowId: str(input.windowId),
    windowFrom: ymd(input.windowFrom),
    windowTo: ymd(input.windowTo),
    entries: (input.entries ?? []).map((entry) => ({
      strategyRef: str(entry.strategyRef),
      strategyId: str(entry.strategyId),
      name: str(entry.name),
      state: str(entry.state),
      stateReason: str(entry.stateReason),
      version: mapStrategyVersion(entry.version),
      window: entry.window ? mapWindowMetrics(entry.window) : null,
      series: (entry.series ?? []).map(mapSeriesPoint),
    })),
    ruleDiffs: (input.ruleDiffs ?? []).map((d) => ({
      a: str(d.a),
      b: str(d.b),
      field: str(d.field),
      aValue: str(d.aValue),
      bValue: str(d.bValue),
    })),
    correlations: (input.correlations ?? []).map((pair) => ({
      a: str(pair.a),
      b: str(pair.b),
      correlation: pair.hasCorrelation === true ? numOrNull(pair.correlation) : null,
      days: int(pair.days),
    })),
  };
}
