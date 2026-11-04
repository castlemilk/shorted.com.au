/// <reference types="jest" />

/**
 * The desk's five loaders (app/actions/ownershipDesk.ts) and what is load-bearing
 * about them:
 *
 *   - AN OUTAGE IS NOT AN EMPTY ANSWER, and a refusal is not an outage. A refusal
 *     (InvalidArgument) carries its reason in `error` and is logged; no retry runs.
 *   - A QUERY THE LOADER CANNOT SEND MAKES NO REQUEST: a half pair of notice dates,
 *     an inverted or over-long span, an argument that is not an object, a stock
 *     code the API would refuse.
 *   - THE NOTICE WINDOW AND THE FUND WINDOW ARE TWO PARAMETERS. The map and the
 *     flows take since/until; the fund changes take from/to, and neither reads the
 *     other's names.
 *   - KV HOLDS THE DEFAULT VIEWS ONLY, AND ONLY A POPULATED ANSWER. A window chip,
 *     a brushed pair, a zoomed sector and a stock are never keys.
 *   - A WINDOW OF DAYS IS COUNTED FROM THE NEWEST NOTICE READ, which the activity
 *     call supplies; the default window sends no dates at all.
 *   - THE ROWS ARE PLAIN. A null is a figure the API did not state, never a zero.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";

const mockGetOwnershipMap = jest.fn();
const mockGetOwnershipFlows = jest.fn();
const mockGetOwnershipActivity = jest.fn();
const mockListFundPositionChanges = jest.fn();
const mockGetStockFundSeries = jest.fn();
const mockGetStockOwnership = jest.fn();
const mockListStockRegisters = jest.fn();
const mockCreateConnectTransport = jest.fn((_options: unknown) => ({}));
const mockGetCached = jest.fn();
const mockLoadNoticeFeed = jest.fn();
const mockSetCached = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (options: unknown) => mockCreateConnectTransport(options),
}));

// The inspector's notice reads go through the feed loader; its own tests are in ownershipExplorer.test.ts.
jest.mock("../ownershipExplorer", () => ({
  loadNoticeFeed: (input: unknown) => mockLoadNoticeFeed(input),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getOwnershipMap: (request: unknown) => mockGetOwnershipMap(request),
    getOwnershipFlows: (request: unknown) => mockGetOwnershipFlows(request),
    getOwnershipActivity: (request: unknown) => mockGetOwnershipActivity(request),
    listFundPositionChanges: (request: unknown) => mockListFundPositionChanges(request),
    getStockFundSeries: (request: unknown) => mockGetStockFundSeries(request),
    getStockOwnership: (request: unknown) => mockGetStockOwnership(request),
    listStockRegisters: (request: unknown) => mockListStockRegisters(request),
  }),
}));

// The real messages and codec: the KV entry is the API's answer as proto JSON.
jest.mock("@bufbuild/protobuf", () => jest.requireActual("@bufbuild/protobuf"));
jest.mock("~/gen/shorts/v1alpha1/ownership_pb", () =>
  jest.requireActual("~/gen/shorts/v1alpha1/ownership_pb"),
);

jest.mock("@/lib/kv-cache", () => {
  const actual = jest.requireActual("@/lib/kv-cache");
  return {
    ...actual,
    getCached: (key: string) => mockGetCached(key),
    setCached: (key: string, value: unknown, ttl: number) => mockSetCached(key, value, ttl),
  };
});

import {
  GetOwnershipActivityResponseSchema,
  GetOwnershipFlowsResponseSchema,
  GetOwnershipMapResponseSchema,
  GetStockFundSeriesResponseSchema,
  GetStockOwnershipResponseSchema,
  ListFundPositionChangesResponseSchema,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { CACHE_KEYS, OWNERSHIP_TTL } from "@/lib/kv-cache";
import {
  loadFundPositionChanges,
  loadOwnershipActivity,
  loadOwnershipFlows,
  loadOwnershipMap,
  loadStockFundSeries,
  loadStockPanel,
} from "../ownershipDesk";

const originalEnv = process.env;

const UNAVAILABLE = { code: 14, message: "unavailable" };
const MAP_KEY = "cache:ownership:desk-map:v2";
const FLOWS_KEY = "cache:ownership:desk-flows:v2";
const ACTIVITY_KEY = "cache:ownership:desk-activity:v2";
const FUNDS_KEY = "cache:ownership:desk-funds:v1";

function mapStock(overrides: Record<string, unknown> = {}) {
  return {
    stockCode: "BHP",
    companyName: "BHP Group",
    industry: "Materials",
    marketCap: 250_000_000_000,
    hasMarketCap: true,
    disclosedPct: 14.1,
    institutionalPct: 9.0,
    hedgePct: 2.2,
    indexPct: 3.4,
    hasIndexPct: true,
    shortPct: 0,
    hasShortPct: false,
    flowPp: 0,
    hasFlowPp: false,
    notices: 4,
    ...overrides,
  };
}

function mapResponse(overrides: Record<string, unknown> = {}) {
  return create(GetOwnershipMapResponseSchema, {
    from: "2026-08-02",
    to: "2026-10-31",
    stocks: [mapStock()],
    asOf: "2026-10-31",
    ...overrides,
  });
}

function activityResponse(overrides: Record<string, unknown> = {}) {
  return create(GetOwnershipActivityResponseSchema, {
    fromWeek: "2026-10-26",
    toWeek: "2026-10-26",
    asOf: "2026-10-31",
    rows: [
      {
        industry: "Materials",
        weekStart: "2026-10-26",
        became: 1,
        increased: 2,
        decreased: 0,
        changed: 0,
        ceased: 0,
        nz: 0,
        netPp: 1.25,
        hasNetPp: true,
      },
    ],
    ...overrides,
  });
}

function flowsResponse(overrides: Record<string, unknown> = {}) {
  return create(GetOwnershipFlowsResponseSchema, {
    from: "2026-08-02",
    to: "2026-10-31",
    asOf: "2026-10-31",
    positions: [
      {
        kind: "super_fund",
        industry: "Materials",
        exposureAud: 3_000_000_000,
        hasExposure: true,
        holdings: 4,
        largestCode: "BHP",
        largestPct: 9.2,
      },
    ],
    changes: [
      { kind: "super_fund", industry: "Materials", direction: "up", exposureAud: 4e8, hasExposure: true, notices: 3 },
      { kind: "super_fund", industry: "Materials", direction: "sideways", exposureAud: 1, hasExposure: true, notices: 1 },
    ],
    ...overrides,
  });
}

function fundsResponse(overrides: Record<string, unknown> = {}) {
  return create(ListFundPositionChangesResponseSchema, {
    snapshotDates: ["2026-09-30", "2026-10-31"],
    from: "2026-09-30",
    to: "2026-10-31",
    rows: [
      {
        stockCode: "BHP",
        companyName: "BHP Group",
        weightFromPct: 4,
        hasWeightFrom: true,
        weightToPct: 5,
        hasWeightTo: true,
        deltaPp: 1,
        hasDelta: true,
        valueFromAud: 1e9,
        hasValueFrom: true,
        valueToAud: 1.2e9,
        hasValueTo: true,
        funds: 2,
        state: "current",
      },
      {
        stockCode: "NEW1",
        companyName: "New One",
        weightFromPct: 0,
        hasWeightFrom: false,
        weightToPct: 1.2,
        hasWeightTo: true,
        deltaPp: 0,
        hasDelta: false,
        valueFromAud: 0,
        hasValueFrom: false,
        valueToAud: 0,
        hasValueTo: false,
        funds: 1,
        state: "new",
      },
      {
        stockCode: "ODD",
        companyName: "Odd State",
        weightFromPct: 0,
        hasWeightFrom: false,
        weightToPct: 0,
        hasWeightTo: false,
        deltaPp: 0,
        hasDelta: false,
        valueFromAud: 0,
        hasValueFrom: false,
        valueToAud: 0,
        hasValueTo: false,
        funds: 1,
        state: "sideways",
      },
    ],
    ...overrides,
  });
}

function seriesResponse(overrides: Record<string, unknown> = {}) {
  return create(GetStockFundSeriesResponseSchema, {
    stockCode: "BHP",
    funds: [
      {
        institutionSlug: "vanguard",
        institutionName: "Vanguard",
        fundName: "Vanguard Australian Shares Index",
        sourceKind: "etf",
        points: [
          { asAt: "2026-09-30", weightPct: 3.1, hasWeight: true, valueAud: 1e8, hasValue: true },
          { asAt: "2026-10-31", weightPct: 0, hasWeight: false, valueAud: 0, hasValue: false },
        ],
      },
    ],
    ...overrides,
  });
}

/**
 * Runs a loader whose request fails with a retryable error. The retry wrapper backs
 * off between attempts, so the timers run at once rather than in real time.
 */
async function withOutage<T>(run: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  const spies = ["log", "warn", "error"].map((method) =>
    jest.spyOn(console, method as "log" | "warn" | "error").mockImplementation(() => {}),
  );
  try {
    const pending = run();
    await jest.runAllTimersAsync();
    return await pending;
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    jest.useRealTimers();
  }
}

// A refusal is logged. The spy keeps the output quiet and lets a test read the log.
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  delete process.env.SKIP_STATIC_GENERATION;
  delete process.env.NEXT_PHASE;
  mockGetCached.mockResolvedValue(null);
  mockSetCached.mockResolvedValue(true);
  mockGetOwnershipMap.mockResolvedValue(mapResponse());
  mockGetOwnershipFlows.mockResolvedValue(flowsResponse());
  mockGetOwnershipActivity.mockResolvedValue(activityResponse());
  mockListFundPositionChanges.mockResolvedValue(fundsResponse());
  mockGetStockFundSeries.mockResolvedValue(seriesResponse());
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  process.env = originalEnv;
});

describe("loadOwnershipMap", () => {
  it("serves the default view from the API with no dates, and keeps a populated answer", async () => {
    const page = await loadOwnershipMap({});
    expect(page.ok).toBe(true);
    expect(page.error).toBe("");
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "", to: "", fundFrom: "", fundTo: "" });
    expect(page.from).toBe("2026-08-02");
    expect(page.to).toBe("2026-10-31");
    expect(page.asOf).toBe("2026-10-31");
    expect(mockSetCached).toHaveBeenCalledWith(MAP_KEY, expect.any(Object), OWNERSHIP_TTL);
  });

  it("maps a figure the API did not state to null, never to zero", async () => {
    const page = await loadOwnershipMap({});
    expect(page.stocks).toEqual([
      {
        code: "BHP",
        name: "BHP Group",
        industry: "Materials",
        marketCap: 250_000_000_000,
        disclosedPct: 14.1,
        institutionalPct: 9,
        hedgePct: 2.2,
        indexPct: 3.4,
        shortPct: null,
        flowPp: null,
        fundValueAud: null,
        fundFlowAud: null,
        fundChangePct: null,
        notices: 4,
      },
    ]);
  });

  it("maps the index fund figures with their flags, and the fund comparison's files", async () => {
    mockGetOwnershipMap.mockResolvedValue(
      mapResponse({
        fundsCompared: 2,
        startFilesFrom: "2026-08-03",
        startFilesTo: "2026-08-10",
        endFilesFrom: "2026-10-30",
        endFilesTo: "2026-10-31",
        stocks: [
          mapStock({ hasFundValue: true, fundValueAud: 5e8, hasFundChange: true, fundChangePct: 1.25 }),
          mapStock({ stockCode: "CBA", hasFundValue: false, fundValueAud: 0, hasFundChange: false, fundChangePct: 0 }),
        ],
      }),
    );
    const page = await loadOwnershipMap({ since: "2026-01-01", until: "2026-01-31" });
    expect(page.fundsCompared).toBe(2);
    expect(page.startFilesFrom).toBe("2026-08-03");
    expect(page.startFilesTo).toBe("2026-08-10");
    expect(page.endFilesFrom).toBe("2026-10-30");
    expect(page.endFilesTo).toBe("2026-10-31");
    expect(page.stocks[0]).toMatchObject({ fundValueAud: 5e8, fundChangePct: 1.25 });
    // A stock with no flag is null, never the zero the wire carries.
    expect(page.stocks[1]).toMatchObject({ fundValueAud: null, fundChangePct: null });
  });

  it("states no fund comparison on an outage: zero funds, every file range empty", async () => {
    mockGetOwnershipMap.mockRejectedValue(new Error("unavailable"));
    const page = await withOutage(() => loadOwnershipMap({ since: "2026-01-01", until: "2026-01-31" }));
    expect(page).toMatchObject({ ok: false, fundsCompared: 0, startFilesFrom: "", endFilesTo: "" });
  });

  it("reads the default view from KV and makes no request", async () => {
    mockGetCached.mockResolvedValue(
      JSON.parse(JSON.stringify({ stocks: [{ stockCode: "CBA", companyName: "CBA", industry: "Financials", hasMarketCap: false, marketCap: 0, disclosedPct: 9, institutionalPct: 1, hedgePct: 0, hasIndexPct: false, indexPct: 0, hasShortPct: false, shortPct: 0, hasFlowPp: false, flowPp: 0, notices: 1 }], from: "2026-08-02", to: "2026-10-31", asOf: "2026-10-31" })),
    );
    const page = await loadOwnershipMap({});
    expect(mockGetOwnershipMap).not.toHaveBeenCalled();
    expect(page.stocks[0]!.code).toBe("CBA");
    expect(page.stocks[0]!.marketCap).toBeNull();
  });

  it("does not keep an empty answer", async () => {
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ stocks: [] }));
    const page = await loadOwnershipMap({});
    expect(page.ok).toBe(true);
    expect(page.stocks).toEqual([]);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("reports an outage as ok: false with no error, and keeps nothing", async () => {
    mockGetOwnershipMap.mockRejectedValue(UNAVAILABLE);
    const page = await withOutage(() => loadOwnershipMap({}));
    expect(page.ok).toBe(false);
    expect(page.error).toBe("");
    expect(page.stocks).toEqual([]);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("counts a window of days from the newest notice read, and sends the dates it names", async () => {
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "2026-10-31" }));
    await loadOwnershipMap({ window: 28 });
    // The newest notice comes from the default activity (52 weeks, KV-kept), not a one-week probe.
    expect(mockGetOwnershipActivity).toHaveBeenCalledWith({ weeks: 52 });
    expect(mockGetOwnershipActivity).not.toHaveBeenCalledWith({ weeks: 1 });
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "2026-10-04", to: "2026-10-31", fundFrom: "", fundTo: "" });
    expect(mockGetCached).not.toHaveBeenCalledWith(MAP_KEY);
  });

  it("falls back to the default window for a window the desk does not serve", async () => {
    await loadOwnershipMap({ window: 7 });
    expect(mockGetOwnershipActivity).not.toHaveBeenCalled();
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "", to: "", fundFrom: "", fundTo: "" });
  });

  it("answers an empty register for a chosen window with no rows, never the API's default span", async () => {
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "" }));
    const page = await loadOwnershipMap({ window: 28 });
    expect(page.ok).toBe(true);
    expect(page.error).toBe("");
    expect(page.stocks).toEqual([]);
    expect(mockGetOwnershipMap).not.toHaveBeenCalled();
  });

  it("refuses a half pair of dates without a request", async () => {
    const page = await loadOwnershipMap({ since: "2026-08-01" });
    expect(page.ok).toBe(false);
    expect(page.error).toBe("a window of dates needs both since and until");
    expect(mockGetOwnershipMap).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("refuses an inverted span, a malformed date and a span past the desk's limit", async () => {
    expect((await loadOwnershipMap({ since: "2026-10-31", until: "2026-08-01" })).error).toBe("since is after until");
    expect((await loadOwnershipMap({ since: "2026-02-30", until: "2026-03-01" })).error).toBe("the dates must be YYYY-MM-DD");
    expect((await loadOwnershipMap({ since: "2025-01-01", until: "2026-10-31" })).error).toMatch(/366 days/);
    expect(mockGetOwnershipMap).not.toHaveBeenCalled();
  });

  it("measures the span as the API does: 366 days apart is served, 367 is refused", async () => {
    // clamps.json desk.noticeDates: 2025-10-19 to 2026-10-20 is 366 days apart (367 days, both ends in).
    expect((await loadOwnershipMap({ since: "2025-10-19", until: "2026-10-20" })).error).toBe("");
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "2025-10-19", to: "2026-10-20", fundFrom: "", fundTo: "" });
    expect((await loadOwnershipMap({ since: "2025-10-14", until: "2026-10-16" })).error).toMatch(/366 days/);
    expect(mockGetOwnershipMap).toHaveBeenCalledTimes(1);
  });

  it("serves a brushed pair of dates as a live read", async () => {
    await loadOwnershipMap({ since: "2026-01-01", until: "2026-01-31" });
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "2026-01-01", to: "2026-01-31", fundFrom: "", fundTo: "" });
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it("carries an API refusal as its reason, logs it, and keeps nothing", async () => {
    mockGetOwnershipMap.mockRejectedValue({ code: 3, rawMessage: "from is after to", message: "x" });
    const page = await loadOwnershipMap({ since: "2026-01-01", until: "2026-01-31" });
    expect(page.ok).toBe(false);
    expect(page.error).toBe("refused by the API: from is after to");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("from is after to"));
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("refuses an argument that is not an object without a request", async () => {
    const page = await loadOwnershipMap(null as never);
    expect(page.ok).toBe(false);
    expect(page.error).toBe("the query must be an object");
    expect(mockGetOwnershipMap).not.toHaveBeenCalled();
  });
});

describe("loadOwnershipFlows", () => {
  it("maps the positions and drops a change whose direction is neither up nor down", async () => {
    const page = await loadOwnershipFlows({});
    expect(page.ok).toBe(true);
    expect(page.positions).toEqual([
      {
        kind: "super_fund",
        industry: "Materials",
        exposureAud: 3_000_000_000,
        holdings: 4,
        largestCode: "BHP",
        largestPct: 9.2,
        topHolders: [],
      },
    ]);
    expect(page.changes).toEqual([
      { kind: "super_fund", industry: "Materials", direction: "up", exposureAud: 4e8, notices: 3 },
    ]);
    expect(mockSetCached).toHaveBeenCalledWith(FLOWS_KEY, expect.any(Object), OWNERSHIP_TTL);
  });

  it("reads the default flows from KV", async () => {
    mockGetCached.mockResolvedValue(null);
    await loadOwnershipFlows({});
    expect(mockGetCached).toHaveBeenCalledWith(FLOWS_KEY);
  });

  it("answers a null exposure where the API states none", async () => {
    mockGetOwnershipFlows.mockResolvedValue(
      flowsResponse({
        positions: [
          { kind: "bank_broker", industry: "Financials", exposureAud: 0, hasExposure: false, holdings: 2, largestCode: "MQG", largestPct: 7.7 },
        ],
      }),
    );
    const page = await loadOwnershipFlows({ window: 364 });
    expect(page.positions[0]!.exposureAud).toBeNull();
  });

  it("reports an outage as ok: false", async () => {
    mockGetOwnershipFlows.mockRejectedValue(UNAVAILABLE);
    const page = await withOutage(() => loadOwnershipFlows({ since: "2026-01-01", until: "2026-01-31" }));
    expect(page.ok).toBe(false);
    expect(page.positions).toEqual([]);
  });
});

describe("loadOwnershipActivity", () => {
  it("serves the 52-week default from KV, and maps the net change", async () => {
    const page = await loadOwnershipActivity({});
    expect(page.ok).toBe(true);
    expect(mockGetOwnershipActivity).toHaveBeenCalledWith({ weeks: 52 });
    expect(mockSetCached).toHaveBeenCalledWith(ACTIVITY_KEY, expect.any(Object), OWNERSHIP_TTL);
    expect(page.rows[0]).toEqual({
      industry: "Materials",
      weekStart: "2026-10-26",
      became: 1,
      increased: 2,
      decreased: 0,
      changed: 0,
      ceased: 0,
      nz: 0,
      netPp: 1.25,
    });
  });

  it("serves a shorter run live, and takes the default for a count the API does not serve", async () => {
    await loadOwnershipActivity({ weeks: 26 });
    expect(mockGetOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 26 });
    expect(mockGetCached).not.toHaveBeenCalledWith(ACTIVITY_KEY);
    await loadOwnershipActivity({ weeks: 99 });
    expect(mockGetOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 52 });
  });

  it("maps a week with no stated figure to a null net change", async () => {
    mockGetOwnershipActivity.mockResolvedValue(
      activityResponse({
        rows: [{ industry: "Energy", weekStart: "2026-10-19", became: 0, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0, netPp: 0, hasNetPp: false }],
      }),
    );
    const page = await loadOwnershipActivity({});
    expect(page.rows[0]!.netPp).toBeNull();
  });
});

describe("loadFundPositionChanges", () => {
  it("serves the two newest snapshots from KV, with each row's state", async () => {
    const page = await loadFundPositionChanges({});
    expect(page.ok).toBe(true);
    expect(mockListFundPositionChanges).toHaveBeenCalledWith({ from: "", to: "", limit: 10 });
    expect(page.snapshotDates).toEqual(["2026-09-30", "2026-10-31"]);
    expect(page.rows.map((row) => [row.code, row.state])).toEqual([
      ["BHP", "current"],
      ["NEW1", "new"],
    ]);
    expect(page.rows[0]).toMatchObject({ weightFrom: 4, weightTo: 5, delta: 1, valueFrom: 1e9, valueTo: 1.2e9 });
    expect(page.rows[1]).toMatchObject({ weightFrom: null, delta: null, valueFrom: null });
    expect(mockSetCached).toHaveBeenCalledWith(FUNDS_KEY, expect.any(Object), OWNERSHIP_TTL);
  });

  it("sends a chosen pair and a limit live, clamping the limit to 50", async () => {
    await loadFundPositionChanges({ from: "2026-06-30", to: "2026-10-31", limit: 500 });
    expect(mockListFundPositionChanges).toHaveBeenCalledWith({ from: "2026-06-30", to: "2026-10-31", limit: 50 });
    expect(mockGetCached).not.toHaveBeenCalledWith(FUNDS_KEY);
  });

  it("sends a lone side live, since the API reads the newest snapshot on the other", async () => {
    await loadFundPositionChanges({ from: "2026-06-30" });
    expect(mockListFundPositionChanges).toHaveBeenCalledWith({ from: "2026-06-30", to: "", limit: 10 });
  });

  it("takes a pair of any span, since snapshot history is not bounded by a year", async () => {
    await loadFundPositionChanges({ from: "2024-01-01", to: "2026-10-31" });
    expect(mockListFundPositionChanges).toHaveBeenCalledWith({ from: "2024-01-01", to: "2026-10-31", limit: 10 });
  });

  it("refuses an inverted pair and a malformed date without a request", async () => {
    expect((await loadFundPositionChanges({ from: "2026-10-31", to: "2026-08-01" })).error).toBe("from is after to");
    expect((await loadFundPositionChanges({ to: "2026-13-01" })).error).toBe("the dates must be YYYY-MM-DD");
    expect(mockListFundPositionChanges).not.toHaveBeenCalled();
  });
});

describe("loadStockFundSeries", () => {
  it("upper-cases a code, maps each point's flags, and keeps no entry", async () => {
    const page = await loadStockFundSeries({ stockCode: " bhp " });
    expect(mockGetStockFundSeries).toHaveBeenCalledWith({ stockCode: "BHP" });
    expect(page.ok).toBe(true);
    expect(page.funds[0]!.points).toEqual([
      { asAt: "2026-09-30", weightPct: 3.1, valueAud: 1e8, units: null },
      { asAt: "2026-10-31", weightPct: null, valueAud: null, units: null },
    ]);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("maps a file's shares as units, and null when the file states none", async () => {
    mockGetStockFundSeries.mockResolvedValue(
      seriesResponse({
        funds: [
          {
            institutionSlug: "vanguard",
            institutionName: "Vanguard",
            fundName: "Vanguard Australian Shares Index",
            sourceKind: "etf",
            points: [
              { asAt: "2026-09-30", units: 1_250_000, hasUnits: true },
              { asAt: "2026-10-31", units: 0, hasUnits: false },
            ],
          },
        ],
      }),
    );
    const page = await loadStockFundSeries({ stockCode: "BHP" });
    expect(page.funds[0]!.points.map((point) => point.units)).toEqual([1_250_000, null]);
  });

  it("maps a band's largest holders from the flows, with their exposure and holdings", async () => {
    mockGetOwnershipFlows.mockResolvedValue(
      flowsResponse({
        positions: [
          {
            kind: "super_fund",
            industry: "Materials",
            exposureAud: 3_000_000_000,
            hasExposure: true,
            holdings: 4,
            largestCode: "BHP",
            largestPct: 9.2,
            topHolders: [
              { slug: "aware", name: "Aware Super", exposureAud: 4e8, hasExposure: true, holdings: 2, hasInstitution: true },
              { slug: "", name: "Unlisted fund", exposureAud: 0, hasExposure: false, holdings: 1, hasInstitution: false },
            ],
          },
        ],
      }),
    );
    const page = await loadOwnershipFlows({});
    expect(page.positions[0]!.topHolders).toEqual([
      { slug: "aware", name: "Aware Super", exposureAud: 4e8, holdings: 2 },
      { slug: "", name: "Unlisted fund", exposureAud: null, holdings: 1 },
    ]);
  });

  it("refuses a code the API would refuse, without a request", async () => {
    const page = await loadStockFundSeries({ stockCode: "BH P!" });
    expect(page.ok).toBe(false);
    expect(page.error).toMatch(/stock code/);
    expect(mockGetStockFundSeries).not.toHaveBeenCalled();
  });

  it("reports an outage as ok: false", async () => {
    mockGetStockFundSeries.mockRejectedValue(UNAVAILABLE);
    const page = await withOutage(() => loadStockFundSeries({ stockCode: "BHP" }));
    expect(page.ok).toBe(false);
    expect(page.funds).toEqual([]);
  });
});

describe("loadStockFundSeries fund window and comparisons (spec 14.10)", () => {
  it("sends the fund window it is given, and maps each fund's own change with its unknown figures as null", async () => {
    mockGetStockFundSeries.mockResolvedValue(
      seriesResponse({
        fundFrom: "2026-08-03",
        fundTo: "2026-10-31",
        funds: [
          {
            institutionSlug: "vanguard",
            institutionName: "Vanguard",
            fundName: "VAS",
            fundCode: "VAS",
            fundKey: "asx:VAS",
            sourceKind: "etf",
            points: [],
            hasStartDate: true,
            startDate: "2026-08-31",
            hasStartUnits: true,
            startUnits: 100e6,
            hasEndDate: true,
            endDate: "2026-10-31",
            hasEndUnits: true,
            endUnits: 110e6,
            hasUnitsChange: true,
            unitsChange: 10e6,
            hasChangeValueAud: true,
            changeValueAud: 4e8,
          },
          { institutionSlug: "blackrock", institutionName: "BlackRock", fundName: "IOZ", fundCode: "IOZ", sourceKind: "etf", points: [] },
        ],
      }),
    );
    const page = await loadStockFundSeries({ stockCode: "BHP", fundFrom: " 2026-08-03 ", fundTo: "2026-10-31" });
    expect(mockGetStockFundSeries).toHaveBeenCalledWith({ stockCode: "BHP", fundFrom: "2026-08-03", fundTo: "2026-10-31" });
    expect(page).toMatchObject({ fundFrom: "2026-08-03", fundTo: "2026-10-31" });
    expect(page.funds[0]!.change).toEqual({
      startDate: "2026-08-31",
      startUnits: 100e6,
      endDate: "2026-10-31",
      endUnits: 110e6,
      unitsChange: 10e6,
      changeValueAud: 4e8,
    });
    expect(page.funds[1]!.change).toEqual({
      startDate: null,
      startUnits: null,
      endDate: null,
      endUnits: null,
      unitsChange: null,
      changeValueAud: null,
    });
  });

  it("sends no window when none is named, so the API takes its own default", async () => {
    await loadStockFundSeries({ stockCode: "BHP", fundFrom: "", fundTo: "" });
    expect(mockGetStockFundSeries).toHaveBeenLastCalledWith({ stockCode: "BHP" });
  });
});

describe("loadOwnershipActivity largest moves (spec 14.10)", () => {
  it("maps the moves the server ranked, with their change, release date and notice", async () => {
    mockGetOwnershipActivity.mockResolvedValue(
      activityResponse({
        largestMoves: [
          {
            stockCode: "BHP",
            companyName: "BHP Group",
            holderName: "Vanguard",
            holderSlug: "vanguard",
            hasInstitution: true,
            previousPct: 5,
            presentPct: 6.2,
            changePp: 1.2,
            event: "increased",
            announcedOn: "2026-10-28",
            announcementUrl: "https://www.asx.com.au/bhp.pdf",
          },
        ],
      }),
    );
    const page = await loadOwnershipActivity({});
    expect(page.largestMoves).toEqual([
      { code: "BHP", holder: "Vanguard", url: "https://www.asx.com.au/bhp.pdf", released: "2026-10-28", change: 1.2 },
    ]);
  });

  it("is empty, not a guess, when the activity did not answer", async () => {
    mockGetOwnershipActivity.mockRejectedValue(UNAVAILABLE);
    const page = await withOutage(() => loadOwnershipActivity({}));
    expect(page.ok).toBe(false);
    expect(page.largestMoves).toEqual([]);
  });
});

describe("the default views' keys", () => {
  it("are the four desk keys, none taking a filter", () => {
    expect(CACHE_KEYS.ownershipDeskMap()).toBe(MAP_KEY);
    expect(CACHE_KEYS.ownershipDeskFlows()).toBe(FLOWS_KEY);
    expect(CACHE_KEYS.ownershipDeskActivity()).toBe(ACTIVITY_KEY);
    expect(CACHE_KEYS.ownershipDeskFunds()).toBe(FUNDS_KEY);
  });
});

describe("loadStockPanel", () => {
  function register(holders: number) {
    return create(GetStockOwnershipResponseSchema, {
      summary: {
        stockCode: "BHP",
        companyName: "BHP Group",
        industry: "Materials",
        disclosedPct: 14.1,
        byKind: [{ kind: "investor", pct: 9, holders: 2 }],
        indexPct: 1.2,
        hasIndexPct: true,
        indexAsAtFrom: "2026-10-01",
        indexAsAtTo: "2026-10-31",
        indexFiles: 4,
        shortPct: 3,
        hasShortPct: true,
        shortAsOf: "2026-10-30",
      },
      holders: Array.from({ length: holders }, (_, i) => ({
        holderName: `Holder ${i}`,
        institutionSlug: `holder-${i}`,
        holderKey: `key-${i}`,
        kind: "investor",
        votingPowerPct: i === 0 ? 2 : 5 + i,
        eventDate: "2026-10-01",
      })),
      history: Array.from({ length: 7 }, (_, i) => ({
        holderName: `Notice ${i}`,
        form: "Form 604",
        ceased: i === 1,
        announcedOn: "2026-10-02",
      })),
    });
  }

  it("maps the register to plain rows: three largest holders, five notices, the index share with its date", async () => {
    mockGetStockOwnership.mockResolvedValue(register(4));

    const page = await loadStockPanel("bhp");

    expect(mockGetStockOwnership).toHaveBeenCalledWith({ stockCode: "BHP" });
    expect(page.ok).toBe(true);
    expect(page.code).toBe("BHP");
    expect(page.companyName).toBe("BHP Group");
    expect(page.disclosed).toEqual([{ kind: "investor", pct: 9, holders: 2 }]);
    expect(page.disclosedPct).toBeCloseTo(14.1);
    expect(page.largest.map((holder) => holder.name)).toEqual(["Holder 3", "Holder 2", "Holder 1"]);
    expect(page.largest[0]).toMatchObject({ slug: "holder-3", asAt: "2026-10-01" });
    expect(page.index).toEqual({ pct: 1.2, asAt: "2026-10-31", asAtFrom: "2026-10-01", files: 4 });
    expect(page.notices).toHaveLength(5);
    expect(page.notices[1]).toEqual({
      announcedOn: "2026-10-02",
      form: "Form 604",
      ceased: true,
      holderName: "Notice 1",
    });
    expect(JSON.stringify(page)).not.toContain("$typeName");
  });

  it("never carries the short position: the panel links it", async () => {
    mockGetStockOwnership.mockResolvedValue(register(1));

    const page = await loadStockPanel("BHP");

    expect("short" in page).toBe(false);
  });

  it("keeps a figure the register does not state as null, never zero", async () => {
    mockGetStockOwnership.mockResolvedValue(
      create(GetStockOwnershipResponseSchema, { summary: { stockCode: "BHP", companyName: "BHP Group" } }),
    );

    const page = await loadStockPanel("BHP");

    expect(page.ok).toBe(true);
    expect(page.index).toMatchObject({ pct: null, asAt: "" });
    expect(page.largest).toEqual([]);
  });

  it("reports an outage as ok: false, with no figures to print", async () => {
    mockGetStockOwnership.mockResolvedValue(undefined);

    const page = await loadStockPanel("BHP");

    expect(page.ok).toBe(false);
    expect(page.largest).toEqual([]);
    expect(page.notices).toEqual([]);
  });

  it("refuses a code the API would refuse, without a request", async () => {
    const page = await loadStockPanel("BH P!");

    expect(page.ok).toBe(false);
    expect(mockGetStockOwnership).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Workspace: the activity's holder kind and the inspector's resolver  */
/* ------------------------------------------------------------------ */

describe("loadOwnershipActivity holder kind (spec 14.3)", () => {
  it("forwards a holder kind of the vocabulary and skips the KV default", async () => {
    mockGetOwnershipActivity.mockResolvedValue(activityResponse());
    await loadOwnershipActivity({ kind: "index_manager" });
    expect(mockGetOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 52, kind: "index_manager" });
    expect(mockSetCached).not.toHaveBeenCalledWith(ACTIVITY_KEY, expect.anything(), expect.anything());
  });

  it("sends no kind for an empty or malformed one", async () => {
    mockGetOwnershipActivity.mockResolvedValue(activityResponse());
    await loadOwnershipActivity({ kind: "" });
    expect(mockGetOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 52 });
    await loadOwnershipActivity({ kind: "Index Manager; drop" });
    expect(mockGetOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 52 });
  });
});

describe("loadInspector (spec 14.1 resolvers)", () => {
  // loadInspector is imported lazily so the mocks above apply to it.
  const load = async () => (await import("../ownershipDesk")).loadInspector;

  it("reads no request for a selection the codec would not write, or a kind it does not serve", async () => {
    const loadInspector = await load();
    expect(await loadInspector({ kind: "stock", code: "bhp; drop" } as never)).toBeNull();
    expect(await loadInspector({ kind: "nope" } as never)).toBeNull();
    expect(await loadInspector({ kind: "fund", fundKey: "A200" })).toBeNull();
    expect(mockLoadNoticeFeed).not.toHaveBeenCalled();
    expect(mockGetStockOwnership).not.toHaveBeenCalled();
  });

  it("asks the feed for the week's seven days in one sector, and the sector's industry is matched exactly", async () => {
    const loadInspector = await load();
    mockLoadNoticeFeed.mockResolvedValue({ ok: true, rows: [], total: 0, nextCursor: "", weeks: [], query: {}, activityOk: true, error: "", asOf: "", activity: null });
    const content = await loadInspector({ kind: "cell", sector: "Materials", date: "2026-10-26" });
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith({
      industry: "Materials",
      since: "2026-10-26",
      until: "2026-11-01",
      includeActivity: false,
      limit: 100,
    });
    expect(content?.heading).toBe("Materials");
  });

  it("reads a week up to the notice feed's own page size, so no larger limit is ever asked", async () => {
    const loadInspector = await load();
    mockLoadNoticeFeed.mockResolvedValue({ ok: true, rows: [], total: 0, nextCursor: "", weeks: [], query: {}, activityOk: true, error: "", asOf: "", activity: null });
    await loadInspector({ kind: "cell", sector: "Materials", date: "2026-10-26", holderKind: "" } as never);
    const sent = mockLoadNoticeFeed.mock.calls.at(-1)?.[0] as { limit: number };
    // The API clamps a larger limit to its page size, so the web's limit is read from the Go constant
    // rather than restated: a raise there must move this test with it.
    const goSource = readFileSync(join(__dirname, "../../../../../services/shorts/internal/services/shorts/ownership_lists.go"), "utf8");
    const pageMaxLimit = Number(/pageMaxLimit\s*=\s*(\d+)/.exec(goSource)?.[1]);
    expect(Number.isFinite(pageMaxLimit)).toBe(true);
    expect(sent.limit).toBe(pageMaxLimit);
  });

  it("throws, so the rail says it could not load, when the feed did not answer", async () => {
    const loadInspector = await load();
    mockLoadNoticeFeed.mockResolvedValue({ ok: false, rows: [], total: 0, nextCursor: "", weeks: [], query: {}, activityOk: false, error: "", asOf: "", activity: null });
    await expect(loadInspector({ kind: "cell", sector: "Materials", date: "2026-10-26", holderKind: "" } as never)).rejects.toThrow();
  });

  it("passes the cell's holder kind to the feed, so its count and list are that kind's", async () => {
    const loadInspector = await load();
    mockLoadNoticeFeed.mockResolvedValue({ ok: true, rows: [], total: 0, nextCursor: "", weeks: [], query: {}, activityOk: true, error: "", asOf: "", activity: null });
    await loadInspector({ kind: "cell", sector: "Materials", date: "2026-10-26", holderKind: "super_fund" } as never);
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith(expect.objectContaining({ kind: "super_fund", industry: "Materials" }));
  });
});

describe("loadInspector stock fund window (spec 14.10)", () => {
  const load = async () => (await import("../ownershipDesk")).loadInspector;

  it("reads each fund's comparison over the dates the map gets for the link's chip window", async () => {
    const loadInspector = await load();
    const { loadOwnershipMap } = await import("../ownershipDesk");
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    // The map resolves a 364-day chip to dates counted back from the newest notice.
    await loadOwnershipMap({ window: 364 });
    const mapWindow = mockGetOwnershipMap.mock.calls[0]?.[0] as { from: string; to: string };
    expect(mapWindow.from).not.toBe("");

    await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE, window: "364" });
    expect(mockGetStockFundSeries).toHaveBeenCalledWith(
      expect.objectContaining({ stockCode: "BHP", fundFrom: mapWindow.from, fundTo: mapWindow.to }),
    );
  });

  it("sends the link's own fund dates ahead of the notice window", async () => {
    const loadInspector = await load();
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    await loadInspector({ kind: "stock", code: "BHP" } as never, {
      ...NO_QUERY_FIXTURE,
      window: "364",
      from: "2026-08-03",
      to: "2026-10-31",
    });
    expect(mockGetStockFundSeries).toHaveBeenCalledWith(
      expect.objectContaining({ stockCode: "BHP", fundFrom: "2026-08-03", fundTo: "2026-10-31" }),
    );
  });

  it("leaves the window to the API for the default chip, as the map does", async () => {
    const loadInspector = await load();
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE, window: "91" });
    const request = mockGetStockFundSeries.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.stockCode).toBe("BHP");
    expect(request).not.toHaveProperty("fundFrom");
    expect(request).not.toHaveProperty("fundTo");
  });
});

describe("loadInspector stock reading window (spec 14.8)", () => {
  const load = async () => (await import("../ownershipDesk")).loadInspector;

  function stockWithNotices(dates: string[]) {
    return create(GetStockOwnershipResponseSchema, {
      summary: { stockCode: "BHP", companyName: "BHP Group", industry: "Materials", disclosedPct: 14.1 },
      history: dates.map((announcedOn) => ({ holderName: "Alpha", form: "Form 604", ceased: false, announcedOn })),
    });
  }

  it("counts the stock's notices in the window the desk reads, back from the newest notice on the activity", async () => {
    const loadInspector = await load();
    mockGetStockOwnership.mockResolvedValue(stockWithNotices(["2026-10-02", "2026-10-20", "2024-03-12"]));
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "2026-10-31" }));
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE, window: "28" });
    // 28 days back from 31 October is 4 October: only the 20 October notice is in it.
    expect(content?.reading).toContain("1 notice in 28 days, the last on 2026-10-20.");
  });

  it("names no notice count when none of the stock's notices is in the desk's window", async () => {
    const loadInspector = await load();
    mockGetStockOwnership.mockResolvedValue(stockWithNotices(["2024-03-12"]));
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "2026-10-31" }));
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE, window: "28" });
    expect(content?.reading).not.toMatch(/notice/);
  });

  it("names no notice count when the activity cannot date the window", async () => {
    const loadInspector = await load();
    mockGetStockOwnership.mockResolvedValue(stockWithNotices(["2026-10-20"]));
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "" }));
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE, window: "28" });
    expect(content?.reading).not.toMatch(/notice/);
  });
});

function stockPanelFixture() {
  return create(GetStockOwnershipResponseSchema, {
    summary: { stockCode: "BHP", companyName: "BHP Group", industry: "Materials", disclosedPct: 14.1 },
  });
}

const NO_QUERY_FIXTURE = { lens: "", view: "", window: "", since: "", until: "", asAt: "", from: "", to: "" };

describe("loadInspector connections read the registers (spec 14.7)", () => {
  const load = async () => (await import("../ownershipDesk")).loadInspector;

  function register(code: string, pct: number, marketCap: number) {
    return {
      stockCode: code,
      companyName: `${code} Ltd`,
      industry: "Materials",
      holders: 1,
      disclosedPct: pct,
      byKind: [{ kind: "index_manager", pct, holders: 1 }],
      marketCap,
      hasMarketCap: true,
      latestNoticeDate: "2026-10-01",
    };
  }

  it("asks the registers for the kind and the industry, sorted by disclosure and capped at the API's maximum", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockResolvedValue({ stocks: [register("BHP", 4, 1e11)], total: 1, universe: 1, industries: [], asOf: "" });
    const content = await loadInspector({ kind: "connection", holderKind: "index_manager", sector: "Materials" } as never);
    expect(mockListStockRegisters).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "index_manager", industry: "Materials", limit: 100, offset: 0 }),
    );
    expect(content?.heading).toBe("Index managers → Materials");
  });

  it("maps each company's figure from the kind's own share in the register", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockResolvedValue({
      stocks: [register("BHP", 4, 1e11), register("RIO", 8, 1e10)],
      total: 2,
      universe: 2,
      industries: [],
      asOf: "",
    });
    const content = await loadInspector({ kind: "connection", holderKind: "index_manager", sector: "Materials" } as never);
    const bars = content?.sections?.find((section) => section.title === "Companies on this connection");
    if (bars?.kind !== "bars") throw new Error("expected bars");
    expect(bars.items.map((item) => item.label)).toEqual(["BHP", "RIO"]);
    // The bars draw the estimated exposure, so each figure is the bar's own measure (spec 14.7).
    expect(bars.items.map((item) => item.value)).toEqual(["$4.00B", "$800.0M"]);
  });

  it("reads a register refusal (an industry it has no notice in) as a connection with nothing on record, never an outage", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockRejectedValue({
      code: 3,
      rawMessage: 'industry "Banks" is not one of the register\'s industries',
      message: "x",
    });
    const content = await loadInspector({ kind: "connection", holderKind: "index_manager", sector: "Banks" } as never);
    expect(content?.rows).toEqual([{ label: "Companies on this connection", value: "0" }]);
  });

  it("pages past the first 100 registers until the connection's total is read", async () => {
    const loadInspector = await load();
    const page = (start: number) =>
      Array.from({ length: 100 }, (_, i) => register(`S${start + i}`, 1, 1e9));
    mockListStockRegisters
      .mockResolvedValueOnce({ stocks: page(0), total: 101, universe: 101, industries: [], asOf: "" })
      .mockResolvedValueOnce({ stocks: [register("LAST", 9, 1e12)], total: 101, universe: 101, industries: [], asOf: "" });
    await loadInspector({ kind: "connection", holderKind: "index_manager", sector: "Materials" } as never);
    expect(mockListStockRegisters).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 100 }));
  });

  it("dates the Change view's window from the newest notice, so the feed serves the desk's own days (spec 14.8)", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockResolvedValue({ stocks: [register("BHP", 4, 1e11)], total: 1, universe: 1, industries: [], asOf: "" });
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "2026-10-31" }));
    mockLoadNoticeFeed.mockResolvedValue({
      ok: true,
      activityOk: true,
      error: "",
      rows: [{ released: "2026-10-30", code: "BHP", holder: "Alpha" }],
      total: 12,
    });
    const content = await loadInspector({
      kind: "connection",
      holderKind: "index_manager",
      sector: "Materials",
      // The feed rounds 28 days up to 30, so the request names the dates instead (28 days back from 31 October).
    } as never, { lens: "", view: "changes", window: "28", since: "", until: "" });
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2026-10-04", until: "2026-10-31", kind: "index_manager", industry: "Materials" }),
    );
    const link = "/ownership/notices?kind=index_manager&industry=Materials&since=2026-10-04&until=2026-10-31";
    expect(content?.links?.[0]?.href).toBe(link);
    expect(content?.links?.find((l) => l.label === "All 12 notices in this window →")?.href).toBe(link);
    // The feed serves 12 notices and lists one row: the count is the served total, and no net is printed for a partial page.
    expect(content?.reading).toBe("12 notices in the window.");
  });

  it("reads the Change view's notice count when the rows are all of the window, and names no net change", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockResolvedValue({ stocks: [register("BHP", 4, 1e11)], total: 1, universe: 1, industries: [], asOf: "" });
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "2026-10-31" }));
    mockLoadNoticeFeed.mockResolvedValue({
      ok: true,
      activityOk: true,
      error: "",
      rows: [{ released: "2026-10-30", code: "BHP", holder: "Alpha" }],
      total: 1,
    });
    const content = await loadInspector({
      kind: "connection",
      holderKind: "index_manager",
      sector: "Materials",
    } as never, { lens: "", view: "changes", window: "28", since: "", until: "" });
    expect(content?.reading).toBe("1 notice in the window.");
  });

  it("dates the Positions view's record links the same way, so the window matches the desk (spec 14.8)", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockResolvedValue({ stocks: [register("BHP", 4, 1e11)], total: 1, universe: 1, industries: [], asOf: "" });
    mockGetOwnershipActivity.mockResolvedValue(activityResponse({ asOf: "2026-10-31" }));
    const content = await loadInspector({
      kind: "connection",
      holderKind: "index_manager",
      sector: "Materials",
    } as never, { lens: "", view: "positions", window: "28", since: "", until: "" });
    expect(content?.links?.[0]?.href).toBe(
      "/ownership/notices?kind=index_manager&industry=Materials&since=2026-10-04&until=2026-10-31",
    );
  });

  it("keeps a brushed pair in the Change view: the feed, the notices and the links carry the brush (spec 14.8)", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockResolvedValue({ stocks: [register("BHP", 4, 1e11)], total: 1, universe: 1, industries: [], asOf: "" });
    mockLoadNoticeFeed.mockResolvedValue({
      ok: true,
      activityOk: true,
      error: "",
      rows: [{ released: "2026-09-15", code: "BHP", holder: "Alpha" }],
      total: 3,
    });
    mockGetOwnershipActivity.mockClear();
    const content = await loadInspector({
      kind: "connection",
      holderKind: "index_manager",
      sector: "Materials",
    } as never, { lens: "", view: "changes", window: "28", since: "2026-09-01", until: "2026-09-20" });
    // The brush is the window: no newest-notice read, and the feed serves the brushed dates.
    expect(mockGetOwnershipActivity).not.toHaveBeenCalled();
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2026-09-01", until: "2026-09-20", kind: "index_manager", industry: "Materials" }),
    );
    const link = "/ownership/notices?kind=index_manager&industry=Materials&since=2026-09-01&until=2026-09-20";
    expect(content?.links?.[0]?.href).toBe(link);
    expect(content?.links?.find((l) => l.label === "All 3 notices in this window →")?.href).toBe(link);
  });

  it("throws, so the rail says it could not load, when the registers did not answer", async () => {
    const loadInspector = await load();
    mockListStockRegisters.mockRejectedValue(UNAVAILABLE);
    await expect(
      loadInspector({ kind: "connection", holderKind: "index_manager", sector: "Materials" } as never),
    ).rejects.toThrow();
  });
});

describe("loadInspector zoomed sector (backlog C4)", () => {
  const load = async () => (await import("../ownershipDesk")).loadInspector;
  const NO_LINK_QUERY = { lens: "", view: "", window: "", since: "", until: "", asAt: "" };

  function holder(slug: string, name: string, exposureAud: number) {
    return { slug, name, exposureAud, hasExposure: true, holdings: 1 };
  }

  function sectorFlows() {
    return flowsResponse({
      positions: [
        {
          kind: "index_manager",
          industry: "Materials",
          exposureAud: 3.2e9,
          hasExposure: true,
          holdings: 4,
          largestCode: "BHP",
          largestPct: 9.2,
          topHolders: [holder("vanguard", "Vanguard", 1.1e9), holder("blackrock", "BlackRock", 0.9e9)],
        },
      ],
      changes: [{ kind: "index_manager", industry: "Materials", direction: "up", exposureAud: 4e8, hasExposure: true, notices: 3 }],
    });
  }

  it("reads the flows over the default window with no dates, and draws the sector's largest holders", async () => {
    const loadInspector = await load();
    mockGetOwnershipFlows.mockResolvedValue(sectorFlows());
    const content = await loadInspector({ kind: "sector", sector: "Materials" }, NO_LINK_QUERY);
    expect(mockGetOwnershipFlows).toHaveBeenCalledWith({ from: "", to: "" });
    expect(content?.heading).toBe("Materials");
    const bars = content?.sections?.find((section) => section.title === "Largest holders by disclosed exposure");
    expect(bars?.kind === "bars" ? bars.items.map((bar) => bar.label) : []).toEqual(["Vanguard", "BlackRock"]);
    expect(content?.reading).toContain("Vanguard largest at");
  });

  it("reads the flows over a brushed pair of dates, as the panes read it", async () => {
    const loadInspector = await load();
    await loadInspector(
      { kind: "sector", sector: "Materials" },
      { ...NO_LINK_QUERY, since: "2026-10-01", until: "2026-10-31" },
    );
    expect(mockGetOwnershipFlows).toHaveBeenCalledWith({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("carries the link's lens and fund dates onto the holders' links, as the link names them", async () => {
    const loadInspector = await load();
    mockGetOwnershipFlows.mockResolvedValue(sectorFlows());
    const content = await loadInspector(
      { kind: "sector", sector: "Materials" },
      { ...NO_LINK_QUERY, lens: "flow", from: "2026-10-01", to: "2026-10-31" },
    );
    const bars = content?.sections?.find((section) => section.title === "Largest holders by disclosed exposure");
    const href = bars?.kind === "bars" ? (bars.items[0]?.href ?? "") : "";
    const params = new URLSearchParams(href.slice(1));
    expect(params.get("lens")).toBe("flow");
    expect(params.get("from")).toBe("2026-10-01");
    expect(params.get("to")).toBe("2026-10-31");
    expect(params.get("sel")).toBe("connection:index_manager>Materials");
  });

  it("dates a chip's window from the newest notice, as the desk does", async () => {
    const loadInspector = await load();
    await loadInspector({ kind: "sector", sector: "Materials" }, { ...NO_LINK_QUERY, window: "28" });
    expect(mockGetOwnershipFlows).toHaveBeenCalledWith({ from: "2026-10-04", to: "2026-10-31" });
  });

  it("names the sector's flows with a note when no holder is disclosed in the window", async () => {
    const loadInspector = await load();
    mockGetOwnershipFlows.mockResolvedValue(flowsResponse({ positions: [], changes: [] }));
    const content = await loadInspector({ kind: "sector", sector: "Materials" }, NO_LINK_QUERY);
    expect(content?.note).toBe("No holder disclosed in this sector in the window.");
    expect(content?.reading).toBeUndefined();
  });

  it("throws, so the rail says it could not load, when the flows did not answer", async () => {
    const loadInspector = await load();
    mockGetOwnershipFlows.mockRejectedValue(UNAVAILABLE);
    await expect(loadInspector({ kind: "sector", sector: "Materials" }, NO_LINK_QUERY)).rejects.toThrow();
  });

  it("throws when the flows refuse the window, and never draws an empty sector for it", async () => {
    const loadInspector = await load();
    mockGetOwnershipFlows.mockRejectedValue({ code: 3, rawMessage: "the window is not served" });
    await expect(loadInspector({ kind: "sector", sector: "Materials" }, NO_LINK_QUERY)).rejects.toThrow();
  });

  it("reads no flows for a sector name the codec would not write", async () => {
    const loadInspector = await load();
    expect(await loadInspector({ kind: "sector", sector: "" }, NO_LINK_QUERY)).toBeNull();
    expect(await loadInspector({ kind: "sector", sector: "Mate\nrials" }, NO_LINK_QUERY)).toBeNull();
    expect(mockGetOwnershipFlows).not.toHaveBeenCalled();
  });
});

describe("loadInspector stock notices by week (backlog C6)", () => {
  const load = async () => (await import("../ownershipDesk")).loadInspector;

  function panelWithNotices(dates: string[]) {
    return create(GetStockOwnershipResponseSchema, {
      summary: { stockCode: "BHP", companyName: "BHP Group", industry: "Materials", disclosedPct: 14.1 },
      history: dates.map((announcedOn) => ({ holderName: "Alpha", form: "Form 604", ceased: false, announcedOn })),
    });
  }

  it("reads the stock's notices over the 26 weeks ending on the map's as-of, and draws them as the strip", async () => {
    const loadInspector = await load();
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ asOf: "2026-10-31" }));
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    mockLoadNoticeFeed.mockResolvedValue({
      ok: true,
      total: 1,
      rows: [{ released: "2026-10-20" }],
      nextCursor: "",
      weeks: [],
      query: {},
      activityOk: true,
      error: "",
    });
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE });
    // The Monday 25 weeks before the week of 31 October is 4 May; the feed is asked through the as-of.
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith({
      stockCode: "BHP",
      since: "2026-05-04",
      until: "2026-10-31",
      limit: 100,
      includeActivity: false,
    });
    const strip = content?.sections?.find((section) => section.title === "Notices by week");
    expect(strip?.kind).toBe("weeks");
    if (strip?.kind !== "weeks") throw new Error("the strip is a weeks section");
    expect(strip.weeks).toHaveLength(26);
    expect(strip.weeks.find((week) => week.weekStart === "2026-10-19")?.count).toBe(1);
    expect(strip.weeks.find((week) => week.weekStart === "2026-10-26")?.href).toBe(
      "/ownership/notices?stock=BHP&since=2026-10-26&until=2026-11-01",
    );
  });

  it("ends the strip on the newest notice the panel states when the map gives no as-of", async () => {
    const loadInspector = await load();
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ asOf: "" }));
    mockGetStockOwnership.mockResolvedValue(panelWithNotices(["2026-10-20", "2026-09-01"]));
    mockLoadNoticeFeed.mockResolvedValue({ ok: true, total: 0, rows: [], nextCursor: "", weeks: [], query: {}, activityOk: true, error: "" });
    await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE });
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith(
      expect.objectContaining({ stockCode: "BHP", since: "2026-04-27", until: "2026-10-20" }),
    );
  });

  it("drops the strip when the feed did not answer, so a failed read is never a quiet half year", async () => {
    const loadInspector = await load();
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ asOf: "2026-10-31" }));
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    mockLoadNoticeFeed.mockResolvedValue({ ok: false, total: 0, rows: [], nextCursor: "", weeks: [], query: {}, activityOk: false, error: "" });
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE });
    expect(content).not.toBeNull();
    expect(content?.sections?.some((section) => section.title === "Notices by week")).toBe(false);
  });

  it("drops the strip when the feed's page holds fewer notices than it matches", async () => {
    const loadInspector = await load();
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ asOf: "2026-10-31" }));
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    mockLoadNoticeFeed.mockResolvedValue({
      ok: true,
      total: 240,
      rows: [{ released: "2026-10-20" }],
      nextCursor: "next",
      weeks: [],
      query: {},
      activityOk: true,
      error: "",
    });
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE });
    expect(content?.sections?.some((section) => section.title === "Notices by week")).toBe(false);
  });

  it("drops the strip when the feed read did not return at all", async () => {
    const loadInspector = await load();
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ asOf: "2026-10-31" }));
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    mockLoadNoticeFeed.mockResolvedValue(undefined);
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE });
    expect(content?.sections?.some((section) => section.title === "Notices by week")).toBe(false);
  });

  it("reads the feed's second page with the first page's cursor, and counts the notices of both", async () => {
    const loadInspector = await load();
    mockGetOwnershipMap.mockResolvedValue(mapResponse({ asOf: "2026-10-31" }));
    mockGetStockOwnership.mockResolvedValue(stockPanelFixture());
    mockLoadNoticeFeed
      .mockResolvedValueOnce({
        ok: true,
        total: 3,
        rows: [{ released: "2026-10-20" }, { released: "2026-10-21" }],
        nextCursor: "page-2",
        weeks: [],
        query: {},
        activityOk: true,
        error: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        total: 3,
        rows: [{ released: "2026-10-22" }],
        nextCursor: "",
        weeks: [],
        query: {},
        activityOk: true,
        error: "",
      });
    const content = await loadInspector({ kind: "stock", code: "BHP" } as never, { ...NO_QUERY_FIXTURE });
    // The strip's span is asked once per page: the first with no cursor, the second with the first's.
    const strip26 = mockLoadNoticeFeed.mock.calls.filter(
      ([input]) => (input as { stockCode?: string; since?: string }).stockCode === "BHP" &&
        (input as { since?: string }).since === "2026-05-04",
    );
    expect(strip26).toHaveLength(2);
    expect(strip26[1]?.[0]).toEqual(expect.objectContaining({ stockCode: "BHP", cursor: "page-2", limit: 100 }));
    const strip = content?.sections?.find((section) => section.title === "Notices by week");
    if (strip?.kind !== "weeks") throw new Error("the strip is a weeks section");
    expect(strip.weeks.find((week) => week.weekStart === "2026-10-19")?.count).toBe(3);
  });
});
