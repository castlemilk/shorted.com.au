/** Small, plain insights rows the lib and component tests share. */

import type {
  InsightFlowRow,
  InsightHeatmapRow,
  InsightRemainderRow,
  InsightSectorRow,
  InsightStockRow,
  InsightsPage,
} from "../types";
import { emptyInsightsPage } from "../types";

export function sector(overrides: Partial<InsightSectorRow> = {}): InsightSectorRow {
  return {
    sector: "Materials",
    label: "Materials",
    stocks: 2,
    fundValue: 6e9,
    fundFlow: 3e8,
    fundChangePct: 7.3,
    disclosedValue: 3.4e10,
    superValue: 1.7e9,
    noticeNetPp: 0.1,
    notices: 2,
    rises: 1,
    falls: 1,
    became: 0,
    ceased: 0,
    interests: 4,
    investorInterests: 3,
    ...overrides,
  };
}

export function stock(overrides: Partial<InsightStockRow> = {}): InsightStockRow {
  return {
    code: "BHP",
    name: "BHP Group",
    sector: "Materials",
    fundValue: 5.12e9,
    funds: 2,
    fundChangePct: 10,
    fundFlow: 4e8,
    indexPct: 2.52,
    disclosedPct: 11.4,
    interests: 2,
    disclosedValue: 3.42e10,
    noticeNetPp: -0.9,
    notices: 1,
    ...overrides,
  };
}

export const STOCKS: InsightStockRow[] = [
  stock(),
  stock({ code: "PLS", name: "PLS Group", fundValue: 9e8, fundChangePct: -100, fundFlow: -1e8, disclosedValue: 4e8, noticeNetPp: 1, indexPct: null }),
  stock({ code: "CBA", name: "Commonwealth Bank", sector: "Banks", fundValue: 3e8, fundChangePct: null, fundFlow: 3e8, disclosedValue: null, noticeNetPp: 0, notices: 0, indexPct: 0.13 }),
  stock({ code: "MIN", name: "Mineral Resources", sector: "", fundValue: null, fundChangePct: null, fundFlow: null, disclosedValue: 1e9, noticeNetPp: -3, notices: 1, indexPct: null }),
];

export const SECTORS: InsightSectorRow[] = [
  sector(),
  sector({ sector: "Banks", label: "Banks", stocks: 1, fundValue: 3e8, fundFlow: 3e8, fundChangePct: null, disclosedValue: null, noticeNetPp: 0, notices: 1, rises: 0, falls: 0, became: 1, investorInterests: 0, interests: 1 }),
  sector({ sector: "", label: "Other", stocks: 1, fundValue: null, fundFlow: null, fundChangePct: null, disclosedValue: 1e9, noticeNetPp: -3, notices: 1, rises: 0, falls: 1, ceased: 1, investorInterests: 0, interests: 1 }),
];

export const REMAINDERS: InsightRemainderRow[] = [{ sector: "Materials", stocks: 12, fundValue: 2e8, disclosedValue: 0 }];

export const FLOW: InsightFlowRow = {
  nodes: [
    { id: "kind:index_manager", label: "index_manager", column: 0, kind: "index_manager", slug: "", sector: "", value: 6e9 },
    { id: "kind:super_fund", label: "super_fund", column: 0, kind: "super_fund", slug: "", sector: "", value: 2e9 },
    { id: "inst:vanguard", label: "Vanguard", column: 1, kind: "index_manager", slug: "vanguard", sector: "", value: 5e9 },
    { id: "inst:blackrock", label: "BlackRock", column: 1, kind: "index_manager", slug: "blackrock", sector: "", value: 1e9 },
    { id: "inst:hostplus", label: "Hostplus", column: 1, kind: "super_fund", slug: "hostplus", sector: "", value: 2e9 },
    { id: "sector:Materials", label: "Materials", column: 2, kind: "", slug: "", sector: "Materials", value: 7e9 },
    { id: "sector:Banks", label: "Banks", column: 2, kind: "", slug: "", sector: "Banks", value: 1e9 },
  ],
  links: [
    { source: 0, target: 2, value: 5e9 },
    { source: 0, target: 3, value: 1e9 },
    { source: 1, target: 4, value: 2e9 },
    { source: 2, target: 5, value: 4.5e9 },
    { source: 2, target: 6, value: 0.5e9 },
    { source: 3, target: 5, value: 1e9 },
    { source: 4, target: 5, value: 1.5e9 },
    { source: 4, target: 6, value: 0.5e9 },
  ],
  total: 8e9,
  asAtFrom: "2026-06-30",
  asAtTo: "2026-10-31",
};

export const HEATMAP: InsightHeatmapRow = {
  buckets: [
    { start: "2026-09-28", end: "2026-10-04" },
    { start: "2026-10-05", end: "2026-10-11" },
  ],
  rows: [
    {
      sector: "Materials",
      label: "Materials",
      cells: [
        { fundFlow: 2.2e8, fundsCompared: 1, noticeNetPp: 0.1, notices: 2, rises: 1, falls: 1, became: 0, ceased: 0 },
        { fundFlow: null, fundsCompared: 0, noticeNetPp: 0, notices: 0, rises: 0, falls: 0, became: 0, ceased: 0 },
      ],
    },
  ],
};

export function insightsPage(overrides: Partial<InsightsPage> = {}): InsightsPage {
  const base = emptyInsightsPage({ from: "", to: "", sector: null, stock: "" }, "all");
  return {
    ...base,
    ok: true,
    window: {
      ...base.window,
      from: "2026-08-03",
      to: "2026-10-31",
      timelineFrom: "2025-01-15",
      timelineTo: "2026-10-31",
      snapshotDates: ["2026-08-31", "2026-09-30", "2026-10-31"],
      noticesFrom: "2025-01-15",
      noticesTo: "2026-10-25",
      noticesAsOf: "2026-10-31",
      bucket: "week",
      startFilesFrom: "2026-08-31",
      startFilesTo: "2026-08-31",
      endFilesFrom: "2026-10-15",
      endFilesTo: "2026-10-31",
      fundsCompared: 1,
      fundsAtEnd: 3,
      noticesInWindow: 4,
    },
    sectors: SECTORS,
    stocks: STOCKS,
    remainders: REMAINDERS,
    stocksTotal: 16,
    flowFunds: FLOW,
    flowDisclosed: FLOW,
    heatmap: HEATMAP,
    moves: [
      {
        code: "MIN",
        companyName: "Mineral Resources",
        holder: "Chris Ellison",
        holderHref: null,
        kind: "unclassified",
        event: "ceased",
        date: "2026-10-25",
        votingPower: "under 5%",
        change: "−3.00 pp",
        deltaPp: -3,
        url: "https://asx/min",
      },
    ],
    timeline: [
      { month: "2026-09", notices: 3, files: 1 },
      { month: "2026-10", notices: 24, files: 2 },
    ],
    ...overrides,
  };
}
