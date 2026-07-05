/**
 * Tests for getTopShortsData server action with KV cache
 *
 * Note: Due to React's cache() wrapper memoization, we test basic behavior.
 * Detailed cache integration is tested in kv-cache.test.ts and warm-cache.test.ts
 */

// Mock React's cache function
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T extends (...args: any[]) => any>(fn: T): T => fn,
}));

// Mock KV cache
const mockGetCached = jest.fn();
const mockSetCached = jest.fn();
const mockDeleteCached = jest.fn();

jest.mock("~/@/lib/kv-cache", () => ({
  getCached: (...args: any[]) => mockGetCached(...args),
  setCached: (...args: any[]) => mockSetCached(...args),
  deleteCached: (...args: any[]) => mockDeleteCached(...args),
  CACHE_KEYS: {
    topShorts: (period: string, limit: number, offset: number) =>
      `cache:homepage:top-shorts:${period}:${limit}:${offset}`,
  },
  HOMEPAGE_TTL: 86400,
}));

// Mock Connect transport
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(),
}));

jest.mock("~/gen/shorts/v1alpha1/shorts_pb", () => ({
  ShortedStocksService: {},
}));

// Note: toPlainMessage is no longer needed in v2 - responses are already plain

jest.unmock("~/app/actions/getTopShorts");

import { getTopShortsData } from "~/app/actions/getTopShorts";
import { HOMEPAGE_TTL } from "~/@/lib/kv-cache";

describe("getTopShortsData with KV Cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCached.mockReset();
    mockSetCached.mockReset();
    mockDeleteCached.mockReset();
    mockGetCached.mockResolvedValue(null);
    mockSetCached.mockResolvedValue(true);
    mockDeleteCached.mockResolvedValue(true);
  });

  it("should be callable and return data structure", async () => {
    const testData = {
      timeSeries: [{ productCode: "CBA", name: "Commonwealth Bank" }],
      offset: 0,
    };

    mockGetCached.mockResolvedValue(testData);

    const result = await getTopShortsData("3m", 50, 0);

    // Verify function returns expected structure
    expect(result).toHaveProperty("timeSeries");
    expect(result).toHaveProperty("offset");
    expect(Array.isArray(result.timeSeries)).toBe(true);
  });

  it("should call API when cache miss occurs", async () => {
    const apiResponse = {
      timeSeries: [{ productCode: "ZIP", name: "ZIP Co" }],
      offset: 0,
    };

    const { createClient } = require("@connectrpc/connect");
    const mockClient = {
      getTopShorts: jest.fn().mockResolvedValue(apiResponse),
    };
    createClient.mockReturnValue(mockClient);

    const result = await getTopShortsData("3m", 50, 0);

    // Verify function returns expected structure
    expect(result).toHaveProperty("timeSeries");
    expect(result).toHaveProperty("offset");
    expect(mockClient.getTopShorts).toHaveBeenCalledWith({
      period: "3M",
      limit: 50,
      offset: 0,
    });
    expect(mockSetCached).toHaveBeenCalledWith(
      "cache:homepage:top-shorts:3m:50:0",
      apiResponse,
      HOMEPAGE_TTL,
    );
  });

  it("should handle different input parameters", async () => {
    mockGetCached.mockResolvedValue({
      timeSeries: [{ productCode: "LOT", name: "Lotus" }],
      offset: 0,
    });

    // Test different periods - function should execute without errors
    const result1 = await getTopShortsData("1m", 20, 10);
    const result2 = await getTopShortsData("6m", 100, 0);
    const result3 = await getTopShortsData("1y", 50, 0);

    // Verify functions return expected structure
    expect(result1).toHaveProperty("timeSeries");
    expect(result2).toHaveProperty("timeSeries");
    expect(result3).toHaveProperty("timeSeries");
  });

  it("should format period for API correctly", async () => {
    const { createClient } = require("@connectrpc/connect");
    const mockClient = {
      getTopShorts: jest.fn().mockResolvedValue({
        timeSeries: [{ productCode: "ZIP", name: "ZIP Co" }],
        offset: 0,
      }),
    };
    createClient.mockReturnValue(mockClient);

    const result = await getTopShortsData("3m", 50, 0);

    // Verify function returns expected structure
    expect(result).toHaveProperty("timeSeries");
    expect(result).toHaveProperty("offset");
    expect(mockClient.getTopShorts).toHaveBeenCalledWith({
      period: "3M",
      limit: 50,
      offset: 0,
    });
  });

  it("refreshes stale empty top-shorts cache entries from the API", async () => {
    const staleCachedResponse = { timeSeries: [], offset: 0 };
    const apiResponse = {
      timeSeries: [
        {
          productCode: "LOT",
          name: "Lotus Resources",
          latestShortPosition: 22.82,
        },
      ],
      offset: 0,
    };
    mockGetCached.mockResolvedValue(staleCachedResponse);

    const { createClient } = require("@connectrpc/connect");
    const mockClient = {
      getTopShorts: jest.fn().mockResolvedValue(apiResponse),
    };
    createClient.mockReturnValue(mockClient);

    const result = await getTopShortsData("3m", 100, 0);

    expect(result.timeSeries).toHaveLength(1);
    expect(result.timeSeries[0]?.productCode).toBe("LOT");
    expect(mockDeleteCached).toHaveBeenCalledWith(
      "cache:homepage:top-shorts:3m:100:0",
    );
    expect(mockClient.getTopShorts).toHaveBeenCalled();
  });
});
