// The explorer's model (the /strategies table and its rail): the columns, every
// cell and metric, the filter options, the selection and the compare ids. Pure:
// no React and no DOM, so each state's copy and each filter is unit-tested
// without rendering. The server builds the model once per ISR render; the
// client island only filters and selects over it.
//
// Copy is the spec's (design 1.5, 1.7, 1.8); the states are the API's
// StrategyEvidence.state, and every figure comes from the evidence, never from
// a constant.

import type { ReturnsHeatmapCell } from "~/@/components/strategies/returns-heatmap-table";
import type { SparkPoint } from "./sparkline";
import { formatSigned, NOT_AVAILABLE } from "./format";
import { DEFAULT_SIGNALS_STRATEGY } from "./workspace-nav";
import { STRATEGIES } from "./registry";
import type { StrategyEvidenceListView, StrategyEvidenceView } from "./map-backtest";
import type { StatusCountsView, StrategyDef } from "./types";

/** The most strategies the compare tray holds (design 2.2). */
export const COMPARE_LIMIT = 3;
/** The fewest a comparison needs. */
export const COMPARE_MINIMUM = 2;

export const WINDOW_OPTIONS = [
  { id: "since_2019_05", label: "Since May 2019" },
  { id: "since_2023", label: "Since 2023" },
  { id: "trailing_12m", label: "Last 12 months" },
  { id: "live", label: "Live since freeze" },
] as const;

export type WindowId = (typeof WINDOW_OPTIONS)[number]["id"];

/** The window the table opens on (design 5.8: Since May 2019). */
export const DEFAULT_WINDOW_ID: WindowId = "since_2019_05";

export const EVIDENCE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "backtested", label: "Backtested" },
  { value: "approximate", label: "Approximate" },
  { value: "live", label: "Live track only" },
] as const;

export type EvidenceFilter = (typeof EVIDENCE_OPTIONS)[number]["value"];

export const UNIVERSE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "asx", label: "ASX ordinary shares" },
  { value: "asic", label: "ASIC-reported names" },
] as const;

export type UniverseFilter = (typeof UNIVERSE_OPTIONS)[number]["value"];

export interface ExplorerFilters {
  query: string;
  style: string;
  horizon: string;
  universe: UniverseFilter;
  evidence: EvidenceFilter;
}

export const DEFAULT_FILTERS: ExplorerFilters = {
  query: "",
  style: "all",
  horizon: "all",
  universe: "all",
  evidence: "all",
};

/** The copy of every cell state. Exact copy from design 1.7. */
export const EXPLORER_COPY = {
  runRequired: "Run required",
  running: "Running",
  notComputable: "Not computable: needs point-in-time fundamentals",
  notComputableWithShare: (pct: number) =>
    `Not computable: needs point-in-time fundamentals (fundamentals for ${Math.round(pct)}% of the universe)`,
  notComputableBefore: (label: string) => `Not computable before ${label}`,
  approximateNotPublished: "Approximate run not published",
  beforeWindow: "Before window",
  notElapsed: "Not elapsed",
  notPublished: "No evidence published",
  unavailable: "Evidence unavailable right now",
  measuredOnAsic:
    "Measured on ASIC-reported names only; delisted companies that were never shorted are missing and cannot be counted.",
  approximate:
    "Approximate: fundamentals assumed known 2 months after period end; restated vendor values; only companies still listed in September 2026 have fundamentals, which flatters results",
  totalNotAnnualised: "total return, not annualised",
  ytd: "YTD",
} as const;

/** The canonical windows open in 2019 (1 May): the table's first year when nothing is published. */
export const CANONICAL_START_YEAR = 2019;

/** A column of the annual table: a calendar year, and a note under its header. */
export interface ExplorerColumn {
  key: string;
  label: string;
  note?: string;
}

export interface ExplorerMetric {
  key: string;
  text: string;
  value: number | null;
  note?: string;
}

export interface ExplorerInspector {
  name: string;
  author: string;
  tagline: string;
  chips: string[];
  holdingHorizon: string;
  latestScreen: string;
  countsText: string;
  counts: StatusCountsView | null;
  /** The sentence the sparkline is labelled with. */
  sparkLabel: string;
  sparkline: { strategy: SparkPoint[]; benchmark: SparkPoint[]; liveFromMs: number | null };
  /** "Recorded since 24 Nov 2026: 13 sessions, 2 trades, too short to judge"; "" when the track is long enough or absent. */
  paperLine: string;
  /** The live rules' freeze date, short form; "" when none. */
  liveFrom: string;
  /** Why the state is what it is (design 8.2), or the running request's start; "" when there is nothing to say. */
  stateLine: string;
}

export interface ExplorerRow {
  id: string;
  name: string;
  /** The line under the name: style and holding period. */
  sublabel: string;
  styleValue: string;
  styleLabel: string;
  horizonValue: string;
  universe: "asx" | "asic";
  universeLabel: string;
  evidenceKind: Exclude<EvidenceFilter, "all">  | "none";
  author: string;
  searchText: string;
  cells: ReturnsHeatmapCell[];
  /** Metrics for each window, keyed by window id: CAGR and max drawdown. */
  metricsByWindow: Record<WindowId, ExplorerMetric[]>;
  live: ExplorerMetric;
  inspector: ExplorerInspector;
}

export interface ExplorerOption {
  value: string;
  label: string;
}

export interface ExplorerModel {
  /** False when the evidence could not be read: rows still list the strategies, with their states unknown. */
  evidenceAvailable: boolean;
  columns: ExplorerColumn[];
  rows: ExplorerRow[];
  styles: ExplorerOption[];
  horizons: ExplorerOption[];
  /** "1 May 2019 to 6 Nov 2026 · universe per strategy · costs ... · benchmark ...". */
  rangeLine: string;
  /** The benchmark every run is measured against, as the API names it. */
  benchmarkName: string;
  footnotes: string[];
  /** The outline chip on the table: the freeze date every row shares, or a plain word. */
  chipLabel: string;
  /** The first row the rail opens on when no selection is named. */
  defaultId: string | null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "3 Nov 2026" from "2026-11-03"; "" for an empty or invalid day. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function yearOf(iso: string | null | undefined): number | null {
  const year = Number((iso ?? "").slice(0, 4));
  return Number.isInteger(year) && year > 1900 ? year : null;
}

/** "FY2024" reads as 2024: the calendar year the fiscal label names. */
export function fiscalYearOf(label: string): number | null {
  const match = /(\d{4})/.exec(label);
  return match ? Number(match[1]) : null;
}

/** "momentum-breakout" reads as "Momentum breakout". */
export function humaniseStyle(value: string): string {
  const words = value.replace(/[-_]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The universe a strategy names. A strategy whose universe is the reported short
 * positions (ASIC's report) is "ASIC-reported names"; every other is the ASX's
 * ordinary shares. The registry's universe copy carries the difference, so the
 * filter reads the same text the strategy page prints.
 */
export function universeOf(universeText: string): "asx" | "asic" {
  return /reported short/i.test(universeText) ? "asic" : "asx";
}

/** "1 May" from "2019-05-01"; "" for 1 January, which needs no note. */
function fromNote(iso: string): string {
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!Number.isInteger(month) || !Number.isInteger(day)) return "";
  if (month === 1 && day === 1) return "";
  return `from ${day} ${MONTHS[month - 1]}`;
}

/**
 * The calendar years the table prints: from the year the canonical windows open
 * to the newest year any evidence or price reaches. The current year is labelled
 * YTD when a strategy carries a YTD figure for it.
 */
export function yearsOf(
  list: StrategyEvidenceListView | null,
  now: Date = new Date(),
): { years: number[]; columns: ExplorerColumn[] } {
  const annualYears = (list?.strategies ?? []).flatMap((s) => s.annual.map((a) => a.year));
  // With no evidence the table still opens on the canonical window (design 5.8): 2019.
  const startYear =
    yearOf(list?.windowStart) ?? (annualYears.length ? Math.min(...annualYears) : CANONICAL_START_YEAR);
  const newest = Math.max(
    annualYears.length ? Math.max(...annualYears) : 0,
    yearOf(list?.pricesThrough) ?? 0,
  );
  const endYear = newest > 0 ? Math.max(startYear, newest) : Math.max(startYear, now.getUTCFullYear());
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y += 1) years.push(y);

  const ytdYear = (list?.strategies ?? []).some((s) =>
    s.annual.some((a) => a.year === endYear && a.months === "YTD"),
  );
  const columns: ExplorerColumn[] = years.map((year, index) => {
    const isEnd = year === endYear && ytdYear;
    const note = index === 0 && list?.windowStart ? fromNote(list.windowStart) : "";
    return {
      key: `y${year}`,
      label: isEnd ? `${year} ${EXPLORER_COPY.ytd}` : String(year),
      ...(note ? { note } : {}),
    };
  });
  return { years, columns };
}

const hatched = (label: string, span = 1): ReturnsHeatmapCell => ({
  state: "hatched",
  label,
  ...(span > 1 ? { span } : {}),
});

/** The annual cells of a computed (or approximate) run, one per year. */
function computedCells(
  evidence: StrategyEvidenceView,
  years: number[],
  startYear: number,
): ReturnsHeatmapCell[] {
  return years.map((year) => {
    const annual = evidence.annual.find((a) => a.year === year);
    if (!annual) {
      return hatched(year < startYear ? EXPLORER_COPY.beforeWindow : EXPLORER_COPY.notElapsed);
    }
    if (annual.strategyPct === null) return hatched(EXPLORER_COPY.notElapsed);
    // A marker names what the figure cannot show: an approximate run's year, or
    // a year measured on ASIC-reported names only. The current year carries its YTD figure.
    const marker = annual.approximate
      ? { glyph: "~", label: EXPLORER_COPY.approximate }
      : annual.coverageMeasurable
        ? undefined
        : { glyph: "?", label: EXPLORER_COPY.measuredOnAsic };
    return {
      state: "value",
      value: annual.strategyPct,
      coverage: annual.coverage,
      ...(marker ? { marker } : {}),
    };
  });
}

/**
 * The cells of a row whose strategy is not computable: the years before its
 * fiscal label merge into one hatched cell, and the years from the label on read
 * "Approximate run not published". No label: the whole row is one cell.
 */
function notComputableCells(
  evidence: StrategyEvidenceView,
  years: number[],
): ReturnsHeatmapCell[] {
  if (years.length === 0) return [];
  const fiscal = fiscalYearOf(evidence.fiscalLabel);
  if (fiscal === null) {
    const share = evidence.computableSharePct;
    const label =
      share === null ? EXPLORER_COPY.notComputable : EXPLORER_COPY.notComputableWithShare(share);
    return [hatched(label, years.length)];
  }
  const before = years.filter((year) => year < fiscal).length;
  const cells: ReturnsHeatmapCell[] = [];
  if (before > 0) {
    cells.push(hatched(EXPLORER_COPY.notComputableBefore(evidence.fiscalLabel), before));
  }
  for (const year of years) {
    if (year >= fiscal) cells.push(hatched(EXPLORER_COPY.approximateNotPublished));
  }
  return cells;
}

/** Every cell of one row, by the evidence's state. */
export function cellsOf(
  evidence: StrategyEvidenceView | null,
  years: number[],
  startYear: number,
  evidenceAvailable: boolean,
): ReturnsHeatmapCell[] {
  if (!evidence) {
    const label = evidenceAvailable ? EXPLORER_COPY.notPublished : EXPLORER_COPY.unavailable;
    return years.map(() => hatched(label));
  }
  switch (evidence.state) {
    case "published":
    case "approximate":
      return computedCells(evidence, years, startYear);
    case "run_required":
      return years.map(() => hatched(EXPLORER_COPY.runRequired));
    case "running":
      return years.map(() => hatched(EXPLORER_COPY.running));
    case "not_computable":
      return notComputableCells(evidence, years);
    default:
      return years.map(() => hatched(EXPLORER_COPY.notPublished));
  }
}

/** A window's CAGR and max drawdown, as the metric columns print them. */
export function windowMetrics(
  evidence: StrategyEvidenceView | null,
  windowId: WindowId,
): ExplorerMetric[] {
  const window = evidence?.windows.find((w) => w.window === windowId) ?? null;
  let cagr: ExplorerMetric = { key: "cagr", text: NOT_AVAILABLE, value: null };
  if (window?.cagrPct != null) {
    cagr = { key: "cagr", text: formatSigned(window.cagrPct), value: window.cagrPct };
  } else if (window?.totalReturnPct != null) {
    // Under 365 days the figure is the total return, marked as not annualised.
    cagr = {
      key: "cagr",
      text: formatSigned(window.totalReturnPct),
      value: window.totalReturnPct,
      note: EXPLORER_COPY.totalNotAnnualised,
    };
  }
  const drawdown: ExplorerMetric =
    window?.maxDrawdownPct != null
      ? { key: "maxdd", text: formatSigned(window.maxDrawdownPct), value: window.maxDrawdownPct }
      : { key: "maxdd", text: NOT_AVAILABLE, value: null };
  return [cagr, drawdown];
}

/** The Live column: the paper track's return once it is long enough, else the date it began. */
export function liveMetric(evidence: StrategyEvidenceView | null): ExplorerMetric {
  const paper = evidence?.paper ?? null;
  if (!paper?.since) return { key: "live", text: NOT_AVAILABLE, value: null };
  if (!paper.tooShort && paper.returnPct != null) {
    return { key: "live", text: formatSigned(paper.returnPct), value: paper.returnPct };
  }
  return { key: "live", text: `Tracking since ${shortDate(paper.since)}`, value: null };
}

/** The evidence a row is filtered by. */
export function evidenceKindOf(evidence: StrategyEvidenceView | null): ExplorerRow["evidenceKind"] {
  if (!evidence) return "none";
  if (evidence.state === "published") return "backtested";
  if (evidence.state === "approximate") return "approximate";
  if (evidence.paper && evidence.paper.sessions > 0) return "live";
  return "none";
}

function countsText(counts: StatusCountsView | null): string {
  if (!counts) return "Status counts unavailable";
  const setups = counts.setup;
  return `${counts.triggered} triggered · ${setups} setup${setups === 1 ? "" : "s"}`;
}

function sparkOf(evidence: StrategyEvidenceView | null) {
  const points = evidence?.miniCurve ?? [];
  return {
    strategy: points.flatMap((p) =>
      p.equity !== null && Number.isFinite(p.t) ? [{ t: p.t, v: p.equity }] : [],
    ),
    benchmark: points.flatMap((p) =>
      p.benchmark !== null && Number.isFinite(p.t) ? [{ t: p.t, v: p.benchmark }] : [],
    ),
  };
}

function inspectorOf(
  def: StrategyDef | undefined,
  id: string,
  evidence: StrategyEvidenceView | null,
): ExplorerInspector {
  const liveFrom = evidence?.version?.liveFrom ?? "";
  const paper = evidence?.paper ?? null;
  const spark = sparkOf(evidence);
  const liveFromLabel = shortDate(liveFrom);
  const sparkLabel = liveFromLabel
    ? `Backtest, in-sample to ${liveFromLabel}, then recorded`
    : "Backtest";
  const paperLine =
    paper?.since && paper.tooShort
      ? `Recorded since ${shortDate(paper.since)}: ${paper.sessions} sessions, ${paper.closedTrades} trades, too short to judge`
      : "";
  return {
    name: def?.name ?? (STRATEGIES[id]?.label ?? id),
    author: def?.author ?? "",
    tagline: def?.tagline ?? "",
    chips: [
      "Long entries",
      ...(/daily/i.test(def?.metadata?.refreshCadence ?? "") ? ["Daily evaluation"] : []),
    ],
    holdingHorizon: def?.metadata?.holdingPeriod ?? "",
    latestScreen: shortDate(evidence?.latestScreen),
    countsText: countsText(evidence?.today ?? null),
    counts: evidence?.today ?? null,
    sparkLabel,
    sparkline: {
      strategy: spark.strategy,
      benchmark: spark.benchmark,
      liveFromMs: liveFrom ? Date.parse(`${liveFrom.slice(0, 10)}T00:00:00Z`) : null,
    },
    paperLine,
    liveFrom: liveFromLabel,
    stateLine: stateLineOf(evidence),
  };
}

/** The API's reason for the state, or the start of a running request. */
function stateLineOf(evidence: StrategyEvidenceView | null): string {
  if (!evidence) return "";
  if (evidence.stateReason) return evidence.stateReason;
  if (evidence.state === "running" && evidence.runningSince) {
    const at = new Date(evidence.runningSince);
    if (!Number.isNaN(at.getTime())) {
      return `Running since ${at.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
    }
  }
  return "";
}

function uniqueOptions(values: string[], label: (value: string) => string): ExplorerOption[] {
  const seen = [...new Set(values.filter((v) => v.length > 0))].sort();
  return [{ value: "all", label: "All" }, ...seen.map((value) => ({ value, label: label(value) }))];
}

/**
 * The whole explorer. `strategies` is the registry's list (names, authors, the
 * metadata the filters read); `evidence` is ListStrategyEvidence, or null when it
 * could not be read. Rows follow the strategies' order, then any strategy only the
 * evidence names.
 */
export function buildExplorerModel(input: {
  strategies: StrategyDef[];
  evidence: StrategyEvidenceListView | null;
  now?: Date;
}): ExplorerModel {
  const { strategies, evidence } = input;
  const { years, columns } = yearsOf(evidence, input.now);
  const startYear = years[0] ?? new Date().getUTCFullYear();
  const evidenceById = new Map((evidence?.strategies ?? []).map((s) => [s.strategyId, s]));
  const defById = new Map(strategies.map((s) => [s.id, s]));
  const ids = [
    ...strategies.map((s) => s.id),
    ...(evidence?.strategies ?? []).map((s) => s.strategyId).filter((id) => !defById.has(id)),
  ];

  const rows: ExplorerRow[] = ids.map((id) => {
    const def = defById.get(id);
    const ev = evidenceById.get(id) ?? null;
    const style = def?.metadata?.style ?? "";
    const horizon = def?.metadata?.holdingPeriod ?? "";
    const universeText = def?.metadata?.universe ?? "";
    const universe = universeOf(universeText);
    const name = def?.name ?? (STRATEGIES[id]?.label ?? id);
    const styleLabel = style ? humaniseStyle(style) : "";
    const sublabel = [styleLabel, horizon ? horizon.toLowerCase() : ""].filter(Boolean).join(" · ");
    const metricsByWindow = Object.fromEntries(
      WINDOW_OPTIONS.map((w) => [w.id, windowMetrics(ev, w.id)]),
    ) as Record<WindowId, ExplorerMetric[]>;
    return {
      id,
      name,
      sublabel,
      styleValue: style,
      styleLabel,
      horizonValue: horizon,
      universe,
      universeLabel: universe === "asic" ? "ASIC-reported names" : "ASX ordinary shares",
      evidenceKind: evidenceKindOf(ev),
      author: def?.author ?? "",
      searchText: [name, id, def?.author ?? "", styleLabel].join(" ").toLowerCase(),
      cells: cellsOf(ev, years, startYear, evidence !== null),
      metricsByWindow,
      live: liveMetric(ev),
      inspector: inspectorOf(def, id, ev),
    };
  });

  const freezes = [...new Set(rows.map((r) => r.inspector.liveFrom).filter(Boolean))];
  const chipLabel =
    freezes.length === 1
      ? `Backtests · in-sample to ${freezes[0]}`
      : freezes.length === 0
        ? "Backtests"
        : "Backtests · in-sample to each rule set's freeze date";

  const rangeParts = evidence
    ? [
        evidence.windowStart
          ? `${shortDate(evidence.windowStart)} to ${evidence.pricesThrough ? shortDate(evidence.pricesThrough) : "prices not yet published"}`
          : "",
        "universe per strategy",
        "costs: house model (tiered spread + brokerage)",
        evidence.benchmarkName ? `benchmark ${evidence.benchmarkName}` : "",
      ].filter(Boolean)
    : [];

  return {
    evidenceAvailable: evidence !== null,
    columns,
    rows,
    styles: uniqueOptions(rows.map((r) => r.styleValue), humaniseStyle),
    horizons: uniqueOptions(rows.map((r) => r.horizonValue), (v) => v),
    rangeLine: rangeParts.join(" · "),
    benchmarkName: evidence?.benchmarkName ?? "",
    footnotes: evidence?.footnotes ?? [],
    chipLabel,
    defaultId: rows.find((r) => r.id === DEFAULT_SIGNALS_STRATEGY)?.id ?? rows[0]?.id ?? null,
  };
}

/**
 * A strategy named from the registry alone, for a render that could not read the list
 * (the build, an outage): its name and dek are there, its metadata is not, so the
 * filters offer nothing for it. Keeps the table's rows in the static HTML.
 */
export function registryStrategy(id: string): StrategyDef {
  return {
    id,
    name: STRATEGIES[id]?.label ?? id,
    author: "",
    tagline: STRATEGIES[id]?.dek ?? "",
    descriptionParagraphs: [],
    rules: [],
    metadata: null,
    caveats: [],
    sources: [],
  };
}

/** The rows the filters keep, in their order. */
export function filterRows(rows: readonly ExplorerRow[], filters: ExplorerFilters): ExplorerRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (query && !row.searchText.includes(query)) return false;
    if (filters.style !== "all" && row.styleValue !== filters.style) return false;
    if (filters.horizon !== "all" && row.horizonValue !== filters.horizon) return false;
    if (filters.universe !== "all" && row.universe !== filters.universe) return false;
    if (filters.evidence !== "all" && row.evidenceKind !== filters.evidence) return false;
    return true;
  });
}

export function isWindowId(value: string | null | undefined): value is WindowId {
  return WINDOW_OPTIONS.some((w) => w.id === value);
}

export function parseWindow(value: string | null | undefined): WindowId {
  return isWindowId(value) ? value : DEFAULT_WINDOW_ID;
}

/** The strategy a `?sel=strategy:<id>` names, when the model holds it; otherwise the default. */
export function parseSelection(
  sel: string | null | undefined,
  rows: readonly ExplorerRow[],
  defaultId: string | null,
): string | null {
  const match = /^strategy:([a-z0-9-]{1,64})$/.exec(sel ?? "");
  const id = match?.[1];
  if (id && rows.some((row) => row.id === id)) return id;
  return defaultId;
}

/** `?ids=` as the compare tray holds it: known ids, unique, at most the limit. */
export function parseIds(raw: string | null | undefined, rows: readonly ExplorerRow[]): string[] {
  const known = new Set(rows.map((row) => row.id));
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (known.has(id) && !out.includes(id)) out.push(id);
    if (out.length === COMPARE_LIMIT) break;
  }
  return out;
}

/** Adds or removes one id from the tray, never past the limit. */
export function toggleId(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= COMPARE_LIMIT) return [...ids];
  return [...ids, id];
}

/** The compare page's link: the ids joined in the order picked. */
export function compareHref(ids: readonly string[]): string {
  return `/strategies/compare?ids=${ids.map(encodeURIComponent).join(",")}`;
}

