/// <reference types="jest" />
import { TextDecoder, TextEncoder } from "util";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StaticGenerationStore } from "next/dist/client/components/static-generation-async-storage.external";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

const createConnectTransportMock = jest.fn();
const createClientMock = jest.fn();
const getCachedMock = jest.fn();
const setCachedMock = jest.fn();
const clientMock = {
  getHousingOverview: jest.fn(),
  listAgencyPriceStats: jest.fn(),
  listAddressPriceDrops: jest.fn(),
  getSuburbProfile: jest.fn(),
  listStateSuburbs: jest.fn(),
  getPriceDropsOverview: jest.fn(),
  listSuburbPriceDrops: jest.fn(),
  getDropIndexSeries: jest.fn(),
  listCouncils: jest.fn(),
  getCouncilProfile: jest.fn(),
};

const connectError = (code: number, message: string) => Object.assign(new Error(message), {
  code,
  metadata: { get: jest.fn(() => null) },
});

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) => createConnectTransportMock(...args),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

jest.mock("@/lib/kv-cache", () => ({
  CACHE_KEYS: {
    housingOverview: (regionType: string) => `housing:overview:${regionType}`,
    priceDropsOverview: () => "housing:price-drops:overview",
    suburbPriceDrops: (state: string, sort: string, limit: number) =>
      `housing:price-drops:suburbs:${state}:${sort}:${limit}`,
    councils: (state: string) => `housing:councils:${state}`,
    councilProfile: (state: string, slug: string) => `housing:council:${state}:${slug}`,
  },
  HOUSING_TTL: 300,
  PRICE_DROPS_TTL: 300,
  getCached: (...args: unknown[]) => getCachedMock(...args),
  setCached: (...args: unknown[]) => setCachedMock(...args),
}));

describe("housing server actions", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  function withoutTestingBypassEnv() {
    const env = { ...originalEnv };
    delete env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET;
    delete env.TF_VAR_rate_limit_testing_bypass_secret;
    return env;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...withoutTestingBypassEnv(),
      SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
      NEXT_PUBLIC_API_URL: "https://api.shorted.com.au",
    };
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    getCachedMock.mockResolvedValue(null);
    setCachedMock.mockResolvedValue(undefined);
    clientMock.getHousingOverview.mockResolvedValue({ metrics: [] });
    clientMock.listAgencyPriceStats.mockResolvedValue({ agencies: [] });
    clientMock.listAddressPriceDrops.mockResolvedValue({ addresses: [] });
    clientMock.getSuburbProfile.mockResolvedValue({ summary: undefined });
    clientMock.listStateSuburbs.mockResolvedValue({ suburbs: [] });
    clientMock.getPriceDropsOverview.mockResolvedValue({ states: [] });
    clientMock.listSuburbPriceDrops.mockResolvedValue({ suburbs: [] });
    clientMock.getDropIndexSeries.mockResolvedValue({ points: [] });
    clientMock.listCouncils.mockResolvedValue({ councils: [] });
    clientMock.getCouncilProfile.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("uses the direct server endpoint for SSR instead of the Cloudflare API host", async () => {
    const { getHousingOverview } = await import("../getHousing");

    await getHousingOverview("");

    expect(createConnectTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://shorts-prod.run.app",
        fetch: expect.any(Function),
      }),
    );
    expect(clientMock.getHousingOverview).toHaveBeenCalledWith({ regionType: "" });
  });

  it("prefers the public direct-service endpoint over the server Cloudflare API host", async () => {
    delete process.env.SHORTS_SERVICE_ENDPOINT;
    process.env.SHORTS_API_URL = "https://api.shorted.com.au";
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT = "https://shorts-prod.run.app";

    const { SERVER_SHORTS_API_URL } = await import("../config");

    expect(SERVER_SHORTS_API_URL).toBe("https://shorts-prod.run.app");
  });

  it("adds the first-party SSR user agent to transport fetches", async () => {
    const { getHousingOverview } = await import("../getHousing");
    await getHousingOverview("");
    const transportFetch = createConnectTransportMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    await transportFetch("https://shorts-prod.run.app/health", {
      headers: { "Content-Type": "application/json" },
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toBe("shorted-web-ssr/1.0 (+https://shorted.com.au)");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves request headers when adding the SSR user agent", async () => {
    const { serverFetchWithUserAgent } = await import("../config");
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const request = {
      headers: new Headers({ "X-Shorted-Test": "1" }),
    } as Request;

    await serverFetchWithUserAgent(request);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toBe("shorted-web-ssr/1.0 (+https://shorted.com.au)");
    expect(headers.get("X-Shorted-Test")).toBe("1");
  });

  it("bypasses shared KV for the flag-gated agency read", async () => {
    const { listAgencyPriceStats } = await import("../getHousing");

    await listAgencyPriceStats("", "drops", 12);

    expect(clientMock.listAgencyPriceStats).toHaveBeenCalledWith({
      stateCode: "",
      sort: "drops",
      limit: 12,
    });
    expect(getCachedMock).not.toHaveBeenCalled();
    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("bypasses shared KV for the flag-gated address read", async () => {
    const { listAddressPriceDrops } = await import("../getHousing");

    await listAddressPriceDrops("VIC", 90, 50, "pct");

    expect(clientMock.listAddressPriceDrops).toHaveBeenCalledWith(
      { stateCode: "VIC", windowDays: 90, limit: 50, sort: "pct" },
      expect.anything(),
    );
    expect(getCachedMock).not.toHaveBeenCalled();
    expect(setCachedMock).not.toHaveBeenCalled();
  });

  // /price-drops waits for this seed. On 2026-10-21 the RPC failed at the
  // backend's 10s store deadline on every call, and four attempts plus backoff
  // held each render for 44s. The board fetches for itself when the seed is
  // empty, so a failed seed must cost one bounded attempt and nothing more.
  it("makes one bounded attempt at the optional address seed", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    clientMock.listAddressPriceDrops.mockRejectedValue(connectError(4, "deadline exceeded"));
    const { ADDRESS_SEED_TIMEOUT_MS, listAddressPriceDrops } = await import("../getHousing");

    await expect(listAddressPriceDrops()).resolves.toBeUndefined();

    expect(clientMock.listAddressPriceDrops).toHaveBeenCalledTimes(1);
    expect(clientMock.listAddressPriceDrops).toHaveBeenCalledWith(
      { stateCode: "", windowDays: 90, limit: 50, sort: "pct" },
      { timeoutMs: ADDRESS_SEED_TIMEOUT_MS },
    );
    expect(ADDRESS_SEED_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  it("resolves already-indexed suburb slugs with one trailing hyphen", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [{
        salCode: "206041122",
        salName: "Abbotsford (Vic.)",
        postcode: "",
      }],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "abbotsford-vic-")).resolves.toBe("206041122");
    expect(clientMock.listStateSuburbs).toHaveBeenCalledWith({
      stateCode: "VIC",
      query: "abbotsford",
      limit: 50,
    });
  });

  it("resolves a canonical suburb slug with a narrow name query", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [{
        salCode: "20075",
        salName: "Ascot Vale",
        postcode: "3032",
      }],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "ascot-vale-3032")).resolves.toBe("20075");
    expect(clientMock.listStateSuburbs).toHaveBeenCalledWith({
      stateCode: "VIC",
      query: "ascot vale",
      limit: 50,
    });
  });

  it("retries punctuation-normalized names with a bounded final-word query", async () => {
    clientMock.listStateSuburbs.mockImplementation(async ({ query }: { query: string }) => ({
      suburbs: query === "connor"
        ? [{ salCode: "80004", salName: "O'Connor", postcode: "2602" }]
        : [],
    }));
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("ACT", "o-connor-2602")).resolves.toBe("80004");
    expect(clientMock.listStateSuburbs).toHaveBeenNthCalledWith(1, {
      stateCode: "ACT",
      query: "o connor",
      limit: 50,
    });
    expect(clientMock.listStateSuburbs).toHaveBeenNthCalledWith(2, {
      stateCode: "ACT",
      query: "connor",
      limit: 50,
    });
  });

  // Internal suburb links carry no ?sal=, so the path alone must pick the
  // suburb. ABS qualifies a name that repeats inside one state with its LGA
  // (prod, 2026-10-21: no slug is shared by two SALs in a state), and the bare
  // name is ambiguous, so it resolves to nothing rather than to either Ascot.
  it("resolves a name that repeats in one state from its qualified slug alone", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [
        { salCode: "20073", salName: "Ascot (Ballarat - Vic.)", postcode: "" },
        { salCode: "20074", salName: "Ascot (Greater Bendigo - Vic.)", postcode: "" },
        { salCode: "20075", salName: "Ascot Vale", postcode: "" },
      ],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "ascot-ballarat-vic")).resolves.toBe("20073");
    await expect(resolveSuburbSalCode("VIC", "ascot-greater-bendigo-vic")).resolves.toBe("20074");
    await expect(resolveSuburbSalCode("VIC", "ascot")).resolves.toBeNull();
  });

  // The name-only fallback keeps the ABS qualifier. Prod, 2026-10-21:
  // /housing/vic/clyde-north-3978 308s to clyde-north, but
  // /housing/nsw/abbotsford-nsw-2046 (a crawl postcode on a qualified name, as
  // the price-drops boards linked it) 404ed.
  it("resolves a qualified name whatever postcode its slug carries", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [{ salCode: "10003", salName: "Abbotsford (NSW)", postcode: "" }],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("NSW", "abbotsford-nsw-2046")).resolves.toBe("10003");
  });

  // Price-drops and similar-suburbs links pass postcode "", so once the feed
  // carries one, they are name-only slugs of a postcoded canonical.
  it("resolves a qualified name-only slug once the feed carries a postcode", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [
        { salCode: "10003", salName: "Abbotsford (NSW)", postcode: "2046" },
        { salCode: "20073", salName: "Ascot (Ballarat - Vic.)", postcode: "3350" },
        { salCode: "20074", salName: "Ascot (Greater Bendigo - Vic.)", postcode: "3551" },
      ],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("NSW", "abbotsford-nsw")).resolves.toBe("10003");
    await expect(resolveSuburbSalCode("VIC", "ascot-ballarat-vic")).resolves.toBe("20073");
    await expect(resolveSuburbSalCode("VIC", "ascot")).resolves.toBeNull();
  });

  it("returns null only when a suburb slug is a genuine miss", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({ suburbs: [] });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "not-a-real-suburb")).resolves.toBeNull();
  });

  it("throws when the state suburb index is unavailable", async () => {
    clientMock.listStateSuburbs.mockRejectedValue(connectError(14, "backend unavailable"));
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "abbotsford-vic")).rejects.toThrow(
      "Unable to resolve suburb slug",
    );
  });

  it("preserves profile NotFound separately from backend unavailability", async () => {
    clientMock.getSuburbProfile.mockRejectedValue(connectError(5, "suburb not found"));
    const { getSuburbProfile } = await import("../getHousing");

    await expect(getSuburbProfile("missing-sal")).rejects.toMatchObject({
      name: "NotFoundError",
      message: "suburb not found",
    });
  });

  it("does not turn a transient profile failure into NotFound", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    clientMock.getSuburbProfile.mockRejectedValue(connectError(14, "backend unavailable"));
    const { getSuburbProfile } = await import("../getHousing");

    await expect(getSuburbProfile("206041122")).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("withRetryAndThrowNotFound"),
      "backend unavailable",
      expect.any(Object),
    );
    consoleError.mockRestore();
  });

  it.each([
    "getHousingOverview",
    "getPriceDropsOverview",
    "listSuburbPriceDrops",
    "listAgencyPriceStats",
    "listAddressPriceDrops",
    "getDropIndexSeries",
    "listStateSuburbs",
    "getSuburbProfile",
    "listCouncils",
    "getCouncilProfile",
  ] as const)("%s preserves the RPC body and ISR without entering Next's fetch cache", async (action) => {
    process.env.VERCEL_ENV = "production";
    process.env.SHORTED_SSR_BYPASS_SECRET = "test-ssr-secret";
    const housing = await import("../getHousing");
    const calls = {
      getHousingOverview: () => housing.getHousingOverview(),
      getPriceDropsOverview: () => housing.getPriceDropsOverview(),
      listSuburbPriceDrops: () => housing.listSuburbPriceDrops(),
      listAgencyPriceStats: () => housing.listAgencyPriceStats(),
      listAddressPriceDrops: () => housing.listAddressPriceDrops(),
      getDropIndexSeries: () => housing.getDropIndexSeries(),
      listStateSuburbs: () => housing.listStateSuburbs("VIC"),
      getSuburbProfile: () => housing.getSuburbProfile("206041122"),
      listCouncils: () => housing.listCouncils("VIC"),
      getCouncilProfile: () => housing.getCouncilProfile("VIC", "example"),
    };
    await calls[action]();
    const transportFetch = createConnectTransportMock.mock.calls[0]?.[0]?.fetch as typeof fetch;

    // Use the installed Next patch and key generator, not a mock that merely
    // checks `next.revalidate`. Next 14 treats Uint8Array.keys as FormData and
    // calls its nonexistent getAll, logging a cache-key error on every RPC.
    const { patchFetch } = await import("next/dist/server/lib/patch-fetch");
    const { IncrementalCache } = await import("next/dist/server/lib/incremental-cache");
    const serverHooks = await import("next/dist/client/components/hooks-server-context");
    const storage = new AsyncLocalStorage<StaticGenerationStore>();
    const fetchCacheKey = jest.fn(IncrementalCache.prototype.fetchCacheKey);
    const store: StaticGenerationStore = {
      isStaticGeneration: true,
      urlPathname: "/price-drops",
      pagePath: "/price-drops/page",
      prerenderState: null,
      revalidate: 3600,
      incrementalCache: { fetchCacheKey } as unknown as InstanceType<typeof IncrementalCache>,
    };
    const origin = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = origin;
    patchFetch({ staticGenerationAsyncStorage: storage, serverHooks });
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const body = new TextEncoder().encode('{"stateCode":"VIC"}');
    const signal = new AbortController().signal;
    try {
      await storage.run(store, () => transportFetch("https://shorts-prod.run.app/shorts.v1alpha1.HousingService/Test", {
        method: "POST",
        body,
        signal,
        headers: { "Content-Type": "application/json" },
      }));
      expect(fetchCacheKey).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(store.revalidate).toBe(3600);
      expect(store.dynamicUsageErr).toBeUndefined();
      expect(origin).toHaveBeenCalledTimes(1);
      const sent = origin.mock.calls[0]?.[1] as RequestInit;
      expect(sent.body).toBe(body);
      expect(sent.signal).toBe(signal);
      expect(sent.cache).not.toBe("no-store");
      expect((sent.headers as Headers).get("User-Agent")).toContain("shorted-web-ssr");
      expect((sent.headers as Headers).get("X-Shorted-SSR-Bypass")).toBe("test-ssr-secret");
    } finally {
      error.mockRestore();
    }
  });
});
