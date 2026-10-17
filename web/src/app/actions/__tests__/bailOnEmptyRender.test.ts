/**
 * bailOnEmptyRender caps an empty fallback render's ISR lifetime; it must never
 * opt the render out of the cache. On a route prerendered as static, Next 14
 * turns unstable_noStore() at runtime into a DynamicServerError ("Page changed
 * from static to dynamic", digest DYNAMIC_SERVER_USAGE), so every blocking
 * render answered 500 instead of the fallback: /price-drops with an empty
 * rollup, and the council pages with the API down.
 */
const cachedCall = jest.fn(async () => true);
const unstableCache = jest.fn((_cb: unknown, _keys: unknown, _opts: unknown) => cachedCall);
const unstableNoStore = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (cb: unknown, keys: unknown, opts: unknown) => unstableCache(cb, keys, opts),
  unstable_noStore: () => unstableNoStore(),
}));

import { bailOnEmptyRender, EMPTY_RENDER_REVALIDATE_SECONDS } from "../config";

const ENV = { ...process.env };

describe("bailOnEmptyRender", () => {
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.NEXT_PHASE;
    unstableCache.mockClear();
    cachedCall.mockClear();
    unstableNoStore.mockClear();
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("lowers the render's revalidate through a short-lived cache entry", async () => {
    await bailOnEmptyRender();

    expect(unstableCache).toHaveBeenCalledTimes(1);
    expect(unstableCache.mock.calls[0]![2]).toEqual({ revalidate: EMPTY_RENDER_REVALIDATE_SECONDS });
    // The entry has to be READ inside the render: that read is what lowers the
    // route's revalidate, not the wrapper's construction.
    expect(cachedCall).toHaveBeenCalledTimes(1);
  });

  it("never opts the render out of the cache", async () => {
    await bailOnEmptyRender();
    expect(unstableNoStore).not.toHaveBeenCalled();
  });

  it("keeps the fallback short but not per-request", () => {
    // unstable_cache rejects 0, and 0 would be the no-store behaviour again.
    expect(EMPTY_RENDER_REVALIDATE_SECONDS).toBeGreaterThan(0);
    expect(EMPTY_RENDER_REVALIDATE_SECONDS).toBeLessThanOrEqual(300);
  });

  it("is a no-op during the production build", async () => {
    process.env.SKIP_STATIC_GENERATION = "1";
    process.env.NEXT_PHASE = "phase-production-build";
    await bailOnEmptyRender();
    expect(unstableCache).not.toHaveBeenCalled();
  });

  it("never fails the fallback render itself", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    cachedCall.mockRejectedValueOnce(new Error("Invariant: incrementalCache missing"));
    await expect(bailOnEmptyRender()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
