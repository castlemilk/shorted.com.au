/// <reference types="jest" />

/**
 * The two hub explorer actions, and the two things about them that have already
 * cost this feature an incident each.
 *
 *   - AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `{}` parses into a perfectly
 *     valid message whose counts are all zero, so a truthy `if (hit)` served
 *     zeros for the full 24h TTL while every rpc behind it was healthy. That is
 *     what /politicians served after the 2026-07-31 deploy.
 *   - THE CACHE KEY IS BUILT FROM THE CLAMPED QUERY. The handler lower-cases the
 *     chamber, upper-cases the state, drops an out-of-range item number and
 *     clamps the limit into [1, 200] — so a key built from the raw input hands
 *     one response two entries, and lets a caller mint unbounded keys by varying
 *     inputs the server ignores.
 */

import { TextDecoder, TextEncoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

const createConnectTransportMock = jest.fn();
const createClientMock = jest.fn();
const clientMock = {
  getRegisterExplorer: jest.fn(),
  listPoliticianSummaries: jest.fn(),
};

const getCachedMock = jest.fn();
const setCachedMock = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) => createConnectTransportMock(...args),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

jest.mock("@/lib/kv-cache", () => {
  const actual = jest.requireActual("@/lib/kv-cache");
  return {
    ...actual,
    getCached: (...args: unknown[]) => getCachedMock(...args),
    setCached: (...args: unknown[]) => setCachedMock(...args),
  };
});

const POPULATED_EXPLORER = {
  itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 12, politicianCount: 4 }],
  politicianCount: 319,
};

describe("politician explorer server actions", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
    };
    delete process.env.SKIP_STATIC_GENERATION;
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    getCachedMock.mockResolvedValue(null);
    setCachedMock.mockResolvedValue(true);
    clientMock.getRegisterExplorer.mockResolvedValue(POPULATED_EXPLORER);
    clientMock.listPoliticianSummaries.mockResolvedValue({ summaries: [{}], total: 1 });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("clamps a query to exactly what the backend will do with it", async () => {
    const { clampPoliticianSummaryQuery } = await import("../getPoliticians");

    expect(
      clampPoliticianSummaryQuery({
        chamber: "House",
        stateCode: "nsw",
        partyAb: "alp",
        itemNo: 99,
        query: "  Smith ",
        limit: 1000,
        offset: -5,
      }),
    ).toEqual({
      chamber: "house",
      stateCode: "NSW",
      partyAb: "ALP",
      itemNo: 0,
      query: "Smith",
      sort: "declared_items",
      limit: 200,
      offset: 0,
    });

    // No limit means the handler's own default, not "everything".
    expect(clampPoliticianSummaryQuery({}).limit).toBe(50);
    expect(clampPoliticianSummaryQuery({ itemNo: 3 }).itemNo).toBe(3);
  });

  it("puts every clamped input in the cache key", async () => {
    const { CACHE_KEYS } = jest.requireActual("@/lib/kv-cache") as typeof import("@/lib/kv-cache");
    const key = CACHE_KEYS.politicianSummaries("senate", "VIC", "ALP", 3, "smith", "companies", 25, 50);

    expect(key).toBe("cache:politicians:summaries:senate:VIC:ALP:3:smith:companies:25:50");
    // Two different queries can never collide on one entry.
    expect(CACHE_KEYS.politicianSummaries("", "", "", 0, "", "declared_items", 25, 0)).not.toBe(key);
  });

  it("sends the clamped query, with the sort mapped to the proto enum", async () => {
    const { clampPoliticianSummaryQuery, listPoliticianSummaries } = await import(
      "../getPoliticians"
    );

    await listPoliticianSummaries(
      clampPoliticianSummaryQuery({ chamber: "Senate", sort: "companies", limit: 25 }),
    );

    expect(clientMock.listPoliticianSummaries).toHaveBeenCalledWith({
      chamber: "senate",
      stateCode: "",
      partyAb: "",
      itemNo: 0,
      query: "",
      // POLITICIAN_SUMMARY_SORT_COMPANIES
      sort: 1,
      limit: 25,
      offset: 0,
    });
  });

  it("treats a zeroed cache entry as a miss and refetches", async () => {
    getCachedMock.mockResolvedValue({ summaries: [], total: 0 });
    const { clampPoliticianSummaryQuery, listPoliticianSummaries } = await import(
      "../getPoliticians"
    );

    const result = await listPoliticianSummaries(clampPoliticianSummaryQuery({ limit: 25 }));

    expect(clientMock.listPoliticianSummaries).toHaveBeenCalledTimes(1);
    expect(result?.summaries).toHaveLength(1);
  });

  it("serves a populated cache entry without calling the rpc", async () => {
    getCachedMock.mockResolvedValue({ summaries: [{ distinctCompanyCount: 3 }], total: 1 });
    const { clampPoliticianSummaryQuery, listPoliticianSummaries } = await import(
      "../getPoliticians"
    );

    await listPoliticianSummaries(clampPoliticianSummaryQuery({ limit: 25 }));

    expect(clientMock.listPoliticianSummaries).not.toHaveBeenCalled();
  });

  it("never caches an explorer response with no category total", async () => {
    clientMock.getRegisterExplorer.mockResolvedValue({
      // The shape a cold materialised view or the kill switch returns: well
      // formed, and empty of every measure the hub renders.
      itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 0, politicianCount: 0 }],
    });
    const { getRegisterExplorer } = await import("../getPoliticians");

    await getRegisterExplorer();

    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("treats an all-zero explorer cache entry as a miss", async () => {
    getCachedMock.mockResolvedValue({
      itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 0 }],
    });
    const { getRegisterExplorer } = await import("../getPoliticians");

    const result = await getRegisterExplorer();

    expect(clientMock.getRegisterExplorer).toHaveBeenCalledTimes(1);
    expect(result?.politicianCount).toBe(319);
  });
});
