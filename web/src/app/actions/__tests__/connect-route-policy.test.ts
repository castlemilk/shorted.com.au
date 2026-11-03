/**
 * @jest-environment node
 */
/**
 * A Connect POST (byte body) with a `next` policy must not reach Next 15's data
 * cache: the response would be served from it for the revalidate window, so an
 * empty response would outlive the render that found it. The route still takes
 * the policy, through unstable_cache. GET requests and string bodies keep the
 * fetch-level `next` option, as before.
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
      ["connect-route-policy", "3600", "shorts-data", "battlegrounds"],
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

  it("keeps a string-body POST's next option, since only byte bodies are unkeyable in Next 14", async () => {
    await serverFetchWithUserAgent("https://api.example.test/json", {
      method: "POST",
      body: "{}",
      next: { revalidate: 300 },
    } as RequestInit);

    expect(unstableCache).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit & { next?: unknown }];
    expect(init.next).toEqual({ revalidate: 300 });
  });

  it("still returns the response when the policy cannot be registered (outside a render), and warns once", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(String(warn.mock.calls[0]?.[0])).toContain("Connect route policy");
    warn.mockRestore();
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
