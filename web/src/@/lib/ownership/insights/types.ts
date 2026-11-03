/**
 * The insights explorer's plain rows (/ownership/insights).
 *
 * The server action (app/actions/ownershipInsights.ts) maps the API's answer
 * into these, and the island and the server page draw them. Only plain values
 * cross the RSC boundary: strings, numbers, booleans, nulls, and arrays and
 * objects of them. A figure the API does not hold is null, never 0, so a page
 * prints it as n/a.
 *
 * Dependency-free on purpose: the island, the charts and the server page all
 * import these types, and none of them may reach generated code from here.
 */

/** Which measure sizes the market map and fills the money flow and the heatmap. */
export type InsightMeasure = "funds" | "disclosed";

/** What the explorer asked for: the window, and an optional focus. */
export interface InsightsQuery {
  /** YYYY-MM-DD; "" for the default window. */
  from: string;
  to: string;
  /** A sector as the API names it ("" is a real sector: Other). null for no focus. */
  sector: string | null;
  /** An ASX code; "" for none. */
  stock: string;
}

/** What one answer is for: the whole view, one sector's drill, or one stock's panel. */
export type InsightsPart = "all" | "sector" | "stock";

export interface InsightsWindowRow {
  from: string;
  to: string;
  timelineFrom: string;
  timelineTo: string;
  snapshotDates: string[];
  noticesFrom: string;
  noticesTo: string;
  noticesAsOf: string;
  bucket: "week" | "month" | "";
  startFilesFrom: string;
  startFilesTo: string;
  endFilesFrom: string;
  endFilesTo: string;
  fundsCompared: number;
  fundsAtEnd: number;
  noticesInWindow: number;
}

export interface InsightSectorRow {
  sector: string;
  /** The sector as printed: "Other" for none or a placeholder. */
  label: string;
  stocks: number;
  fundValue: number | null;
  fundFlow: number | null;
  fundChangePct: number | null;
  disclosedValue: number | null;
  superValue: number | null;
  noticeNetPp: number;
  notices: number;
  rises: number;
  falls: number;
  became: number;
  ceased: number;
  interests: number;
  investorInterests: number;
}

export interface InsightStockRow {
  code: string;
  name: string;
  sector: string;
  fundValue: number | null;
  funds: number;
  fundChangePct: number | null;
  fundFlow: number | null;
  indexPct: number | null;
  disclosedPct: number;
  interests: number;
  disclosedValue: number | null;
  noticeNetPp: number;
  notices: number;
}

export interface InsightRemainderRow {
  sector: string;
  stocks: number;
  fundValue: number;
  disclosedValue: number;
}

export interface InsightFlowNodeRow {
  id: string;
  label: string;
  /** 0 a kind, 1 an institution or Other, 2 a sector or Other sectors. */
  column: number;
  kind: string;
  slug: string;
  sector: string;
  value: number;
}

export interface InsightFlowLinkRow {
  source: number;
  target: number;
  value: number;
}

export interface InsightFlowRow {
  nodes: InsightFlowNodeRow[];
  links: InsightFlowLinkRow[];
  total: number;
  asAtFrom: string;
  asAtTo: string;
}

export interface InsightBucketRow {
  start: string;
  end: string;
}

export interface InsightHeatCellRow {
  fundFlow: number | null;
  fundsCompared: number;
  noticeNetPp: number;
  notices: number;
  rises: number;
  falls: number;
  became: number;
  ceased: number;
}

export interface InsightHeatRowRow {
  sector: string;
  label: string;
  cells: InsightHeatCellRow[];
}

export interface InsightHeatmapRow {
  buckets: InsightBucketRow[];
  rows: InsightHeatRowRow[];
}

/** A move a notice states: present less previous, both figures stated. */
export interface InsightMoveRow {
  code: string;
  companyName: string;
  holder: string;
  holderHref: string | null;
  kind: string;
  event: string;
  /** The event date, else the release date. */
  date: string;
  votingPower: string;
  change: string;
  deltaPp: number;
  url: string;
}

export interface InsightInstitutionRow {
  slug: string;
  name: string;
  kind: string;
  value: number | null;
  flow: number | null;
}

export interface InsightFundPositionRow {
  institution: string;
  slug: string;
  kind: string;
  fund: string;
  sourceKind: string;
  asAt: string;
  startAsAt: string;
  units: number | null;
  value: number | null;
  startUnits: number | null;
}

export interface InsightKindShareRow {
  kind: string;
  pct: number;
  holders: number;
}

export interface InsightStockDetailRow {
  code: string;
  name: string;
  sector: string;
  disclosedPct: number;
  byKind: InsightKindShareRow[];
  holders: number;
  latestNoticeDate: string;
  funds: InsightFundPositionRow[];
  notices: InsightMoveRow[];
}

export interface InsightTimelineRow {
  month: string;
  notices: number;
  files: number;
}

/**
 * One answer. `ok` means the API served it: a failed read and an empty register
 * both arrive with no rows, and they mean opposite things.
 */
export interface InsightsPage {
  ok: boolean;
  /** Why a query was refused; "" when it was served or the read failed. */
  error: string;
  query: InsightsQuery;
  part: InsightsPart;
  window: InsightsWindowRow;
  sectors: InsightSectorRow[];
  stocks: InsightStockRow[];
  remainders: InsightRemainderRow[];
  stocksTotal: number;
  flowFunds: InsightFlowRow;
  flowDisclosed: InsightFlowRow;
  heatmap: InsightHeatmapRow;
  moves: InsightMoveRow[];
  sectorInstitutions: InsightInstitutionRow[];
  stockDetail: InsightStockDetailRow | null;
  timeline: InsightTimelineRow[];
}

/** The window of an answer that holds none: a shell, a refusal or an outage. */
export const EMPTY_WINDOW: InsightsWindowRow = {
  from: "",
  to: "",
  timelineFrom: "",
  timelineTo: "",
  snapshotDates: [],
  noticesFrom: "",
  noticesTo: "",
  noticesAsOf: "",
  bucket: "",
  startFilesFrom: "",
  startFilesTo: "",
  endFilesFrom: "",
  endFilesTo: "",
  fundsCompared: 0,
  fundsAtEnd: 0,
  noticesInWindow: 0,
};

export const EMPTY_FLOW: InsightFlowRow = { nodes: [], links: [], total: 0, asAtFrom: "", asAtTo: "" };

/** A page with no answer in it, for the query asked. */
export function emptyInsightsPage(query: InsightsQuery, part: InsightsPart, error = ""): InsightsPage {
  return {
    ok: false,
    error,
    query,
    part,
    window: EMPTY_WINDOW,
    sectors: [],
    stocks: [],
    remainders: [],
    stocksTotal: 0,
    flowFunds: EMPTY_FLOW,
    flowDisclosed: EMPTY_FLOW,
    heatmap: { buckets: [], rows: [] },
    moves: [],
    sectorInstitutions: [],
    stockDetail: null,
    timeline: [],
  };
}
