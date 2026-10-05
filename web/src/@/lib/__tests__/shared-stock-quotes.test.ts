/** @jest-environment node */
import { getSharedStockQuotes, invalidateSharedStockQuotes, normalizeQuoteCodes, QUOTE_FRESH_MS } from "../shared-stock-quotes";
import { acquireCacheLease, getCached, getCachedMany, releaseCacheLease, setCached, setCachedMany } from "../kv-cache";

jest.mock("../kv-cache", () => ({
  acquireCacheLease: jest.fn(), getCached: jest.fn(), getCachedMany: jest.fn(), releaseCacheLease: jest.fn(),
  setCached: jest.fn(), setCachedMany: jest.fn(),
}));
const store = new Map<string, unknown>();
const quote = (stockCode: string, close = 120) => ({ stockCode, date: "2026-10-02T00:00:00Z", close });
const signal = () => new AbortController().signal;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe("public shared stock quote cache", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-03T12:00:00Z"));
    jest.clearAllMocks(); store.clear();
    jest.mocked(getCached).mockImplementation(async key => (store.get(key) ?? null) as never);
    jest.mocked(getCachedMany).mockImplementation(async keys => keys.map(key => store.get(key) ?? null) as never);
    jest.mocked(setCachedMany).mockImplementation(async entries => { entries.forEach(e => store.set(e.key, e.data)); return true; });
    jest.mocked(setCached).mockImplementation(async (key, data) => { store.set(key, data); return true; });
    jest.mocked(acquireCacheLease).mockResolvedValue("acquired");
    jest.mocked(releaseCacheLease).mockResolvedValue(true);
  });
  afterEach(() => jest.useRealTimers());

  it("normalizes and deduplicates symbols, rejecting invalid or oversized requests", () => {
    expect(normalizeQuoteCodes({ stockCodes: [" wbc ", "cba", "CBA"] })).toEqual(["CBA", "WBC"]);
    for (const stockCodes of [[], ["../../"], [123], Array(51).fill("CBA")]) {
      expect(() => normalizeQuoteCodes({ stockCodes })).toThrow(TypeError);
    }
  });

  it("shares per-symbol coverage across different portfolios and caches legitimate missing symbols", async () => {
    const load = jest.fn(async () => ({ prices: { CBA: quote("CBA"), WBC: quote("WBC") } }));
    expect((await getSharedStockQuotes(["CBA", "NCM", "WBC"], signal(), load)).cache).toBe("MISS");
    const next = await getSharedStockQuotes(["CBA", "NCM"], signal(), load);
    expect(next).toEqual({ cache: "HIT", prices: { CBA: quote("CBA") } });
    expect(load).toHaveBeenCalledTimes(1);
    expect(getCachedMany).toHaveBeenLastCalledWith([
      "cache:quotes:v1:initial:CBA", "cache:quotes:v1:initial:NCM",
    ]);
    jest.advanceTimersByTime(5 * 60_000);
    const missing = jest.fn(async () => ({ prices: {} }));
    await getSharedStockQuotes(["CBA", "NCM"], signal(), missing);
    expect(missing).toHaveBeenCalledWith(["NCM"], expect.any(AbortSignal));
  });

  it("coalesces overlapping cold portfolios without fetching their common symbol twice", async () => {
    const first = deferred<unknown>();
    const load = jest.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ prices: { WBC: quote("WBC") } });
    const one = getSharedStockQuotes(["CBA"], signal(), load);
    await tick();
    const two = getSharedStockQuotes(["CBA", "WBC"], signal(), load);
    await tick();
    expect(load.mock.calls.map(call => call[0])).toEqual([["CBA"], ["WBC"]]);
    first.resolve({ prices: { CBA: quote("CBA") } });
    expect((await one).prices).toEqual({ CBA: quote("CBA") });
    expect((await two).prices).toEqual({ CBA: quote("CBA"), WBC: quote("WBC") });
  });

  it("does not cancel another consumer when the first consumer leaves", async () => {
    const pending = deferred<unknown>();
    const load = jest.fn(() => pending.promise);
    const controller = new AbortController();
    const one = getSharedStockQuotes(["CBA"], controller.signal, load);
    const rejected = expect(one).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    const two = getSharedStockQuotes(["CBA"], signal(), load);
    await tick(); controller.abort();
    await rejected;
    expect(load.mock.calls[0]?.[1].aborted).toBe(false);
    pending.resolve({ prices: { CBA: quote("CBA") } });
    expect((await two).prices.CBA).toEqual(quote("CBA"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cancels the origin fetch after the last consumer leaves and writes no negative cache", async () => {
    const load = jest.fn((_codes: string[], upstream: AbortSignal) => new Promise((_resolve, reject) => {
      upstream.addEventListener("abort", () => reject(upstream.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = getSharedStockQuotes(["CBA"], controller.signal, load);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await tick(); controller.abort(); await rejected; await tick();
    expect(load.mock.calls[0]?.[1].aborted).toBe(true);
    expect(setCachedMany).not.toHaveBeenCalled();
    expect(releaseCacheLease).toHaveBeenCalledTimes(1);
  });

  it("retains a last good quote on failed or malformed refresh without renewing its age", async () => {
    await getSharedStockQuotes(["CBA"], signal(), async () => ({ prices: { CBA: quote("CBA") } }));
    const original = store.get("cache:quotes:v1:initial:CBA");
    jest.advanceTimersByTime(QUOTE_FRESH_MS);
    for (const load of [async () => { throw new Error("down"); }, async () => ({ prices: { CBA: quote("CBA", NaN) } }), async () => ({ prices: {} })]) {
      expect((await getSharedStockQuotes(["CBA"], signal(), load)).cache).toBe("STALE");
      expect(store.get("cache:quotes:v1:initial:CBA")).toEqual(original);
    }
    jest.advanceTimersByTime(24 * 60 * 60_000);
    await expect(getSharedStockQuotes(["CBA"], signal(), async () => { throw new Error("down"); })).rejects.toThrow("down");
  });

  it("rejects invalid successful data instead of caching missing coverage", async () => {
    for (const prices of [null, { CBA: { stockCode: "WBC", date: quote("CBA").date, close: 1 } }, { CBA: { stockCode: "CBA", close: 1 } }, [], { CBA: quote("CBA", 0) }]) {
      await expect(getSharedStockQuotes(["CBA"], signal(), async () => ({ prices }))).rejects.toThrow("Invalid quote");
    }
    expect(setCachedMany).not.toHaveBeenCalled();
  });

  it("waits for another instance's lease and reads its result with bounded batched polling", async () => {
    jest.mocked(acquireCacheLease).mockResolvedValue("busy");
    const load = jest.fn();
    const pending = getSharedStockQuotes(["CBA"], signal(), load);
    await tick();
    store.set("cache:quotes:v1:initial:CBA", { generation: "initial", fetchedAt: Date.now(), quote: quote("CBA") });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await pending).prices.CBA).toEqual(quote("CBA"));
    expect(load).not.toHaveBeenCalled();
    expect(getCachedMany).toHaveBeenCalledTimes(2);
    expect(releaseCacheLease).not.toHaveBeenCalled();
  });

  it("invalidates in one write and ignores a late write from the previous generation", async () => {
    const pending = deferred<unknown>();
    const one = getSharedStockQuotes(["CBA"], signal(), () => pending.promise);
    await tick(); await invalidateSharedStockQuotes();
    pending.resolve({ prices: { CBA: quote("CBA") } }); await one;
    const load = jest.fn(async () => ({ prices: { CBA: quote("CBA", 121) } }));
    expect((await getSharedStockQuotes(["CBA"], signal(), load)).prices.CBA?.close).toBe(121);
    expect(setCached).toHaveBeenCalledTimes(1);
  });
});
