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
  ListStockRegistersResponse,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import {
  GetOwnershipActivityResponseSchema,
  GetOwnershipFlowsResponseSchema,
  GetOwnershipMapResponseSchema,
  ListFundPositionChangesResponseSchema,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import type { InspectorContent, InspectorQuery } from "~/@/components/ownership/workspace/inspector-types";
import {
  SELECTION_KINDS,
  parseSelection,
  sectorSelection,
  serializeSelection,
  type Selection,
} from "~/@/components/ownership/workspace/selection";
import { cellInspectorContent } from "~/@/components/ownership/workspace/inspectors/cell-inspector";
import {
  connectionInspectorContent,
  type ConnectionCompany,
  type ConnectionSpan,
} from "~/@/components/ownership/workspace/inspectors/connection-inspector";
import { sectorInspectorContent } from "~/@/components/ownership/workspace/inspectors/sector-inspector";
import { changePpOf } from "~/@/components/ownership/workspace/inspectors/window-net";
import {
  stockInspectorContent,
  type StockNoticeWindow,
} from "~/@/components/ownership/workspace/inspectors/stock-inspector";
import type { DeskLens } from "~/@/components/ownership/desk/desk-state";
import { OTHER_SECTOR, type MapStockRow } from "~/@/components/ownership/desk/map-layout";
import { FOLDED_SECTOR_LABEL } from "~/@/lib/ownership/kinds";
import type {
  FlowChangeRow,
  FlowDirection,
  FlowHolderRow,
  FlowPositionRow,
} from "~/@/components/ownership/desk/flows-layout";
import type { FundChangeRow, FundChangeState } from "~/@/components/ownership/desk/fund-changes";
import type { LargestMove } from "~/@/lib/ownership/largest-moves";
import type { StockPanelPage } from "~/@/components/ownership/desk/stock-panel";
import {
  DEFAULT_DESK_LENS,
  DEFAULT_DESK_WINDOW,
  DESK_LENSES,
  DESK_MAX_SPAN_DAYS,
  DESK_WINDOWS,
  dayGap,
  isIsoDate,
  shiftDate,
  windowDates,
} from "~/@/components/ownership/desk/desk-state";
import { loadNoticeFeed } from "./ownershipExplorer";
import { readWeekNotices, weekWindow, type WeekNotices } from "~/@/components/ownership/workspace/week-strip";
import { PAGE_MAX_LIMIT } from "~/@/lib/ownership/query";
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
  /** The index fund window the fund figures compare (spec 14.10): both snapshot dates, or neither (the notice window). */
  fundFrom?: string;
  fundTo?: string;
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
/** A holder kind's shape (super_fund, index_manager ...). The API holds the vocabulary and refuses the rest. */
const KIND_SHAPE = /^[a-z_]{1,32}$/;

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
const requestMap = withRetryAndNotFound((request: { from: string; to: string; fundFrom: string; fundTo: string }) =>
  ask(() => ownershipClient().getOwnershipMap(request)),
);
const requestFlows = withRetryAndNotFound((request: { from: string; to: string }) =>
  ask(() => ownershipClient().getOwnershipFlows(request)),
);
const requestActivity = withRetryAndNotFound((request: { weeks: number; kind?: string }) =>
  ask(() => ownershipClient().getOwnershipActivity(request)),
);
const requestFundChanges = withRetryAndNotFound(
  (request: { from: string; to: string; limit: number }) =>
    ask(() => ownershipClient().listFundPositionChanges(request)),
);
const requestFundSeries = withRetryAndNotFound((request: { stockCode: string; fundFrom?: string; fundTo?: string }) =>
  ask(() => ownershipClient().getStockFundSeries(request)),
);
// A connection's companies: the register filtered to one holder kind and one sector (spec 14.7).
// The API's maximum, so the rail can rank the band's companies by the kind's own figure.
const CONNECTION_REGISTER_LIMIT = 100;
// Pages read at most: a sector's companies on one kind are read whole up to this many rows.
const CONNECTION_REGISTER_PAGES = 5;
const requestConnectionRegisters = withRetryAndNotFound(
  (request: { kind: string; industry: string; offset: number }) =>
    ask(() =>
      ownershipClient().listStockRegisters({
        sort: "disclosed",
        ascending: false,
        industry: request.industry,
        kind: request.kind,
        limit: CONNECTION_REGISTER_LIMIT,
        offset: request.offset,
      }),
    ),
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
  /**
   * The index funds compared in the fund window (spec 14.10): each with a file at its start (or
   * inside the window) and a newer one at the end. Zero when the window holds one file per fund,
   * so every fund change is n/a.
   */
  fundsCompared: number;
  /** The as-at range of the start files the comparison reads; "" when none. */
  startFilesFrom: string;
  startFilesTo: string;
  /** The as-at range of the end files the comparison reads; "" when none. */
  endFilesFrom: string;
  endFilesTo: string;
  /** The index fund window the figures compare, as the API served it (its snapshot dates); "" when none. */
  fundFrom: string;
  fundTo: string;
}

/** The fund comparison's fields of a map page that holds no answer: no fund is compared. */
const NO_FUND_COMPARISON = {
  fundsCompared: 0,
  startFilesFrom: "",
  startFilesTo: "",
  endFilesFrom: "",
  endFilesTo: "",
  fundFrom: "",
  fundTo: "",
} as const;

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
  /** The window's largest stated moves, ranked by the server (spec 14.10); empty when none or unread. */
  largestMoves: LargestMove[];
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
  /** The fund's shares in the stock at this file; null when the file states none (spec 14.10). */
  units: number | null;
}

/**
 * One index fund's own comparison of a stock over the fund window (spec 14.10): its file at the
 * window's start (or its first file inside it) against its newest file at the end. Each figure is
 * null where the files do not state it; a super option has none.
 */
export interface FundStockChange {
  startDate: string | null;
  startUnits: number | null;
  endDate: string | null;
  endUnits: number | null;
  /** End shares less start shares. */
  unitsChange: number | null;
  /** That change valued at the end file's price, in AUD. */
  changeValueAud: number | null;
}

/** One tracked fund's weight in a stock, over its snapshots, and its own change over the fund window. */
export interface FundSeriesRow {
  institutionSlug: string;
  institutionName: string;
  fundName: string;
  /** The ASX code the file names; "" for a super option (spec 14.7: label it with fundLabel). */
  fundCode: string;
  /** The fund's key, the one its page resolves under (fundHref). */
  fundKey: string;
  /** etf or super_phd. */
  sourceKind: string;
  points: FundSeriesPoint[];
  change: FundStockChange;
}

export interface StockFundSeriesPage {
  ok: boolean;
  error: string;
  stockCode: string;
  /** The fund window the comparisons read, as served; "" when unknown. */
  fundFrom: string;
  fundTo: string;
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
  // The fund window is its own pair of dates: a window named here is never the default view, so it is not kept.
  const fund = checkFundDates((input.fundFrom ?? "").trim(), (input.fundTo ?? "").trim());
  if ("error" in fund) return refusedMap(fund.error);
  if (range.kind === "empty") {
    return { ok: true, error: "", from: "", to: "", asOf: "", stocks: [], ...NO_FUND_COMPARISON };
  }
  if (range.kind === "outage" || skipForBuild()) return mapPage(undefined);
  const request = () => requestMap({ ...range.dates, fundFrom: fund.from, fundTo: fund.to });
  if (range.dates.from !== "" || fund.from !== "" || fund.to !== "") return mapPage(await request());
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

/**
 * The movement over the last weeks. `loadOwnershipActivity({})` is the default view.
 * `kind` is a holder kind of the vocabulary (spec 14.3, Activity's Holder type); ""
 * or left out is every kind. A kind outside the vocabulary is refused by the API.
 * Never throws.
 */
export async function loadOwnershipActivity(
  input: { weeks?: number; kind?: string } = {},
): Promise<OwnershipActivityPage> {
  if (!isQueryObject(input)) return refusedActivity(NOT_AN_OBJECT);
  const weeks = input.weeks;
  const served =
    typeof weeks === "number" && Number.isInteger(weeks) && weeks >= 1 && weeks <= ACTIVITY_WEEKS_DEFAULT
      ? weeks
      : ACTIVITY_WEEKS_DEFAULT;
  const kind = typeof input.kind === "string" && KIND_SHAPE.test(input.kind) ? input.kind : "";
  if (skipForBuild()) return activityPage(undefined);
  const request = () => requestActivity(kind === "" ? { weeks: served } : { weeks: served, kind });
  if (served !== ACTIVITY_WEEKS_DEFAULT || kind !== "") return activityPage(await request());
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

/**
 * One stock's weight in every tracked fund that holds it, and each fund's change in the stock's
 * shares over the fund window (spec 14.10). A window named by fundFrom and fundTo is sent; without
 * one the API takes its own default. Never throws.
 */
export async function loadStockFundSeries(
  input: { stockCode?: string; fundFrom?: string; fundTo?: string } = {},
): Promise<StockFundSeriesPage> {
  if (!isQueryObject(input)) return refusedSeries(NOT_AN_OBJECT, "");
  const stockCode = typeof input.stockCode === "string" ? input.stockCode.trim().toUpperCase() : "";
  if (!STOCK_CODE.test(stockCode)) return refusedSeries("the stock code must be 1 to 6 letters or digits", "");
  if (skipForBuild()) return seriesPage(undefined, stockCode);
  const fundFrom = typeof input.fundFrom === "string" ? input.fundFrom.trim() : "";
  const fundTo = typeof input.fundTo === "string" ? input.fundTo.trim() : "";
  const request: { stockCode: string; fundFrom?: string; fundTo?: string } = { stockCode };
  if (fundFrom !== "") request.fundFrom = fundFrom;
  if (fundTo !== "") request.fundTo = fundTo;
  return seriesPage(await requestFundSeries(request), stockCode);
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

/**
 * The notices a cell's rail reads: the first page of its week. The notice feed serves at most
 * 100 a page (pageMaxLimit in ownership_lists.go), so a larger limit would be served as 100 anyway;
 * a week that is longer than this is read in part and the rail says so.
 */
const CELL_LIMIT = 100;

/**
 * The selection the workspace's inspector asks about, read as the codec reads it
 * (a server action receives whatever the caller posts). A kind or key the codec
 * would not write is no selection.
 */
function cleanInspectorSelection(input: unknown): Selection | null {
  if (typeof input !== "object" || input === null) return null;
  const kind = (input as { kind?: unknown }).kind;
  // The zoomed sector is internal (backlog C4): it is no link kind, so it is read from its own name, not the codec's link form.
  if (kind === "sector") return sectorSelection((input as { sector?: unknown }).sector);
  if (typeof kind !== "string" || !(SELECTION_KINDS as readonly string[]).includes(kind)) return null;
  return parseSelection(serializeSelection(input as Selection));
}

/**
 * The companies on one connection: the register's current positions of the holder
 * kind in the sector, each with the kind's own figure (spec 14.7). Null when the
 * register could not be read; a refusal is an empty list with its total of zero.
 */
export async function loadConnectionCompanies(
  holderKind: string,
  sector: string,
): Promise<{ companies: ConnectionCompany[]; total: number } | null> {
  if (!KIND_SHAPE.test(holderKind) || sector === "") return null;
  if (skipForBuild()) return null;
  // Every page up to the cap, so the rail ranks the whole connection by exposure, not the first 100 by total.
  const companies: ConnectionCompany[] = [];
  let total = 0;
  for (let page = 0; page < CONNECTION_REGISTER_PAGES; page += 1) {
    const asked = await requestConnectionRegisters({
      kind: holderKind,
      industry: sector,
      offset: page * CONNECTION_REGISTER_LIMIT,
    });
    if (asked === undefined) return null;
    // The register refuses an industry it has no notice in (the API names its own industries), which a
    // band drawn from fund holdings can still reach: nothing on record for this connection, not an outage.
    if (asked.kind === "refused") {
      logRefusal(asked.reason);
      return { companies: [], total: 0 };
    }
    const answer: ListStockRegistersResponse = asked.response;
    total = answer.total;
    for (const stock of answer.stocks) {
      const share = stock.byKind.find((entry) => entry.kind === holderKind);
      companies.push({
        code: stock.stockCode,
        name: stock.companyName,
        pct: share === undefined ? null : share.pct,
        marketCap: stock.hasMarketCap ? stock.marketCap : null,
        latestNotice: stock.latestNoticeDate,
      });
    }
    if (answer.stocks.length < CONNECTION_REGISTER_LIMIT || companies.length >= total) break;
  }
  return { companies, total };
}

/**
 * The inspector's content for one selection on the workspace (spec 14.1), as the
 * plain contract the rail draws. A company reads the register and the fund series;
 * a connection reads the register's companies on it (spec 14.7); a cell reads the
 * notice feed for its filters, the holder kind included; a zoomed sector reads the
 * flows over the link's window (backlog C4). A read that failed is
 * thrown, so the rail says it could not load (an outage is never an empty record);
 * a selection this loader does not serve, or one with nothing on record, is null.
 * `lens` is the map's figure for a company (the disclosed notices by default).
 */
/** The link's parameters a page passes with a selection (spec 14.8); "" is unset. */
const NO_INSPECTOR_QUERY: InspectorQuery = { lens: "", view: "", window: "", since: "", until: "", asAt: "" };

/** The notices a connection's Change view lists: the window's first rows, the rest counted. */
const CONNECTION_NOTICE_LIMIT = 10;

/** The window a connection reads, from the link: a brushed pair, else the chips' days (clamped). */
function connectionWindow(query: InspectorQuery): ConnectionSpan {
  const days = Number(query.window);
  const windowDays = (DESK_WINDOWS as readonly number[]).includes(days) ? days : DEFAULT_DESK_WINDOW;
  if (isIsoDate(query.since) && isIsoDate(query.until)) {
    return { window: String(windowDays), since: query.since, until: query.until };
  }
  return { window: String(windowDays), since: "", until: "" };
}

/**
 * The index fund window a link names (spec 14.10): its two snapshot dates, both or neither. A
 * date that is not one, or an inverted pair, is no window, so a fund's change is n/a.
 */
function fundDatesOf(query: InspectorQuery): { fundFrom: string; fundTo: string } {
  const from = query.from ?? "";
  const to = query.to ?? "";
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return { fundFrom: "", fundTo: "" };
  return { fundFrom: from, fundTo: to };
}

/**
 * The notice window a link names, as dates, for the index fund window it shares when the link
 * names no fund dates (spec 14.10). It is resolved as the map resolves its window, so a chip
 * (28, 91, 182, 364 days) or a brushed pair gives the map's dates; the default window, or any
 * window that cannot be dated, sends none and the API applies its own default, as the map does.
 */
async function linkNoticeDates(query: InspectorQuery): Promise<{ fundFrom: string; fundTo: string }> {
  const span = connectionWindow(query);
  const range = await resolveRange({ window: Number(span.window), since: span.since, until: span.until });
  if (range.kind !== "range") return { fundFrom: "", fundTo: "" };
  return { fundFrom: range.dates.from, fundTo: range.dates.to };
}

/**
 * The notice window a stock's reading counts over, as dates (spec 14.8). The desk resolves it the way the
 * connections do: a brushed pair as it stands, else the chip's days counted back from the newest notice the
 * market read. Null when the window cannot be dated (an outage, or no notice on record), so the reading names
 * no count rather than one over a guessed window.
 */
async function stockNoticeWindow(query: InspectorQuery): Promise<StockNoticeWindow | null> {
  const span = connectionWindow(query);
  const brushed = span.since !== "" && span.until !== "";
  const answer: RangeAnswer = brushed
    ? await resolveRange({ since: span.since, until: span.until })
    : await datedWindow(Number(span.window));
  if (answer.kind !== "range") return null;
  return { since: answer.dates.from, until: answer.dates.to, days: brushed ? null : Number(span.window) };
}

/**
 * The largest holders of a connection's band, from the flows' current positions (spec 14.10).
 * Null when the flows did not answer, so the rail draws no holders rather than an empty list.
 */
async function bandHolders(holderKind: string, sector: string): Promise<FlowHolderRow[] | null> {
  const flows = await loadOwnershipFlows({});
  if (!flows.ok) return null;
  const band = flows.positions.find((position) => position.kind === holderKind && position.industry === sector);
  return band?.topHolders ?? [];
}

/**
 * The newest notice date the desk reads (backlog C6): the map's as-of, the newest notice the market
 * read. When the map did not answer, the newest of the given dates (a stock's panel states its own).
 * "" when neither states one, so a strip is not drawn over a guessed end.
 */
async function deskAsOf(fallbackDates: readonly string[] = []): Promise<string> {
  const map = await loadOwnershipMap({});
  if (map.ok && isIsoDate(map.asOf)) return map.asOf;
  return fallbackDates.reduce((latest, date) => (isIsoDate(date) && date > latest ? date : latest), "");
}

/**
 * A stock's notice dates over the strip's 26 weeks (backlog C6), or null when they cannot be read whole.
 * The feed is asked for the span the strip draws, from the Monday of its first week through the as-of,
 * one page after another (readWeekNotices), at the feed's own page size.
 */
async function stockWeekNotices(code: string, panelDates: readonly string[]): Promise<WeekNotices | null> {
  const asOf = await deskAsOf(panelDates);
  const span = weekWindow(asOf);
  if (span === null) return null;
  return readWeekNotices(
    loadNoticeFeed,
    { stockCode: code, since: span.since, until: span.until, limit: PAGE_MAX_LIMIT, includeActivity: false },
    asOf,
  );
}

export async function loadInspector(
  selection: Selection,
  query: InspectorQuery = NO_INSPECTOR_QUERY,
): Promise<InspectorContent | null> {
  const clean = cleanInspectorSelection(selection);
  if (clean === null) return null;
  // The lens is read from the link, and an unknown one is the default (spec 14.7).
  const lens: DeskLens = (DESK_LENSES as readonly string[]).includes(query.lens)
    ? (query.lens as DeskLens)
    : DEFAULT_DESK_LENS;
  switch (clean.kind) {
    case "stock": {
      // The map's fund window is the link's fund dates, or the notice window when the link names none
      // (the map resolves that window to dates; see linkNoticeDates). The series reads the same window,
      // so each fund's line compares the files the map compares.
      const fund = fundDatesOf(query);
      const fundWindow = fund.fundFrom !== "" ? fund : await linkNoticeDates(query);
      const [panel, series, notices] = await Promise.all([
        loadStockPanel(clean.code),
        loadStockFundSeries({ stockCode: clean.code, ...fundWindow }),
        stockNoticeWindow(query),
      ]);
      if (!panel.ok) throw new Error("the register could not be read");
      // The strip's notices are read after the panel, which names the newest notice a desk with no map can end on.
      const weekly = await stockWeekNotices(
        clean.code,
        panel.notices.map((notice) => notice.announcedOn),
      );
      return stockInspectorContent(panel, series.ok ? series : null, lens, notices, weekly);
    }
    case "connection": {
      // The folded tail is several sectors under one label: no register filter, so it is withheld like Other.
      if (clean.sector === OTHER_SECTOR || clean.sector === FOLDED_SECTOR_LABEL) {
        return connectionInspectorContent({ holderKind: clean.holderKind, sector: clean.sector, companies: null });
      }
      const span = connectionWindow(query);
      const changes = query.view === "changes";
      // The window as dates (spec 14.8): a brushed pair is the window as it stands (validated
      // like any span); the chips' days are counted back from the newest notice, because the
      // feed serves 7, 30, 90 and 365 days and rounds a day count up. The Change view lists
      // those notices and fails with them; the Positions view links the same dates when
      // they are known and keeps the chips' window when they are not.
      const brushed = span.since !== "" && span.until !== "";
      const answer: RangeAnswer = brushed
        ? await resolveRange({ since: span.since, until: span.until })
        : await datedWindow(Number(span.window));
      if (changes && (answer.kind === "outage" || answer.kind === "refused")) {
        throw new Error("the notices could not be read");
      }
      const range: RangeAnswer | null = changes || answer.kind === "range" ? answer : null;
      const dated = range?.kind === "range" ? range.dates : null;
      const noticeSpan: ConnectionSpan = dated ? { window: span.window, since: dated.from, until: dated.to } : span;
      const [read, feed, holders] = await Promise.all([
        loadConnectionCompanies(clean.holderKind, clean.sector),
        changes && range?.kind !== "empty"
          ? loadNoticeFeed({
              since: dated?.from ?? "",
              until: dated?.to ?? "",
              industry: clean.sector,
              kind: clean.holderKind,
              includeActivity: false,
              limit: CONNECTION_NOTICE_LIMIT,
            })
          : Promise.resolve(null),
        bandHolders(clean.holderKind, clean.sector),
      ]);
      if (read === null) throw new Error("the registers could not be read");
      if (feed !== null && !feed.ok) throw new Error("the notices could not be read");
      return connectionInspectorContent({
        holderKind: clean.holderKind,
        sector: clean.sector,
        companies: read.companies,
        total: read.total,
        view: changes ? "changes" : "positions",
        span: noticeSpan,
        holders,
        notices:
          feed === null
            ? changes && range?.kind === "empty"
              ? { rows: [], total: 0 }
              : null
            : {
                rows: feed.rows.map((row) => ({
                  released: row.released,
                  code: row.code,
                  holder: row.holder,
                  changePp: changePpOf(row),
                })),
                total: feed.total,
              },
      });
    }
    case "sector": {
      // The zoomed sector's holders (backlog C4): the flows over the link's window, the range the panes read.
      // An outage or a refusal is thrown, so the rail says it could not load and never draws an empty sector.
      const span = connectionWindow(query);
      const flows = await loadOwnershipFlows({ window: Number(span.window), since: span.since, until: span.until });
      if (!flows.ok || flows.error !== "") throw new Error("the flows could not be read");
      // The holders' links keep the reader's lens and fund dates, as the link names them (spec 14.8); a default is not written.
      const fund = fundDatesOf(query);
      const keep = {
        lens: lens === DEFAULT_DESK_LENS ? "" : lens,
        view: query.view ?? "",
        from: fund.fundFrom,
        to: fund.fundTo,
      };
      return sectorInspectorContent({ sector: clean.sector, flows, window: span, keep });
    }
    case "cell": {
      // The Other row is the placeholder industry: the feed cannot filter to it, so its count is withheld.
      if (clean.sector === OTHER_SECTOR) {
        return cellInspectorContent({ sector: clean.sector, weekStart: clean.date, feed: null, kind: clean.holderKind });
      }
      const feed = await loadNoticeFeed({
        industry: clean.sector,
        since: clean.date,
        until: shiftDate(clean.date, 6),
        kind: clean.holderKind,
        includeActivity: false,
        limit: CELL_LIMIT,
      });
      if (!feed.ok) throw new Error("the notices could not be read");
      return cellInspectorContent({ sector: clean.sector, weekStart: clean.date, feed, kind: clean.holderKind });
    }
    default:
      return null;
  }
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
  return datedWindow(window);
}

/**
 * A window of `days` as dates, counted back from the newest notice. The newest comes
 * from the default activity, which the KV layer keeps: a chip never asks for a week
 * of activity just to learn a date. The default window is dated too (the Connections
 * Change view lists the window's own notices, and the feed rounds a day count up).
 */
async function datedWindow(days: number): Promise<RangeAnswer> {
  if (skipForBuild()) return { kind: "outage" };
  const newest = await loadOwnershipActivity();
  if (newest.error !== "") return { kind: "refused", error: newest.error };
  if (!newest.ok) return { kind: "outage" };
  if (newest.asOf === "") return { kind: "empty" };
  const dates = windowDates(days, newest.asOf);
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
    industry: summary.industry,
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
    return { ok: false, error: "", from: "", to: "", asOf: "", stocks: [], ...NO_FUND_COMPARISON };
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
        fundValueAud: stock.hasFundValue ? stock.fundValueAud : null,
        fundFlowAud: stock.hasFundFlow ? stock.fundFlowAud : null,
        fundChangePct: stock.hasFundChange ? stock.fundChangePct : null,
        notices: stock.notices,
      }),
    ),
    fundsCompared: response.fundsCompared,
    startFilesFrom: response.startFilesFrom,
    startFilesTo: response.startFilesTo,
    endFilesFrom: response.endFilesFrom,
    endFilesTo: response.endFilesTo,
    fundFrom: response.fundFrom,
    fundTo: response.fundTo,
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
        topHolders: position.topHolders.map((holder) => ({
          slug: holder.slug,
          name: holder.name,
          exposureAud: holder.hasExposure ? holder.exposureAud : null,
          holdings: holder.holdings,
        })),
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
    return { ok: false, error: "", fromWeek: "", toWeek: "", asOf: "", rows: [], largestMoves: [] };
  }
  return {
    ok: true,
    error: "",
    fromWeek: response.fromWeek,
    toWeek: response.toWeek,
    asOf: response.asOf,
    largestMoves: response.largestMoves.map(
      (move): LargestMove => ({
        code: move.stockCode,
        holder: move.holderName,
        url: move.announcementUrl,
        released: move.announcedOn,
        change: move.changePp,
      }),
    ),
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
  if (response === undefined) return { ok: false, error: "", stockCode, fundFrom: "", fundTo: "", funds: [] };
  return {
    ok: true,
    error: "",
    stockCode: response.stockCode,
    fundFrom: response.fundFrom,
    fundTo: response.fundTo,
    funds: response.funds.map(
      (fund): FundSeriesRow => ({
        institutionSlug: fund.institutionSlug,
        institutionName: fund.institutionName,
        fundName: fund.fundName,
        fundCode: fund.fundCode,
        fundKey: fund.fundKey,
        sourceKind: fund.sourceKind,
        points: fund.points.map(
          (point): FundSeriesPoint => ({
            asAt: point.asAt,
            weightPct: point.hasWeight ? point.weightPct : null,
            valueAud: point.hasValue ? point.valueAud : null,
            units: point.hasUnits ? point.units : null,
          }),
        ),
        change: {
          startDate: fund.hasStartDate ? fund.startDate : null,
          startUnits: fund.hasStartUnits ? fund.startUnits : null,
          endDate: fund.hasEndDate ? fund.endDate : null,
          endUnits: fund.hasEndUnits ? fund.endUnits : null,
          unitsChange: fund.hasUnitsChange ? fund.unitsChange : null,
          changeValueAud: fund.hasChangeValueAud ? fund.changeValueAud : null,
        },
      }),
    ),
  };
}
