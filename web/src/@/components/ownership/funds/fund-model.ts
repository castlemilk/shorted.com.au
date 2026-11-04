/**
 * The funds' plain rows and their pure helpers (spec 14.3, 14.4). Every figure
 * arrives here as the loader maps it: a null is a figure the API did not state,
 * and it prints as n/a, never as zero.
 *
 * A PURE MODULE. No React, no DOM, no Connect: the actions, the islands, the
 * inspectors and the tests read it alike. The fund exposure map, the portfolio
 * treemap and the change table are drawn from these rows, so the arithmetic that
 * decides what a cell or a row says lives in one place.
 */

import { MINUS, NOT_AVAILABLE, formatPct, formatShares } from "~/@/lib/fundamentals/format";
import { formatPointChange, shortSector } from "~/@/lib/ownership/kinds";
import { layoutMap, sectorOf, type MapLayout, type MapStockRow } from "../desk/map-layout";
import type { DeskSort } from "../desk/desk-state";
import { isFundKey as isFundKeyGrammar } from "../workspace/selection";

/** Up to this many funds can be compared at once (spec 14.3). */
export const FUND_COMPARE_MAX = 3;
/** The largest sectors a fund map shows as columns; the rest fold into Other. */
export const SECTOR_COLUMN_COUNT = 6;
/** An ISO calendar date, YYYY-MM-DD. The shape only; the loaders check the calendar. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* Plain rows                                                         */
/* ------------------------------------------------------------------ */

export interface FundSectorWeight {
  industry: string;
  weightPct: number | null;
}

export interface FundTopHolding {
  code: string;
  name: string;
  weightPct: number | null;
}

/** One tracked fund, as ListFunds states it at its newest file. */
export interface FundRow {
  key: string;
  ticker: string;
  name: string;
  institutionSlug: string;
  institutionName: string;
  /** etf (an index fund) or super_phd (a super fund option). */
  sourceKind: string;
  pooled: boolean;
  asAt: string;
  sourceUrl: string;
  holdings: number;
  top10Pct: number | null;
  sectorWeights: FundSectorWeight[];
  largest: FundTopHolding[];
  aumAud: number | null;
  /**
   * The file dates the fund has on record (ListFunds' snapshot_count). A comparison
   * needs two. The loader always states it (0 when the API omits it); a fixture that
   * predates the field reads as 0 too, so the field is optional in the type.
   */
  snapshotCount?: number;
  /**
   * The largest absolute change in one sector's weight between the fund's two newest files, in percentage
   * points, signed (the later file less the earlier), and that sector (backlog C3b). Null, and the sector "",
   * when the API states none: a fund with one file, or no sector stated on both. Optional like snapshotCount:
   * a fixture that predates the fields reads as none.
   */
  largestSectorChangePp?: number | null;
  largestSectorChangeSector?: string;
}

/** One holding of one fund at one file date. */
export interface PortfolioHolding {
  code: string;
  name: string;
  industry: string;
  weightPct: number | null;
  units: number | null;
  valueAud: number | null;
  sharesOnIssue: number | null;
  /** Units over the shares on issue, in percent; null unless both are stated. */
  estCompanyPct: number | null;
  /** The date of the shares-on-issue figure the estimate divides by. */
  sharesOnIssueAsAt: string;
}

/** One fund at one file date: its header, the file dates it has, and the holdings. */
export interface FundPortfolio {
  key: string;
  ticker: string;
  name: string;
  institutionSlug: string;
  institutionName: string;
  sourceKind: string;
  pooled: boolean;
  /** The file date this portfolio is the one of. */
  asAt: string;
  sourceUrl: string;
  /** Every file date the fund has, oldest first. */
  snapshotDates: string[];
  holdings: PortfolioHolding[];
  holdingsTotal: number;
  top10Pct: number | null;
  sectorWeights: FundSectorWeight[];
}

/** One stock across two files of one fund. */
export interface CompareRow {
  code: string;
  name: string;
  industry: string;
  weightFrom: number | null;
  weightTo: number | null;
  /** Percentage points, later less earlier. Null when the stock is in one file only. */
  deltaPp: number | null;
  valueFrom: number | null;
  valueTo: number | null;
  /** continuing, new (absent from the earlier file) or dropped (absent from the later). */
  status: string;
}

/** A comparison of two files of one fund, as the change table reads it. */
export interface FundComparison {
  ok: boolean;
  /** A refusal's reason (the action's own query check); "" or absent for an outage or a read. */
  error?: string;
  from: string;
  to: string;
  sourceFrom: string;
  sourceTo: string;
  rows: CompareRow[];
}

/**
 * The loaders an island receives as props (spec 13.7): the server actions of
 * ownershipFunds.ts, typed structurally, so no client module imports an action.
 */
export type LoadFundPortfolio = (input: {
  fundKey: string;
  asAt?: string;
}) => Promise<{ ok: boolean; fund: FundPortfolio | null }>;

export type LoadFundComparison = (input: {
  fundKey: string;
  from: string;
  to: string;
}) => Promise<FundComparison>;

/** A box as a layout gives it, in the layout's own units. */
export interface LayoutBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A layout box as percentages of its canvas, for absolutely positioned cells that resize with the page. */
export function boxPercent(box: LayoutBox, width: number, height: number): Record<string, string> {
  return {
    left: `${(box.x0 / width) * 100}%`,
    top: `${(box.y0 / height) * 100}%`,
    width: `${((box.x1 - box.x0) / width) * 100}%`,
    height: `${((box.y1 - box.y0) / height) * 100}%`,
  };
}

/** A fund's kind as its badge names it: a super option, a pooled wholesale fund, or an ETF. */
export function fundKindLabel(fund: { sourceKind: string; pooled: boolean }): string {
  if (fund.sourceKind === "super_phd") return "Super option";
  return fund.pooled ? "Pooled" : "ETF";
}

/* ------------------------------------------------------------------ */
/* Keys, tabs and filters                                             */
/* ------------------------------------------------------------------ */

export const FUND_TABS = ["portfolio", "changes", "sources"] as const;
export type FundTab = (typeof FUND_TABS)[number];
export const FUND_TAB_LABELS: Readonly<Record<FundTab, string>> = {
  portfolio: "Portfolio",
  changes: "Changes",
  sources: "Sources & fund details",
};

export const CHANGES_TABS = ["funds", "notices"] as const;
export type ChangesTab = (typeof CHANGES_TABS)[number];
export const CHANGES_TAB_LABELS: Readonly<Record<ChangesTab, string>> = {
  funds: "Fund snapshots",
  notices: "Substantial notices",
};

export const CHANGE_FILTERS = ["all", "increases", "decreases", "coverage"] as const;
export type ChangeFilter = (typeof CHANGE_FILTERS)[number];
export const CHANGE_FILTER_LABELS: Readonly<Record<ChangeFilter, string>> = {
  all: "All changes",
  increases: "Increases",
  decreases: "Decreases",
  coverage: "Coverage changes",
};

/** A tab the URL names, or the first one. Only a known name is kept. */
export function parseTab<T extends string>(raw: string | null | undefined, tabs: readonly T[], fallback: T): T {
  return tabs.find((tab) => tab === raw) ?? fallback;
}

/**
 * Whether a string is a fund key in the shape the API issues (spec 14.7): the one
 * grammar, shared with the selection codec (workspace/selection.ts `isFundKey`), so a
 * key the page accepts is a key a `sel=` link can carry.
 */
export function isFundKey(raw: string): boolean {
  return isFundKeyGrammar(raw);
}

/** A fund key the URL or a path names, or "" when it is not one. */
export function cleanFundKey(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const key = raw.trim();
  return isFundKey(key) ? key : "";
}

/**
 * The fund key a route segment names (spec 14.9). The segment is the encoded key, so it
 * is decoded once; a segment that is already decoded, or carries a stray "%", is taken
 * as it is. Empty or malformed is "".
 */
export function fundKeyFromSegment(segment: string | null | undefined): string {
  if (typeof segment !== "string") return "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return cleanFundKey(decoded);
}

/** Whether a fund states a largest sector change: a finite change in percentage points. */
function sectorChangeStated<T extends { largestSectorChangePp?: number | null }>(
  fund: T,
): fund is T & { largestSectorChangePp: number } {
  return typeof fund.largestSectorChangePp === "number" && Number.isFinite(fund.largestSectorChangePp);
}

/**
 * The fund rows in the order a sort gives (backlog C3b). "largest" is the API's order. "changed" orders by
 * the size of the largest sector change, largest first, and a fund that states none comes last in the API's
 * order. Array.prototype.sort is stable, so ties keep the API's order.
 */
export function orderFundsForSort<T extends { largestSectorChangePp?: number | null }>(
  funds: readonly T[],
  sort: DeskSort,
): T[] {
  if (sort !== "changed") return [...funds];
  return [...funds].sort((a, b) => {
    const x = changeSize(a);
    const y = changeSize(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return y - x;
  });
}

/** The size of a fund's largest sector change, or null when it states none. */
function changeSize(fund: { largestSectorChangePp?: number | null }): number | null {
  return sectorChangeStated(fund) ? Math.abs(fund.largestSectorChangePp) : null;
}

/**
 * The sector a changed row names after its manager: the sector's short name and its change, true minus
 * ("Banks +10.20 pp"). "" when the fund states no change, so the row carries nothing it cannot back.
 */
export function sectorChangeDetail(fund: {
  largestSectorChangePp?: number | null;
  largestSectorChangeSector?: string;
}): string {
  if (!sectorChangeStated(fund)) return "";
  return `${shortSector(fund.largestSectorChangeSector)} ${formatPointChange(0, fund.largestSectorChangePp)}`;
}

/**
 * A fund's printed label (spec 14.7): its ticker, else its name. A super option has
 * no ticker, so it is labelled by its name and never by an empty cell or a raw key.
 */
export function fundLabel(fund: { ticker: string; name?: string }): string {
  return fund.ticker.trim() !== "" ? fund.ticker.trim() : (fund.name ?? "");
}

/**
 * The code a fund shows when no row on record names one: the ASX code of an asx:
 * key, else the fund's name (the part after the slash). Never a raw key with a prefix.
 */
export function fundCodeOf(key: string): string {
  if (key.startsWith("asx:")) return key.slice(4);
  const slash = key.indexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
}

/** An ISO date the URL names, or "" when it is not one (the shape only). */
export function cleanIsoDate(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const date = raw.trim();
  return ISO_DATE.test(date) ? date : "";
}

/**
 * A fund key as one item of the `funds=` list. A super option's name may hold a comma
 * ("aware/Growth, Balanced"), so the two characters that would split or escape the
 * list are written as %2C and %25 (spec 14.7). A key without either is unchanged.
 */
function escapeFundKey(key: string): string {
  return key.replace(/%/g, "%25").replace(/,/g, "%2C");
}

/** The inverse of `escapeFundKey`: one pass, so a written %25 never reads as a %2C. */
function unescapeFundKey(part: string): string {
  return part.replace(/%(25|2C)/gi, (match) => (match === "%25" ? "%" : ","));
}

/** The `funds=` value for a list of keys; `parseFundKeys` reads it back exactly. */
export function serializeFundKeys(keys: readonly string[]): string {
  return keys.map(escapeFundKey).join(",");
}

/** The funds named in a comma-separated list: valid, unique, at most the compare limit. */
export function parseFundKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const key = cleanFundKey(unescapeFundKey(part));
    if (key !== "" && !out.includes(key)) out.push(key);
    if (out.length === FUND_COMPARE_MAX) break;
  }
  return out;
}

/** The selection after a checkbox is ticked or cleared. A tick past the limit is ignored. */
export function toggleFundKey(keys: readonly string[], key: string, max: number = FUND_COMPARE_MAX): string[] {
  if (keys.includes(key)) return keys.filter((k) => k !== key);
  if (keys.length >= max) return [...keys];
  return [...keys, key];
}

/** The filter a change row passes. Coverage is a row in one file only. */
export function filterChanges(rows: readonly CompareRow[], filter: ChangeFilter): CompareRow[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "increases":
      return rows.filter((row) => row.deltaPp !== null && row.deltaPp > 0);
    case "decreases":
      return rows.filter((row) => row.deltaPp !== null && row.deltaPp < 0);
    case "coverage":
      return rows.filter((row) => row.status === "new" || row.status === "dropped");
  }
}

/* ------------------------------------------------------------------ */
/* Sectors                                                            */
/* ------------------------------------------------------------------ */

/**
 * The fund map's sector columns: the largest sectors by their summed weight across
 * the funds given, by name for a tie. Every other sector folds into Other.
 */
export function sectorColumns(funds: readonly FundRow[], count: number = SECTOR_COLUMN_COUNT): string[] {
  const totals = new Map<string, number>();
  for (const fund of funds) {
    for (const sector of fund.sectorWeights) {
      if (sector.weightPct === null) continue;
      totals.set(sector.industry, (totals.get(sector.industry) ?? 0) + sector.weightPct);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, count)
    .map(([industry]) => industry);
}

/** A fund's weight in one sector, or null when the file does not state it. */
export function sectorWeightOf(fund: { sectorWeights: readonly FundSectorWeight[] }, industry: string): number | null {
  const hit = fund.sectorWeights.find((sector) => sector.industry === industry);
  return hit?.weightPct ?? null;
}

/**
 * A fund's weight outside the given columns. Null when no sector outside them
 * states a weight, so an unknown Other is n/a and never a zero.
 */
export function otherWeightOf(fund: { sectorWeights: readonly FundSectorWeight[] }, columns: readonly string[]): number | null {
  let sum = 0;
  let stated = false;
  for (const sector of fund.sectorWeights) {
    if (sector.weightPct === null || columns.includes(sector.industry)) continue;
    sum += sector.weightPct;
    stated = true;
  }
  return stated ? sum : null;
}

/** A sector's name with its weight in the fund, "Materials (32%)"; the name alone when no weight is stated. */
export function sectorSummary(sector: string, weightPct: number | null | undefined): string {
  if (weightPct === null || weightPct === undefined || !Number.isFinite(weightPct)) return sector;
  return `${sector} (${formatPct(weightPct, { digits: 0 })})`;
}

/**
 * The six sector tints of the treemap, assigned by sector order (spec 14.3). They
 * are the warm palette and the theme's inks: never the kind colours, never red or
 * green. Each is a CSS colour the caller mixes onto the card.
 */
export const SECTOR_TINTS: readonly string[] = [
  "hsl(var(--primary))",
  "hsl(var(--accent))",
  "hsl(var(--secondary))",
  "hsl(var(--foreground))",
  "hsl(var(--muted-foreground))",
  "hsl(var(--input))",
];

/** The tint of the sector at this position in the order the layout draws them. */
export function sectorTint(index: number): string {
  const n = SECTOR_TINTS.length;
  return SECTOR_TINTS[((index % n) + n) % n]!;
}

/* ------------------------------------------------------------------ */
/* The portfolio treemap                                              */
/* ------------------------------------------------------------------ */

/**
 * The fund's holdings laid out as a treemap (spec 14.3): area is the weight, the
 * sectors are the groups. It is the desk's own layout, given each holding's weight
 * in the area field, so the squarify is shared. A holding with no weight, or a
 * zero, has no area and is left to the list.
 */
export function holdingsTreemap(
  holdings: readonly PortfolioHolding[],
  width: number,
  height: number,
  focus = "",
): MapLayout {
  const stocks: MapStockRow[] = holdings
    .filter((holding) => holding.weightPct !== null && holding.weightPct > 0)
    .map((holding) => {
      const weight = holding.weightPct!;
      return {
        code: holding.code,
        name: holding.name,
        industry: holding.industry,
        marketCap: weight,
        disclosedPct: weight,
        institutionalPct: weight,
        hedgePct: weight,
        indexPct: null,
        shortPct: null,
        flowPp: null,
        fundValueAud: null,
        fundFlowAud: null,
        fundChangePct: null,
        notices: 0,
      };
    });
  return layoutMap(stocks, { width, height, lens: "disclosed", sector: focus });
}

/** The weight a sector holds across the holdings it groups, for its header; a holding with no weight adds nothing. */
export function sectorWeightTotals(holdings: readonly PortfolioHolding[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const holding of holdings) {
    if (holding.weightPct === null) continue;
    const sector = sectorOf(holding.industry);
    totals.set(sector, (totals.get(sector) ?? 0) + holding.weightPct);
  }
  return totals;
}

/* ------------------------------------------------------------------ */
/* Changes                                                            */
/* ------------------------------------------------------------------ */

const STATUS_LABELS: Readonly<Record<string, string>> = {
  continuing: "Continuing",
  new: "Newly reported",
  dropped: "No longer reported",
};

/** A comparison row's status, in the words the change table prints. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? NOT_AVAILABLE;
}

/** A change in percentage points with a true minus: "+0.10 pp", "−0.31 pp"; n/a when unstated. */
export function formatDeltaPp(pp: number | null | undefined): string {
  if (pp === null || pp === undefined || !Number.isFinite(pp)) return NOT_AVAILABLE;
  if (Math.abs(pp) < 0.005) return "0.00 pp";
  return `${pp > 0 ? "+" : MINUS}${Math.abs(pp).toFixed(2)} pp`;
}

/** A weight in percent, two decimals, n/a when unstated. */
export function formatWeight(pct: number | null | undefined, digits = 2): string {
  return formatPct(pct, { digits });
}

/** The reported shares as the figure prints them ("25.4m"), or n/a. */
export function formatUnits(units: number | null | undefined): string {
  return formatShares(units);
}

/** The estimated share of the company, two decimals; n/a unless both units and shares on issue are stated. */
export function formatEstCompany(pct: number | null | undefined): string {
  return formatPct(pct, { digits: 2 });
}

/** The two newest file dates, the earlier then the later; "" when the fund has fewer than two. */
export function defaultPair(dates: readonly string[]): { from: string; to: string } {
  const sorted = [...dates].sort();
  if (sorted.length < 2) return { from: "", to: "" };
  return { from: sorted[sorted.length - 2]!, to: sorted[sorted.length - 1]! };
}

/* ------------------------------------------------------------------ */
/* The comparison's fund picker and caption (spec 14.3, B4)           */
/* ------------------------------------------------------------------ */

/** The file dates a fund has on record; a fund that states none reads as 0. */
function filesOf(fund: { snapshotCount?: number }): number {
  return fund.snapshotCount !== undefined && Number.isFinite(fund.snapshotCount) ? fund.snapshotCount : 0;
}

/**
 * The funds in the order the Fund select lists them: every fund with two file dates
 * first, then the rest, each group in the API's own order. A fund with one file stays
 * in the list (the record is the record); it is only listed after the comparable ones.
 */
export function orderFundsForCompare<T extends { snapshotCount?: number }>(funds: readonly T[]): T[] {
  return [...funds.filter((fund) => filesOf(fund) >= 2), ...funds.filter((fund) => filesOf(fund) < 2)];
}

/**
 * The fund the Changes page compares on arrival: the first index fund with two file
 * dates, else the first fund of any kind with two, else the first fund. Undefined when
 * the registry is empty.
 */
export function defaultCompareFund<T extends { sourceKind: string; snapshotCount?: number }>(
  funds: readonly T[],
): T | undefined {
  return (
    funds.find((fund) => fund.sourceKind !== "super_phd" && filesOf(fund) >= 2) ??
    funds.find((fund) => filesOf(fund) >= 2) ??
    funds[0]
  );
}

/**
 * A fund's label in the Fund select: "{TICKER} · {name}" (the name alone when it has no
 * ticker), with " (one file)" after it when the fund has exactly one file date. A listed
 * fund always has at least one file, so a count of 0 is a count the API did not state
 * (protobuf-es reads an omitted field as 0): it earns no suffix, because the label must
 * claim only what the record holds.
 */
export function compareOptionLabel(fund: { ticker: string; name: string; snapshotCount?: number }): string {
  const base = fund.ticker.trim() !== "" ? `${fund.ticker} · ${fund.name}` : fund.name;
  const oneFile = filesOf(fund) === 1;
  return oneFile ? `${base} (one file)` : base;
}

const CAPTION_TAIL = "Reported snapshot change, not a trade record.";

/**
 * A comparison row counts as changed when its status is not continuing (a holding
 * newly reported or no longer reported), or when its stated change rounds to 0.01 pp or
 * more at two decimals, the precision the table prints.
 */
function rowChanged(row: CompareRow): boolean {
  if (row.status !== "continuing") return true;
  return row.deltaPp !== null && Number.isFinite(row.deltaPp) && Math.round(Math.abs(row.deltaPp) * 100) >= 1;
}

/**
 * The caption under the table's title: the comparison's own summary, naming the two
 * dates it compares (the ones it was read for, never the selects' pending values). With
 * no comparison on screen it is the bare note on what the figures are. One file on both
 * sides is no comparison either: the API answers it with no rows, and the caption must not
 * read "no holding changed" as if a file had been compared with the same file.
 */
export function compareCaption(ticker: string, from: string, to: string, rows: readonly CompareRow[]): string {
  if (from === "" || to === "" || from === to) return CAPTION_TAIL;
  const changed = rows.filter(rowChanged).length;
  const count =
    changed === 0 ? "no holding changed" : changed === 1 ? "1 holding changed" : `${changed} holdings changed`;
  return `${ticker}, ${from} against ${to}: ${count}. ${CAPTION_TAIL}`;
}

/** A cell of the CSV: a number to two decimals, or empty when it is not stated. */
function csvNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "" : value.toFixed(2);
}

/** A cell of the CSV as text: quoted, with a leading formula character neutralised. */
function csvText(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The change table as a CSV, built in the browser from the rows shown (spec
 * 14.3). Header first; CRLF line ends, as spreadsheets read them.
 */
export function changesCsv(rows: readonly CompareRow[]): string {
  const lines = ["Code,Company,Earlier weight (%),Later weight (%),Change (pp),Status"];
  for (const row of rows) {
    lines.push(
      [
        csvText(row.code),
        csvText(row.name),
        csvNumber(row.weightFrom),
        csvNumber(row.weightTo),
        csvNumber(row.deltaPp),
        csvText(statusLabel(row.status)),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------ */
/* Links                                                              */
/* ------------------------------------------------------------------ */

/**
 * The link to the current path with some parameters set (a string) or cleared
 * (null or ""), every other parameter kept in order. The bare path when none is left.
 */
export function patchHref(
  pathname: string,
  params: URLSearchParams,
  patch: Readonly<Record<string, string | null>>,
): string {
  const next = new URLSearchParams(params.toString());
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === "") next.delete(name);
    else next.set(name, value);
  }
  const search = next.toString();
  return search === "" ? pathname : `${pathname}?${search}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
