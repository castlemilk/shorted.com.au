/// <reference types="jest" />

/**
 * The sole-declarer rail's action, and the three things about it that are
 * load-bearing rather than incidental.
 *
 *   - AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `{}` parses into a perfectly
 *     valid message with no holdings, so a truthy `if (hit)` pins an empty rail
 *     for the full 24h TTL while the rpc behind it is healthy. That is what
 *     /politicians served after the 2026-07-31 deploy.
 *   - THE WRITER GUARD IS THE SAME PREDICATE AS THE READER. An asymmetric pair
 *     is what makes a bad entry stick: the write refuses it, the read accepts
 *     it, and nothing ever corrects it.
 *   - THE KEY LIVES UNDER `cache:politicians:`. That prefix is what
 *     `/api/revalidate?flush=politicians` clears; a key outside it survives an
 *     ingest and serves last week's declarer counts.
 */

import { TextDecoder, TextEncoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

const createConnectTransportMock = jest.fn();
const createClientMock = jest.fn();
const clientMock = {
  listDistinctiveHoldings: jest.fn(),
};

const getCachedMock = jest.fn();
const setCachedMock = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) => createConnectTransportMock(...args),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

/**
 * The global setup mock of @bufbuild/protobuf has no `toJson` at all, and the
 * writer wraps its call in a try/catch (a cache write must never break a
 * render). Left alone, the write silently no-ops and the assertion that it
 * HAPPENED passes for the wrong reason. This local mock restores a passthrough
 * for the two codecs this action uses.
 */
jest.mock("@bufbuild/protobuf", () => ({
  fromJson: jest.fn((_schema: unknown, data: unknown) => data ?? {}),
  toJson: jest.fn((_schema: unknown, data: unknown) => data ?? {}),
  create: jest.fn((_schema: unknown, data: unknown) => data ?? {}),
}));

jest.mock("@/lib/kv-cache", () => {
  const actual = jest.requireActual("@/lib/kv-cache");
  return {
    ...actual,
    getCached: (...args: unknown[]) => getCachedMock(...args),
    setCached: (...args: unknown[]) => setCachedMock(...args),
  };
});

/** The JSON form, as it comes back out of KV. */
const POPULATED = {
  canonicalSlug: "anthony-albanese",
  holdings: [
    {
      stockCode: "VGN",
      companyName: "Vagabond Ltd",
      industry: "Software",
      holder: 1,
      corpusDeclarerCount: 1,
      shortPercent: 0,
    },
  ],
  moreCount: 0,
};

/**
 * The shape the register kill switch and a cold materialized view both return:
 * well formed, canonical slug and all, and empty of the only thing the rail
 * renders.
 */
const EMPTY_BUT_WELL_FORMED = { canonicalSlug: "anthony-albanese", holdings: [] };

async function loadAction() {
  const mod = await import("../getDistinctiveHoldings");
  return mod.getDistinctiveHoldings;
}

describe("distinctive holdings action", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
    };
    delete process.env.SKIP_STATIC_GENERATION;
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    getCachedMock.mockResolvedValue(null);
    setCachedMock.mockResolvedValue(true);
    clientMock.listDistinctiveHoldings.mockResolvedValue(POPULATED);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("keys the cache under the prefix the politicians flush clears", async () => {
    const getDistinctiveHoldings = await loadAction();

    await getDistinctiveHoldings("anthony-albanese");

    expect(getCachedMock).toHaveBeenCalledWith("cache:politicians:distinctive:anthony-albanese");
    // Two members can never collide on one entry.
    expect(getCachedMock.mock.calls[0]?.[0]).not.toBe(
      "cache:politicians:distinctive:someone-else",
    );
  });

  it("normalises the slug into the key the way the handler normalises it", async () => {
    const getDistinctiveHoldings = await loadAction();

    // The handler trims and lower-cases, so these are ONE member and must be one
    // entry: two keys would give one link a warm cache and the other a miss, and
    // a flush that clears one would leave the other serving pre-flush rows.
    await getDistinctiveHoldings("  Anthony-Albanese ");

    expect(getCachedMock).toHaveBeenCalledWith("cache:politicians:distinctive:anthony-albanese");
  });

  it("asks the rpc for exactly the requested member", async () => {
    const getDistinctiveHoldings = await loadAction();

    await getDistinctiveHoldings("anthony-albanese");

    expect(clientMock.listDistinctiveHoldings).toHaveBeenCalledWith({
      slug: "anthony-albanese",
    });
  });

  it("treats a well-formed but holding-less cache entry as a miss and refetches", async () => {
    getCachedMock.mockResolvedValue(EMPTY_BUT_WELL_FORMED);
    const getDistinctiveHoldings = await loadAction();

    const result = await getDistinctiveHoldings("anthony-albanese");

    expect(clientMock.listDistinctiveHoldings).toHaveBeenCalledTimes(1);
    expect(result?.holdings).toHaveLength(1);
  });

  it("treats a completely empty cache entry as a miss", async () => {
    getCachedMock.mockResolvedValue({});
    const getDistinctiveHoldings = await loadAction();

    await getDistinctiveHoldings("anthony-albanese");

    expect(clientMock.listDistinctiveHoldings).toHaveBeenCalledTimes(1);
  });

  it("serves a populated cache entry without calling the rpc", async () => {
    getCachedMock.mockResolvedValue(POPULATED);
    const getDistinctiveHoldings = await loadAction();

    const result = await getDistinctiveHoldings("anthony-albanese");

    expect(clientMock.listDistinctiveHoldings).not.toHaveBeenCalled();
    expect(result?.holdings[0]?.stockCode).toBe("VGN");
  });

  it("never writes an empty response to the cache", async () => {
    clientMock.listDistinctiveHoldings.mockResolvedValue(EMPTY_BUT_WELL_FORMED);
    const getDistinctiveHoldings = await loadAction();

    await getDistinctiveHoldings("anthony-albanese");

    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("writes a populated response under the 24h register TTL", async () => {
    const { POLITICIANS_TTL } = jest.requireActual(
      "@/lib/kv-cache",
    ) as typeof import("@/lib/kv-cache");
    const getDistinctiveHoldings = await loadAction();

    await getDistinctiveHoldings("anthony-albanese");

    expect(setCachedMock).toHaveBeenCalledWith(
      "cache:politicians:distinctive:anthony-albanese",
      expect.objectContaining({ canonicalSlug: "anthony-albanese" }),
      POLITICIANS_TTL,
    );
  });

  it("returns the empty response rather than throwing, so the rail simply stays silent", async () => {
    clientMock.listDistinctiveHoldings.mockResolvedValue(EMPTY_BUT_WELL_FORMED);
    const getDistinctiveHoldings = await loadAction();

    const result = await getDistinctiveHoldings("anthony-albanese");

    expect(result?.holdings).toEqual([]);
  });

  it("does nothing at all without a slug, and nothing during a build prerender", async () => {
    const getDistinctiveHoldings = await loadAction();
    expect(await getDistinctiveHoldings("")).toBeUndefined();
    expect(clientMock.listDistinctiveHoldings).not.toHaveBeenCalled();

    jest.resetModules();
    process.env.SKIP_STATIC_GENERATION = "1";
    process.env.NEXT_PHASE = "phase-production-build";
    const duringBuild = await loadAction();
    expect(await duringBuild("anthony-albanese")).toBeUndefined();
    expect(clientMock.listDistinctiveHoldings).not.toHaveBeenCalled();
  });
});
