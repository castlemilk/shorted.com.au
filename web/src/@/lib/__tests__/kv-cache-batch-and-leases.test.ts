/** @jest-environment node */

const mockIoPipeline = { setex: jest.fn(), exec: jest.fn() };
const mockRestPipeline = { setex: jest.fn(), exec: jest.fn() };
const mockIo = {
  on: jest.fn(), get: jest.fn(), mget: jest.fn(), set: jest.fn(), eval: jest.fn(),
  pipeline: jest.fn(() => mockIoPipeline),
};
const mockRest = {
  get: jest.fn(), mget: jest.fn(), set: jest.fn(), eval: jest.fn(),
  pipeline: jest.fn(() => mockRestPipeline),
};

jest.mock("ioredis", () => ({
  __esModule: true, default: jest.fn(() => mockIo),
}));
jest.mock("@upstash/redis", () => ({ Redis: jest.fn(() => mockRest) }));

type CacheModule = typeof import("../kv-cache");
type CacheMode = "redis" | "upstash" | "local" | "unavailable";
const originalEnv = process.env;

function load(mode: CacheMode): CacheModule {
  process.env = { ...originalEnv, NODE_ENV: mode === "unavailable" ? "production" : "test" };
  delete process.env.REDIS_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  if (mode === "redis") process.env.REDIS_URL = "redis://cache.example.test:6379";
  if (mode === "upstash") {
    process.env.KV_REST_API_URL = "https://cache.example.test";
    process.env.KV_REST_API_TOKEN = "test-token";
  }
  return require("../kv-cache") as CacheModule;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockIoPipeline.exec.mockResolvedValue([[null, "OK"], [null, "OK"]]);
  mockRestPipeline.exec.mockResolvedValue(["OK", "OK"]);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe.each(["redis", "upstash"] as const)("%s batched cache", (mode) => {
  function store() { return mode === "redis" ? mockIo : mockRest; }
  function pipeline() { return mode === "redis" ? mockIoPipeline : mockRestPipeline; }

  it("uses one MGET, preserves duplicate/order/null positions, and isolates malformed compressed records", async () => {
    const cache = load(mode);
    const first = { symbol: "BHP", price: 40 };
    const large = { prices: Array.from({ length: 1000 }, () => first) };
    const compressed = cache.serializeCacheValue(large);
    expect(compressed.startsWith("gz64:")).toBe(true);
    store().mget.mockResolvedValue(mode === "redis"
      ? [JSON.stringify(first), null, "{malformed", compressed, "false", JSON.stringify(first), "gz64:broken"]
      : [first, null, "gz64:broken", compressed, false, first, "gz64:broken"]);

    const keys = ["BHP", "missing", "bad", "large", "boolean", "BHP", "bad-gzip"];
    expect(await cache.getCachedMany(keys)).toEqual([first, null, null, large, false, first, null]);
    expect(store().mget).toHaveBeenCalledTimes(1);
    expect(store().mget).toHaveBeenCalledWith(...keys);
    expect(store().get).not.toHaveBeenCalled();
  });

  it("returns independent null misses for every key when MGET fails, without issuing per-key GETs", async () => {
    const cache = load(mode);
    store().mget.mockRejectedValue(new Error("cache unavailable"));
    expect(await cache.getCachedMany(["BHP", "CBA", "BHP"])).toEqual([null, null, null]);
    expect(store().mget).toHaveBeenCalledTimes(1);
    expect(store().get).not.toHaveBeenCalled();
  });

  it("pipelines all SETEX commands once, with the requested TTL and BigInt-safe values", async () => {
    const cache = load(mode);
    const entries = [{ key: "BHP", data: { volume: 42n } }, { key: "CBA", data: { volume: 3n } }];
    expect(await cache.setCachedMany(entries, 300)).toBe(true);
    expect(store().pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline().setex.mock.calls).toEqual([
      ["BHP", 300, '{"volume":"42"}'], ["CBA", 300, '{"volume":"3"}'],
    ]);
    expect(pipeline().exec).toHaveBeenCalledTimes(1);
    expect(store().get).not.toHaveBeenCalled();
    expect(store().mget).not.toHaveBeenCalled();
  });

  it("reports partial, incomplete, and rejected pipeline writes as false", async () => {
    const cache = load(mode);
    const entries = [{ key: "BHP", data: 1 }, { key: "CBA", data: 2 }];
    pipeline().exec.mockResolvedValueOnce(mode === "redis"
      ? [[null, "OK"], [new Error("write rejected"), null]] : ["OK", "ERR"]);
    expect(await cache.setCachedMany(entries, 300)).toBe(false);
    pipeline().exec.mockResolvedValueOnce([]);
    expect(await cache.setCachedMany(entries, 300)).toBe(false);
    pipeline().exec.mockRejectedValueOnce(new Error("pipeline unavailable"));
    expect(await cache.setCachedMany(entries, 300)).toBe(false);
    if (mode === "redis") {
      pipeline().exec.mockResolvedValueOnce(null);
      expect(await cache.setCachedMany(entries, 300)).toBe(false);
    }
  });

  it("avoids any commands for empty input, invalid TTL, or unserializable records", async () => {
    const cache = load(mode);
    expect(await cache.getCachedMany([])).toEqual([]);
    expect(await cache.setCachedMany([], 300)).toBe(true);
    expect(await cache.setCachedMany([{ key: "bad", data: 1 }], 0)).toBe(false);
    expect(await cache.setCachedMany([{ key: "bad", data: 1 }], 1.5)).toBe(false);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(await cache.setCachedMany([{ key: "good", data: 1 }, { key: "bad", data: circular }], 300)).toBe(false);
    expect(await cache.setCachedMany([{ key: "bad", data: undefined }], 300)).toBe(false);
    expect(store().mget).not.toHaveBeenCalled();
    expect(store().pipeline).not.toHaveBeenCalled();
  });

  it("acquires atomically in one SET NX EX and distinguishes busy from unavailable", async () => {
    const cache = load(mode);
    store().set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
    expect(await cache.acquireCacheLease("lease:BHP,CBA", "owner-a", 60)).toBe("acquired");
    expect(await cache.acquireCacheLease("lease:BHP,CBA", "owner-b", 60)).toBe("busy");
    expect(await cache.acquireCacheLease("lease:BHP,CBA", "owner-c", 60)).toBe("unavailable");
    expect(store().set).toHaveBeenCalledWith(...(mode === "redis"
      ? ["lease:BHP,CBA", "owner-a", "EX", 60, "NX"]
      : ["lease:BHP,CBA", "owner-a", { nx: true, ex: 60 }]));
    expect(store().get).not.toHaveBeenCalled();
    expect(store().mget).not.toHaveBeenCalled();
    expect(await cache.acquireCacheLease("lease", "", 60)).toBe("unavailable");
    expect(await cache.acquireCacheLease("lease", "owner", 0)).toBe("unavailable");
    expect(store().set).toHaveBeenCalledTimes(3);
  });

  it("releases using one owner-checked EVAL, and reports missing/foreign leases or errors as false", async () => {
    const cache = load(mode);
    store().eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("offline"));
    expect(await cache.releaseCacheLease("lease:BHP", "owner-a")).toBe(true);
    expect(await cache.releaseCacheLease("lease:BHP", "owner-b")).toBe(false);
    expect(await cache.releaseCacheLease("lease:BHP", "owner-c")).toBe(false);
    const [script, ...arguments_] = store().eval.mock.calls[0]!;
    expect(script).toMatch(/redis\.call\("get", KEYS\[1\]\) == ARGV\[1\]/);
    expect(script).toMatch(/return redis\.call\("del", KEYS\[1\]\)/);
    expect(arguments_).toEqual(mode === "redis" ? [1, "lease:BHP", "owner-a"] : [["lease:BHP"], ["owner-a"]]);
    expect(store().get).not.toHaveBeenCalled();
    expect(await cache.releaseCacheLease("lease:BHP", "")).toBe(false);
    expect(store().eval).toHaveBeenCalledTimes(3);
  });
});

describe("local and absent cache stores", () => {
  it("preserves batch order/nulls and expires local values at the TTL boundary", async () => {
    jest.useFakeTimers();
    const cache = load("local");
    await cache.setCached("legacy-undefined", undefined, 60);
    expect(await cache.getCachedMany(["legacy-undefined"])).toEqual([null]);
    expect(await cache.setCachedMany([{ key: "BHP", data: { price: 40 } }, { key: "CBA", data: { price: 90 } }], 1)).toBe(true);
    expect(await cache.getCachedMany(["CBA", "missing", "BHP", "CBA"])).toEqual([{ price: 90 }, null, { price: 40 }, { price: 90 }]);
    jest.advanceTimersByTime(1000);
    expect(await cache.getCachedMany(["CBA", "BHP"])).toEqual([null, null]);
  });

  it("keeps local leases owner-exclusive and prevents expired owners deleting replacements", async () => {
    jest.useFakeTimers();
    const cache = load("local");
    expect(await cache.acquireCacheLease("lease", "owner-a", 60)).toBe("acquired");
    expect(await cache.acquireCacheLease("lease", "owner-b", 60)).toBe("busy");
    expect(await cache.releaseCacheLease("lease", "owner-b")).toBe(false);
    expect(await cache.acquireCacheLease("lease", "owner-b", 60)).toBe("busy");
    expect(await cache.releaseCacheLease("lease", "owner-a")).toBe(true);
    expect(await cache.acquireCacheLease("lease", "owner-b", 60)).toBe("acquired");
    jest.advanceTimersByTime(60_000);
    expect(await cache.acquireCacheLease("lease", "owner-c", 60)).toBe("acquired");
    expect(await cache.releaseCacheLease("lease", "owner-b")).toBe(false);
    expect(await cache.acquireCacheLease("lease", "owner-d", 60)).toBe("busy");
    expect(await cache.releaseCacheLease("lease", "owner-c")).toBe(true);
    expect(await cache.releaseCacheLease("lease", "owner-c")).toBe(false);
  });

  it("does not acquire NX over a live local cache entry, including a null value", async () => {
    const cache = load("local");
    await cache.setCached("existing", null, 60);
    expect(await cache.acquireCacheLease("existing", "owner", 60)).toBe("busy");
    expect(await cache.releaseCacheLease("existing", "owner")).toBe(false);
  });

  it("returns cache misses, failed writes, and unavailable leases without a production store", async () => {
    const cache = load("unavailable");
    expect(await cache.getCachedMany(["BHP", "CBA"])).toEqual([null, null]);
    expect(await cache.setCachedMany([{ key: "BHP", data: 1 }], 60)).toBe(false);
    expect(await cache.acquireCacheLease("lease", "owner", 60)).toBe("unavailable");
    expect(await cache.releaseCacheLease("lease", "owner")).toBe(false);
    expect(mockIo.pipeline).not.toHaveBeenCalled();
    expect(mockRest.pipeline).not.toHaveBeenCalled();
  });
});
