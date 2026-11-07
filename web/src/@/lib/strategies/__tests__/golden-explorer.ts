// The explorer's test inputs, read from the protojson goldens that PR-18's real handler
// produces (./golden). Nothing here is hand-written: every constant the tests compare
// against is derived from the golden files, so a regenerated golden (new sensitivity runs,
// identity hashes, live_from, a corrected coverage) flows through without an edit.
//
// The goldens are full responses. They are mapped through the shared mapper
// (map-backtest.ts), the same code the server runs.
import * as fs from "fs";
import * as path from "path";
import {
  mapStrategyEvidenceList,
  type ListStrategyEvidenceInput,
  type StrategyEvidenceListView,
} from "../map-backtest";
import type { StrategyDef } from "../types";

const GOLDEN = path.join(__dirname, "golden");

function read<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN, file), "utf8")) as T;
}

/** The raw ListStrategyEvidence response, exactly as the golden stores it. */
export const EVIDENCE_RAW = read<ListStrategyEvidenceInput>("strategy_evidence_all.json");

/** The same response through the shared mapper: what the server renders from. */
export const EVIDENCE: StrategyEvidenceListView = mapStrategyEvidenceList(EVIDENCE_RAW);

/** The strategies the golden holds, in the order the API serves them. */
export const GOLDEN_IDS: string[] = EVIDENCE.strategies.map((s) => s.strategyId);

/** Display facts the golden does not carry (they come from the registry in production). */
const NAMES: Record<string, string> = {
  "zanger-breakout": "Zanger Breakout",
  canslim: "CAN SLIM",
  "minervini-trend-template": "Minervini Trend Template",
  "crowded-short-breakout": "Crowded-Short Breakout",
  "quality-compounders": "Quality compounders",
};
const AUTHORS: Record<string, string> = {
  "zanger-breakout": "Dan Zanger",
  canslim: "William O'Neil",
  "minervini-trend-template": "Mark Minervini",
  "crowded-short-breakout": "Shorted",
  "quality-compounders": "Shorted",
};
const STYLES: Record<string, string> = {
  "zanger-breakout": "momentum-breakout",
  canslim: "growth-momentum",
  "minervini-trend-template": "trend-following",
  "crowded-short-breakout": "short-squeeze-breakout",
  "quality-compounders": "quality",
};
const HORIZONS: Record<string, string> = {
  "zanger-breakout": "Weeks to months",
  canslim: "Months",
  "minervini-trend-template": "Weeks to months",
  "crowded-short-breakout": "Days to weeks",
  "quality-compounders": "Years",
};

/** The registry-shaped definition of each strategy, from its name in the golden's version. */
export const DEFS: StrategyDef[] = GOLDEN_IDS.map((id) => ({
  id,
  name: NAMES[id] ?? id,
  author: AUTHORS[id] ?? "",
  tagline: `${NAMES[id] ?? id} tagline.`,
  descriptionParagraphs: [],
  rules: [],
  metadata: {
    style: STYLES[id] ?? "",
    holdingPeriod: HORIZONS[id] ?? "",
    riskPosture: "",
    universe: "",
    refreshCadence: "Daily, after the evening price sweep",
    ruleCount: 0,
  },
  caveats: [],
  sources: [],
}));

/** The one row of a golden that has a published run, and the one that does not, by state. */
export function rowIdIn(state: string): string {
  const id = EVIDENCE.strategies.find((s) => s.state === state)?.strategyId;
  if (!id) throw new Error(`the golden holds no ${state} row`);
  return id;
}

/** The golden's first calendar year and its newest, from its own window and prices. */
export const GOLDEN_START_YEAR = Number(EVIDENCE.windowStart.slice(0, 4));
export const GOLDEN_PRICES_YEAR = Number(EVIDENCE.pricesThrough.slice(0, 4));
