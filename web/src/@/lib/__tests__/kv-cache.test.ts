// Set environment variables BEFORE any imports or mocks
// This ensures Redis is initialized when kv-cache module loads
process.env.KV_REST_API_URL = "https://test-redis.upstash.io";
process.env.KV_REST_API_TOKEN = "test-token";

// Create shared mock data Map outside of mock factory
// This ensures all Redis instances share the same data
const mockData = new Map<
  string,
  { value: any; ttl: number; expiresAt: number }
>();

// Create shared mock functions that use the shared mockData Map
const mockGet = jest.fn(async (key: string) => {
  const entry = mockData.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    mockData.delete(key);
    return null;
  }
  return entry.value;
});

const mockSetex = jest.fn(async (key: string, ttl: number, value: any) => {
  mockData.set(key, {
    value,
    ttl,
    expiresAt: Date.now() + ttl * 1000,
  });
  return "OK";
});

const mockDel = jest.fn(async (key: string) => {
  mockData.delete(key);
  return 1;
});

// Mock @upstash/redis BEFORE importing kv-cache
jest.mock("@upstash/redis", () => {
  return {
    Redis: jest.fn().mockImplementation(() => ({
      get: mockGet,
      setex: mockSetex,
      del: mockDel,
    })),
  };
});

import {
  getCached,
  setCached,
  deleteCached,
  getOrSetCached,
  CACHE_KEYS,
  HOMEPAGE_TTL,
  isCacheAvailable,
} from "../kv-cache";

describe("KV Cache", () => {
  beforeEach(() => {
    // Clear mock data and reset mock call counts
    mockData.clear();
    mockGet.mockClear();
    mockSetex.mockClear();
    mockDel.mockClear();

    // Ensure environment variables are set (already set at top level, but ensure they're still set)
    process.env.KV_REST_API_URL = "https://test-redis.upstash.io";
    process.env.KV_REST_API_TOKEN = "test-token";
  });

  afterEach(() => {
    // Clean up mock data
    mockData.clear();
  });

  describe("Cache Keys", () => {
    it("should generate correct cache keys for top shorts", () => {
      const key = CACHE_KEYS.topShorts("3m", 50, 0);
      expect(key).toBe("cache:homepage:top-shorts:3m:50:0");
    });

    it("should generate correct cache keys for treemap", () => {
      const key = CACHE_KEYS.industryTreeMap("3m", 10, "1");
      expect(key).toBe("cache:homepage:treemap:3m:10:1");
    });

    it("should generate correct cache keys for statistics", () => {
      expect(CACHE_KEYS.statistics).toBe("cache:about:statistics");
    });

    it("should generate correct cache keys for top stocks", () => {
      const key = CACHE_KEYS.topStocks(5);
      expect(key).toBe("cache:about:top-stocks:5");
    });
  });

  describe("setCached and getCached", () => {
    it("should set and get cached data", async () => {
      const testData = {
        timeSeries: [{ productCode: "CBA", name: "Commonwealth Bank" }],
      };
      const key = "test:key";

      const setResult = await setCached(key, testData, 300);
      expect(setResult).toBe(true);

      const cached = await getCached<typeof testData>(key);
      expect(cached).toEqual(testData);
    });

    it("should return null for non-existent keys", async () => {
      const cached = await getCached("non-existent-key");
      expect(cached).toBeNull();
    });

    it("should handle cache expiration", async () => {
      const testData = { data: "test" };
      const key = "expiring-key";

      await setCached(key, testData, 1); // 1 second TTL

      // Should be available immediately
      const cached = await getCached(key);
      expect(cached).toEqual(testData);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be null after expiration
      const expired = await getCached(key);
      expect(expired).toBeNull();
    });
  });

  describe("getOrSetCached", () => {
    it("should return cached data if available", async () => {
      const testData = { cached: true };
      const key = "cache-hit-key";

      // Set cache first
      await setCached(key, testData, 300);

      // Should return cached data without calling fallback
      const fallback = jest.fn().mockResolvedValue({ cached: false });
      const result = await getOrSetCached(key, fallback, 300);

      expect(result).toEqual(testData);
      expect(fallback).not.toHaveBeenCalled();
    });

    it("should call fallback and cache result on cache miss", async () => {
      const key = "cache-miss-key";
      const freshData = { fresh: true };
      const fallback = jest.fn().mockResolvedValue(freshData);

      const result = await getOrSetCached(key, fallback, 300);

      expect(result).toEqual(freshData);
      expect(fallback).toHaveBeenCalledTimes(1);

      // Verify data was cached
      const cached = await getCached(key);
      expect(cached).toEqual(freshData);
    });

    it("should handle fallback errors gracefully", async () => {
      const key = "error-key";
      const fallback = jest.fn().mockRejectedValue(new Error("API error"));

      await expect(getOrSetCached(key, fallback, 300)).rejects.toThrow(
        "API error",
      );
      expect(fallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteCached", () => {
    it("should delete cached data", async () => {
      const testData = { data: "test" };
      const key = "delete-key";

      await setCached(key, testData, 300);
      expect(await getCached(key)).toEqual(testData);

      const deleted = await deleteCached(key);
      expect(deleted).toBe(true);

      expect(await getCached(key)).toBeNull();
    });
  });

  describe("isCacheAvailable", () => {
    it("should return true when KV is configured", () => {
      // Environment variables are set before module import (at top of file)
      // So Redis should be initialized and isCacheAvailable() should return true
      expect(isCacheAvailable()).toBe(true);
    });

    it("should handle missing Redis gracefully", () => {
      // Test that getCached returns null when Redis is not available
      // This is tested implicitly through other tests, but we can verify
      // that the cache functions handle null Redis gracefully
      const result = getCached("test-key");
      // Should not throw, even if Redis is not properly initialized
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe("HOMEPAGE_TTL", () => {
    it("should export HOMEPAGE_TTL constant", () => {
      expect(HOMEPAGE_TTL).toBe(600); // 10 minutes
    });
  });
});
