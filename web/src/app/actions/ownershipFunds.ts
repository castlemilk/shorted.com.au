"use server";

/**
 * The funds' loaders and the workspace inspector's resolvers for the fund pages
 * (spec 14.3, 14.4): the fund list, one fund's portfolio at a file date, the
 * comparison of two files of one fund, and the resolvers that turn a selection of
 * a fund, a holding or a change row into the inspector's plain content.
 *
 * THE SAME SHAPE AS THE DESK'S ACTIONS (ownershipDesk.ts). An outage is ok: false
 * (the retry wrapper's undefined), and an honest empty answer is ok: true with no
 * rows. A query this module can see is malformed (a key outside its shape, dates
 * out of order) is refused before any request and says why in `error`. A portfolio
 * the record does not hold is `missing`, which the page answers with a 404; the
 * portfolio read uses the NotFound-throwing wrapper so that case is never confused
 * with an outage.
 *
 * NEVER THROWS, loaders and resolvers alike. A resolver that cannot read its
 * selection says so in its content's note; it answers null only for a selection
 * that names nothing on record, so the rail never says "nothing on record" for an
 * outage. Plain rows: a null is a figure the API did not state, never a zero.
 */

import type {
  CompareFundSnapshotsResponse,
  FundPortfolioHolding,
  FundSectorWeight as ProtoSectorWeight,
  FundSnapshotChange,
  FundSummary,
  FundTopHolding as ProtoTopHolding,
  GetFundPortfolioResponse,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import {
  cleanFundKey,
  cleanIsoDate,
  fundCodeOf,
  fundLabel,
  type CompareRow,
  type FundPortfolio,
  type FundRow,
  type FundSectorWeight,
  type FundTopHolding,
  type PortfolioHolding,
} from "~/@/components/ownership/funds/fund-model";
import type { InspectorContent } from "~/@/components/ownership/workspace/inspector-types";
import type { Selection } from "~/@/components/ownership/workspace/selection";
import { changeInspectorContent } from "~/@/components/ownership/workspace/inspectors/change-inspector";
import { fundInspectorContent } from "~/@/components/ownership/workspace/inspectors/fund-inspector";
import {
  absentHoldingContent,
  holdingInspectorContent,
  type HoldingSeriesPoint,
} from "~/@/components/ownership/workspace/inspectors/holding-inspector";
import { skipForBuild } from "./config";
import { ownershipClient } from "./ownership-shared";
import { NotFoundError, withRetryAndNotFound, withRetryAndThrowNotFound } from "./withRetry";

/** The file dates a holding's series reads: the newest this many, one request each. */
const SERIES_DATES_MAX = 8;
const NOT_A_FUND_KEY = "the fund key must be asx:<code>, abn:<11 digits>, or <institution>/<fund name>";
const NOT_AN_OBJECT = "the query must be an object";
const OUTAGE_NOTE = "This selection could not be read just now. Nothing here is missing from the record: this is our end.";

/* ------------------------------------------------------------------ */
/* The pages                                                          */
/* ------------------------------------------------------------------ */

/** Every tracked fund at its newest file. */
export interface FundsPage {
  ok: boolean;
  error: string;
  funds: FundRow[];
}

/** One fund at one file date. `missing` is a fund the record does not hold: the page's 404. */
export interface FundPortfolioPage {
  ok: boolean;
  missing: boolean;
  error: string;
  fund: FundPortfolio | null;
}

/** The changes between two files of one fund. `from` and `to` are the dates used. */
export interface FundComparePage {
  ok: boolean;
  error: string;
  from: string;
  to: string;
  sourceFrom: string;
  sourceTo: string;
  rows: CompareRow[];
}

/* ------------------------------------------------------------------ */
/* The requests                                                       */
/* ------------------------------------------------------------------ */

const requestFunds = withRetryAndNotFound(() => ownershipClient().listFunds({}));
// NotFound throws, so a missing fund is told apart from an outage (undefined).
const requestPortfolio = withRetryAndThrowNotFound((request: { fundKey: string; asAt: string }) =>
  ownershipClient().getFundPortfolio(request),
);
const requestCompare = withRetryAndNotFound((request: { fundKey: string; from: string; to: string }) =>
  ownershipClient().compareFundSnapshots(request),
);

/** A refusal is logged, cut short: a reason can quote the caller's own text. */
const REFUSAL_LOG_CHARS = 200;

function logRefusal(reason: string): string {
  console.warn(`[ownership funds] refused query: ${reason.slice(0, REFUSAL_LOG_CHARS)}`);
  return reason;
}

/* ------------------------------------------------------------------ */
/* Loaders                                                            */
/* ------------------------------------------------------------------ */

/** Every tracked fund at its newest file, index funds and super options. Never throws. */
export async function loadFunds(): Promise<FundsPage> {
  if (skipForBuild()) return { ok: false, error: "", funds: [] };
  const response = await requestFunds();
  if (response === undefined) return { ok: false, error: "", funds: [] };
  return { ok: true, error: "", funds: response.funds.map(fundRow) };
}

/**
 * One fund's portfolio at one file date (`asAt`, "" for the newest at or before
 * nothing, which is the newest). Never throws.
 */
export async function loadFundPortfolio(input: { fundKey?: string; asAt?: string } = {}): Promise<FundPortfolioPage> {
  if (!isObject(input)) return portfolioRefusal(NOT_AN_OBJECT);
  const fundKey = cleanFundKey(input.fundKey);
  if (fundKey === "") return portfolioRefusal(NOT_A_FUND_KEY);
  const asAt = cleanIsoDate(input.asAt);
  if (skipForBuild()) return { ok: false, missing: false, error: "", fund: null };
  try {
    const response = await requestPortfolio({ fundKey, asAt });
    if (response === undefined) return { ok: false, missing: false, error: "", fund: null };
    return { ok: true, missing: false, error: "", fund: portfolio(response) };
  } catch (error) {
    // NotFound is the one error the wrapper lets through: the fund is not on record.
    if (error instanceof NotFoundError) return { ok: false, missing: true, error: "", fund: null };
    return { ok: false, missing: false, error: "", fund: null };
  }
}

/**
 * The changes between two files of one fund (`from` and `to`, ISO dates; "" for the
 * API's own choice). Never throws.
 */
export async function compareFundSnapshots(input: { fundKey?: string; from?: string; to?: string } = {}): Promise<FundComparePage> {
  if (!isObject(input)) return compareRefusal(NOT_AN_OBJECT);
  const fundKey = cleanFundKey(input.fundKey);
  if (fundKey === "") return compareRefusal(NOT_A_FUND_KEY);
  const from = cleanIsoDate(input.from);
  const to = cleanIsoDate(input.to);
  if (from !== "" && to !== "" && from > to) return compareRefusal("from is after to");
  if (skipForBuild()) return compareOutage();
  const response = await requestCompare({ fundKey, from, to });
  if (response === undefined) return compareOutage();
  return compareRows(response);
}

/* ------------------------------------------------------------------ */
/* Resolvers (the inspector's resolve prop)                           */
/* ------------------------------------------------------------------ */

/**
 * The inspector content for a fund or a holding of a fund (spec 14.1). A holding is
 * read from the file the page shows (`view.asAt`, "" for the newest), so a row of an
 * older snapshot resolves in that file. A holding the file does not state says so and
 * keeps its weight series; it is never "nothing on record" while the file is on record.
 * A holding's series is one portfolio read per recent file date, the newest eight.
 * Null when the selection names nothing on record; the note carries an outage. Never throws.
 */
export async function resolveFundSelection(
  selection: Selection,
  view: { asAt?: string } = {},
): Promise<InspectorContent | null> {
  if (selection.kind === "fund") {
    const page = await loadFunds();
    if (!page.ok) return outageContent();
    const fund = page.funds.find((row) => row.key === selection.fundKey);
    return fund ? fundInspectorContent(fund) : null;
  }
  if (selection.kind === "holding") {
    const asAt = cleanIsoDate(view.asAt);
    const shown = await loadFundPortfolio({ fundKey: selection.fundKey, asAt });
    if (shown.missing) return null;
    if (!shown.fund) return outageContent();
    const fund = shown.fund;
    const dates = fund.snapshotDates.slice(-SERIES_DATES_MAX);
    const series = await seriesOf(selection.fundKey, selection.code, dates);
    const holding = fund.holdings.find((row) => row.code === selection.code);
    const fundFacts = { ticker: fund.ticker, name: fund.name, asAt: fund.asAt, sourceUrl: fund.sourceUrl };
    if (!holding) return absentHoldingContent({ fund: fundFacts, code: selection.code, series });
    return holdingInspectorContent({ fund: fundFacts, holding, series });
  }
  return null;
}

/**
 * The inspector content for one row of a comparison (spec 14.3, Changes). The
 * changes page passes its own two dates, so the resolver takes them as well as the
 * selection; the page wraps it in a closure for the rail. Never throws.
 */
/** A fund's label in a change heading: its ticker, else its name, else its key's code (spec 14.7). */
function changeLabel(match: { ticker: string; name: string } | undefined, fundKey: string): string {
  const label = fundLabel({ ticker: match?.ticker ?? "", name: match?.name ?? "" });
  return label !== "" ? label : fundCodeOf(fundKey);
}

export async function resolveChangeSelection(
  selection: Selection,
  range: { from: string; to: string },
): Promise<InspectorContent | null> {
  if (selection.kind !== "holding") return null;
  const page = await compareFundSnapshots({ fundKey: selection.fundKey, from: range.from, to: range.to });
  if (!page.ok) return outageContent();
  const row = page.rows.find((candidate) => candidate.code === selection.code);
  if (!row) return null;
  // The heading names the fund by its ticker; a fund with no row on record shows its code, never its key.
  const listed = await loadFunds();
  const match = listed.ok ? listed.funds.find((fund) => fund.key === selection.fundKey) : undefined;
  return changeInspectorContent({
    fund: { key: selection.fundKey, ticker: changeLabel(match, selection.fundKey) },
    row,
    from: page.from,
    to: page.to,
    sourceFrom: page.sourceFrom,
    sourceTo: page.sourceTo,
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function isObject(input: unknown): boolean {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function outageContent(): InspectorContent {
  return { heading: "Unavailable", rows: [], note: OUTAGE_NOTE };
}

function portfolioRefusal(error: string): FundPortfolioPage {
  return { ok: false, missing: false, error: logRefusal(error), fund: null };
}

function compareRefusal(error: string): FundComparePage {
  return { ...compareOutage(), error: logRefusal(error) };
}

function compareOutage(): FundComparePage {
  return { ok: false, error: "", from: "", to: "", sourceFrom: "", sourceTo: "", rows: [] };
}

/**
 * The weight of one holding on each of the given file dates, oldest first. A file that
 * could not be read is `read: false`, so it is not drawn as a file without the holding.
 */
async function seriesOf(fundKey: string, code: string, dates: readonly string[]): Promise<HoldingSeriesPoint[]> {
  const pages = await Promise.all(dates.map((asAt) => loadFundPortfolio({ fundKey, asAt })));
  return dates.map((asAt, index) => {
    const page = pages[index];
    const holding = page?.fund?.holdings.find((row) => row.code === code);
    return { asAt, weightPct: holding?.weightPct ?? null, read: page?.ok === true && page.fund !== null };
  });
}

function sectorWeight(sector: ProtoSectorWeight): FundSectorWeight {
  return { industry: sector.industry, weightPct: sector.hasWeightPct ? sector.weightPct : null };
}

function topHolding(holding: ProtoTopHolding): FundTopHolding {
  return { code: holding.code, name: holding.name, weightPct: holding.hasWeightPct ? holding.weightPct : null };
}

function fundRow(fund: FundSummary): FundRow {
  return {
    key: fund.fundKey,
    ticker: fund.ticker,
    name: fund.name,
    institutionSlug: fund.institutionSlug,
    institutionName: fund.institutionName,
    sourceKind: fund.sourceKind,
    pooled: fund.pooled,
    asAt: fund.asAt,
    sourceUrl: fund.sourceUrl,
    holdings: fund.holdings,
    top10Pct: fund.hasTop10Pct ? fund.top10Pct : null,
    sectorWeights: fund.sectorWeights.map(sectorWeight),
    largest: fund.largest.map(topHolding),
    aumAud: fund.hasAumAud ? fund.aumAud : null,
  };
}

function holding(row: FundPortfolioHolding): PortfolioHolding {
  return {
    code: row.code,
    name: row.name,
    industry: row.industry,
    weightPct: row.hasWeightPct ? row.weightPct : null,
    units: row.hasUnits ? row.units : null,
    valueAud: row.hasValueAud ? row.valueAud : null,
    sharesOnIssue: row.hasSharesOnIssue ? row.sharesOnIssue : null,
    estCompanyPct: row.hasEstCompanyPct ? row.estCompanyPct : null,
    sharesOnIssueAsAt: row.sharesOnIssueAsAt,
  };
}

function portfolio(response: GetFundPortfolioResponse): FundPortfolio {
  return {
    key: response.fundKey,
    ticker: response.ticker,
    name: response.name,
    institutionSlug: response.institutionSlug,
    institutionName: response.institutionName,
    sourceKind: response.sourceKind,
    pooled: response.pooled,
    asAt: response.asAt,
    sourceUrl: response.sourceUrl,
    // The file dates are sorted oldest first, so a consumer never depends on the API's order.
    snapshotDates: response.snapshotDates.filter((d) => cleanIsoDate(d) !== "").sort(),
    holdings: response.holdings.map(holding),
    holdingsTotal: response.holdingsTotal,
    top10Pct: response.hasTop10Pct ? response.top10Pct : null,
    sectorWeights: response.sectorWeights.map(sectorWeight),
  };
}

function change(row: FundSnapshotChange): CompareRow {
  return {
    code: row.code,
    name: row.name,
    industry: row.industry,
    weightFrom: row.hasWeightFromPct ? row.weightFromPct : null,
    weightTo: row.hasWeightToPct ? row.weightToPct : null,
    deltaPp: row.hasDeltaPp ? row.deltaPp : null,
    valueFrom: row.hasValueFromAud ? row.valueFromAud : null,
    valueTo: row.hasValueToAud ? row.valueToAud : null,
    status: row.status,
  };
}

function compareRows(response: CompareFundSnapshotsResponse): FundComparePage {
  return {
    ok: true,
    error: "",
    from: response.from,
    to: response.to,
    sourceFrom: response.sourceFrom,
    sourceTo: response.sourceTo,
    rows: response.rows.map(change),
  };
}
