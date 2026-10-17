/** @jest-environment node */
import { getSharedStockQuotes, invalidateSharedStockQuotes, QUOTE_FRESH_MS } from "../shared-stock-quotes";
import { acquireCacheLease, getCached, getCachedMany, releaseCacheLease, setCached, setCachedMany } from "../kv-cache";

jest.mock("../kv-cache", () => ({
  acquireCacheLease: jest.fn(), getCached: jest.fn(), getCachedMany: jest.fn(), releaseCacheLease: jest.fn(),
  setCached: jest.fn(), setCachedMany: jest.fn(),
}));

const store = new Map<string, unknown>();
const quote = (close: number) => ({ stockCode: "CBA", date: "2026-10-02T00:00:00Z", close });
const signal = () => new AbortController().signal;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("shared quote cache review regressions", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-03T12:00:00Z"));
    jest.clearAllMocks();
    store.clear();
    jest.mocked(getCached).mockImplementation(async key => (store.get(key) ?? null) as never);
    jest.mocked(getCachedMany).mockImplementation(async keys => keys.map(key => store.get(key) ?? null) as never);
    jest.mocked(setCachedMany).mockImplementation(async entries => {
      entries.forEach(entry => store.set(entry.key, entry.data));
      return true;
    });
    jest.mocked(setCached).mockImplementation(async (key, data) => { store.set(key, data); return true; });
    jest.mocked(acquireCacheLease).mockResolvedValue("acquired");
    jest.mocked(releaseCacheLease).mockResolvedValue(true);
  });
  afterEach(() => jest.useRealTimers());

  it("keeps a refreshed generation cached when an earlier generation completes later", async () => {
    const oldBody = deferred<unknown>();
    const oldRequest = getSharedStockQuotes(["CBA"], signal(), () => oldBody.promise);
    await tick();

    await invalidateSharedStockQuotes();
    const refreshed = await getSharedStockQuotes(["CBA"], signal(), async () => ({ prices: { CBA: quote(121) } }));
    expect(refreshed.prices.CBA?.close).toBe(121);

    oldBody.resolve({ prices: { CBA: quote(120) } });
    await oldRequest;

    const unnecessaryLoad = jest.fn(async () => ({ prices: { CBA: quote(122) } }));
    const next = await getSharedStockQuotes(["CBA"], signal(), unnecessaryLoad);
    expect(next).toEqual({ cache: "HIT", prices: { CBA: quote(121) } });
    expect(unnecessaryLoad).not.toHaveBeenCalled();
  });

  it("rejects an explicitly null prices map without writing missing coverage", async () => {
    await expect(getSharedStockQuotes(["CBA"], signal(), async () => ({ prices: null })))
      .rejects.toThrow("Invalid quote");
    expect(setCachedMany).not.toHaveBeenCalled();

    const load = jest.fn(async () => ({ prices: { CBA: quote(121) } }));
    expect((await getSharedStockQuotes(["CBA"], signal(), load)).prices.CBA?.close).toBe(121);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the initially known stale quote when a retention read misses during an empty refresh", async () => {
    await getSharedStockQuotes(["CBA"], signal(), async () => ({ prices: { CBA: quote(120) } }));
    const [key, original] = Array.from(store.entries()).find(([cacheKey]) => cacheKey.endsWith(":CBA"))!;
    jest.advanceTimersByTime(QUOTE_FRESH_MS);
    jest.mocked(getCachedMany)
      .mockImplementationOnce(async keys => keys.map(cacheKey => store.get(cacheKey) ?? null) as never)
      .mockResolvedValueOnce([null]);

    const result = await getSharedStockQuotes(["CBA"], signal(), async () => ({ prices: {} }));

    expect(result).toEqual({ cache: "STALE", prices: { CBA: quote(120) } });
    expect(store.get(key)).toEqual(original);
  });
});
