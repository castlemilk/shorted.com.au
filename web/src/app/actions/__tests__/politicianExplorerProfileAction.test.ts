/// <reference types="jest" />

/**
 * The profile explorer action, and the three things about it that are
 * load-bearing rather than incidental.
 *
 *   - AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `{}` parses into a perfectly
 *     valid message whose counts are all zero, so a truthy `if (hit)` served
 *     zeros for the full 24h TTL while every rpc behind it was healthy. That is
 *     what /politicians served after the 2026-07-31 deploy, and the profile
 *     inherits both the shape and the failure mode.
 *   - THE WRITER GUARD IS THE SAME PREDICATE AS THE READER. An asymmetric pair
 *     is what makes a bad entry stick: the write refuses it, the read accepts
 *     it, and nothing ever corrects it.
 *   - THE KEY LIVES UNDER `cache:politicians:`. That prefix is what
 *     `/api/revalidate?flush=politicians` clears; a key outside it survives an
 *     ingest and serves last week's counts.
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
  getPoliticianExplorerProfile: jest.fn(),
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
 * HAPPENED passes for the wrong reason — the same class of bug as an empty cache
 * entry reading as a hit. This local mock restores a passthrough for the two
 * codecs this action uses; protobuf's own serialisation is not under test here.
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
  itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 8 }],
  timeline: [{ month: "2026-06", declaredCount: 8 }],
  undatedCount: 2,
};


async function loadAction() {
  const mod = await import("../getPoliticianExplorerProfile");
  return mod.getPoliticianExplorerProfile;
}

describe("politician explorer profile action", () => {
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
    clientMock.getPoliticianExplorerProfile.mockResolvedValue(POPULATED);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("keys the cache under the prefix the politicians flush clears", async () => {
    const getPoliticianExplorerProfile = await loadAction();

    await getPoliticianExplorerProfile("anthony-albanese");

    expect(getCachedMock).toHaveBeenCalledWith(
      "cache:politicians:explorer-profile:anthony-albanese",
    );
    // Two members can never collide on one entry.
    expect(getCachedMock.mock.calls[0]?.[0]).not.toBe(
      "cache:politicians:explorer-profile:someone-else",
    );
  });

  it("normalises the slug into the key the way the handler normalises it", async () => {
    const getPoliticianExplorerProfile = await loadAction();

    // The handler trims and lower-cases: one member, one entry, whatever casing
    // the link that reached this render happened to carry.
    await getPoliticianExplorerProfile(" Anthony-Albanese  ");

    expect(getCachedMock).toHaveBeenCalledWith(
      "cache:politicians:explorer-profile:anthony-albanese",
    );
  });

  it("asks for the five industries the profile actually renders", async () => {
    const getPoliticianExplorerProfile = await loadAction();

    await getPoliticianExplorerProfile("anthony-albanese");

    expect(clientMock.getPoliticianExplorerProfile).toHaveBeenCalledWith({
      slug: "anthony-albanese",
      topIndustries: 5,
    });
  });

  it("treats a zeroed cache entry as a miss and refetches", async () => {
    // The shape a cold materialized view or the register kill switch returns:
    // well formed, and empty of every measure the profile renders.
    getCachedMock.mockResolvedValue({
      itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 0 }],
      timeline: [],
    });
    const getPoliticianExplorerProfile = await loadAction();

    const result = await getPoliticianExplorerProfile("anthony-albanese");

    expect(clientMock.getPoliticianExplorerProfile).toHaveBeenCalledTimes(1);
    expect(result?.undatedCount).toBe(2);
  });

  it("treats a completely empty cache entry as a miss", async () => {
    getCachedMock.mockResolvedValue({});
    const getPoliticianExplorerProfile = await loadAction();

    await getPoliticianExplorerProfile("anthony-albanese");

    expect(clientMock.getPoliticianExplorerProfile).toHaveBeenCalledTimes(1);
  });

  it("serves a populated cache entry without calling the rpc", async () => {
    getCachedMock.mockResolvedValue(POPULATED);
    const getPoliticianExplorerProfile = await loadAction();

    const result = await getPoliticianExplorerProfile("anthony-albanese");

    expect(clientMock.getPoliticianExplorerProfile).not.toHaveBeenCalled();
    expect(result?.itemCounts[0]?.currentCount).toBe(8);
  });

  it("never writes an empty response to the cache", async () => {
    clientMock.getPoliticianExplorerProfile.mockResolvedValue({
      itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 0 }],
      timeline: [],
    });
    const getPoliticianExplorerProfile = await loadAction();

    await getPoliticianExplorerProfile("anthony-albanese");

    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("writes a populated response under the 24h register TTL", async () => {
    const { POLITICIANS_TTL } = jest.requireActual(
      "@/lib/kv-cache",
    ) as typeof import("@/lib/kv-cache");
    const getPoliticianExplorerProfile = await loadAction();

    await getPoliticianExplorerProfile("anthony-albanese");

    expect(setCachedMock).toHaveBeenCalledWith(
      "cache:politicians:explorer-profile:anthony-albanese",
      expect.objectContaining({ undatedCount: 2 }),
      POLITICIANS_TTL,
    );
  });

  it("does nothing at all without a slug, and nothing during a build prerender", async () => {
    const getPoliticianExplorerProfile = await loadAction();
    expect(await getPoliticianExplorerProfile("")).toBeUndefined();
    expect(clientMock.getPoliticianExplorerProfile).not.toHaveBeenCalled();

    jest.resetModules();
    process.env.SKIP_STATIC_GENERATION = "1";
    process.env.NEXT_PHASE = "phase-production-build";
    const duringBuild = await loadAction();
    expect(await duringBuild("anthony-albanese")).toBeUndefined();
    expect(clientMock.getPoliticianExplorerProfile).not.toHaveBeenCalled();
  });
});
