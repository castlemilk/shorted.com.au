/// <reference types="jest" />

/**
 * The insights action (/ownership/insights): an outage is not an empty answer,
 * a refused query makes no request, KV holds the default view only, the part
 * asked for is all that is sent, and the rows are plain.
 */

import { create, toJson } from "@bufbuild/protobuf";

const mockGetInsights = jest.fn();
const mockCreateConnectTransport = jest.fn((_options: unknown) => ({}));
const mockGetCached = jest.fn();
const mockSetCached = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (options: unknown) => mockCreateConnectTransport(options),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({ getOwnershipInsights: (request: unknown) => mockGetInsights(request) }),
}));
jest.mock("@bufbuild/protobuf", () => jest.requireActual("@bufbuild/protobuf"));
jest.mock("~/gen/shorts/v1alpha1/ownership_insights_pb", () => jest.requireActual("~/gen/shorts/v1alpha1/ownership_insights_pb"));
jest.mock("~/gen/shorts/v1alpha1/ownership_pb", () => jest.requireActual("~/gen/shorts/v1alpha1/ownership_pb"));
jest.mock("@/lib/kv-cache", () => {
  const actual = jest.requireActual("@/lib/kv-cache");
  return {
    ...actual,
    getCached: (key: string) => mockGetCached(key),
    setCached: (key: string, value: unknown, ttl: number) => mockSetCached(key, value, ttl),
  };
});

import { GetOwnershipInsightsResponseSchema } from "~/gen/shorts/v1alpha1/ownership_insights_pb";
import { OWNERSHIP_TTL } from "@/lib/kv-cache";
import { loadOwnershipInsights } from "../ownershipInsights";

const KEY = "cache:ownership:insights:v1";
const originalEnv = process.env;

function response() {
  return create(GetOwnershipInsightsResponseSchema, {
    window: { from: "2026-08-03", to: "2026-10-31", timelineFrom: "2025-01-15", timelineTo: "2026-10-31", bucket: "week", fundsCompared: 1, noticesAsOf: "2026-10-31" },
    sectors: [
      { sector: "Materials", stocks: 2, fundValueAud: 6e9, hasFundValue: true, fundFlowAud: 3e8, hasFundFlow: true, noticeNetPp: 0.1, notices: 2 },
      { sector: "Not Applic", stocks: 1, disclosedValueAud: 1e9, hasDisclosedValue: true },
    ],
    stocks: [{ stockCode: "BHP", companyName: "BHP Group", sector: "Materials", fundValueAud: 5e9, hasFundValue: true, fundChangePct: 10, hasFundChange: false }],
    flowFunds: {
      nodes: [
        { id: "kind:index_manager", label: "index_manager", column: 0, kind: "index_manager", valueAud: 1 },
        { id: "sector:", label: "", column: 2, sector: "", valueAud: 1 },
        { id: "sector:other", label: "Other sectors", column: 2, sector: "", valueAud: 1 },
      ],
      links: [{ source: 0, target: 1, valueAud: 1 }],
      totalAud: 1,
    },
    heatmap: { buckets: [{ start: "2026-10-26", end: "2026-10-31" }], rows: [{ sector: "Materials", cells: [{ hasFundFlow: false, notices: 1, noticeNetPp: -0.9 }] }] },
    moves: [
      {
        stockCode: "BHP", companyName: "BHP Group", holderKey: "vanguard", holderName: "Vanguard", institutionSlug: "vanguard",
        kind: "index_manager", form: "604", presentPct: 5.1, hasPresent: true, previousPct: 6, hasPrevious: true,
        eventDate: "2026-09-29", announcedOn: "2026-09-30", announcementUrl: "https://asx/bhp", event: "decreased",
      },
    ],
    stockDetail: { stockCode: "BHP", companyName: "BHP Group", holders: 2, funds: [{ institutionSlug: "vanguard", fundName: "VAS", fundCode: "VAS", sourceKind: "etf", asAt: "2026-10-31", hasUnits: true, units: 1e8 }] },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  delete process.env.SKIP_STATIC_GENERATION;
  delete process.env.NEXT_PHASE;
  mockGetCached.mockResolvedValue(null);
  mockSetCached.mockResolvedValue(true);
  mockGetInsights.mockResolvedValue(response());
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = originalEnv;
});

describe("loadOwnershipInsights", () => {
  it("maps the default view into plain rows, n/a as null, and keeps it in KV", async () => {
    const page = await loadOwnershipInsights({});
    expect(page.ok).toBe(true);
    expect(mockGetInsights).toHaveBeenCalledWith({ windowFrom: "", windowTo: "", sector: "", stockCode: "" });
    expect(page.sectors.map((s) => s.label)).toEqual(["Materials", "Other"]);
    expect(page.sectors[1]!.fundValue).toBeNull();
    expect(page.stocks[0]!.fundChangePct).toBeNull();
    expect(page.flowFunds.nodes.map((n) => n.label)).toEqual(["index_manager", "Other", "Other sectors"]);
    expect(page.heatmap.rows[0]!.cells[0]!.fundFlow).toBeNull();
    expect(page.moves[0]).toMatchObject({ code: "BHP", holder: "Vanguard", holderHref: "/ownership/vanguard", change: "−0.90 pp", date: "2026-09-29" });
    expect(page.stockDetail!.funds[0]!.fund).toBe("VAS");
    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    expect(mockSetCached).toHaveBeenCalledWith(KEY, toJson(GetOwnershipInsightsResponseSchema, response()), OWNERSHIP_TTL);
  });

  it("answers the default view from a populated KV entry without a request", async () => {
    mockGetCached.mockResolvedValue(toJson(GetOwnershipInsightsResponseSchema, response()));
    const page = await loadOwnershipInsights({});
    expect(page.ok).toBe(true);
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it("reads any other window live, never through KV, and sends only the part asked for", async () => {
    const stock = await loadOwnershipInsights({ from: "2026-09-01", to: "2026-10-01", stock: "BHP", part: "stock" });
    expect(mockGetInsights).toHaveBeenCalledWith({ windowFrom: "2026-09-01", windowTo: "2026-10-01", sector: "", stockCode: "BHP" });
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(stock.stockDetail?.code).toBe("BHP");
    expect(stock.sectors).toEqual([]);
    expect(stock.heatmap.rows).toEqual([]);

    const sector = await loadOwnershipInsights({ sector: "", part: "sector" });
    expect(mockGetInsights).toHaveBeenLastCalledWith({ windowFrom: "", windowTo: "", sector: "", stockCode: "" });
    expect(sector.stocks).toHaveLength(1);
    expect(sector.flowFunds.nodes).toEqual([]);
  });

  it("refuses a query the clamp refuses, or that is not an object, without a request", async () => {
    const bad = await loadOwnershipInsights({ from: "2026-10-02", to: "2026-10-01" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/from is after to/);
    const notObject = await loadOwnershipInsights("x" as never);
    expect(notObject.error).toMatch(/must be an object/);
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it("carries the API's refusal, without a retry", async () => {
    mockGetInsights.mockRejectedValue({ code: 3, rawMessage: "window_from is after window_to" });
    const page = await loadOwnershipInsights({ from: "2026-09-01" });
    expect(page.ok).toBe(false);
    expect(page.error).toBe("refused by the API: window_from is after window_to");
    expect(mockGetInsights).toHaveBeenCalledTimes(1);
  });

  it("draws an outage as ok: false with no reason, and never keeps it", async () => {
    jest.useFakeTimers();
    try {
      mockGetInsights.mockRejectedValue({ code: 14, message: "unavailable" });
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      jest.spyOn(console, "log").mockImplementation(() => undefined);
      const pending = loadOwnershipInsights({});
      await jest.runAllTimersAsync();
      const page = await pending;
      expect(page.ok).toBe(false);
      expect(page.error).toBe("");
      expect(mockSetCached).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not read during the build prerender", async () => {
    process.env.SKIP_STATIC_GENERATION = "1";
    process.env.NEXT_PHASE = "phase-production-build";
    const page = await loadOwnershipInsights({});
    expect(page.ok).toBe(false);
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it("tags the transport for ISR and sends it through the server fetcher", async () => {
    await loadOwnershipInsights({});
    expect(mockCreateConnectTransport).toHaveBeenCalled();
  });
});
