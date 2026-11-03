"use server";

/**
 * The explorer's two list pages as plain data: the notices feed
 * (/ownership/notices) and the registers table (/ownership/stocks).
 *
 * WHY A SEPARATE `"use server"` MODULE. The readers in getOwnership.ts are
 * `cache(withRetryAndNotFound(...))` wrappers, which cannot carry the directive.
 * Each page's island is handed these actions to re-query, and the page calls
 * them for its default render. The same function serves both, so the two can
 * never render different shapes.
 *
 * WHY THE ROWS ARE THE ISLANDS' OWN TYPES. Each island declares the row it draws
 * (notice-feed-explorer.tsx, register-rows-table.tsx), and this module imports
 * those types, as politicianTable.ts does. A row that drifts from what its island
 * reads fails tsc here, before any page is wired. Only plain rows cross the RSC
 * boundary: strings, numbers, booleans, nulls, and the arrays and objects of
 * them. The generated messages (a `$typeName`, their own prototypes) never do.
 *
 * NEVER THROWS, AND `ok` MEANS THE QUERY WAS SERVED. A failed read and a filter
 * nobody matches both arrive as zero rows, and they mean opposite things: one is
 * our outage, the other is an honest answer about the filter. `ok: false` is an
 * outage (the retry wrapper's undefined, with an empty `error`) or a refusal, with
 * its reason in `error`. `ok: true` with no rows is the honest answer. A query
 * the clamp refuses, or an argument that is not an object, makes no request at
 * all. A query the API refuses (InvalidArgument) is a refusal too, and no retry
 * changes it. Every refusal says why in `error` and is logged. The islands draw
 * every `ok: false` as the outage copy. A reader can reach a refusal: the clamp
 * keeps any well-formed holder slug, so a stale or hand-edited `?holder=` link
 * goes to the API, which refuses a slug the registry does not list.
 *
 * KV ONLY FOR THE DEFAULT VIEW. Each page's default view is one entry under a
 * versioned key, and only a populated answer is kept. The entry is the API's
 * answer as proto JSON, and every read maps it again, so a change to the mapping
 * needs no new version, unless a field's meaning changes or the mapping starts
 * reading a field the API did not send when the entry was written: the old entry
 * still parses, with that field empty, and a deploy does not flush KV. An empty
 * or failed read is never pinned for six hours. Every other query is a live read:
 * the API's own page-one cache and its in-memory registers are the dedupe, and a
 * key per filter value would store an entry for every choice a visitor makes.
 */

import {
  ListStockRegistersResponseSchema,
  ListSubstantialNoticesResponseSchema,
  type ListStockRegistersRequest,
  type ListStockRegistersResponse,
  type ListSubstantialNoticesRequest,
  type ListSubstantialNoticesResponse,
  type NoticeActivity,
  type NoticeWeek,
  type OwnershipStock,
  type SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import type {
  NoticeFeedPage as NoticeFeedIslandPage,
  NoticeFeedRow,
} from "~/@/components/ownership/notice-feed-explorer";
import type { NoticeWeekBar } from "~/@/components/ownership/notice-week-bars";
import type { RegisterStockRow } from "~/@/components/ownership/register-rows-table";
import type {
  RegisterIndustry,
  RegistersPage as RegistersIslandPage,
} from "~/@/components/ownership/registers-explorer";
import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { INVESTOR_KINDS, asAtRange } from "~/@/lib/ownership/kinds";
import {
  clampNoticeQuery,
  clampRegistersQuery,
  defaultNoticeQuery,
  defaultRegistersQuery,
  isDefaultNoticeQuery,
  isDefaultRegistersQuery,
  wantsActivity,
  type NoticeQuery,
  type NoticeQueryInput,
  type RegistersQuery,
  type RegistersQueryInput,
} from "~/@/lib/ownership/query";
import { noticeRow } from "~/@/lib/ownership/rows";
import { CACHE_KEYS } from "@/lib/kv-cache";
import { skipForBuild } from "./config";
import { cachedRead, ownershipClient, type ProtoSchema } from "./ownership-shared";
import { withRetryAndNotFound } from "./withRetry";

type NoticeRequest = Pick<
  ListSubstantialNoticesRequest,
  | "windowDays"
  | "event"
  | "kind"
  | "stockCode"
  | "industry"
  | "since"
  | "until"
  | "institutionSlug"
  | "cursor"
  | "limit"
  | "includeActivity"
>;

type RegistersRequest = Pick<
  ListStockRegistersRequest,
  | "sort"
  | "ascending"
  | "industry"
  | "kind"
  | "minInterests"
  | "minShortPct"
  | "query"
  | "limit"
  | "offset"
>;

/**
 * The API's answer to one request: its response, or its refusal of the arguments
 * it was sent. A refusal is an answer, so the retry wrapper never takes it for a
 * failure and never retries it.
 */
type Asked<T> = { kind: "answered"; response: T } | { kind: "refused"; reason: string };

/** Connect's InvalidArgument (gRPC code 3). A constant, as withRetry.ts holds NotFound. */
const CODE_INVALID_ARGUMENT = 3;

/**
 * Asks the API. InvalidArgument is the API refusing the arguments, which no retry
 * changes, so it comes back as a refusal. Any other failure is thrown, and the
 * retry wrapper answers it undefined: an outage.
 */
async function ask<T>(call: () => Promise<T>): Promise<Asked<T>> {
  try {
    return { kind: "answered", response: await call() };
  } catch (error) {
    const reason = refusalReason(error);
    if (reason === undefined) throw error;
    return { kind: "refused", reason };
  }
}

/** The server's own message for an InvalidArgument error, or undefined for any other error. */
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

// withRetryAndNotFound answers undefined for every failure. That undefined is
// this module's outage, so it is reported as ok: false and never as an empty answer.
const requestNotices = withRetryAndNotFound((request: NoticeRequest) =>
  ask(() => ownershipClient().listSubstantialNotices(request)),
);
const requestRegisters = withRetryAndNotFound((request: RegistersRequest) =>
  ask(() => ownershipClient().listStockRegisters(request)),
);

/** The window's counts by event, and its largest moves. Its weekly counts are the page's `weeks`. */
export interface NoticeActivityRows {
  became: number;
  increased: number;
  decreased: number;
  changed: number;
  ceased: number;
  nz: number;
  /** Form 604 notices with both figures, by the largest rise in percentage points: at most five. */
  largestRises: NoticeFeedRow[];
  /** The same notices by the largest fall. */
  largestFalls: NoticeFeedRow[];
}

/**
 * The feed's answer to one query: the island's page, with the newest release
 * date, the activity the window owes and why a refused query was refused.
 */
export interface NoticeFeedPage extends NoticeFeedIslandPage {
  /** Why the query was refused, by the clamp or by the API; "" when it was served or the read failed. Logged. */
  error: string;
  /** The newest notice release date read; "" when none. */
  asOf: string;
  /** The window's counts and largest moves when it carries activity; null otherwise. */
  activity: NoticeActivityRows | null;
}

/**
 * The register's answer to one query: the island's page, with the newest release
 * date and the universe the filters are counted against.
 */
export interface RegistersPage extends RegistersIslandPage {
  /** Why the query was refused, by the clamp or by the API; "" when it was served or the read failed. Logged. */
  error: string;
  /** The newest notice release date read; "" when none. */
  asOf: string;
  /** Always true: the register carries no activity to owe. */
  activityOk: boolean;
  /** Stocks with at least one current holder, before the filters. */
  universe: number;
}

/** The argument a server action receives is whatever the caller posted, so only a plain object is read. */
const NOT_AN_OBJECT = "the query must be an object";

/**
 * The notices feed for one query. `loadNoticeFeed({})` is the default view: the
 * last 30 days with their activity, on the first page. Never throws.
 */
export async function loadNoticeFeed(input: NoticeQueryInput = {}): Promise<NoticeFeedPage> {
  if (!isQueryObject(input)) return refusedFeed(NOT_AN_OBJECT);
  const clamped = clampNoticeQuery(input);
  if (!clamped.ok) return refusedFeed(clamped.error);
  return readNoticeFeed(clamped.query);
}

/**
 * The registers table for one query. `loadStockRegisters({})` is the default
 * view: sorted by disclosed voting power, unfiltered, on the first page. Never throws.
 */
export async function loadStockRegisters(input: RegistersQueryInput = {}): Promise<RegistersPage> {
  if (!isQueryObject(input)) return refusedRegisters(NOT_AN_OBJECT);
  const clamped = clampRegistersQuery(input);
  if (!clamped.ok) return refusedRegisters(clamped.error);
  return readRegisters(clamped.query);
}

function isQueryObject(input: unknown): boolean {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * A refusal is logged, cut short: a reason can quote the caller's own text, and the
 * log only needs its start to tell the refusals apart.
 */
const REFUSAL_LOG_CHARS = 200;

/** Logs a refusal and returns it, so the reason is in `error` and in the log. */
function logRefusal(reason: string): string {
  console.warn(`[ownership explorer] refused query: ${reason.slice(0, REFUSAL_LOG_CHARS)}`);
  return reason;
}

/** A refused feed: the default view's shape with no answer in it, and the reason. */
function refusedFeed(error: string): NoticeFeedPage {
  return { ...mapNoticeFeed(defaultNoticeQuery(), undefined), error: logRefusal(error) };
}

/** A refused register: the default view's shape with no answer in it, and the reason. */
function refusedRegisters(error: string): RegistersPage {
  return { ...mapRegisters(defaultRegistersQuery(), undefined), error: logRefusal(error) };
}

async function readNoticeFeed(query: NoticeQuery): Promise<NoticeFeedPage> {
  if (skipForBuild()) return mapNoticeFeed(query, undefined);
  const request = () => requestNotices(noticeRequest(query));
  if (!isDefaultNoticeQuery(query)) return mapNoticeFeed(query, await request());
  const asked = await cachedAsked(
    CACHE_KEYS.ownershipNotices(),
    ListSubstantialNoticesResponseSchema,
    (answer: ListSubstantialNoticesResponse) => noticesArePopulated(answer, query),
    request,
  );
  return mapNoticeFeed(query, asked);
}

async function readRegisters(query: RegistersQuery): Promise<RegistersPage> {
  if (skipForBuild()) return mapRegisters(query, undefined);
  const request = () => requestRegisters(registersRequest(query));
  if (!isDefaultRegistersQuery(query)) return mapRegisters(query, await request());
  const asked = await cachedAsked(
    CACHE_KEYS.ownershipRegisters(),
    ListStockRegistersResponseSchema,
    registersArePopulated,
    request,
  );
  return mapRegisters(query, asked);
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

/**
 * Kept: an answer with notices, and the activity the window owes. An empty answer
 * is not kept, and neither is one whose activity did not come back.
 */
function noticesArePopulated(answer: ListSubstantialNoticesResponse, query: NoticeQuery): boolean {
  return answer.notices.length > 0 && (!wantsActivity(query) || answer.activity !== undefined);
}

function registersArePopulated(answer: ListStockRegistersResponse): boolean {
  return answer.stocks.length > 0;
}

function noticeRequest(query: NoticeQuery): NoticeRequest {
  return {
    windowDays: query.windowDays,
    event: query.event,
    kind: query.kind,
    stockCode: query.stockCode,
    industry: query.industry,
    since: query.since,
    until: query.until,
    institutionSlug: query.institutionSlug,
    cursor: query.cursor,
    limit: query.limit,
    // Asked exactly when the page is due the activity (wantsActivity), so a load-more
    // never asks for it: the API serves activity on a first page only.
    includeActivity: wantsActivity(query),
  };
}

function registersRequest(query: RegistersQuery): RegistersRequest {
  return {
    sort: query.sort,
    ascending: query.ascending,
    industry: query.industry,
    kind: query.kind,
    minInterests: query.minInterests,
    minShortPct: query.minShortPct,
    query: query.query,
    limit: query.limit,
    offset: query.offset,
  };
}

function mapNoticeFeed(
  query: NoticeQuery,
  asked: Asked<ListSubstantialNoticesResponse> | undefined,
): NoticeFeedPage {
  if (asked?.kind === "refused") {
    return {
      ...mapNoticeFeed(query, undefined),
      error: logRefusal(`refused by the API: ${asked.reason}`),
    };
  }
  const response = asked?.response;
  if (response === undefined) {
    return {
      ok: false,
      activityOk: !wantsActivity(query),
      error: "",
      query,
      rows: [],
      total: 0,
      asOf: "",
      nextCursor: "",
      weeks: [],
      activity: null,
    };
  }
  const activity = response.activity ? activityRows(response.activity) : null;
  return {
    ok: true,
    activityOk: !wantsActivity(query) || activity !== null,
    error: "",
    query,
    rows: response.notices.map(feedRow),
    total: response.total,
    asOf: response.asOf,
    nextCursor: response.nextCursor,
    weeks: response.activity ? response.activity.weeks.map(weekBar) : [],
    activity,
  };
}

function mapRegisters(
  query: RegistersQuery,
  asked: Asked<ListStockRegistersResponse> | undefined,
): RegistersPage {
  if (asked?.kind === "refused") {
    return {
      ...mapRegisters(query, undefined),
      error: logRefusal(`refused by the API: ${asked.reason}`),
    };
  }
  const response = asked?.response;
  if (response === undefined) {
    return {
      ok: false,
      activityOk: true,
      error: "",
      query,
      rows: [],
      total: 0,
      asOf: "",
      universe: 0,
      industries: [],
    };
  }
  return {
    ok: true,
    activityOk: true,
    error: "",
    query,
    rows: response.stocks.map(registerRow),
    total: response.total,
    asOf: response.asOf,
    universe: response.universe,
    industries: response.industries.map(
      (row): RegisterIndustry => ({ industry: row.industry, stocks: row.stocks }),
    ),
  };
}

/**
 * A notice as the feed prints it. The holder and the figures are rows.ts's
 * noticeRow, so one notice reads the same here as on the stock and holder tables.
 * The feed adds the event, which the island labels from the API's decision, and
 * the company's name.
 */
function feedRow(notice: SubstantialNotice): NoticeFeedRow {
  // noticeRow names the holder whenever it is asked to, so the holder is always set.
  const row = noticeRow(notice, true);
  const holder = row.holder!;
  return {
    released: row.released,
    event: notice.event,
    code: row.code,
    companyName: notice.companyName,
    holder: holder.name,
    holderHref: holder.href,
    votingPower: row.votingPower,
    change: row.change,
    url: row.url,
  };
}

/** One week of the window: the notices released in it, every event counted. */
function weekBar(week: NoticeWeek): NoticeWeekBar {
  return {
    weekStart: week.weekStart,
    count: week.became + week.increased + week.decreased + week.changed + week.ceased + week.nz,
  };
}

function activityRows(activity: NoticeActivity): NoticeActivityRows {
  return {
    became: activity.became,
    increased: activity.increased,
    decreased: activity.decreased,
    changed: activity.changed,
    ceased: activity.ceased,
    nz: activity.nz,
    largestRises: activity.largestRises.map(feedRow),
    largestFalls: activity.largestFalls.map(feedRow),
  };
}

/**
 * A kind's disclosed share of one stock, printed as stage 1 prints it. A kind
 * nobody holds sums to 0.00%, the figure the API ranks it by. Printing n/a there
 * would show an unknown on a row the API sorts as a known zero, so an ascending
 * column would open on rows that read as unknowns.
 */
function kindShare(stock: OwnershipStock, accept: (kind: string) => boolean): string {
  const pct = stock.byKind.reduce((sum, kind) => (accept(kind.kind) ? sum + kind.pct : sum), 0);
  return formatPct(pct, { digits: 2 });
}

/**
 * A stock's register row. Each figure keeps its own date, because they are not on
 * one date: the index files span a range, and ASIC's short position is as of its
 * report. A figure the stock does not state carries no date either, so no key is
 * sent for it.
 */
function registerRow(stock: OwnershipStock): RegisterStockRow {
  return {
    code: stock.stockCode,
    companyName: stock.companyName,
    industry: stock.industry,
    interests: String(stock.byKind.reduce((total, kind) => total + kind.holders, 0)),
    disclosed: formatPct(stock.disclosedPct, { digits: 2 }),
    disclosedPct: stock.disclosedPct,
    byKind: stock.byKind.map((kind) => ({
      kind: kind.kind,
      pct: kind.pct,
      holders: kind.holders,
    })),
    institutions: kindShare(stock, (kind) => INVESTOR_KINDS.has(kind)),
    banks: kindShare(stock, (kind) => kind === "bank_broker"),
    hedgeActive: kindShare(stock, (kind) => kind === "hedge_fund" || kind === "active_manager"),
    index: stock.hasIndexPct ? formatPct(stock.indexPct, { digits: 2 }) : "n/a",
    ...(stock.hasIndexPct && (stock.indexAsAtFrom || stock.indexAsAtTo)
      ? { indexAsAt: asAtRange(stock.indexAsAtFrom, stock.indexAsAtTo) }
      : {}),
    superOptions: String(stock.superOptions),
    superValue: stock.hasSuperValue ? formatAmount(stock.superValueAud, "AUD") : "n/a",
    short: stock.hasShortPct ? formatPct(stock.shortPct, { digits: 2 }) : "n/a",
    ...(stock.hasShortPct && stock.shortAsOf ? { shortAsOf: stock.shortAsOf } : {}),
    latestNotice: stock.latestNoticeDate,
  };
}
