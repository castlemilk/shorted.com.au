// StrategyService's backtest reads -> plain rows (ListStrategyEvidence,
// GetBacktestRun, ListBacktestTrades).
//
// THE ONE PLACE the backtest's proto names live. Like map.ts, this file imports
// nothing from the generated modules: its input types are structural, all
// optional and JSON-compatible, so a protobuf-es message satisfies them and so
// does Connect's JSON. Every component, page and test below this file reads the
// camelCase view types it exports, so a change to the API's field names (the
// rebase onto the PR-18 revision, design 8.2) touches this file and nothing else.
//
// Vocabulary follows design 8.2: run and evidence states `published`,
// `approximate`, `run_required`, `running`, `not_computable` (plus `state_reason`
// on a run); window ids `since_2019_05`, `since_2023`, `trailing_12m`, `live`;
// survivorship measurement `measured`, `partial`, `not_measurable`; annual and
// monthly states `complete`, `partial`, `current` (the MTD or YTD period),
// `not_elapsed`, `before_window`, `not_computable`, `run_required`.
//
// Where the PR-18 head names a field differently, the input accepts that name
// as a fallback (marked FALLBACK below); the rebase removes it.
//
// The one place proto3's "0 means missing" is resolved: a figure with a has_*
// flag is null unless the flag is set (a measured zero survives); a benchmark or
// reference level of zero is "not measured" (the reference is not recorded after
// the freeze); a non-finite double (the JSON string "NaN") is never a number.

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
  /** since_2019_05 | since_2023 | trailing_12m | live. */
  window?: string;
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
  maxDrawdownPct?: WireDouble;
  /** The session the peak was set on, the trough, and the recovery ("" when not recovered). */
  drawdownPeak?: string;
  drawdownTrough?: string;
  drawdownRecovery?: string;
  sharpe?: WireDouble;
  sharpeSe?: WireDouble;
  hasSharpe?: boolean;
  closedTrades?: number;
  winRatePct?: WireDouble;
  hasWinRate?: boolean;
  exposurePct?: WireDouble;
  recordedTail?: boolean;
  label?: string;
  note?: string;
  notAnnualised?: boolean;
  sessions?: number;
  calendarDays?: number;
  volatilityPct?: WireDouble;
  hasVolatility?: boolean;
}

export interface AnnualReturnInput {
  year?: number;
  state?: string;
  months?: string;
  strategyPct?: WireDouble;
  benchmarkPct?: WireDouble;
  hasBenchmark?: boolean;
  referencePct?: WireDouble;
  hasReference?: boolean;
  coveragePct?: WireDouble;
  coverageMeasurable?: boolean;
  /** The measure the coverage figure names: "qualifying" (>= 5% short) or "all_reported". */
  coverageMeasure?: string;
  approximate?: boolean;
}

export interface MonthlyReturnInput {
  year?: number;
  month?: number;
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
  /** Coverage on the qualifying measure, its name-days and the priced ones. */
  measurable?: boolean;
  coveragePct?: WireDouble;
  hasCoverage?: boolean;
  qualifyingNameDays?: WireDouble;
  pricedNameDays?: WireDouble;
  allReportedPct?: WireDouble;
  hasAllReported?: boolean;
  delistingExits?: number;
  caExits?: number;
  flatBarCancels?: number;
  dividendStepSuspects?: number;
  /** FALLBACK (PR-18 head names): qualifying_pct and friends. */
  qualifyingPct?: WireDouble;
  hasQualifying?: boolean;
  qualifyingPriced?: number;
  allReportedPriced?: number;
}

export interface CoverageMonthInput {
  month?: string;
  coveragePct?: WireDouble;
  hasCoverage?: boolean;
  measurable?: boolean;
  /** FALLBACK (PR-18 head names). */
  qualifyingPct?: WireDouble;
  hasQualifying?: boolean;
  allReportedPct?: WireDouble;
  hasAllReported?: boolean;
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
  applies?: boolean;
  reason?: string;
  cagrPct?: WireDouble;
  hasCagr?: boolean;
  excessVsBenchmarkPct?: WireDouble;
  hasExcess?: boolean;
  maxDrawdownPct?: WireDouble;
  fragile?: boolean;
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
  avgWinPct?: WireDouble;
  avgLossPct?: WireDouble;
  bestPct?: WireDouble;
  worstPct?: WireDouble;
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

export interface PaperTrackInput {
  since?: string;
  sessions?: number;
  closedTrades?: number;
  openPositions?: number;
  returnPct?: WireDouble;
  hasReturn?: boolean;
  tooShort?: boolean;
}

export interface StrategyEvidenceInput {
  strategyId?: string;
  version?: StrategyVersionInput | null;
  state?: string;
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

export interface BacktestRunInput {
  state?: string;
  /** Why the run is in this state, in words the page prints (run_required, not_computable). */
  stateReason?: string;
  strategyId?: string;
  computableFrom?: string;
  fiscalLabel?: string;
  identity?: BacktestIdentityInput | null;
  windows?: readonly WindowMetricsInput[];
  annual?: readonly AnnualReturnInput[];
  monthly?: readonly MonthlyReturnInput[];
  series?: readonly SeriesPointInput[];
  /** FALLBACK (PR-18 head name): coverageByYear. */
  coverage?: readonly CoverageYearInput[];
  coverageByYear?: readonly CoverageYearInput[];
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
// Views (camelCase, nulls where a figure is not measured)
// ---------------------------------------------------------------------------

/** The states of a run or an evidence read (8.2). Anything else is "unavailable". */
export type BacktestState =
  | "published"
  | "approximate"
  | "run_required"
  | "running"
  | "not_computable"
  | "unavailable";

/** The window ids of 5.8, as 8.2 names them. */
export type BacktestWindowId = "since_2019_05" | "since_2023" | "trailing_12m" | "live";

/** The states an annual or monthly period can be in. */
export type PeriodState =
  | "complete"
  | "partial"
  | "current"
  | "not_elapsed"
  | "before_window"
  | "not_computable"
  | "run_required"
  | "unknown";

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
  maxDrawdownPct: number;
  drawdownPeak: string | null;
  drawdownTrough: string | null;
  /** Null when the drawdown has not recovered. */
  drawdownRecovery: string | null;
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
  /** "May-Dec" from the window start, "YTD" for the current year, "" for a whole year. */
  months: string;
  strategyPct: number | null;
  benchmarkPct: number | null;
  referencePct: number | null;
  coveragePct: number | null;
  coverageMeasurable: boolean;
  /** "qualifying" (>= 5% short) or "all_reported"; "" when the API states none. */
  coverageMeasure: string;
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

export interface CoverageDataQualityView {
  delistingExits: number;
  caExits: number;
  flatBarCancels: number;
  dividendStepSuspects: number;
}

export interface CoverageYearView {
  year: number;
  /** Measurable on the qualifying measure; false (Minervini before 2025) reads "not measurable". */
  measurable: boolean;
  /** Priced over qualifying name-days ("qualifying >= 5% short"). */
  coveragePct: number | null;
  qualifyingNameDays: number;
  pricedNameDays: number;
  /** Priced over every ordinary reported name-day ("all reported"). */
  allReportedPct: number | null;
  dataQuality: CoverageDataQualityView;
}

export interface CoverageMonthView {
  /** YYYY-MM. */
  month: string;
  coveragePct: number | null;
  measurable: boolean;
  allReportedPct: number | null;
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
  /** A$ on the chained curve. */
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

export interface PaperTrackView {
  since: string;
  sessions: number;
  closedTrades: number;
  openPositions: number;
  returnPct: number | null;
  tooShort: boolean;
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
  series: SeriesPointView[];
  coverageByYear: CoverageYearView[];
  coverageMonthly: CoverageMonthView[];
  survivorship: SurvivorshipView | null;
  sensitivity: SensitivityView[];
  recipe: RecipeLinesView | null;
  tradeSummary: TradeSummaryView | null;
  liveVersion: StrategyVersionDef | null;
  rulesMatchLive: boolean;
  engineMatchesLive: boolean;
  replayAgreement: string;
  inputChangeNote: string;
  disclosures: string[];
  dataNotes: string[];
  runningSince: string;
  /** "weekly" or "daily": what the series carries. */
  seriesResolution: string;
  computableSharePct: number | null;
}

export interface StrategyEvidenceView {
  strategyId: string;
  version: StrategyVersionDef | null;
  state: BacktestState;
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

const KNOWN_PERIOD_STATES: readonly PeriodState[] = [
  "complete",
  "partial",
  "current",
  "not_elapsed",
  "before_window",
  "not_computable",
  "run_required",
];

function toPeriodState(value: unknown): PeriodState {
  return KNOWN_PERIOD_STATES.find((s) => s === value) ?? "unknown";
}

/** A period's own figures are read only when the period was measured (complete, partial or current). */
function measuredPeriod(state: PeriodState): boolean {
  return state === "complete" || state === "partial" || state === "current";
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapWindowMetrics(input: WindowMetricsInput): BacktestWindowView {
  const recovery = ymd(input.drawdownRecovery);
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
    maxDrawdownPct: num(input.maxDrawdownPct),
    drawdownPeak: ymd(input.drawdownPeak) || null,
    drawdownTrough: ymd(input.drawdownTrough) || null,
    drawdownRecovery: recovery || null,
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
  const measured = measuredPeriod(state);
  return {
    year: int(input.year),
    state,
    months: str(input.months),
    strategyPct: measured ? numOrNull(input.strategyPct) : null,
    benchmarkPct: measured ? flagged(input.benchmarkPct, input.hasBenchmark) : null,
    referencePct: measured ? flagged(input.referencePct, input.hasReference) : null,
    coveragePct: input.coverageMeasurable === true ? numOrNull(input.coveragePct) : null,
    coverageMeasurable: input.coverageMeasurable === true,
    coverageMeasure: str(input.coverageMeasure),
    approximate: input.approximate === true,
  };
}

export function mapMonthlyReturn(input: MonthlyReturnInput): MonthlyReturnView {
  const state = toPeriodState(input.state);
  const measured = measuredPeriod(state);
  return {
    year: int(input.year),
    month: int(input.month),
    state,
    strategyPct: measured ? numOrNull(input.strategyPct) : null,
    benchmarkPct: measured ? flagged(input.benchmarkPct, input.hasBenchmark) : null,
    referencePct: measured ? flagged(input.referencePct, input.hasReference) : null,
    label: str(input.label),
  };
}

export function mapCoverageYear(input: CoverageYearInput): CoverageYearView {
  // FALLBACK (PR-18 head): the flag-style names, read only where the 8.2 names are absent.
  const measurable =
    input.measurable !== undefined ? input.measurable === true : input.hasQualifying === true;
  const coverage =
    input.coveragePct !== undefined || input.hasCoverage !== undefined
      ? flagged(input.coveragePct, input.hasCoverage ?? true)
      : flagged(input.qualifyingPct, input.hasQualifying);
  return {
    year: int(input.year),
    measurable,
    coveragePct: measurable ? coverage : null,
    qualifyingNameDays: int(input.qualifyingNameDays),
    pricedNameDays: int(input.pricedNameDays ?? input.qualifyingPriced),
    allReportedPct: flagged(input.allReportedPct, input.hasAllReported),
    dataQuality: {
      delistingExits: int(input.delistingExits),
      caExits: int(input.caExits),
      flatBarCancels: int(input.flatBarCancels),
      dividendStepSuspects: int(input.dividendStepSuspects),
    },
  };
}

export function mapCoverageMonth(input: CoverageMonthInput): CoverageMonthView {
  const measurable = input.measurable !== false;
  const coverage =
    input.coveragePct !== undefined || input.hasCoverage !== undefined
      ? flagged(input.coveragePct, input.hasCoverage ?? true)
      : flagged(input.qualifyingPct, input.hasQualifying);
  return {
    month: /^\d{4}-\d{2}$/.test(str(input.month)) ? str(input.month) : "",
    coveragePct: measurable ? coverage : null,
    measurable,
    allReportedPct: flagged(input.allReportedPct, input.hasAllReported),
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
    applies: input.applies !== false,
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
    avgHoldSessions: numOrNull(input.avgHoldSessions),
    avgWinPct: numOrNull(input.avgWinPct),
    avgLossPct: numOrNull(input.avgLossPct),
    bestPct: numOrNull(input.bestPct),
    worstPct: numOrNull(input.worstPct),
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

export function mapPaperTrack(input: PaperTrackInput): PaperTrackView {
  return {
    since: ymd(input.since),
    sessions: int(input.sessions),
    closedTrades: int(input.closedTrades),
    openPositions: int(input.openPositions),
    returnPct: flagged(input.returnPct, input.hasReturn),
    tooShort: input.tooShort === true,
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
export function mapBacktestRun(input: BacktestRunInput): BacktestRunView {
  const share = flagged(input.computableSharePct, input.hasComputableShare);
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
    coverageByYear: (input.coverage ?? input.coverageByYear ?? []).map(mapCoverageYear),
    coverageMonthly: (input.coverageMonthly ?? []).map(mapCoverageMonth),
    survivorship: input.survivorship ? mapSurvivorship(input.survivorship) : null,
    sensitivity: (input.sensitivity ?? []).map(mapSensitivity),
    recipe: input.recipe ? mapRecipeLines(input.recipe) : null,
    tradeSummary: input.tradeSummary ? mapTradeSummary(input.tradeSummary) : null,
    liveVersion: mapStrategyVersion(input.liveVersion),
    rulesMatchLive: input.rulesMatchLive === true,
    engineMatchesLive: input.engineMatchesLive === true,
    replayAgreement: str(input.replayAgreement),
    inputChangeNote: str(input.inputChangeNote),
    disclosures: strings(input.disclosures),
    dataNotes: strings(input.dataNotes),
    runningSince: str(input.runningSince),
    seriesResolution: str(input.seriesResolution),
    computableSharePct: share,
  };
}

export function mapStrategyEvidence(input: StrategyEvidenceInput): StrategyEvidenceView {
  return {
    strategyId: str(input.strategyId),
    version: mapStrategyVersion(input.version),
    state: toBacktestState(input.state),
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
