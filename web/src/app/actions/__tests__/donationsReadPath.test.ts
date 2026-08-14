/// <reference types="jest" />

/**
 * The four AEC funding read paths, and the three things about them that are
 * load-bearing rather than incidental.
 *
 *   - AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `{}` parses into a perfectly
 *     valid message with empty lists, so a truthy `if (hit)` pins an empty
 *     surface for the full 24h TTL while the rpc behind it is healthy. That is
 *     what /politicians served after the 2026-07-31 deploy — and the AEC kill
 *     switch returns exactly that shape, so a takedown would otherwise outlive
 *     itself by a day.
 *   - THE WRITER GUARD IS THE SAME PREDICATE AS THE READER. An asymmetric pair
 *     is what makes a bad entry stick: the write refuses it, the read accepts
 *     it, and nothing ever corrects it.
 *   - EVERY KEY IS UNDER `cache:politicians:` AND CARRIES EVERY CLAMPED INPUT.
 *     The prefix is what `/api/revalidate?flush=politicians` clears; a key
 *     outside it survives an AEC re-ingest. An input missing from the key is a
 *     cache that serves one page under another page's name — and the party group
 *     goes in VERBATIM, because the backend matches it exactly and case-folding
 *     it would fold a populated response and an empty one onto one entry.
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
  getDonationsOverview: jest.fn(),
  listTopDonors: jest.fn(),
  listPartyFunding: jest.fn(),
  getPoliticianFunding: jest.fn(),
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
 * HAPPENED passes for the wrong reason.
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

const OVERVIEW = { financialYear: "2024-25", parties: [{ partyGroup: "Liberal" }] };
const DONORS = { financialYear: "2024-25", donors: [{ donorName: "A Payer Pty Ltd" }], total: 9 };
const PARTY = { partyGroup: "Liberal", series: [{ financialYear: "2024-25" }] };
const MEMBER = { canonicalSlug: "helen-haines", annualReturns: [{ financialYear: "2023-24" }] };

/**
 * The shape the AEC kill switch and a cold ingest both return: well formed,
 * every note in place, and empty of the only thing each surface renders.
 */
const EMPTY_OVERVIEW = { financialYear: "", parties: [], censoringNote: "x" };
const EMPTY_DONORS = { financialYear: "2024-25", donors: [], total: 0 };
const EMPTY_PARTY = { partyGroup: "Liberal", series: [] };
const EMPTY_MEMBER = { canonicalSlug: "", annualReturns: [], candidateReturns: [], coverageNote: "x" };

async function loadDonations() {
  return import("../getDonations");
}

async function loadMemberFunding() {
  const mod = await import("../getPoliticianFunding");
  return mod.getPoliticianFunding;
}

describe("AEC funding read paths", () => {
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
    clientMock.getDonationsOverview.mockResolvedValue(OVERVIEW);
    clientMock.listTopDonors.mockResolvedValue(DONORS);
    clientMock.listPartyFunding.mockResolvedValue(PARTY);
    clientMock.getPoliticianFunding.mockResolvedValue(MEMBER);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("keys every read under the prefix the politicians flush clears", async () => {
    const { getDonationsOverview, listTopDonors, listPartyFunding } = await loadDonations();
    const getPoliticianFunding = await loadMemberFunding();

    await getDonationsOverview("2024-25", 25);
    await listTopDonors({ financialYear: "2024-25", partyGroup: "The Greens", limit: 25, offset: 50 });
    await listPartyFunding("The Greens", "2024-25", 100);
    await getPoliticianFunding("helen-haines");

    for (const call of getCachedMock.mock.calls) {
      expect(call[0]).toMatch(/^cache:politicians:/);
    }
  });

  it("puts every clamped input in the key, so one page cannot serve another's", async () => {
    const { listTopDonors } = await loadDonations();

    await listTopDonors({ financialYear: "2024-25", partyGroup: "The Greens", limit: 25, offset: 50 });

    expect(getCachedMock).toHaveBeenCalledWith(
      "cache:politicians:donations:donors:2024-25:The Greens:25:50",
    );
  });

  it("keys an unresolved year distinctly from any resolved one", async () => {
    const { getDonationsOverview } = await loadDonations();

    await getDonationsOverview("", 25);

    // "" means "the latest year held", which is a different request from any
    // named year — and the year it resolves to changes when an ingest lands.
    expect(getCachedMock).toHaveBeenCalledWith("cache:politicians:donations:overview:latest:25");
  });

  it("keeps the party group verbatim in the key, never case-folded", async () => {
    const { listPartyFunding } = await loadDonations();

    await listPartyFunding("The Greens", "2024-25", 100);

    // The backend matches the group EXACTLY, so "the greens" is a different
    // request with a different (empty) answer. One key for both would serve the
    // empty one under the populated one's name.
    expect(getCachedMock).toHaveBeenCalledWith(
      "cache:politicians:donations:party:The Greens:2024-25:100",
    );
  });

  it("clamps a page size before the key is built", async () => {
    const { listTopDonors } = await loadDonations();

    await listTopDonors({ financialYear: "2024-25", limit: 5000, offset: -1 });

    expect(getCachedMock).toHaveBeenCalledWith(
      "cache:politicians:donations:donors:2024-25:all:200:0",
    );
    expect(clientMock.listTopDonors).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, offset: 0 }),
    );
  });

  it("refuses a party-funding read with no group rather than asking for one", async () => {
    const { listPartyFunding } = await loadDonations();

    // The handler answers InvalidArgument for an empty group; asking is a caller
    // bug, and a request that can only fail should not be made.
    expect(await listPartyFunding("", "2024-25")).toBeUndefined();
    expect(clientMock.listPartyFunding).not.toHaveBeenCalled();
  });

  it.each([
    ["overview", () => loadDonations().then((m) => m.getDonationsOverview("2024-25", 25)), "getDonationsOverview", EMPTY_OVERVIEW],
    ["donors", () => loadDonations().then((m) => m.listTopDonors({ financialYear: "2024-25" })), "listTopDonors", EMPTY_DONORS],
    ["party", () => loadDonations().then((m) => m.listPartyFunding("Liberal", "2024-25")), "listPartyFunding", EMPTY_PARTY],
  ])(
    "%s treats a well-formed but empty cache entry as a miss and refetches",
    async (_name, run, method, empty) => {
      getCachedMock.mockResolvedValue(empty);

      await run();

      expect(clientMock[method as keyof typeof clientMock]).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["overview", () => loadDonations().then((m) => m.getDonationsOverview("2024-25", 25)), "getDonationsOverview", EMPTY_OVERVIEW],
    ["donors", () => loadDonations().then((m) => m.listTopDonors({ financialYear: "2024-25" })), "listTopDonors", EMPTY_DONORS],
    ["party", () => loadDonations().then((m) => m.listPartyFunding("Liberal", "2024-25")), "listPartyFunding", EMPTY_PARTY],
  ])("%s never writes an empty response to the cache", async (_name, run, method, empty) => {
    (clientMock[method as keyof typeof clientMock] as jest.Mock).mockResolvedValue(empty);

    await run();

    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("writes a populated response under the 24h register TTL", async () => {
    const { POLITICIANS_TTL } = jest.requireActual(
      "@/lib/kv-cache",
    ) as typeof import("@/lib/kv-cache");
    const { getDonationsOverview } = await loadDonations();

    await getDonationsOverview("2024-25", 25);

    expect(setCachedMock).toHaveBeenCalledWith(
      "cache:politicians:donations:overview:2024-25:25",
      expect.objectContaining({ financialYear: "2024-25" }),
      POLITICIANS_TTL,
    );
  });

  it("serves a populated cache entry without calling the rpc", async () => {
    getCachedMock.mockResolvedValue(OVERVIEW);
    const { getDonationsOverview } = await loadDonations();

    const result = await getDonationsOverview("2024-25", 25);

    expect(clientMock.getDonationsOverview).not.toHaveBeenCalled();
    expect(result?.parties).toHaveLength(1);
  });

  it("does nothing at all during a build prerender", async () => {
    process.env.SKIP_STATIC_GENERATION = "1";
    process.env.NEXT_PHASE = "phase-production-build";
    const { getDonationsOverview } = await loadDonations();

    expect(await getDonationsOverview("2024-25", 25)).toBeUndefined();
    expect(clientMock.getDonationsOverview).not.toHaveBeenCalled();
  });
});

describe("member funding read path", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv, SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app" };
    delete process.env.SKIP_STATIC_GENERATION;
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    getCachedMock.mockResolvedValue(null);
    setCachedMock.mockResolvedValue(true);
    clientMock.getPoliticianFunding.mockResolvedValue(MEMBER);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("normalises the slug into the key the way the handler normalises it", async () => {
    const getPoliticianFunding = await loadMemberFunding();

    // Two spellings of ONE member must be one entry: two keys give one link a
    // warm cache and the other a miss, and a flush that clears one leaves the
    // other serving pre-flush figures.
    await getPoliticianFunding("  Helen-Haines ");

    expect(getCachedMock).toHaveBeenCalledWith("cache:politicians:funding:helen-haines");
  });

  it("treats a member with no linked return as a miss, never a cached silence", async () => {
    getCachedMock.mockResolvedValue(EMPTY_MEMBER);
    const getPoliticianFunding = await loadMemberFunding();

    await getPoliticianFunding("helen-haines");

    expect(clientMock.getPoliticianFunding).toHaveBeenCalledTimes(1);
  });

  it("never caches an empty response, so a kill switch cannot outlive itself", async () => {
    clientMock.getPoliticianFunding.mockResolvedValue(EMPTY_MEMBER);
    const getPoliticianFunding = await loadMemberFunding();

    const result = await getPoliticianFunding("helen-haines");

    expect(setCachedMock).not.toHaveBeenCalled();
    // And it returns the empty response rather than throwing, so the section
    // simply renders nothing.
    expect(result?.annualReturns).toEqual([]);
  });

  it("does nothing without a slug, and nothing during a build prerender", async () => {
    const getPoliticianFunding = await loadMemberFunding();
    expect(await getPoliticianFunding("")).toBeUndefined();
    expect(clientMock.getPoliticianFunding).not.toHaveBeenCalled();

    jest.resetModules();
    process.env.SKIP_STATIC_GENERATION = "1";
    process.env.NEXT_PHASE = "phase-production-build";
    const duringBuild = await loadMemberFunding();
    expect(await duringBuild("helen-haines")).toBeUndefined();
    expect(clientMock.getPoliticianFunding).not.toHaveBeenCalled();
  });
});
