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
const MAP_KEY = "cache:ownership:desk-map:v1";
const FLOWS_KEY = "cache:ownership:desk-flows:v1";
const ACTIVITY_KEY = "cache:ownership:desk-activity:v1";
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
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "", to: "" });
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
        notices: 4,
      },
    ]);
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
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "2026-10-04", to: "2026-10-31" });
    expect(mockGetCached).not.toHaveBeenCalledWith(MAP_KEY);
  });

  it("falls back to the default window for a window the desk does not serve", async () => {
    await loadOwnershipMap({ window: 7 });
    expect(mockGetOwnershipActivity).not.toHaveBeenCalled();
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "", to: "" });
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
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "2025-10-19", to: "2026-10-20" });
    expect((await loadOwnershipMap({ since: "2025-10-14", until: "2026-10-16" })).error).toMatch(/366 days/);
    expect(mockGetOwnershipMap).toHaveBeenCalledTimes(1);
  });

  it("serves a brushed pair of dates as a live read", async () => {
    await loadOwnershipMap({ since: "2026-01-01", until: "2026-01-31" });
    expect(mockGetOwnershipMap).toHaveBeenCalledWith({ from: "2026-01-01", to: "2026-01-31" });
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
      { asAt: "2026-09-30", weightPct: 3.1, valueAud: 1e8 },
      { asAt: "2026-10-31", weightPct: null, valueAud: null },
    ]);
    expect(mockSetCached).not.toHaveBeenCalled();
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
      limit: 50,
    });
    expect(content?.heading).toBe("Materials");
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
