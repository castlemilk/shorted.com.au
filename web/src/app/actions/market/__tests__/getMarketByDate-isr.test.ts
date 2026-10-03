const mockEntries = new Map<string, { value: unknown; tags: string[] }>();
const mockCacheOptions: Array<{ key: string[]; tags: string[]; revalidate: number }> = [];
jest.mock("next/cache", () => ({
  unstable_cache: (
    loader: () => Promise<unknown>,
    key: string[],
    options: { tags: string[]; revalidate: number },
  ) => async () => {
    const cacheKey = JSON.stringify(key);
    mockCacheOptions.push({ key, ...options });
    if (mockEntries.has(cacheKey)) return mockEntries.get(cacheKey)!.value;
    const value: unknown = JSON.parse(JSON.stringify(await loader()));
    mockEntries.set(cacheKey, { value, tags: options.tags });
    return value;
  },
  revalidateTag: (tag: string) => {
    for (const [key, entry] of mockEntries) {
      if (entry.tags.includes(tag)) mockEntries.delete(key);
    }
  },
}));
jest.mock("react", () => ({ ...jest.requireActual("react"), cache: (fn: unknown) => fn }));
jest.mock("../../withRetry", () => ({ withRetry: (fn: unknown) => fn, withRetryAndNotFound: (fn: unknown) => fn }));
jest.mock("../../config", () => ({
  SHORTS_API_URL: "http://api.test",
  serverFetchOutsideNextCache: jest.fn(),
  serverFetchWithUserAgent: jest.fn(),
}));
const mockEdge = jest.fn();
jest.mock("../../edgeRead", () => ({ fetchEdgeReadJson: (...args: unknown[]) => mockEdge(...args) }));
jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn() }));
const mockMarket = jest.fn();
jest.mock("@connectrpc/connect", () => ({ createClient: () => ({ getMarketByDate: (...args: unknown[]) => mockMarket(...args) }) }));
jest.mock("~/gen/shorts/v1alpha1/market_pb", () => ({ MarketService: {} }));

import { revalidateTag } from "next/cache";
import { createConnectTransport } from "@connectrpc/connect-web";
import { serverFetchOutsideNextCache } from "../../config";
import { getMarketByDateStrict, isValidMarketDate } from "../getMarketByDate";

describe("market snapshot ISR cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntries.clear();
    mockCacheOptions.length = 0;
    mockEdge.mockResolvedValue(undefined);
  });

  it("caches serializable RPC data and keeps uncached Connect POSTs outside Next's render fetch", async () => {
    mockMarket.mockResolvedValue({ stocks: [{ productCode: "BHP", reportedShortPositions: BigInt(1234) }], totalCount: 1 });
    await expect(getMarketByDateStrict("2026-05-15")).resolves.toHaveProperty("stocks.0.reportedShortPositions", 1234);
    await getMarketByDateStrict("2026-05-15");
    expect(mockMarket).toHaveBeenCalledTimes(1);
    expect(mockEdge).toHaveBeenCalledWith(
      "/edge/v1/market-by-date",
      { date: "2026-05-15", limit: 50, offset: 0 },
      ["market-date:2026-05-15"],
    );
    expect(createConnectTransport).toHaveBeenCalledWith({ baseUrl: "http://api.test", fetch: serverFetchOutsideNextCache });
    expect(mockCacheOptions[0]).toMatchObject({ revalidate: 86400, tags: ["shorts-data", "market-date:2026-05-15"] });
  });

  it("accepts a successful empty proto JSON response without confusing it with an outage", async () => {
    mockEdge.mockResolvedValue({});
    await expect(getMarketByDateStrict("2026-05-16")).resolves.toEqual({});
    expect(mockMarket).not.toHaveBeenCalled();
  });

  it("never caches a transient RPC failure and succeeds on the next generation", async () => {
    mockMarket.mockRejectedValue(new Error("backend unavailable"));
    await expect(getMarketByDateStrict("2026-05-15")).rejects.toThrow("backend unavailable");
    expect(mockEntries.size).toBe(0);
    mockMarket.mockResolvedValue({ stocks: [{ productCode: "BHP" }], totalCount: 1 });
    await expect(getMarketByDateStrict("2026-05-15")).resolves.toHaveProperty("totalCount", 1);
  });

  it("clears a cached missing date when ingestion publishes its snapshot", async () => {
    mockMarket.mockRejectedValue({ code: 5, message: "no snapshot" });
    await expect(getMarketByDateStrict("2026-05-15")).resolves.toBeNull();
    mockMarket.mockResolvedValue({ stocks: [{ productCode: "BHP" }], totalCount: 1 });
    revalidateTag("shorts-data");
    await expect(getMarketByDateStrict("2026-05-15")).resolves.toHaveProperty("totalCount", 1);
  });

  it("allows a targeted historical correction without invalidating other dates", async () => {
    mockMarket.mockResolvedValue({ stocks: [{ productCode: "BHP" }], totalCount: 1 });
    await getMarketByDateStrict("2026-05-15");
    await getMarketByDateStrict("2026-05-14");
    mockMarket.mockResolvedValue({ stocks: [{ productCode: "BHP" }, { productCode: "CBA" }], totalCount: 2 });
    revalidateTag("market-date:2026-05-15");
    await expect(getMarketByDateStrict("2026-05-15")).resolves.toHaveProperty("totalCount", 2);
    await expect(getMarketByDateStrict("2026-05-14")).resolves.toHaveProperty("totalCount", 1);
  });

  it.each([["2024-02-29", true], ["2026-02-29", false], ["2026-02-30", false], ["2026-13-01", false]])("validates actual calendar dates: %s", (date, valid) => {
    expect(isValidMarketDate(date as string)).toBe(valid);
  });
});
