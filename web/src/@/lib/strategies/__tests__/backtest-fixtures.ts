// The test fixtures are the goldens PR-18's real handler produced
// (web/src/@/lib/strategies/__tests__/golden/), read as protojson. Nothing here is
// hand-written: every constant is read from a golden, so a test cannot disagree with the
// contract. The goldens are the source of truth for every figure a test asserts.
//
//   backtest_run_crowded_short.json        Crowded-Short: measured coverage, a paper tail,
//                                          two engine segments, disclosures
//   backtest_run_minervini.json            Minervini: partial coverage (the "?" years)
//   backtest_run_zanger_not_computable.json Zanger: not_computable, the measured FY2024 label
//   strategy_evidence_all.json             ListStrategyEvidence, all five strategies

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BacktestRunInput,
  SeriesPointInput,
  StrategyEvidenceInput,
  WindowMetricsInput,
} from "../map-backtest";

const GOLDEN = join(__dirname, "golden");

function read<T>(file: string): T {
  return JSON.parse(readFileSync(join(GOLDEN, file), "utf8")) as T;
}

interface GoldenRun {
  run: BacktestRunInput;
}

const CROWDED_RUN = read<GoldenRun>("backtest_run_crowded_short.json").run;
const MINERVINI_RUN = read<GoldenRun>("backtest_run_minervini.json").run;
const ZANGER_RUN = read<BacktestRunInput>("backtest_run_zanger_not_computable.json");
const EVIDENCE = read<{
  strategies: StrategyEvidenceInput[];
  windowStart: string;
  pricesThrough: string;
  benchmarkName: string;
  footnotes: string[];
}>("strategy_evidence_all.json");

function evidenceOf(strategyId: string): StrategyEvidenceInput {
  const found = EVIDENCE.strategies.find((s) => s.strategyId === strategyId);
  if (!found) throw new Error(`strategy_evidence_all.json has no ${strategyId}`);
  return found;
}

// --- The Crowded-Short golden's own facts, as the tests name them ----------------------

/** The in-sample end (the golden's identity) and the session after it: the freeze the rules name. */
export const FIXTURE_IN_SAMPLE_UNTIL = CROWDED_RUN.identity!.inSampleUntil as string;
export const FIXTURE_PRICES_THROUGH = CROWDED_RUN.identity!.pricesThrough as string;
/** The paper track's first recorded session (recorded_from): where the recorded band starts. */
export const FIXTURE_RECORDED_FROM = CROWDED_RUN.paperStart as string;
/** The second engine segment's first session: the engine change marked on the recorded band. */
export const FIXTURE_ENGINE_CHANGE = (CROWDED_RUN.paperEngineSegments ?? [])[1]?.firstSession as string;
export const FIXTURE_RULES_HASH = CROWDED_RUN.liveVersion!.rulesHash as string;
export const FIXTURE_RECIPE_HASH = CROWDED_RUN.identity!.recipeHash as string;
export const FIXTURE_ENGINE_SEGMENTS = CROWDED_RUN.paperEngineSegments ?? [];

export const FIXTURE_LIVE_FROM = nextDayOf(FIXTURE_IN_SAMPLE_UNTIL);

function nextDayOf(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The Crowded-Short golden's series: one point per ISO week, the paper track after the freeze. */
export function fixtureSeries(): SeriesPointInput[] {
  return CROWDED_RUN.series ?? [];
}

/** The four windows of 5.8 in the golden's own order and figures. */
export function fixtureWindows(): WindowMetricsInput[] {
  return CROWDED_RUN.windows ?? [];
}

/** The Crowded-Short golden's live rules version. */
export function fixtureVersion(over: Record<string, unknown> = {}) {
  return { ...CROWDED_RUN.liveVersion, ...over };
}

/** A published Crowded-Short run, exactly as PR-18's handler serves it. */
export function fixturePublishedRun(over: Partial<BacktestRunInput> = {}): BacktestRunInput {
  return { ...CROWDED_RUN, ...over };
}

/** The Minervini golden: partial coverage, every pre-2025 year "?" (the all-reported measure). */
export function fixtureMinerviniRun(over: Partial<BacktestRunInput> = {}): BacktestRunInput {
  return { ...MINERVINI_RUN, ...over };
}

/** The Zanger golden: not computable before the measured FY2024 label. */
export function fixtureZangerRun(over: Partial<BacktestRunInput> = {}): BacktestRunInput {
  return { ...ZANGER_RUN, ...over };
}

/** The Crowded-Short evidence entry from ListStrategyEvidence. */
export function fixtureEvidence(over: Partial<StrategyEvidenceInput> = {}): StrategyEvidenceInput {
  return { ...evidenceOf("crowded-short-breakout"), ...over };
}

/** Any strategy's evidence entry from the golden list. */
export function fixtureEvidenceFor(strategyId: string): StrategyEvidenceInput {
  return evidenceOf(strategyId);
}

/** The whole ListStrategyEvidence golden. */
export function fixtureEvidenceList() {
  return EVIDENCE;
}
