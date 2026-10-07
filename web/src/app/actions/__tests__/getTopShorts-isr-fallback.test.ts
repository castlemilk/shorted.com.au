/**
 * The connect fallback inside getTopShortsData must be ISR-cacheable.
 *
 * A bare connect POST is `no-store` at Vercel runtime. Next records that
 * dynamic usage even when the caller swallows the error, so every ISR
 * regeneration of a page that reaches the fallback fails and Vercel keeps
 * serving the previous copy. Measured 2026-10-07: /news stayed on a render
 * from before two takes were published (`x-vercel-cache: STALE`, `age`
 * climbing past 5,000s across on-demand revalidations that reported success)
 * and `/` logged "Dynamic server usage: no-store fetch … GetTopShorts".
 *
 * This test drives the real getTopShortsData with the edge read disabled and
 * the KV cache empty, captures the fetch the connect transport is built with,
 * and asserts it carries a positive `next.revalidate` and the `shorts-data`
 * tag the sync's revalidation ping busts.
 */

const capturedTransports: Array<{ fetch: typeof fetch; baseUrl: string }> = [];
const getTopShortsRpc = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (opts: { fetch: typeof fetch; baseUrl: string }) => {
    capturedTransports.push(opts);
    return { __transport: true };
  },
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({ getTopShorts: getTopShortsRpc }),
}));

const serverFetchWithUserAgent = jest.fn();
jest.mock("../config", () => ({
  SHORTS_API_URL: "https://shorts-test.run.app",
  serverFetchWithUserAgent: (...args: unknown[]) =>
    serverFetchWithUserAgent(...args),
}));

jest.mock("../edgeRead", () => ({
  fetchEdgeReadJson: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("~/@/lib/kv-cache", () => ({
  CACHE_KEYS: { topShorts: (p: string, l: number, o: number) => `t:${p}:${l}:${o}` },
  HOMEPAGE_TTL: 60,
  deleteCached: jest.fn().mockResolvedValue(undefined),
  getCached: jest.fn().mockResolvedValue(null),
  setCached: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("~/@/lib/tracing", () => ({
  withSpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

jest.mock("~/@/lib/top-shorts-filter", () => ({
  filterTopShortsResponse: (r: unknown) => r,
  hasOnlyEligibleTopShortsInstruments: () => true,
}));

jest.mock("~/@/lib/cache-freshness", () => ({
  isCachedShortsDataStale: () => false,
}));

// src/test/setup.ts mocks "~/app/actions/getTopShorts" globally (most page
// tests want a canned response); this test needs the real implementation.
const { getTopShortsData, TOP_SHORTS_FALLBACK_REVALIDATE_SECONDS } =
  jest.requireActual<typeof import("../getTopShorts")>("../getTopShorts");

describe("getTopShortsData connect fallback", () => {
  beforeEach(() => {
    capturedTransports.length = 0;
    getTopShortsRpc.mockReset();
    serverFetchWithUserAgent.mockReset();
    getTopShortsRpc.mockResolvedValue({ timeSeries: [{ productCode: "BHP" }] });
  });

  it("builds its transport on an ISR-cacheable, shorts-data-tagged fetch", async () => {
    const response = await getTopShortsData("3m", 10, 0);
    expect(response?.timeSeries).toHaveLength(1);
    expect(capturedTransports).toHaveLength(1);

    const [{ fetch: transportFetch, baseUrl }] = capturedTransports;
    expect(baseUrl).toBe("https://shorts-test.run.app");

    serverFetchWithUserAgent.mockResolvedValue(new Response("{}"));
    await transportFetch("https://shorts-test.run.app/x", { method: "POST" });

    expect(serverFetchWithUserAgent).toHaveBeenCalledTimes(1);
    const init = serverFetchWithUserAgent.mock.calls[0]?.[1] as
      | (RequestInit & { next?: { revalidate?: number; tags?: string[] } })
      | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.next?.revalidate).toBe(TOP_SHORTS_FALLBACK_REVALIDATE_SECONDS);
    expect(init?.next?.revalidate).toBeGreaterThan(0);
    expect(init?.next?.tags).toContain("shorts-data");
  });

  it("keeps the fallback lifetime at the edge read's so no page's ISR interval drops", () => {
    // edgeRead.ts: EDGE_READ_REVALIDATE_SECONDS = 86400. Next takes the
    // minimum fetch revalidate on a route as that route's interval.
    expect(TOP_SHORTS_FALLBACK_REVALIDATE_SECONDS).toBe(86400);
  });
});
