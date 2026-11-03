/**
 * The explorer's two list requests as the web builds them: the clamps the Go
 * handlers apply (services/shorts/internal/services/shorts/ownership_lists.go)
 * and the URL codec the islands use to read and write their state.
 *
 * A clamp returns the query the API will run, or refuses it, so an action never
 * sends a request the API would refuse on its shape. The registry and the
 * industry list are the API's own check. The shared fixture
 * __fixtures__/clamps.json holds this file and the Go handlers to the same
 * values. The codec reads a link the way the clamp serves it, one parameter at a
 * time: a window rounds as the API rounds it, and a value of the wrong shape
 * takes its default, so one bad parameter never costs the rest. A well-formed
 * holder slug, and an industry when the page has no list, is left for the API,
 * which refuses one the registry does not hold: a stale link ends in a refusal
 * the island draws as the outage, not in a silently different view.
 */

import { KIND_ORDER, REGISTER_CODE_PATTERN, isInstitutionSlug, type OwnershipKind } from "./kinds";

/** The windows the feed serves, in days. A request rounds up to the next one. */
export const NOTICE_WINDOWS: readonly number[] = [7, 30, 90, 365];
/** The window of the feed's default view, and of a request that names no window. */
export const DEFAULT_NOTICE_WINDOW = 30;
/** Every notice the register holds, sent as window 0. */
export const NOTICE_WINDOW_ALL = 0;
/** The widest window that carries activity: its weekly buckets and largest moves. */
export const ACTIVITY_MAX_WINDOW = 90;
/**
 * Whether a feed request that does not say asks for activity. The default view
 * draws its week bars from it, so the default asks. The API itself reads an
 * omitted flag as false.
 */
const DEFAULT_NOTICE_ACTIVITY = true;

export const NOTICE_EVENTS = [
  "became",
  "increased",
  "decreased",
  "changed",
  "ceased",
  "nz",
] as const;
export type NoticeEvent = (typeof NOTICE_EVENTS)[number];

export const REGISTER_SORTS = [
  "disclosed",
  "investors",
  "banks",
  "hedge_active",
  "short",
  "index",
  "super_value",
  "super_options",
  "interests",
  "latest_notice",
  "code",
] as const;
export type RegisterSort = (typeof REGISTER_SORTS)[number];
export const DEFAULT_REGISTER_SORT: RegisterSort = "disclosed";
/** The minimum short position the register filters by. 0 filters nothing. */
export const REGISTER_SHORT_STEPS: readonly number[] = [0, 1, 3, 5, 10];
export const REGISTER_MAX_OFFSET = 5000;
/** The longest register query, in characters (code points, not UTF-16 units). */
export const REGISTER_MAX_QUERY = 24;

export const PAGE_DEFAULT_LIMIT = 50;
export const PAGE_MAX_LIMIT = 100;

/** The register holds no notice older than this, and Postgres takes no year 0000. */
const CURSOR_EARLIEST = "2000-01-01";

/** The range of the proto's int32 fields: a number outside it cannot reach the API. */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const WHOLE = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERCENT = /^\d+(\.\d+)?$/;

export function isNoticeEvent(value: string): value is NoticeEvent {
  return (NOTICE_EVENTS as readonly string[]).includes(value);
}

function isInt32(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
  );
}

/**
 * A request is an object of fields. A server action's arguments are whatever the
 * caller posted, so anything else (undefined, null, text, a list) is refused.
 */
function isRequestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_A_REQUEST = "the request must be an object of its fields";

/**
 * A request's text, folded. "" when the caller left it out (undefined or null),
 * and null when it is not text at all. A server action's arguments are whatever
 * the caller posted, so a number where a word belongs is refused, never coerced.
 */
function requestText(
  value: unknown,
  fold: (text: string) => string = (text) => text,
): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? fold(value) : null;
}

function lowerTrim(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A word checked against its vocabulary: "" when the request names none, the
 * word when it is listed, and null when it is not, or is not text at all.
 */
function inVocabulary<T extends string>(value: string | null, words: readonly T[]): T | "" | null {
  if (value === null) return null;
  if (value === "") return "";
  return (words as readonly string[]).includes(value) ? (value as T) : null;
}

/** A value for an error message: text quoted, anything else named as not text. */
function quoted(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : "(not text)";
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * The window a request for `days` is served as: the next served window up,
 * the whole register above the widest, and null for a negative request.
 */
function servedWindow(days: number): number | null {
  if (days < 0) return null;
  return NOTICE_WINDOWS.find((w) => days > 0 && days <= w) ?? NOTICE_WINDOW_ALL;
}

/** 0 and below mean the default page, and anything above the maximum is the maximum. */
function pageLimit(limit: number): number {
  if (limit <= 0) return PAGE_DEFAULT_LIMIT;
  return Math.min(limit, PAGE_MAX_LIMIT);
}

/**
 * The step a minimum short position snaps down to. NaN and anything under 1
 * filter nothing; a position above 10 is the 10 step.
 */
export function snapShortPct(pct: number): number {
  return [...REGISTER_SHORT_STEPS].reverse().find((step) => pct >= step) ?? 0;
}

/** A YYYY-MM-DD date that exists: 2026-02-30 and 2025-02-29 do not. */
function isCalendarDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const day = new Date(0);
  day.setUTCFullYear(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return day.toISOString().slice(0, 10) === date;
}

/** A cursor is the previous page's next_cursor: YYYY-MM-DD|announcement_url. The URL is never empty. */
function isNoticeCursor(cursor: string): boolean {
  const bar = cursor.indexOf("|");
  if (bar < 0 || cursor.slice(bar + 1) === "") return false;
  const date = cursor.slice(0, bar);
  return isCalendarDate(date) && date >= CURSOR_EARLIEST;
}

/** A feed query as the API runs it. */
export interface NoticeQuery {
  /** 0 for every notice the register holds, else a served window. */
  windowDays: number;
  event: NoticeEvent | "";
  kind: OwnershipKind | "";
  /** Upper case, 1 to 6 letters or digits, or "". */
  stockCode: string;
  /**
   * A lower-case slug in the shape a registry slug takes, or "". The API checks it
   * against the registry.
   */
  institutionSlug: string;
  /** The previous page's next_cursor, or "" for a first page. */
  cursor: string;
  limit: number;
  includeActivity: boolean;
}

/** A feed query as a caller states it. A field left out takes its default. */
export interface NoticeQueryInput {
  /** Left out means the default window (30). 0 means every notice the register holds. */
  windowDays?: number;
  event?: string;
  kind?: string;
  stockCode?: string;
  institutionSlug?: string;
  cursor?: string;
  limit?: number;
  /** Left out means true: the default view's week bars read it. */
  includeActivity?: boolean;
}

/** A register list query as the API runs it. */
export interface RegistersQuery {
  sort: RegisterSort;
  ascending: boolean;
  /** Trimmed. The API checks it against the register's industries. */
  industry: string;
  kind: OwnershipKind | "";
  /** Interests counted once, at least 1. */
  minInterests: number;
  /** One of REGISTER_SHORT_STEPS. */
  minShortPct: number;
  /** The query as typed, trimmed. See registerQueryMatch for what it matches. */
  query: string;
  limit: number;
  offset: number;
}

/** A register list query as a caller states it. A field left out takes its default. */
export interface RegistersQueryInput {
  sort?: string;
  ascending?: boolean;
  industry?: string;
  kind?: string;
  minInterests?: number;
  minShortPct?: number;
  query?: string;
  limit?: number;
  offset?: number;
}

export type ClampResult<T> = { ok: true; query: T } | { ok: false; error: string };

/**
 * A feed query clamped the way the API clamps it. Refused input is never
 * truncated: a negative window, an unknown event or a malformed cursor is an
 * error, as InvalidArgument is. A field of the wrong type is refused in the same
 * way, as is a whole number outside the 32-bit range the API's fields carry, and
 * anything that is not an object of fields. An institution slug must have the
 * shape of a path segment, as the codec requires; only the API knows the
 * registry, so it refuses a slug of that shape the registry does not hold.
 */
export function clampNoticeQuery(input: unknown): ClampResult<NoticeQuery> {
  if (!isRequestObject(input)) return refuse(NOT_A_REQUEST);
  const requestedDays = input.windowDays ?? DEFAULT_NOTICE_WINDOW;
  if (!isInt32(requestedDays)) return refuse("window_days must be a whole number");
  const windowDays = servedWindow(requestedDays);
  if (windowDays === null) return refuse("window_days must not be negative");

  const event = inVocabulary(requestText(input.event, lowerTrim), NOTICE_EVENTS);
  if (event === null) return refuse(`event must be one of ${NOTICE_EVENTS.join(", ")}`);
  const kind = inVocabulary(requestText(input.kind, lowerTrim), KIND_ORDER);
  if (kind === null) return refuse(`kind ${quoted(input.kind)} is not a holder kind`);
  const stockCode = requestText(input.stockCode, (text) => text.trim().toUpperCase());
  if (stockCode === null) return refuse("stock_code must be text");
  if (stockCode !== "" && !REGISTER_CODE_PATTERN.test(stockCode)) {
    return refuse(`stock_code ${quoted(input.stockCode)} is not 1 to 6 letters or digits`);
  }
  const institutionSlug = requestText(input.institutionSlug, lowerTrim);
  if (institutionSlug === null) return refuse("institution_slug must be text");
  if (institutionSlug !== "" && !isInstitutionSlug(institutionSlug)) {
    return refuse(`institution_slug ${quoted(input.institutionSlug)} is not an institution slug`);
  }
  const cursor = requestText(input.cursor);
  if (cursor === null) return refuse("cursor must be text");
  if (cursor !== "" && !isNoticeCursor(cursor)) {
    return refuse("cursor must be the previous page's next_cursor, YYYY-MM-DD|announcement_url");
  }
  const requestedLimit = input.limit ?? 0;
  if (!isInt32(requestedLimit)) return refuse("limit must be a 32-bit whole number");
  const includeActivity = input.includeActivity ?? DEFAULT_NOTICE_ACTIVITY;
  if (typeof includeActivity !== "boolean") return refuse("include_activity must be true or false");

  return {
    ok: true,
    query: {
      windowDays,
      event,
      kind,
      stockCode,
      institutionSlug,
      cursor,
      limit: pageLimit(requestedLimit),
      includeActivity,
    },
  };
}

/**
 * A register list query clamped the way the API clamps it. As for the feed, a
 * refused value is an error, never a truncation, a value of the wrong type is
 * refused rather than coerced, and anything that is not an object of fields is
 * refused. The industry is only trimmed: the API checks it against the register's
 * own list.
 */
export function clampRegistersQuery(input: unknown): ClampResult<RegistersQuery> {
  if (!isRequestObject(input)) return refuse(NOT_A_REQUEST);
  const sort = inVocabulary(requestText(input.sort, lowerTrim), REGISTER_SORTS);
  if (sort === null) return refuse(`sort must be one of ${REGISTER_SORTS.join(", ")}`);
  const kind = inVocabulary(requestText(input.kind, lowerTrim), KIND_ORDER);
  if (kind === null) return refuse(`kind ${quoted(input.kind)} is not a holder kind`);
  const ascending = input.ascending ?? false;
  if (typeof ascending !== "boolean") return refuse("ascending must be true or false");
  const minInterests = input.minInterests ?? 0;
  if (!isInt32(minInterests)) return refuse("min_interests must be a 32-bit whole number");
  const minShortPct = input.minShortPct ?? 0;
  if (typeof minShortPct !== "number") return refuse("min_short_pct must be a number");
  const industry = requestText(input.industry, (text) => text.trim());
  if (industry === null) return refuse("industry must be text");
  const query = requestText(input.query, (text) => text.trim());
  if (query === null) return refuse("query must be text");
  if ([...query].length > REGISTER_MAX_QUERY) {
    return refuse(`query must be at most ${REGISTER_MAX_QUERY} characters`);
  }
  const offset = input.offset ?? 0;
  if (!isInt32(offset) || offset < 0 || offset > REGISTER_MAX_OFFSET) {
    return refuse(`offset must be between 0 and ${REGISTER_MAX_OFFSET}`);
  }
  const requestedLimit = input.limit ?? 0;
  if (!isInt32(requestedLimit)) return refuse("limit must be a 32-bit whole number");

  return {
    ok: true,
    query: {
      sort: sort === "" ? DEFAULT_REGISTER_SORT : sort,
      ascending,
      industry,
      kind,
      minInterests: Math.max(minInterests, 1),
      minShortPct: snapShortPct(minShortPct),
      query,
      limit: pageLimit(requestedLimit),
      offset,
    },
  };
}

/**
 * What a register query's text matches, as the API splits it: a stock code
 * prefix in upper case, and a company name substring in lower case.
 */
export function registerQueryMatch(query: string): { codePrefix: string; nameSubstring: string } {
  const text = query.trim();
  return { codePrefix: text.toUpperCase(), nameSubstring: text.toLowerCase() };
}

/**
 * Whether a feed page is due its window's activity, so whether a page that asked
 * for it and did not get it is a failed read. This is the API's rule: activity
 * comes back only on a first page (no cursor) and only for a window of at most
 * ACTIVITY_MAX_WINDOW days. A load-more page and the whole register are never due
 * it, so neither is a failed read.
 */
export function wantsActivity(query: NoticeQuery): boolean {
  return (
    query.includeActivity &&
    query.cursor === "" &&
    query.windowDays > 0 &&
    query.windowDays <= ACTIVITY_MAX_WINDOW
  );
}

/** The part of URLSearchParams the codec reads, so a Next.js read-only view works too. */
export type ParamSource = Pick<URLSearchParams, "get">;

export interface RegisterParamOptions {
  /**
   * The register's industries. A link naming one the register does not hold makes
   * the API refuse the whole read (InvalidArgument), so the page passes the list it
   * has and such an industry reads as no filter. Left out, the link's industry is
   * kept and the API decides it.
   */
  industries?: ReadonlySet<string>;
}

/** The feed's default view: the default window, no filters, the first page, with its activity. */
export function defaultNoticeQuery(): NoticeQuery {
  return {
    windowDays: DEFAULT_NOTICE_WINDOW,
    event: "",
    kind: "",
    stockCode: "",
    institutionSlug: "",
    cursor: "",
    limit: PAGE_DEFAULT_LIMIT,
    includeActivity: DEFAULT_NOTICE_ACTIVITY,
  };
}

/** The register's default view: the default sort, no filters, the first page. */
export function defaultRegistersQuery(): RegistersQuery {
  return {
    sort: DEFAULT_REGISTER_SORT,
    ascending: false,
    industry: "",
    kind: "",
    minInterests: 1,
    minShortPct: 0,
    query: "",
    limit: PAGE_DEFAULT_LIMIT,
    offset: 0,
  };
}

/** Whether every field of a query holds its default value. */
function atDefaults<T extends object>(query: T, defaults: T): boolean {
  return (Object.keys(defaults) as Array<keyof T>).every((key) => query[key] === defaults[key]);
}

/**
 * Whether a feed query is the default view. The feed's KV entry is keyed on
 * this, never on the serialised link: a cursor page serialises to the same empty
 * string as the default view.
 */
export function isDefaultNoticeQuery(query: NoticeQuery): boolean {
  return atDefaults(query, defaultNoticeQuery());
}

/** Whether a register query is the default view, by the same rule as isDefaultNoticeQuery. */
export function isDefaultRegistersQuery(query: RegistersQuery): boolean {
  return atDefaults(query, defaultRegistersQuery());
}

/**
 * A window parameter, read the way the clamp serves it: "all" is every notice, a
 * whole number takes the window the API serves for it (0 and anything above 365
 * are every notice, int32 or not), and anything else is the default, a negative
 * included.
 */
function parseWindow(value: string): number {
  if (value === "all") return NOTICE_WINDOW_ALL;
  if (!WHOLE.test(value)) return DEFAULT_NOTICE_WINDOW;
  return servedWindow(Number(value)) ?? DEFAULT_NOTICE_WINDOW;
}

/**
 * Reads a feed query from a link: window, event, kind, stock and holder. The
 * rest of the query (limit, cursor, activity) is not in a link and takes its
 * default. Each parameter falls back on its own, so one bad value keeps the rest.
 */
export function parseNoticeParams(params: ParamSource): NoticeQuery {
  const read = (name: string): string => (params.get(name) ?? "").trim();
  const holder = read("holder").toLowerCase();
  const stock = read("stock").toUpperCase();
  // A holder is a slug in the shape a path segment takes. A name or a listed
  // company's key never is. Whether the registry holds the slug is for the API to
  // check, so a well-formed slug is kept.
  const clamped = clampNoticeQuery({
    windowDays: parseWindow(read("window").toLowerCase()),
    event: inVocabulary(lowerTrim(read("event")), NOTICE_EVENTS) ?? "",
    kind: inVocabulary(lowerTrim(read("kind")), KIND_ORDER) ?? "",
    stockCode: REGISTER_CODE_PATTERN.test(stock) ? stock : "",
    institutionSlug: isInstitutionSlug(holder) ? holder : "",
  } satisfies NoticeQueryInput);
  return clamped.ok ? clamped.query : defaultNoticeQuery();
}

/**
 * A feed query as a link carries it, with the defaults left out, so the default
 * view has no query string. A link does not carry the cursor, the page size or
 * the activity flag, so a cursor page serialises to the same string as the
 * default view: ask isDefaultNoticeQuery which view a query is, never the string.
 */
export function serialiseNoticeParams(query: NoticeQuery): URLSearchParams {
  const out = new URLSearchParams();
  if (query.windowDays !== DEFAULT_NOTICE_WINDOW) {
    out.set("window", query.windowDays === NOTICE_WINDOW_ALL ? "all" : String(query.windowDays));
  }
  if (query.event !== "") out.set("event", query.event);
  if (query.kind !== "") out.set("kind", query.kind);
  if (query.stockCode !== "") out.set("stock", query.stockCode);
  if (query.institutionSlug !== "") out.set("holder", query.institutionSlug);
  return out;
}

/**
 * Reads a register list query from a link: sort, dir, industry, kind, short, q
 * and offset. Each parameter falls back on its own. A short position is snapped
 * down to a step, as the API snaps it.
 */
export function parseRegisterParams(
  params: ParamSource,
  options: RegisterParamOptions = {},
): RegistersQuery {
  const read = (name: string): string => (params.get(name) ?? "").trim();
  const industry = read("industry");
  const text = read("q");
  const offset = read("offset");
  const pct = read("short");
  const clamped = clampRegistersQuery({
    sort: inVocabulary(read("sort").toLowerCase(), REGISTER_SORTS) ?? "",
    ascending: read("dir").toLowerCase() === "asc",
    industry: options.industries === undefined || options.industries.has(industry) ? industry : "",
    kind: inVocabulary(read("kind").toLowerCase(), KIND_ORDER) ?? "",
    minShortPct: PERCENT.test(pct) ? Number(pct) : 0,
    query: [...text].length > REGISTER_MAX_QUERY ? "" : text,
    offset: WHOLE.test(offset) && Number(offset) <= REGISTER_MAX_OFFSET ? Number(offset) : 0,
  } satisfies RegistersQueryInput);
  return clamped.ok ? clamped.query : defaultRegistersQuery();
}

/**
 * A register list query as a link carries it, with the defaults left out. The
 * page size and the minimum interests are not in a link: the page sets neither.
 */
export function serialiseRegisterParams(query: RegistersQuery): URLSearchParams {
  const out = new URLSearchParams();
  if (query.sort !== DEFAULT_REGISTER_SORT) out.set("sort", query.sort);
  if (query.ascending) out.set("dir", "asc");
  if (query.industry !== "") out.set("industry", query.industry);
  if (query.kind !== "") out.set("kind", query.kind);
  if (query.minShortPct > 0) out.set("short", String(query.minShortPct));
  if (query.query !== "") out.set("q", query.query);
  if (query.offset > 0) out.set("offset", String(query.offset));
  return out;
}
