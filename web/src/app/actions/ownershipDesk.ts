"use server";

/**
 * The desk's five loaders on /ownership, one per rpc of the desk (spec 13.6):
 * the map, the flows, the movement's activity, the index fund window's changes
 * and one stock's fund series. Each is the data the islands draw, as plain rows.
 *
 * THE SAME SHAPE AS THE EXPLORER'S ACTIONS. ownershipExplorer.ts sets the rules:
 * an outage (the retry wrapper's undefined) is ok: false, an honest empty answer is
 * ok: true with no rows, a refusal (a query the clamp or the API rejects) makes its
 * reason plain in `error` and is logged, and only the default view is a KV entry.
 * The refusal handling is the same few lines; they are repeated here, not shared,
 * because the explorer's helpers are not exported and ownership-shared.ts holds
 * only the transport and the KV layer.
 *
 * WINDOWS ARE RESOLVED HERE. The map and the flows take a window of days or a
 * brushed pair of notice dates. A chip names days, and the API counts from the
 * newest notice read, so a chip other than the default first reads that date from
 * the default activity (kept by the KV layer) and then asks for the dates it names. A brushed
 * pair goes straight through. The default window with no dates is the API's own
 * default. A chip with no notice to count back from is an honest empty answer.
 *
 * NEVER THROWS. withRetryAndNotFound answers undefined for every failure, and the
 * loaders map that to ok: false. The loaders write no key but the four default
 * views, and only a populated answer is kept, so an empty or failed read is never
 * pinned for an hour.
 */

import type {
  GetOwnershipActivityResponse,
  GetOwnershipFlowsResponse,
  GetOwnershipMapResponse,
  GetStockFundSeriesResponse,
  GetStockOwnershipResponse,
  ListFundPositionChangesResponse,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import {
  GetOwnershipActivityResponseSchema,
  GetOwnershipFlowsResponseSchema,
  GetOwnershipMapResponseSchema,
  ListFundPositionChangesResponseSchema,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import type { MapStockRow } from "~/@/components/ownership/desk/map-layout";
import type { FlowChangeRow, FlowDirection, FlowPositionRow } from "~/@/components/ownership/desk/flows-layout";
import type { FundChangeRow, FundChangeState } from "~/@/components/ownership/desk/fund-changes";
import type { StockPanelPage } from "~/@/components/ownership/desk/stock-panel";
import {
  DEFAULT_DESK_WINDOW,
  DESK_MAX_SPAN_DAYS,
  DESK_WINDOWS,
  dayGap,
  isIsoDate,
  windowDates,
} from "~/@/components/ownership/desk/desk-state";
import { CACHE_KEYS } from "@/lib/kv-cache";
import { skipForBuild } from "./config";
import { cachedRead, ownershipClient, type ProtoSchema } from "./ownership-shared";
import { withRetryAndNotFound } from "./withRetry";

/**
 * The notice window of the map and the flows: a window of change in days, or a
 * brushed pair of notice release dates (since, until). The index fund window's
 * snapshot dates are a different parameter and never reach these loaders.
 */
export interface DeskRangeInput {
  window?: number;
  since?: string;
  until?: string;
}

/** Connect's InvalidArgument (gRPC code 3). A constant, as withRetry.ts holds NotFound. */
const CODE_INVALID_ARGUMENT = 3;
/** The window's default: the API's own, with no dates sent. */
const NO_DATES = { from: "", to: "" };
/** The movement's weeks: the default, and the most the API serves. */
const ACTIVITY_WEEKS_DEFAULT = 52;
/** The index window's rows per direction: the default, and the most the API serves. */
const FUND_LIMIT_DEFAULT = 10;
const FUND_LIMIT_MAX = 50;
const NOT_AN_OBJECT = "the query must be an object";
/** The ticker shape the API accepts. */
const STOCK_CODE = /^[A-Z0-9]{1,6}$/;

type Asked<T> = { kind: "answered"; response: T } | { kind: "refused"; reason: string };

/** Asks the API. InvalidArgument is the API refusing the arguments; any other failure is thrown. */
async function ask<T>(call: () => Promise<T>): Promise<Asked<T>> {
  try {
    return { kind: "answered", response: await call() };
  } catch (error) {
    const reason = refusalReason(error);
    if (reason === undefined) throw error;
    return { kind: "refused", reason };
  }
}

function refusalReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, rawMessage, message } = error as {
    code?: unknown;
    rawMessage?: unknown;
    message?: unknown;
  };
  if (code !== CODE_INVALID_ARGUMENT) return undefined;
  if (typeof rawMessage === "string") return rawMessage;
  return typeof message === "string" ? message : "";
}

/** A refusal is logged, cut short: a reason can quote the caller's own text. */
const REFUSAL_LOG_CHARS = 200;

function logRefusal(reason: string): string {
  console.warn(`[ownership desk] refused query: ${reason.slice(0, REFUSAL_LOG_CHARS)}`);
  return reason;
}

// withRetryAndNotFound answers undefined for every failure: that is this module's outage.
const requestMap = withRetryAndNotFound((request: { from: string; to: string }) =>
  ask(() => ownershipClient().getOwnershipMap(request)),
);
const requestFlows = withRetryAndNotFound((request: { from: string; to: string }) =>
  ask(() => ownershipClient().getOwnershipFlows(request)),
);
const requestActivity = withRetryAndNotFound((request: { weeks: number }) =>
  ask(() => ownershipClient().getOwnershipActivity(request)),
);
const requestFundChanges = withRetryAndNotFound(
  (request: { from: string; to: string; limit: number }) =>
    ask(() => ownershipClient().listFundPositionChanges(request)),
);
const requestFundSeries = withRetryAndNotFound((request: { stockCode: string }) =>
  ask(() => ownershipClient().getStockFundSeries(request)),
);
// The stock panel's register. Read per stock and never kept: KV holds the default views only.
const requestStockOwnership = withRetryAndNotFound((request: { stockCode: string }) =>
  ownershipClient().getStockOwnership(request),
);

/* ------------------------------------------------------------------ */
/* The pages                                                          */
/* ------------------------------------------------------------------ */

/** The map for one window: every stock of the universe, with its figures for the lenses. */
export interface OwnershipMapPage {
  ok: boolean;
  /** Why the query was refused; "" when it was served or the read failed. Logged. */
  error: string;
  /** The span the API used, echoed; "" when the read failed. */
  from: string;
  to: string;
  /** The newest notice release date read; "" when none. */
  asOf: string;
  stocks: MapStockRow[];
}

/** The flows for one window: the positions (current) and the window's changes. */
export interface OwnershipFlowsPage {
  ok: boolean;
  error: string;
  from: string;
  to: string;
  asOf: string;
  positions: FlowPositionRow[];
  changes: FlowChangeRow[];
}

/** One industry in one ISO week of the movement, with the net change it states. */
export interface IndustryWeekRow {
  industry: string;
  weekStart: string;
  became: number;
  increased: number;
  decreased: number;
  changed: number;
  ceased: number;
  nz: number;
  /** Null for a week with no notice that states a figure. */
  netPp: number | null;
}

/** The movement: industries by week over the last weeks. */
export interface OwnershipActivityPage {
  ok: boolean;
  error: string;
  fromWeek: string;
  toWeek: string;
  asOf: string;
  rows: IndustryWeekRow[];
}

/** The index fund window: the snapshot dates the tracked funds have, and the changes between two of them. */
export interface FundPositionChangesPage {
  ok: boolean;
  error: string;
  snapshotDates: string[];
  from: string;
  to: string;
  rows: FundChangeRow[];
}

/** One point of a fund's weight series: a snapshot date, and the weight and value it states. */
export interface FundSeriesPoint {
  asAt: string;
  weightPct: number | null;
  valueAud: number | null;
}

/** One tracked fund's weight in a stock, over its snapshots. */
export interface FundSeriesRow {
  institutionSlug: string;
  institutionName: string;
  fundName: string;
  /** etf or super_phd. */
  sourceKind: string;
  points: FundSeriesPoint[];
}

export interface StockFundSeriesPage {
  ok: boolean;
  error: string;
  stockCode: string;
  funds: FundSeriesRow[];
}

/* ------------------------------------------------------------------ */
/* The loaders                                                        */
/* ------------------------------------------------------------------ */

/** The map for one window. `loadOwnershipMap({})` is the default view. Never throws. */
export async function loadOwnershipMap(input: DeskRangeInput = {}): Promise<OwnershipMapPage> {
  if (!isQueryObject(input)) return refusedMap(NOT_AN_OBJECT);
  const range = await resolveRange(input);
  if (range.kind === "refused") return refusedMap(range.error);
  if (range.kind === "empty") return { ok: true, error: "", from: "", to: "", asOf: "", stocks: [] };
  if (range.kind === "outage" || skipForBuild()) return mapPage(undefined);
  const request = () => requestMap(range.dates);
  if (range.dates.from !== "") return mapPage(await request());
  const asked = await cachedAsked(
    CACHE_KEYS.ownershipDeskMap(),
    GetOwnershipMapResponseSchema,
    (answer: GetOwnershipMapResponse) => answer.stocks.length > 0,
    request,
  );
  return mapPage(asked);
}

/** The flows for one window. `loadOwnershipFlows({})` is the default view. Never throws. */
export async function loadOwnershipFlows(input: DeskRangeInput = {}): Promise<OwnershipFlowsPage> {
  if (!isQueryObject(input)) return refusedFlows(NOT_AN_OBJECT);
  const range = await resolveRange(input);
  if (range.kind === "refused") return refusedFlows(range.error);
  if (range.kind === "empty") {
    return { ok: true, error: "", from: "", to: "", asOf: "", positions: [], changes: [] };
  }
  if (range.kind === "outage" || skipForBuild()) return flowsPage(undefined);
  const request = () => requestFlows(range.dates);
  if (range.dates.from !== "") return flowsPage(await request());
  const asked = await cachedAsked(
    CACHE_KEYS.ownershipDeskFlows(),
    GetOwnershipFlowsResponseSchema,
    (answer: GetOwnershipFlowsResponse) => answer.positions.length > 0 || answer.changes.length > 0,
    request,
  );
  return flowsPage(asked);
}

/** The movement over the last weeks. `loadOwnershipActivity({})` is the default view. Never throws. */
export async function loadOwnershipActivity(
  input: { weeks?: number } = {},
): Promise<OwnershipActivityPage> {
  if (!isQueryObject(input)) return refusedActivity(NOT_AN_OBJECT);
  const weeks = input.weeks;
  const served =
    typeof weeks === "number" && Number.isInteger(weeks) && weeks >= 1 && weeks <= ACTIVITY_WEEKS_DEFAULT
      ? weeks
      : ACTIVITY_WEEKS_DEFAULT;
  if (skipForBuild()) return activityPage(undefined);
  const request = () => requestActivity({ weeks: served });
  if (served !== ACTIVITY_WEEKS_DEFAULT) return activityPage(await request());
  const asked = await cachedAsked(
    CACHE_KEYS.ownershipDeskActivity(),
    GetOwnershipActivityResponseSchema,
    (answer: GetOwnershipActivityResponse) => answer.rows.length > 0,
    request,
  );
  return activityPage(asked);
}

/**
 * The index fund window's changes. `loadFundPositionChanges({})` is the default
 * view: the two newest snapshot dates, ten per list. Never throws.
 */
export async function loadFundPositionChanges(
  input: { from?: string; to?: string; limit?: number } = {},
): Promise<FundPositionChangesPage> {
  if (!isQueryObject(input)) return refusedFunds(NOT_AN_OBJECT);
  const from = typeof input.from === "string" ? input.from.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const limit = clampLimit(input.limit);
  const dates = checkFundDates(from, to);
  if ("error" in dates) return refusedFunds(dates.error);
  const request = () => requestFundChanges({ ...dates, limit });
  if (skipForBuild()) return fundsPage(undefined);
  if (dates.from !== "" || dates.to !== "" || limit !== FUND_LIMIT_DEFAULT) {
    return fundsPage(await request());
  }
  const asked = await cachedAsked(
    CACHE_KEYS.ownershipDeskFunds(),
    ListFundPositionChangesResponseSchema,
    (answer: ListFundPositionChangesResponse) => answer.snapshotDates.length > 0,
    request,
  );
  return fundsPage(asked);
}

/** One stock's weight in every tracked fund that holds it. Never throws. */
export async function loadStockFundSeries(
  input: { stockCode?: string } = {},
): Promise<StockFundSeriesPage> {
  if (!isQueryObject(input)) return refusedSeries(NOT_AN_OBJECT, "");
  const stockCode = typeof input.stockCode === "string" ? input.stockCode.trim().toUpperCase() : "";
  if (!STOCK_CODE.test(stockCode)) return refusedSeries("the stock code must be 1 to 6 letters or digits", "");
  if (skipForBuild()) return seriesPage(undefined, stockCode);
  return seriesPage(await requestFundSeries({ stockCode }), stockCode);
}

/**
 * One stock's register as the map's panel prints it (spec 13.2). A stock the
 * register cannot be read for is ok: false, which the panel words as an outage.
 * The short position is never carried: the panel links it (spec 13.8), so its
 * figure stays null here and the page never prints it from this loader.
 * Never throws.
 */
export async function loadStockPanel(code: string): Promise<StockPanelPage> {
  const stockCode = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!STOCK_CODE.test(stockCode) || skipForBuild()) return panelPage(stockCode, undefined);
  return panelPage(stockCode, await requestStockOwnership({ stockCode }));
}

/* ------------------------------------------------------------------ */
/* Windows and clamps                                                 */
/* ------------------------------------------------------------------ */

function isQueryObject(input: unknown): boolean {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

type RangeAnswer =
  | { kind: "range"; dates: { from: string; to: string } }
  /** A window of days with no notice to count back from: nothing to serve. */
  | { kind: "empty" }
  | { kind: "refused"; error: string }
  | { kind: "outage" };

/**
 * The span a request names. Brushed dates win; otherwise a window of days is
 * counted back from the newest notice read, which the activity call supplies. The
 * default window sends no dates, so the API applies its own. A chosen window is
 * never swapped for the default span: with no newest notice it is empty.
 */
async function resolveRange(input: DeskRangeInput): Promise<RangeAnswer> {
  const since = typeof input.since === "string" ? input.since.trim() : "";
  const until = typeof input.until === "string" ? input.until.trim() : "";
  if (since !== "" || until !== "") {
    const dates = checkDates(since, until);
    return "error" in dates ? { kind: "refused", error: dates.error } : { kind: "range", dates };
  }
  const days = input.window;
  const window =
    typeof days === "number" && (DESK_WINDOWS as readonly number[]).includes(days)
      ? days
      : DEFAULT_DESK_WINDOW;
  if (window === DEFAULT_DESK_WINDOW) return { kind: "range", dates: NO_DATES };
  if (skipForBuild()) return { kind: "outage" };
  // The newest notice comes from the default activity, which the KV layer keeps: a chip
  // never asks for a week of activity just to learn a date.
  const newest = await loadOwnershipActivity();
  if (newest.error !== "") return { kind: "refused", error: newest.error };
  if (!newest.ok) return { kind: "outage" };
  if (newest.asOf === "") return { kind: "empty" };
  const dates = windowDates(window, newest.asOf);
  if (dates === null) return { kind: "outage" };
  return { kind: "range", dates };
}

/** Two notice dates as a span the API serves, or the reason it does not. Both or neither. */
function checkDates(since: string, until: string): { from: string; to: string } | { error: string } {
  if (since === "" || until === "") return { error: "a window of dates needs both since and until" };
  if (!isIsoDate(since) || !isIsoDate(until)) return { error: "the dates must be YYYY-MM-DD" };
  if (since > until) return { error: "since is after until" };
  if (dayGap(since, until) > DESK_MAX_SPAN_DAYS) {
    return { error: `a span of ${DESK_MAX_SPAN_DAYS} days is the most the desk serves` };
  }
  return { from: since, to: until };
}

/**
 * The index fund window's two snapshot dates. Either side may be empty (the newest
 * snapshot, or the one before it), and no span is capped: the history is not a year.
 */
function checkFundDates(from: string, to: string): { from: string; to: string } | { error: string } {
  if ((from !== "" && !isIsoDate(from)) || (to !== "" && !isIsoDate(to))) {
    return { error: "the dates must be YYYY-MM-DD" };
  }
  if (from !== "" && to !== "" && from > to) return { error: "from is after to" };
  return { from, to };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return FUND_LIMIT_DEFAULT;
  return Math.min(limit, FUND_LIMIT_MAX);
}

/**
 * The default view through the KV layer. The layer keeps only an answer, so a
 * refusal is carried out of the cached read beside it, and it is never kept.
 */
async function cachedAsked<T>(
  key: string,
  schema: ProtoSchema,
  isKept: (answer: T) => boolean,
  request: () => Promise<Asked<T> | undefined>,
): Promise<Asked<T> | undefined> {
  let refusal: Asked<T> | undefined;
  const answer = await cachedRead(key, schema, isKept, async () => {
    const asked = await request();
    if (asked?.kind === "refused") {
      refusal = asked;
      return undefined;
    }
    return asked?.response;
  });
  if (answer !== undefined) return { kind: "answered", response: answer };
  return refusal;
}

/** The panel's lists: the largest holders by voting power, and the latest notices. */
const PANEL_HOLDERS = 3;
const PANEL_NOTICES = 5;

/** A stock's register as the panel prints it: plain rows, and no protobuf message crosses. */
function panelPage(code: string, data: GetStockOwnershipResponse | undefined): StockPanelPage {
  const summary = data?.summary;
  if (!data || !summary) {
    return {
      ok: false,
      code,
      companyName: "",
      // ok: false carries no figures: the panel discards the page, so this 0 is never printed.
      disclosedPct: 0,
      disclosed: [],
      largest: [],
      index: { pct: null, asAt: "" },
      notices: [],
    };
  }
  return {
    ok: true,
    code,
    companyName: summary.companyName,
    disclosed: summary.byKind.map((share) => ({ kind: share.kind, pct: share.pct, holders: share.holders })),
    disclosedPct: summary.disclosedPct,
    largest: [...data.holders]
      .sort((a, b) => b.votingPowerPct - a.votingPowerPct)
      .slice(0, PANEL_HOLDERS)
      .map((holder) => ({
        name: holder.holderName,
        slug: holder.institutionSlug,
        holderKey: holder.holderKey,
        kind: holder.kind,
        votingPowerPct: holder.votingPowerPct,
        asAt: holder.eventDate,
      })),
    index: {
      pct: summary.hasIndexPct ? summary.indexPct : null,
      asAt: summary.indexAsAtTo,
      asAtFrom: summary.indexAsAtFrom,
      files: summary.indexFiles,
    },
    notices: data.history.slice(0, PANEL_NOTICES).map((notice) => ({
      announcedOn: notice.announcedOn,
      form: notice.form,
      ceased: notice.ceased,
      holderName: notice.holderName,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Mapping: the API's messages to plain rows                          */
/* ------------------------------------------------------------------ */

function refusedMap(error: string): OwnershipMapPage {
  return { ...mapPage(undefined), error: logRefusal(error) };
}

function mapPage(asked: Asked<GetOwnershipMapResponse> | undefined): OwnershipMapPage {
  if (asked?.kind === "refused") return refusedMap(`refused by the API: ${asked.reason}`);
  const response = asked?.response;
  if (response === undefined) {
    return { ok: false, error: "", from: "", to: "", asOf: "", stocks: [] };
  }
  return {
    ok: true,
    error: "",
    from: response.from,
    to: response.to,
    asOf: response.asOf,
    stocks: response.stocks.map(
      (stock): MapStockRow => ({
        code: stock.stockCode,
        name: stock.companyName,
        industry: stock.industry,
        marketCap: stock.hasMarketCap ? stock.marketCap : null,
        disclosedPct: stock.disclosedPct,
        institutionalPct: stock.institutionalPct,
        hedgePct: stock.hedgePct,
        indexPct: stock.hasIndexPct ? stock.indexPct : null,
        shortPct: stock.hasShortPct ? stock.shortPct : null,
        flowPp: stock.hasFlowPp ? stock.flowPp : null,
        notices: stock.notices,
      }),
    ),
  };
}

function refusedFlows(error: string): OwnershipFlowsPage {
  return { ...flowsPage(undefined), error: logRefusal(error) };
}

function flowsPage(asked: Asked<GetOwnershipFlowsResponse> | undefined): OwnershipFlowsPage {
  if (asked?.kind === "refused") return refusedFlows(`refused by the API: ${asked.reason}`);
  const response = asked?.response;
  if (response === undefined) {
    return { ok: false, error: "", from: "", to: "", asOf: "", positions: [], changes: [] };
  }
  return {
    ok: true,
    error: "",
    from: response.from,
    to: response.to,
    asOf: response.asOf,
    positions: response.positions.map(
      (position): FlowPositionRow => ({
        kind: position.kind,
        industry: position.industry,
        exposureAud: position.hasExposure ? position.exposureAud : null,
        holdings: position.holdings,
        largestCode: position.largestCode,
        largestPct: position.largestPct,
      }),
    ),
    // A direction the page does not draw is dropped, not guessed into one of the two.
    changes: response.changes.flatMap((change): FlowChangeRow[] => {
      if (change.direction !== "up" && change.direction !== "down") return [];
      return [
        {
          kind: change.kind,
          industry: change.industry,
          direction: change.direction as FlowDirection,
          exposureAud: change.hasExposure ? change.exposureAud : null,
          notices: change.notices,
        },
      ];
    }),
  };
}

function refusedActivity(error: string): OwnershipActivityPage {
  return { ...activityPage(undefined), error: logRefusal(error) };
}

function activityPage(asked: Asked<GetOwnershipActivityResponse> | undefined): OwnershipActivityPage {
  if (asked?.kind === "refused") return refusedActivity(`refused by the API: ${asked.reason}`);
  const response = asked?.response;
  if (response === undefined) {
    return { ok: false, error: "", fromWeek: "", toWeek: "", asOf: "", rows: [] };
  }
  return {
    ok: true,
    error: "",
    fromWeek: response.fromWeek,
    toWeek: response.toWeek,
    asOf: response.asOf,
    rows: response.rows.map(
      (row): IndustryWeekRow => ({
        industry: row.industry,
        weekStart: row.weekStart,
        became: row.became,
        increased: row.increased,
        decreased: row.decreased,
        changed: row.changed,
        ceased: row.ceased,
        nz: row.nz,
        netPp: row.hasNetPp ? row.netPp : null,
      }),
    ),
  };
}

function refusedFunds(error: string): FundPositionChangesPage {
  return { ...fundsPage(undefined), error: logRefusal(error) };
}

const FUND_STATES: readonly FundChangeState[] = ["current", "new", "dropped"];

function fundsPage(asked: Asked<ListFundPositionChangesResponse> | undefined): FundPositionChangesPage {
  if (asked?.kind === "refused") return refusedFunds(`refused by the API: ${asked.reason}`);
  const response = asked?.response;
  if (response === undefined) {
    return { ok: false, error: "", snapshotDates: [], from: "", to: "", rows: [] };
  }
  return {
    ok: true,
    error: "",
    snapshotDates: [...response.snapshotDates],
    from: response.from,
    to: response.to,
    rows: response.rows.flatMap((row): FundChangeRow[] => {
      const state = FUND_STATES.find((known) => known === row.state);
      if (state === undefined) return [];
      return [
        {
          code: row.stockCode,
          name: row.companyName,
          weightFrom: row.hasWeightFrom ? row.weightFromPct : null,
          weightTo: row.hasWeightTo ? row.weightToPct : null,
          delta: row.hasDelta ? row.deltaPp : null,
          valueFrom: row.hasValueFrom ? row.valueFromAud : null,
          valueTo: row.hasValueTo ? row.valueToAud : null,
          funds: row.funds,
          state,
        },
      ];
    }),
  };
}

function refusedSeries(error: string, stockCode: string): StockFundSeriesPage {
  return { ...seriesPage(undefined, stockCode), error: logRefusal(error) };
}

function seriesPage(
  asked: Asked<GetStockFundSeriesResponse> | undefined,
  stockCode: string,
): StockFundSeriesPage {
  if (asked?.kind === "refused") return refusedSeries(`refused by the API: ${asked.reason}`, stockCode);
  const response = asked?.response;
  if (response === undefined) return { ok: false, error: "", stockCode, funds: [] };
  return {
    ok: true,
    error: "",
    stockCode: response.stockCode,
    funds: response.funds.map(
      (fund): FundSeriesRow => ({
        institutionSlug: fund.institutionSlug,
        institutionName: fund.institutionName,
        fundName: fund.fundName,
        sourceKind: fund.sourceKind,
        points: fund.points.map(
          (point): FundSeriesPoint => ({
            asAt: point.asAt,
            weightPct: point.hasWeight ? point.weightPct : null,
            valueAud: point.hasValue ? point.valueAud : null,
          }),
        ),
      }),
    ),
  };
}
