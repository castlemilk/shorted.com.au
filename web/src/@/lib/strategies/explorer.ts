// The explorer's model (the /strategies table and its rail): the columns, every cell
// and metric, the filter options, the selection and the compare ids. Pure: no React
// and no DOM, so each state's copy and each filter is unit-tested without rendering.
// The server builds the model for the ISR render; the client island only filters and
// selects over it.
//
// Copy is the spec's (design 1.5, 1.7, 1.8). The states, windows and coverage measures
// are the design 8.2 vocabulary, read through map-backtest.ts (the only proto reader).

import type { ReturnsHeatmapCell } from "~/@/components/strategies/returns-heatmap-table";
import type { SparkPoint } from "./sparkline";
import { formatSigned, NOT_AVAILABLE } from "./format";
import { DEFAULT_SIGNALS_STRATEGY } from "./workspace-nav";
import { STRATEGIES, STRATEGY_SLUGS } from "./registry";
import type { StrategyEvidenceListView, StrategyEvidenceView } from "./map-backtest";
import type { StatusCountsView, StrategyDef } from "./types";

/** The most strategies the compare tray holds (design 2.2). */
export const COMPARE_LIMIT = 3;
/** The fewest a comparison needs. */
export const COMPARE_MINIMUM = 2;

/** The canonical windows open in 2019 (1 May): the table's first year when nothing is published. */
export const CANONICAL_START_YEAR = 2019;

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

/**
 * The universe the table is read on (spec 1.5). "ASX ordinary shares" lists every
 * strategy; "ASIC-reported names" narrows to the strategies whose universe is the
 * names ASIC reports short. There is no "All": the default is the ASX universe.
 */
export const UNIVERSE_OPTIONS = [
  { value: "asx", label: "ASX", name: "ASX ordinary shares" },
  { value: "asic", label: "ASIC-reported", name: "ASIC-reported names" },
] as const;

export type UniverseFilter = (typeof UNIVERSE_OPTIONS)[number]["value"];

export const DEFAULT_UNIVERSE: UniverseFilter = "asx";

export interface ExplorerFilters {
  query: string;
  /** A style key (e.g. "momentum-breakout"), or "all". */
  style: string;
  /** A horizon key (a slug of the holding period, e.g. "weeks-to-months"), or "all". */
  horizon: string;
  universe: UniverseFilter;
  evidence: EvidenceFilter;
}

export const DEFAULT_FILTERS: ExplorerFilters = {
  query: "",
  style: "all",
  horizon: "all",
  universe: DEFAULT_UNIVERSE,
  evidence: "all",
};

/** The copy of every cell and rail state. Exact copy from design 1.7 and 1.8. */
export const EXPLORER_COPY = {
  runRequired: "Run required",
  notComputable: "Not computable: needs point-in-time fundamentals",
  notComputableBefore: (label: string) => `Not computable before ${label}`,
  notComputableSecond: (label: string) =>
    `From ${label} a test is possible only by assuming when results were known and using restated figures; it is not published.`,
  approximateNotPublished: "Approximate run not published",
  beforeWindow: "Before window",
  notElapsed: "Not elapsed",
  noEvidence: "No evidence published",
  unavailable: "Backtest unavailable right now",
  measuredOnAsic:
    "Measured on ASIC-reported names only; delisted companies that were never shorted are missing and cannot be counted.",
  approximate:
    "Approximate: fundamentals assumed known 2 months after period end; restated vendor values; only companies still listed in September 2026 have fundamentals, which flatters results",
  lowCoverage: (pct: number) =>
    `${pct}% of the stocks this strategy could have held in that year have prices. The missing ones mostly delisted before 2025, and heavily shorted failures are over-represented among them, so results this year are flattered; by how much cannot be measured.`,
  totalNotAnnualised: "total return, not annualised",
  hypothetical:
    "Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice.",
  costs:
    "Costs: 10 bps brokerage (min A$10) + 5-50 bps spread by liquidity, per side. Returns are total return after costs.",
  ytd: "YTD",
} as const;

/** Each strategy's short profile for its row: the style and the horizon, in the mockup's form. */
export const SHORT_PROFILE: Readonly<Record<string, string>> = {
  "zanger-breakout": "Breakout · weeks",
  canslim: "Growth · months",
  "minervini-trend-template": "Trend · weeks-months",
  "crowded-short-breakout": "Short crowding · days-weeks",
  "quality-compounders": "Quality · months-years",
};

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
  /** A line under the figure. */
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
  /** The visible caption of the growth line, and its accessible name. */
  sparkLabel: string;
  sparkline: { strategy: SparkPoint[]; benchmark: SparkPoint[]; liveFromMs: number | null };
  /** Shown instead of the line when there is no curve: the state's own copy. */
  emptyLabel: string;
  /** "Recorded since 23 Nov 2026: 10 sessions, 2 trades, too short to judge"; "" otherwise. */
  paperLine: string;
  /** The state's copy: why there is no figure, or when a run started. "" when nothing to say. */
  stateLine: string;
  /** The selected strategy's survivorship statement (1.8 #3); "" when none. */
  survivorship: string;
  /** The live rules' freeze date, short form; "" when none. */
  liveFrom: string;
}

export interface ExplorerRow {
  id: string;
  name: string;
  /** The line under the name: the short profile. */
  sublabel: string;
  styleValue: string;
  styleLabel: string;
  horizonValue: string;
  horizonLabel: string;
  universe: UniverseFilter;
  universeLabel: string;
  evidenceKind: Exclude<EvidenceFilter, "all"> | "none";
  author: string;
  searchText: string;
  cells: ReturnsHeatmapCell[];
  /** Metrics for each window, keyed by window id: CAGR (or the return) and max drawdown. */
  metricsByWindow: Record<WindowId, ExplorerMetric[]>;
  live: ExplorerMetric;
  inspector: ExplorerInspector;
}

export interface ExplorerOption {
  value: string;
  label: string;
  /** The option's full meaning, as its title. */
  title?: string;
}

export interface ExplorerModel {
  /** False when the evidence could not be read: rows still list the strategies, with no figures. */
  evidenceAvailable: boolean;
  columns: ExplorerColumn[];
  rows: ExplorerRow[];
  styles: ExplorerOption[];
  horizons: ExplorerOption[];
  /** "1 May 2019 to 6 Nov 2026 · universe per strategy · costs: house model (tiered spread + brokerage) · benchmark ...". */
  rangeLine: string;
  /** The benchmark every run is measured against, as the API names it. */
  benchmarkName: string;
  footnotes: string[];
  /** The outline chip on the table: the freeze date every row shares. */
  chipLabel: string;
  /** The first row the rail opens on when no selection is named. */
  defaultId: string | null;
}

/** The status counts and the session they are as at, from the picks the page already holds. */
export type TodayByStrategy = Record<string, { counts: StatusCountsView | null; asOf: string } | undefined>;

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

/** "14:02 UTC" from an RFC 3339 time; "" when it does not parse. */
export function utcClock(rfc3339: string | null | undefined): string {
  if (!rfc3339) return "";
  const at = new Date(rfc3339);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })} UTC`;
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

/** A holding period as a stable filter key: "Weeks to months" reads as "weeks-to-months". */
export function horizonKey(period: string): string {
  return period.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The universe a strategy names. A strategy whose universe is the names ASIC reports short
 * is "ASIC-reported names"; every other is ASX ordinary shares.
 *
 * TODO(universe_kind): the contract has no universe kind yet. When StrategyEvidence carries
 * `universe_kind`, read it here and delete the text match.
 */
export function universeOf(universeText: string): UniverseFilter {
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
 * The calendar years the table prints: from the year the canonical windows open to the
 * newest year any evidence or price reaches. The current year is labelled YTD when a
 * strategy carries a to-date figure for it.
 */
export function yearsOf(
  list: StrategyEvidenceListView | null,
  now: Date = new Date(),
): { years: number[]; columns: ExplorerColumn[] } {
  const annualYears = (list?.strategies ?? []).flatMap((s) => s.annual.map((a) => a.year));
  const startYear = yearOf(list?.windowStart) ?? CANONICAL_START_YEAR;
  const newest = Math.max(
    annualYears.length ? Math.max(...annualYears) : 0,
    yearOf(list?.pricesThrough) ?? 0,
  );
  const endYear = Math.max(startYear, newest > 0 ? newest : now.getUTCFullYear());
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y += 1) years.push(y);

  const toDate = (list?.strategies ?? []).some((s) =>
    s.annual.some((a) => a.year === endYear && a.state === "to_date"),
  );
  const columns: ExplorerColumn[] = years.map((year, index) => {
    const isEnd = year === endYear && toDate;
    const note = index === 0 && list?.windowStart ? fromNote(list.windowStart) : "";
    return {
      key: `y${year}`,
      label: isEnd ? `${year} ${EXPLORER_COPY.ytd}` : String(year),
      ...(note ? { note } : {}),
    };
  });
  return { years, columns };
}

/** A hatched cell over `span` year columns. */
const hatched = (label: string, span = 1, title?: string): ReturnsHeatmapCell => ({
  state: "hatched",
  label,
  ...(span > 1 ? { span } : {}),
  ...(title ? { title } : {}),
});

/** The first year a row has a figure for; the window's start when it has none. */
function rowStartYear(evidence: StrategyEvidenceView, fallback: number): number {
  const years = evidence.annual.map((a) => a.year).filter((y) => Number.isInteger(y) && y > 0);
  return years.length ? Math.min(...years) : fallback;
}

/** The annual cells of a published (or approximate) run, one per year. */
function computedCells(
  evidence: StrategyEvidenceView,
  years: number[],
  startYear: number,
): ReturnsHeatmapCell[] {
  const rowStart = rowStartYear(evidence, startYear);
  return years.map((year) => {
    const annual = evidence.annual.find((a) => a.year === year);
    if (annual?.strategyPct == null) {
      return hatched(year < rowStart ? EXPLORER_COPY.beforeWindow : EXPLORER_COPY.notElapsed);
    }
    // A year the strategy has no measure for (not measurable) is marked "?"; a measurable
    // year carries no mark, and its coverage line names its measure in the title.
    const marker = annual.approximate
      ? { glyph: "~", label: EXPLORER_COPY.approximate, title: EXPLORER_COPY.approximate }
      : annual.coverageMeasurable
        ? undefined
        : { glyph: "?", label: EXPLORER_COPY.measuredOnAsic, title: EXPLORER_COPY.measuredOnAsic };
    const coverageTitle =
      annual.coverageMeasurable && annual.coverage !== null
        ? EXPLORER_COPY.lowCoverage(Math.round(annual.coverage * 100))
        : undefined;
    return {
      state: "value",
      value: annual.strategyPct,
      coverage: annual.coverageMeasurable ? annual.coverage : null,
      ...(coverageTitle ? { coverageTitle } : {}),
      ...(marker ? { marker } : {}),
    };
  });
}

/**
 * The cells of a row that is not computable. `computable_from` decides the split: every
 * year before its year is one span "Not computable before <label>", and every year from it
 * on is one span "Approximate run not published". The label is copy only. With no
 * computable_from, the label's year decides. With neither, the whole row is one span.
 */
export function notComputableCells(
  evidence: StrategyEvidenceView,
  years: number[],
): ReturnsHeatmapCell[] {
  if (years.length === 0) return [];
  const cfYear = yearOf(evidence.computableFrom) ?? fiscalYearOf(evidence.fiscalLabel);
  if (cfYear === null) {
    const share = evidence.computableSharePct;
    const label =
      share === null
        ? EXPLORER_COPY.notComputable
        : `Not computable: needs point-in-time fundamentals (fundamentals for ${Math.round(share)}% of the universe)`;
    return [hatched(label, years.length)];
  }
  const copyLabel = evidence.fiscalLabel || String(cfYear);
  const before = years.filter((year) => year < cfYear).length;
  const after = years.length - before;
  const cells: ReturnsHeatmapCell[] = [];
  if (before > 0) {
    cells.push(
      hatched(
        EXPLORER_COPY.notComputableBefore(copyLabel),
        before,
        EXPLORER_COPY.notComputableSecond(copyLabel),
      ),
    );
  }
  if (after > 0) cells.push(hatched(EXPLORER_COPY.approximateNotPublished, after));
  return cells;
}

/** Every cell of one row, by the evidence's state. */
export function cellsOf(
  evidence: StrategyEvidenceView | null,
  years: number[],
  startYear: number,
  evidenceAvailable: boolean,
): ReturnsHeatmapCell[] {
  const span = Math.max(1, years.length);
  if (!evidence) {
    return [evidenceAvailable ? hatched(EXPLORER_COPY.noEvidence, span) : hatched("", span)];
  }
  switch (evidence.state) {
    case "published":
    case "approximate":
      return computedCells(evidence, years, startYear);
    case "run_required":
      return years.map(() => hatched(EXPLORER_COPY.runRequired));
    case "running": {
      const clock = utcClock(evidence.runningSince);
      return [hatched(clock ? `Running since ${clock}` : "Running", span)];
    }
    case "not_computable":
      return notComputableCells(evidence, years);
    default:
      return [hatched(EXPLORER_COPY.noEvidence, span)];
  }
}

/** A window's CAGR (or total return under a year) and max drawdown, as the metric columns print them. */
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

/**
 * The Live column: the paper track's return once it is long enough, labelled as recorded
 * from the track's actual start (recorded_from, else the freeze date); else the date
 * tracking began, while the track is too short to judge.
 */
export function liveMetric(evidence: StrategyEvidenceView | null): ExplorerMetric {
  const paper = evidence?.paper ?? null;
  // The track's first recorded session, else the freeze date. A row with no track, or a start
  // that does not read as a day, is n/a: the label never prints without its date.
  const start = shortDate(paper ? (paper.recordedFrom !== "" ? paper.recordedFrom : paper.since) : "");
  if (!start) return { key: "live", text: NOT_AVAILABLE, value: null };
  if (!paper?.tooShort && paper?.returnPct != null) {
    return {
      key: "live",
      text: formatSigned(paper.returnPct),
      value: paper.returnPct,
      note: `Recorded since ${start}`,
    };
  }
  return { key: "live", text: `Tracking since ${start}`, value: null, note: "Recorded" };
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
    strategy: points.flatMap((p) => (p.equity !== null && Number.isFinite(p.t) ? [{ t: p.t, v: p.equity }] : [])),
    benchmark: points.flatMap((p) =>
      p.benchmark !== null && Number.isFinite(p.t) ? [{ t: p.t, v: p.benchmark }] : [],
    ),
  };
}

/** The rail's state copy: the API's reason where it gives one, else the spec's copy for the state. */
function stateLineOf(evidence: StrategyEvidenceView | null, evidenceAvailable: boolean): string {
  if (!evidence) return evidenceAvailable ? EXPLORER_COPY.noEvidence : EXPLORER_COPY.unavailable;
  if (evidence.stateReason) return evidence.stateReason;
  switch (evidence.state) {
    case "run_required":
      return "No completed backtest for this rules version yet. It is queued; results usually appear within the hour.";
    case "running": {
      const clock = utcClock(evidence.runningSince);
      return clock ? `Running since ${clock}` : "Running";
    }
    case "not_computable": {
      const cfYear = yearOf(evidence.computableFrom) ?? fiscalYearOf(evidence.fiscalLabel);
      if (cfYear === null) {
        const share = evidence.computableSharePct;
        return share === null
          ? EXPLORER_COPY.notComputable
          : `${EXPLORER_COPY.notComputable} (fundamentals for ${Math.round(share)}% of the universe)`;
      }
      const label = evidence.fiscalLabel || String(cfYear);
      return `${EXPLORER_COPY.notComputableBefore(label)}. ${EXPLORER_COPY.notComputableSecond(label)}`;
    }
    case "approximate":
      return EXPLORER_COPY.approximate;
    default:
      return "";
  }
}

/** What the rail's sparkline says where it has no curve: the state's own word. */
function emptyLabelOf(evidence: StrategyEvidenceView | null, evidenceAvailable: boolean): string {
  if (!evidence) return evidenceAvailable ? EXPLORER_COPY.noEvidence : EXPLORER_COPY.unavailable;
  switch (evidence.state) {
    case "run_required":
      return EXPLORER_COPY.runRequired;
    case "running":
      return "Running";
    case "not_computable":
      return "Not computable";
    default:
      return "No backtest yet";
  }
}

function inspectorOf(
  def: StrategyDef | undefined,
  id: string,
  evidence: StrategyEvidenceView | null,
  today: TodayByStrategy[string],
  evidenceAvailable: boolean,
): ExplorerInspector {
  const liveFrom = evidence?.version?.liveFrom ?? "";
  const paper = evidence?.paper ?? null;
  const spark = sparkOf(evidence);
  const liveFromLabel = shortDate(liveFrom);
  const paperLine =
    paper?.since && paper.tooShort
      ? `Recorded since ${shortDate(paper.recordedFrom || paper.since)}: ${paper.sessions} sessions, ${paper.closedTrades} trades, too short to judge`
      : "";
  // The status counts and their session come from the picks the page holds; the
  // evidence's own counts are the fallback.
  const counts = today?.counts ?? evidence?.today ?? null;
  const pickedAsOf = today?.asOf ?? "";
  const asOf = pickedAsOf !== "" ? pickedAsOf : (evidence?.latestScreen ?? "");
  return {
    name: def?.name ?? (STRATEGIES[id]?.label ?? id),
    author: def?.author ?? "",
    tagline: def?.tagline ?? "",
    chips: [
      "Long entries",
      ...(/daily/i.test(def?.metadata?.refreshCadence ?? "") ? ["Daily evaluation"] : []),
    ],
    holdingHorizon: def?.metadata?.holdingPeriod ?? "",
    latestScreen: shortDate(asOf),
    countsText: countsText(counts),
    counts,
    sparkLabel: liveFromLabel ? `Backtest, in-sample to ${liveFromLabel}, then recorded` : "Backtest",
    sparkline: {
      strategy: spark.strategy,
      benchmark: spark.benchmark,
      liveFromMs: liveFrom ? Date.parse(`${liveFrom.slice(0, 10)}T00:00:00Z`) : null,
    },
    emptyLabel: emptyLabelOf(evidence, evidenceAvailable),
    paperLine,
    stateLine: stateLineOf(evidence, evidenceAvailable),
    survivorship: evidence?.survivorship ?? "",
    liveFrom: liveFromLabel,
  };
}

function uniqueOptions(values: string[], label: (value: string) => string): ExplorerOption[] {
  const seen = [...new Set(values.filter((v) => v.length > 0))].sort();
  return [{ value: "all", label: "All" }, ...seen.map((value) => ({ value, label: label(value) }))];
}

/**
 * The whole explorer. `strategies` is the registry's list (names, authors, the metadata
 * the filters read); `evidence` is ListStrategyEvidence, or null when it could not be
 * read. `today` holds each strategy's picks counts and session. Rows follow the
 * strategies' order, then any strategy only the evidence names.
 */
export function buildExplorerModel(input: {
  strategies: StrategyDef[];
  evidence: StrategyEvidenceListView | null;
  today?: TodayByStrategy;
  now?: Date;
}): ExplorerModel {
  const { strategies, evidence } = input;
  const { years, columns } = yearsOf(evidence, input.now);
  const startYear = years[0] ?? CANONICAL_START_YEAR;
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
    const universe = universeOf(def?.metadata?.universe ?? "");
    const name = def?.name ?? (STRATEGIES[id]?.label ?? id);
    const styleLabel = style ? humaniseStyle(style) : "";
    const metricsByWindow = Object.fromEntries(
      WINDOW_OPTIONS.map((w) => [w.id, windowMetrics(ev, w.id)]),
    ) as Record<WindowId, ExplorerMetric[]>;
    return {
      id,
      name,
      sublabel: SHORT_PROFILE[id] ?? [styleLabel, horizon.toLowerCase()].filter(Boolean).join(" · "),
      styleValue: style,
      styleLabel,
      horizonValue: horizon ? horizonKey(horizon) : "",
      horizonLabel: horizon,
      universe,
      universeLabel: UNIVERSE_OPTIONS.find((o) => o.value === universe)?.name ?? "",
      evidenceKind: evidenceKindOf(ev),
      author: def?.author ?? "",
      searchText: [name, id, def?.author ?? "", styleLabel].join(" ").toLowerCase(),
      cells: cellsOf(ev, years, startYear, evidence !== null),
      metricsByWindow,
      live: liveMetric(ev),
      inspector: inspectorOf(def, id, ev, input.today?.[id], evidence !== null),
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
    horizons: uniqueOptions(rows.map((r) => r.horizonValue), (key) => rows.find((r) => r.horizonValue === key)?.horizonLabel ?? key),
    rangeLine: rangeParts.join(" · "),
    benchmarkName: evidence?.benchmarkName ?? "",
    footnotes: evidence?.footnotes ?? [],
    chipLabel,
    defaultId: rows.find((r) => r.id === DEFAULT_SIGNALS_STRATEGY)?.id ?? rows[0]?.id ?? null,
  };
}

/**
 * A strategy named from the registry alone, for a render that could not read the list
 * (the build, an outage): its name and dek are there, its metadata is not.
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

/** The rows the filters keep, in their order. Universe "asx" keeps every row; "asic" narrows. */
export function filterRows(rows: readonly ExplorerRow[], filters: ExplorerFilters): ExplorerRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (query && !row.searchText.includes(query)) return false;
    if (filters.style !== "all" && row.styleValue !== filters.style) return false;
    if (filters.horizon !== "all" && row.horizonValue !== filters.horizon) return false;
    if (filters.universe === "asic" && row.universe !== "asic") return false;
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

/** The value a URL names when it is one of the options; the fallback otherwise. Stable keys only. */
export function pickOption<T extends string>(
  value: string | null | undefined,
  options: readonly { value: T }[],
  fallback: T,
): T {
  return options.some((o) => o.value === value) ? (value as T) : fallback;
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

/** The strategies the compare picker offers: the registry's, in its order. */
export function compareCandidates(): Array<{ id: string; name: string }> {
  return STRATEGY_SLUGS.map((id) => ({ id, name: STRATEGIES[id]?.label ?? id }));
}
