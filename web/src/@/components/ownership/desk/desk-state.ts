import { cleanSelection } from "../workspace/selection";

/**
 * The desk's URL state on /ownership (spec 13.1): the window of change, the
 * map's lens, a zoomed sector, and the two snapshot dates of the index fund
 * window. Every instrument reads the same state, so a link to one view of the
 * desk is a link to all of them.
 *
 * READ AND WRITE ARE ONE RULE. `cleanDeskState` is the only place a value is
 * accepted, so the codec round-trips by construction: `readDeskState` of the
 * string `writeDeskState` makes is `normalizeDeskState` of the state it was
 * given. A value of the wrong shape takes its default, one parameter at a time,
 * so one bad parameter never costs the rest of a link.
 *
 * DEFAULTS ARE OMITTED. The server renders the default view, and a default
 * link is the bare path: `writeDeskState(DEFAULT_DESK_STATE) === ""`.
 *
 * A PURE MODULE. The islands and the server render both read it; nothing here
 * touches the DOM, React or the API.
 */

/** The windows of change the desk serves, in days. */
export const DESK_WINDOWS = [28, 91, 182, 364] as const;
export type DeskWindow = (typeof DESK_WINDOWS)[number];
export const DEFAULT_DESK_WINDOW: DeskWindow = 91;

/** The map's colour: what each cell's figure is. */
export const DESK_LENSES = [
  "disclosed",
  "institutional",
  "hedge",
  "index",
  "short",
  "flow",
  "index_flow",
] as const;
export type DeskLens = (typeof DESK_LENSES)[number];
export const DEFAULT_DESK_LENS: DeskLens = "disclosed";

/**
 * The order an instrument draws its rows or sectors in (spec 13.3, backlog C3). "largest" is the
 * order the instrument has always drawn (by area, or by notices); "changed" orders by the net change
 * the instrument can state, rises first on the heatmap and the biggest magnitude first on the map.
 */
export const DESK_SORTS = ["largest", "changed"] as const;
export type DeskSort = (typeof DESK_SORTS)[number];
export const DEFAULT_DESK_SORT: DeskSort = "largest";

/**
 * The longest sector name a link may carry. Industries are a few words; a longer
 * value is not one, and the API matches it exactly, so it would only be refused.
 */
const SECTOR_MAX = 64;

/**
 * The widest notice span the map and the flows serve, measured the way the API
 * measures it: the days from `since` to `until` (their difference, not a count of
 * both ends). A pair of 2025-10-19 and 2026-10-20 is 366 and served. The index
 * fund window has no such limit: its snapshot history is not bounded by a year.
 */
export const DESK_MAX_SPAN_DAYS = 366;

export interface DeskState {
  /**
   * The window of change in days: the map's, the flows' and the movement's. A
   * brushed pair (since, until) takes its place, so it is the default while a pair is set.
   */
  window: DeskWindow;
  /** A brushed window's first notice release date, YYYY-MM-DD; "" when the chips name it. */
  since: string;
  /** A brushed window's last notice release date, inclusive; "" with no brush. */
  until: string;
  lens: DeskLens;
  /** A zoomed sector, by its industry name; "" is the whole market. */
  sector: string;
  /** The index fund window's two snapshot dates, YYYY-MM-DD; "" is none. */
  from: string;
  to: string;
  /**
   * The workspace selection (spec 14.1), in its link form `kind:key`; "" is none.
   * Only a value `parseSelection` reads is kept (see workspace/selection.ts).
   */
  sel: string;
  /** The order the change-measured instruments draw in; see DESK_SORTS. */
  sort: DeskSort;
}

/** The window of change as the notice instruments read it: the chips' days, or a brushed pair. */
export type NoticeWindow = Pick<DeskState, "window" | "since" | "until">;

export const DEFAULT_DESK_STATE: DeskState = {
  window: DEFAULT_DESK_WINDOW,
  since: "",
  until: "",
  lens: DEFAULT_DESK_LENS,
  sector: "",
  from: "",
  to: "",
  sel: "",
  sort: DEFAULT_DESK_SORT,
};

/** The raw values a link or a page hands over, before any of them is trusted. */
export interface DeskStateInput {
  window?: unknown;
  since?: unknown;
  until?: unknown;
  lens?: unknown;
  sector?: unknown;
  from?: unknown;
  to?: unknown;
  sel?: unknown;
  sort?: unknown;
}

/** The two shapes a parameter arrives in: the browser's URLSearchParams, or Next's record. */
export type DeskParamSource =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

const WHOLE = /^\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Any control character: a sector name is printed, never a line break or a tab. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A calendar date in YYYY-MM-DD form. Rejects 2026-02-30, which Date would roll over. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The day count of an ISO date since the epoch. Only differences are meaningful. */
function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/**
 * The days from `from` to `to`, the way the API measures a notice span (`until`
 * minus `since`, not a count of both ends). The span must be valid.
 */
export function dayGap(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** `date` moved by `days` (negative goes back), as YYYY-MM-DD. The date must be valid. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The span a window of change covers, ending on `asOf` (the newest notice read).
 * Null when the date is not one, so a caller never asks for a span it cannot name.
 */
export function windowDates(days: number, asOf: string): { from: string; to: string } | null {
  if (!isIsoDate(asOf)) return null;
  return { from: shiftDate(asOf, -(days - 1)), to: asOf };
}

function isDeskWindow(value: number): value is DeskWindow {
  return (DESK_WINDOWS as readonly number[]).includes(value);
}

function isDeskLens(value: string): value is DeskLens {
  return (DESK_LENSES as readonly string[]).includes(value);
}

/** The window as a link states it: a whole number from the served list, or the default. */
function cleanWindow(value: unknown): DeskWindow {
  if (typeof value === "number" && Number.isInteger(value) && isDeskWindow(value)) return value;
  if (typeof value !== "string" || !WHOLE.test(value)) return DEFAULT_DESK_WINDOW;
  const days = Number(value);
  return isDeskWindow(days) ? days : DEFAULT_DESK_WINDOW;
}

/** Whether a value is one of the sorts the desk serves. */
export function isDeskSort(value: unknown): value is DeskSort {
  return typeof value === "string" && (DESK_SORTS as readonly string[]).includes(value);
}

/** The sort a link states: one of DESK_SORTS, or the default. A sort is never a number. */
function cleanSort(value: unknown): DeskSort {
  return isDeskSort(value) ? value : DEFAULT_DESK_SORT;
}

function cleanLens(value: unknown): DeskLens {
  return typeof value === "string" && isDeskLens(value) ? value : DEFAULT_DESK_LENS;
}

/** A sector name as the API matches it: trimmed, short, printable. Anything else is no sector. */
function cleanSector(value: unknown): string {
  if (typeof value !== "string") return "";
  const sector = value.trim();
  if (sector.length === 0 || sector.length > SECTOR_MAX || CONTROL.test(sector)) return "";
  return sector;
}

/**
 * The two dates of the index window, or both empty. One date alone is no window,
 * an inverted pair is none, and a pair the API would refuse (over DESK_MAX_SPAN_DAYS) is none. The window of change is a separate parameter, so
 * a pair of dates never replaces it.
 */
function cleanDates(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== "string" || typeof to !== "string") return { from: "", to: "" };
  if (!isIsoDate(from) || !isIsoDate(to)) return { from: "", to: "" };
  if (from > to) return { from: "", to: "" };
  // The API refuses a fund window longer than DESK_MAX_SPAN_DAYS (ownership_desk.go deskWindow).
  if (dayGap(from, to) > DESK_MAX_SPAN_DAYS) return { from: "", to: "" };
  return { from, to };
}

/**
 * A brushed notice window the API serves: both dates, in order, and no more than
 * DESK_MAX_SPAN_DAYS apart. Dates alone name a window; the chips do not need them.
 * The same rule the API applies (clamps.json desk.windows and desk.noticeDates),
 * so a link the API would refuse reads as no brush.
 */
export function isServedNoticePair(since: string, until: string): boolean {
  if (!isIsoDate(since) || !isIsoDate(until)) return false;
  if (since > until) return false;
  return dayGap(since, until) <= DESK_MAX_SPAN_DAYS;
}

/** The brushed pair, or both empty: one date alone is no window. */
function cleanNoticePair(since: unknown, until: unknown): { since: string; until: string } {
  const start = typeof since === "string" ? since.trim() : "";
  const end = typeof until === "string" ? until.trim() : "";
  return isServedNoticePair(start, end) ? { since: start, until: end } : { since: "", until: "" };
}

/** The one accepting rule. Each parameter is cleaned on its own. */
export function cleanDeskState(input: DeskStateInput): DeskState {
  const dates = cleanDates(input.from, input.to);
  const brushed = cleanNoticePair(input.since, input.until);
  return {
    // A brushed window names its own dates, so the chips' days are the default beside it.
    window: brushed.since === "" ? cleanWindow(input.window) : DEFAULT_DESK_WINDOW,
    since: brushed.since,
    until: brushed.until,
    lens: cleanLens(input.lens),
    sector: cleanSector(input.sector),
    from: dates.from,
    to: dates.to,
    sel: cleanSelection(input.sel),
    sort: cleanSort(input.sort),
  };
}

/** The state a caller would read back from the link it writes. */
export function normalizeDeskState(state: DeskState): DeskState {
  return cleanDeskState(state);
}

function paramValue(source: DeskParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return undefined;
}

/** The desk's state from a link. Unknown values fall back to their defaults. */
export function readDeskState(source: DeskParamSource): DeskState {
  return cleanDeskState({
    window: paramValue(source, "window"),
    since: paramValue(source, "since"),
    until: paramValue(source, "until"),
    lens: paramValue(source, "lens"),
    sector: paramValue(source, "sector"),
    from: paramValue(source, "from"),
    to: paramValue(source, "to"),
    sel: paramValue(source, "sel"),
    sort: paramValue(source, "sort"),
  });
}

/**
 * The sort an instrument draws in, for a link that may name none. A link that names a
 * valid sort gets it; a link that names none, or a value that is not a sort, gets
 * `fallback`. The hub's compact panes pass "changed" here, so a bare link shows the movers
 * while the full pages keep the default, and a link that names "largest" is honoured.
 */
export function readDeskSort(source: DeskParamSource, fallback: DeskSort = DEFAULT_DESK_SORT): DeskSort {
  const raw = paramValue(source, "sort");
  return isDeskSort(raw) ? raw : fallback;
}

/**
 * The query string for a state, without its leading "?", or "" for the default.
 * Each parameter is written only when it differs from its default.
 */
export function writeDeskState(state: DeskState): string {
  const clean = cleanDeskState(state);
  const params = new URLSearchParams();
  if (clean.window !== DEFAULT_DESK_WINDOW) params.set("window", String(clean.window));
  if (clean.since !== "") {
    params.set("since", clean.since);
    params.set("until", clean.until);
  }
  if (clean.from !== "") {
    params.set("from", clean.from);
    params.set("to", clean.to);
  }
  if (clean.lens !== DEFAULT_DESK_LENS) params.set("lens", clean.lens);
  if (clean.sector !== "") params.set("sector", clean.sector);
  if (clean.sel !== "") params.set("sel", clean.sel);
  if (clean.sort !== DEFAULT_DESK_SORT) params.set("sort", clean.sort);
  return params.toString();
}

/** The desk's own parameter names: writeDeskParams replaces these and leaves every other one alone. */
const DESK_PARAM_NAMES = ["window", "since", "until", "from", "to", "lens", "sector", "sel", "sort"] as const;

/**
 * Writes a state into a link's parameters in place. The desk's names are replaced
 * with the state's; any other parameter the reader has stays where it is.
 */
export function writeDeskParams(params: URLSearchParams, state: DeskState): void {
  for (const name of DESK_PARAM_NAMES) params.delete(name);
  new URLSearchParams(writeDeskState(state)).forEach((value, name) => params.set(name, value));
}

/** The notice window a link names: the chips' window, or a brushed pair. */
export function readNoticeWindow(source: DeskParamSource): NoticeWindow {
  const { window, since, until } = readDeskState(source);
  return { window, since, until };
}

/**
 * Writes a notice window into a link's parameters, leaving the rest of the desk
 * state (the lens, the sector, the fund dates) as the link has it.
 */
export function writeNoticeWindow(params: URLSearchParams, next: NoticeWindow): void {
  writeDeskParams(params, { ...readDeskState(params), ...next });
}
