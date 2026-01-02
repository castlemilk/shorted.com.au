// Mock @upstash/redis to avoid ESM parsing issues with 'uncrypto' dependency
jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  })),
}));

import {
  setCached,
  getCached,
  isCacheAvailable,
} from "../kv-cache";

describe("In-Memory Cache Fallback", () => {
  // Save original env vars
  const originalEnv = process.env;

  beforeAll(() => {
    jest.resetModules(); // Reset modules to re-evaluate top-level code
    process.env = { ...originalEnv }; // Clone env
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    // Ensure we are in dev mode for fallback to activate
    process.env.NODE_ENV = "development";
  });

  afterAll(() => {
    process.env = originalEnv; // Restore env
  });

  it("should report cache as available in dev mode even without Redis", () => {
    // We need to re-import to trigger the top-level logic
    jest.isolateModules(() => {
      const { isCacheAvailable } = require("../kv-cache");
      expect(isCacheAvailable()).toBe(true);
    });
  });

  it("should store and retrieve data in memory", async () => {
    jest.isolateModules(async () => {
      const { setCached, getCached } = require("../kv-cache");
      
      const key = "test-memory-key";
      const value = { foo: "bar" };
      
      await setCached(key, value, 60);
      const cached = await getCached(key);
      
      expect(cached).toEqual(value);
    });
  });

  it("should expire data", async () => {
    jest.isolateModules(async () => {
      const { setCached, getCached } = require("../kv-cache");
      
      const key = "test-memory-expiry";
      const value = { foo: "bar" };
      
      // Set minimal TTL
      await setCached(key, value, 0.01); 
      
      // Wait for expiration
      await new Promise(r => setTimeout(r, 20));
      
      const cached = await getCached(key);
      expect(cached).toBeNull();
    });
  });
});
