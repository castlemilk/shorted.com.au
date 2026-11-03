/**
 * @jest-environment node
 */
/**
 * A request that is not a GET or HEAD, and carries a `next` option, must not
 * reach Next 15's data cache: the response would be served from it for the
 * revalidate window, so an empty response would outlive the render that found
 * it. That holds for a Connect POST (byte body) and for a plain JSON POST
 * (string body) alike. The route still takes the policy, through unstable_cache.
 * GET and HEAD requests keep the fetch-level `next` option, as before.
 */
const cachedCall = jest.fn(async () => true);
const unstableCache = jest.fn((_cb: unknown, _keys: unknown, _opts: unknown) => cachedCall);

jest.mock("next/cache", () => ({
  unstable_cache: (cb: unknown, keys: unknown, opts: unknown) => unstableCache(cb, keys, opts),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { serverFetchWithUserAgent } from "../config";

const ORIGINAL_FETCH = globalThis.fetch;

describe("serverFetchWithUserAgent and the Next data cache", () => {
  let fetchMock: jest.Mock;

  // A console.warn spy is restored after each test, even one whose assertions
  // fail: a leaked spy would also fail the next test's call count.
  const warnSpies: jest.SpyInstance[] = [];
  const silenceWarn = (): jest.SpyInstance => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    warnSpies.push(spy);
    return spy;
  };
  afterEach(() => {
    for (const spy of warnSpies.splice(0)) spy.mockRestore();
  });

  beforeEach(() => {
    unstableCache.mockClear();
    cachedCall.mockReset();
    cachedCall.mockImplementation(async () => true);
    fetchMock = jest.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("sends a byte-body POST around the patched fetch and registers its route policy", async () => {
    const response = await serverFetchWithUserAgent("https://api.example.test/rpc", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      next: { revalidate: 3600, tags: ["shorts-data", "battlegrounds"] },
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["route-policy", "3600", "shorts-data", "battlegrounds"],
      { revalidate: 3600, tags: ["shorts-data", "battlegrounds"] },
    );
    expect(cachedCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init).not.toHaveProperty("next");
  });

  it("keeps a GET's fetch-level next option on the patched path", async () => {
    await serverFetchWithUserAgent("https://api.example.test/feed", {
      method: "GET",
      next: { revalidate: 60 },
    } as RequestInit);

    expect(unstableCache).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init.next).toEqual({ revalidate: 60 });
  });

  it("keeps a HEAD's fetch-level next option on the patched path, as for a GET", async () => {
    await serverFetchWithUserAgent("https://api.example.test/feed", {
      method: "HEAD",
      next: { revalidate: 60 },
    } as RequestInit);

    expect(unstableCache).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init.next).toEqual({ revalidate: 60 });
  });

  it("routes a string-body POST's next option through the route policy, not the fetch", async () => {
    // The plain JSON POSTs on /news and /feed.xml. Next 15 keys a string body
    // exactly as it keys a byte body, so the same rule applies.
    const response = await serverFetchWithUserAgent("https://api.example.test/json", {
      method: "POST",
      body: "{}",
      next: { revalidate: 300, tags: ["news-index"] },
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["route-policy", "300", "news-index"],
      { revalidate: 300, tags: ["news-index"] },
    );
    expect(cachedCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init).not.toHaveProperty("next");
    expect(init.body).toBe("{}");
  });

  it("drops next on the guarded path too, when Next's original fetch is not stashed (a renamed stash)", async () => {
    silenceWarn();
    const patched = jest.fn(async () => new Response("{}", { status: 200 })) as jest.Mock & {
      __nextPatched?: boolean;
      _nextOriginalFetch?: unknown;
    };
    patched.__nextPatched = true;
    // No _nextOriginalFetch: the bypass cannot resolve the native fetch, so the
    // request goes through the patch. The patch must not get the `next` option.
    globalThis.fetch = patched as unknown as typeof fetch;

    const response = await serverFetchWithUserAgent("https://api.example.test/json", {
      method: "POST",
      body: "{}",
      next: { revalidate: 300, tags: ["news-index"] },
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["route-policy", "300", "news-index"],
      { revalidate: 300, tags: ["news-index"] },
    );
    expect(patched).toHaveBeenCalledTimes(1);
    const [, init] = patched.mock.calls[0] as unknown as [unknown, RequestInit & { next?: unknown }];
    expect(init).not.toHaveProperty("next");
    expect(init.body).toBe("{}");
  });

  it("applies the route policy to any non-GET request with a next option, bodiless or not", async () => {
    await serverFetchWithUserAgent("https://api.example.test/item", {
      method: "DELETE",
      next: { revalidate: 120 },
    } as RequestInit);

    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["route-policy", "120"],
      { revalidate: 120, tags: undefined },
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init).not.toHaveProperty("next");
  });

  it("leaves a string-body POST with no next option alone", async () => {
    await serverFetchWithUserAgent("https://api.example.test/json", {
      method: "POST",
      body: "{}",
    } as RequestInit);

    expect(unstableCache).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still returns the response when the policy cannot be registered (outside a render), and warns once", async () => {
    const warn = silenceWarn();
    cachedCall.mockRejectedValue(new Error("Invariant: static generation store missing"));

    const call = () =>
      serverFetchWithUserAgent("https://api.example.test/rpc", {
        method: "POST",
        body: new Uint8Array([9]),
        next: { revalidate: 3600, tags: ["shorts-data"] },
      } as RequestInit);

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("route policy");
  });

  it("ignores a null next option instead of rejecting the call", async () => {
    const response = await serverFetchWithUserAgent("https://api.example.test/rpc", {
      method: "POST",
      body: new Uint8Array([7]),
      next: null,
    } as unknown as RequestInit);

    expect(response.status).toBe(200);
    expect(unstableCache).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init).not.toHaveProperty("next");
  });

  it("sends a byte-body POST through the original fetch Next stashed, never the patched one", async () => {
    const original = jest.fn(async () => new Response("{}", { status: 200 }));
    const patched = jest.fn(async () => new Response("{}", { status: 200 })) as jest.Mock & {
      __nextPatched?: boolean;
      _nextOriginalFetch?: unknown;
    };
    patched.__nextPatched = true;
    patched._nextOriginalFetch = original;
    globalThis.fetch = patched as unknown as typeof fetch;

    const response = await serverFetchWithUserAgent("https://api.example.test/rpc", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      next: { revalidate: 3600, tags: ["shorts-data"] },
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(original).toHaveBeenCalledTimes(1);
    expect(patched).not.toHaveBeenCalled();
    const [, init] = original.mock.calls[0] as unknown as [unknown, RequestInit & { next?: unknown }];
    expect(init).not.toHaveProperty("next");
  });

  it("guards the bypass: the installed Next still stashes the original fetch on its patch", () => {
    const patchFetch = readFileSync(
      join(__dirname, "../../../../node_modules/next/dist/server/lib/patch-fetch.js"),
      "utf8",
    );
    // serverFetchWithUserAgent's bypass reads this stash. If a Next upgrade
    // renames it, the bypass falls back to the patched fetch with one warning,
    // and the Connect POSTs go back to the data cache.
    expect(patchFetch).toMatch(/\._nextOriginalFetch\s*=/);
  });
});
