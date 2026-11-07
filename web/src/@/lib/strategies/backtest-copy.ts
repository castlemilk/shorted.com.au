// The Backtest tab's words: the states of design 1.7 and the honesty labels of
// 1.8, verbatim where the design gives the copy, and the run identity line. Pure,
// so each sentence is tested and nothing names a year or a time the data does
// not carry (the fiscal label, the live date and the run date all come from the
// API).

import type { BacktestIdentityView, PaperTrackView } from "./map-backtest";
import type { GrowthPoint } from "./backtest-series";

const MONTHS = [
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
];

/** A YYYY-MM-DD date as "24 Nov 2026"; "" when it is not a date. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "";
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** A YYYY-MM-DD date as "7 Nov", for a date whose year is clear from the line it sits in. */
export function dayMonth(iso: string): string {
  const full = shortDate(iso);
  return full ? full.replace(/ \d{4}$/, "") : "";
}

/** "Running since 14:02 UTC" from an RFC 3339 instant; "Running" when the instant does not parse. */
export function runningCopy(runningSince: string): string {
  const instant = new Date(runningSince);
  if (!runningSince || Number.isNaN(instant.getTime())) return "Running";
  const hh = String(instant.getUTCHours()).padStart(2, "0");
  const mm = String(instant.getUTCMinutes()).padStart(2, "0");
  return `Running since ${hh}:${mm} UTC`;
}

/**
 * Run required (1.7), for a computable version with no succeeded run. The API's
 * state_reason is printed when it names one (a live version with no recipe yet
 * says so); the default copy is for a version that is simply queued. It never
 * borrows the fundamentals sentence: that belongs to not_computable only.
 */
export function runRequiredCopy(
  versionLabel: string,
  rulesHash: string,
  stateReason = "",
): string {
  const reason = stateReason.trim();
  if (reason) return reason;
  const version = [versionLabel, rulesHash ? `(${rulesHash.slice(0, 8)})` : ""]
    .filter(Boolean)
    .join(" ");
  return `No completed backtest for rules ${version} yet. It is queued; results usually appear within the hour.`;
}

/** The headline of a fundamentals strategy that is not computable yet (1.7). */
export function notComputableHeadline(fiscalLabel: string): string {
  return `Not computable before ${fiscalLabel}. From ${fiscalLabel} a test is possible only by assuming when results were known and using restated figures; it is not published.`;
}

/** The body under the headline of a fundamentals strategy (1.7). */
export const NOT_COMPUTABLE_BODY =
  "This strategy's core rules need company fundamentals. Shorted has captured them point-in-time only since November 2026, and earlier vendor figures were overwritten when restated, so a historical test would use numbers nobody had at the time.";

/** Not computable with no label: the 50% threshold was never met (5.15). */
export function notComputableNoLabel(sharePct: number | null): string {
  if (sharePct === null) return "Not computable: needs point-in-time fundamentals.";
  return `Not computable: needs point-in-time fundamentals (fundamentals for ${Math.round(sharePct)}% of the universe).`;
}

/** The approximate run's chip (1.7; PR-21 publishes these). */
export const APPROXIMATE_CHIP =
  "Approximate: fundamentals assumed known 2 months after period end; restated vendor values; only companies still listed in September 2026 have fundamentals, which flatters results";

/** The tooltip of a year whose coverage is under 80% (1.7). */
export function lowCoverageCopy(year: number, coveragePct: number): string {
  return `${Math.round(coveragePct)}% of the stocks this strategy could have held in ${year} have prices. The missing ones mostly delisted before 2025, and heavily shorted failures are over-represented among them, so results this year are flattered; by how much cannot be measured.`;
}

/** The note on a measure that cannot see delisted companies that were never shorted (1.7). */
export const COVERAGE_NOT_MEASURABLE_COPY =
  "Measured on ASIC-reported names only; delisted companies that were never shorted are missing and cannot be counted.";

/** The paper track before it can be judged (1.7). */
export function tooShortCopy(paper: PaperTrackView): string {
  // The track's actual first recorded session (recorded_from) is the date it is recorded
  // from; live_from is the freeze, which can differ.
  const since = shortDate(paper.recordedFrom || paper.since);
  const lead = since ? `Recorded since ${since}` : "Recorded";
  const trades = paper.closedTrades === 1 ? "trade" : "trades";
  return `${lead}: ${paper.sessions} sessions, ${paper.closedTrades} ${trades}, too short to judge`;
}

/** The out-of-sample row (1.5): the recorded figure once it can be judged, else the reason it cannot. */
export function outOfSampleLine(paper: PaperTrackView): string {
  if (!paper.tooShort) return "Out-of-sample (recorded)";
  const weeks = Math.max(1, Math.round(paper.sessions / 5));
  return `Out-of-sample: ${weeks} ${weeks === 1 ? "week" : "weeks"}, too short to judge`;
}

/** The run's identity, one line (1.8 item 1). */
export function runIdentityLine(identity: BacktestIdentityView): string {
  const parts = [
    identity.runDate ? `Run ${shortDate(identity.runDate)}` : "Run",
    identity.pricesThrough ? `prices to ${dayMonth(identity.pricesThrough)}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The full identity: rules, recipe, engine and the ASIC report, the disclosure's first line (1.8 item 1). */
export function runIdentityDetail(identity: BacktestIdentityView): string {
  const parts = [
    identity.version ? `rules ${identity.version.label} ${identity.version.rulesHash.slice(0, 8)}` : "",
    identity.recipeId
      ? `recipe ${identity.recipeId}${identity.recipeHash ? ` ${identity.recipeHash.slice(0, 8)}` : ""}`
      : "",
    identity.engineVersion ? `engine ${identity.engineVersion}` : "",
    identity.asicReportThrough ? `ASIC report to ${dayMonth(identity.asicReportThrough)}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The chip that says the metrics are in-sample (1.8 item 2). */
export function inSampleChip(liveFrom: string): string {
  const date = shortDate(liveFrom);
  return date ? `In-sample backtest · rules frozen ${date}` : "In-sample backtest";
}

/** The coverage chip (1.5 and 1.8 item 3). */
export const COVERAGE_CHIP_PREFIX = "Coverage";
export const SURVIVORSHIP_SHORT = "flatters results; by how much cannot be measured";

/** The return basis (1.8 item 4). */
export const RETURN_BASIS_COPY =
  "Total return: dividends as adjusted by the price vendor, or credited in cash on the ex-date from ASX dividend notices where the vendor has not adjusted them (notices from 11 Sep 2024); franking excluded; vs S&P/ASX 200 Gross Total Return.";

/** The hypothetical-results line under every chart (1.8 item 8). */
export const HYPOTHETICAL_COPY =
  "Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice.";

/** The preface the Backtest tab's execution assumptions open with (5.3). */
export const RECIPE_PREFACE_FALLBACK =
  "Execution recipe chosen by Shorted to test the screen; the author's own entries and exits differ.";

/** The variant callout (1.5). */
export const VARIANT_CALLOUT_COPY =
  "Editing rules creates a new variant and requires a new backtest.";

/** The sign-in slot of the trade list (2.2: summary only for anonymous callers). */
export const TRADES_SIGN_IN_COPY =
  "Sign in free to see every trade in this run. The summary above is public.";

/** The growth chart's title and its unit line (OD-8). */
export const GROWTH_TITLE = "Growth of A$100,000";
export const GROWTH_UNIT = "AUD · after costs";

/** The label a recorded span carries on the chart (1.5). */
export function recordedSinceLabel(liveFrom: string): string {
  const date = shortDate(liveFrom);
  return date ? `Recorded since ${date}` : "Recorded";
}

/** The label of the frozen-rules marker on the chart. */
export function frozenLabel(liveFrom: string): string {
  const date = shortDate(liveFrom);
  return date ? `Rules frozen ${date}` : "Rules frozen";
}

/** The chart's text summary for screen readers: where the rebased curve starts and ends. */
export function growthSummary(
  points: readonly GrowthPoint[],
  from: string,
  to: string,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return `${GROWTH_TITLE}: no series for this window.`;
  const span = `${shortDate(from) || first.date} to ${shortDate(to) || last.date}`;
  const end = Math.round(last.strategy).toLocaleString("en-AU");
  return `${GROWTH_TITLE}, ${span}. The strategy ends at A$${end}.`;
}

/** The chart's mark for an engine change inside the recorded span (design 5.13, 1.8). */
export function engineChangeLabel(engineVersion: string, firstSession: string): string {
  const date = dayMonth(firstSession);
  const version = engineVersion ? `engine ${engineVersion}` : "engine change";
  return date ? `${version} from ${date}` : version;
}

/** The live window's chip (1.8 item 2): "Recorded since <recorded_from>". "" when there is no track. */
export function recordedFromCopy(recordedFrom: string): string {
  const date = shortDate(recordedFrom);
  return date ? `Recorded since ${date}` : "";
}

/** The universe label (item 14): from the live version's universe_kind; "" when the API names none. */
export function universeLabel(kind: "asic_reported" | "asx_ordinary" | ""): string {
  if (kind === "asic_reported") return "Universe: ASIC-reported names";
  if (kind === "asx_ordinary") return "Universe: ASX ordinary shares";
  return "";
}

/**
 * The reference span's copy (item 9): "to 30 Oct" where the reference figures run to that session,
 * and "n/a: the reference is measured to 30 Oct" where the window has no reference figure.
 */
export function referenceSpanCopy(referenceTo: string | null | undefined): string {
  const day = dayMonth(referenceTo ?? "");
  return day ? `(to ${day})` : "";
}
export function referenceUnmeasuredCopy(referenceTo: string | null | undefined): string {
  const day = dayMonth(referenceTo ?? "");
  return day ? `n/a: the reference is measured to ${day}` : "n/a";
}
