import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const mockGetStockOwnership = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockOwnership: (...args: unknown[]) => mockGetStockOwnership(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/ownership_pb", () => ({ OwnershipService: {} }));

type CacheCall = [() => Promise<unknown>, string[], { revalidate: number; tags: string[] }];
const cacheCalls: CacheCall[] = [];
jest.mock("next/cache", () => ({
  unstable_cache: (
    loader: () => Promise<unknown>,
    key: string[],
    opts: { revalidate: number; tags: string[] },
  ) => {
    cacheCalls.push([loader, key, opts]);
    return loader;
  },
}));

import { createConnectTransport } from "@connectrpc/connect-web";
import {
  REGISTER_STRIP_TIMEOUT_MS,
  getStockRegisterStrip,
  mapStockRegisterStrip,
} from "../getStockRegisterStrip";
import { SERVER_SHORTS_API_URL, serverFetchOutsideNextCache } from "../config";

/** Four current holders, as GetStockOwnership answers one stock. */
function ownershipResponse() {
  return {
    asOf: "2026-10-30",
    summary: {
      stockCode: "BHP",
      holders: 4,
      disclosedPct: 25.81,
      byKind: [
        { kind: "investors", pct: 9.1, holders: 2 },
        { kind: "bank_broker", pct: 6.5, holders: 1 },
        { kind: "corporate", pct: 5.2, holders: 1 },
        { kind: "other", pct: 5.01, holders: 1 },
      ],
      hasIndexPct: true,
      indexPct: 6.004,
      indexAsAtFrom: "2026-09-30",
      indexAsAtTo: "2026-10-29",
    },
    holders: [
      {
        holderKey: "asx:SFR",
        holderName: "Swift TV",
        institutionSlug: "",
        kind: "corporate",
        votingPowerPct: 5.2,
        eventDate: "",
        announcedOn: "2026-10-01",
      },
      {
        holderKey: "blackrock",
        holderName: "BlackRock Investment Management",
        institutionSlug: "blackrock",
        kind: "investors",
        votingPowerPct: 9.1,
        eventDate: "2026-10-20",
        announcedOn: "2026-10-21",
      },
      {
        holderKey: "mufg",
        holderName: "MUFG Securities",
        institutionSlug: "",
        kind: "bank_broker",
        votingPowerPct: 6.5,
        eventDate: "",
        announcedOn: "2026-02-01",
      },
      {
        holderKey: "small",
        holderName: "",
        institutionSlug: "",
        kind: "other",
        votingPowerPct: 5.01,
        eventDate: "",
        announcedOn: "",
      },
    ],
  };
}

describe("mapStockRegisterStrip", () => {
  it("maps the summary's figures and the three largest holders by voting power", () => {
    expect(mapStockRegisterStrip("BHP", ownershipResponse())).toEqual({
      stockCode: "BHP",
      holders: 4,
      interests: 5,
      disclosed: "25.81%",
      indexPct: "6.00",
      indexAsAtFrom: "2026-09-30",
      indexAsAtTo: "2026-10-29",
      asOf: "2026-10-30",
      rows: [
        {
          name: "BlackRock Investment Management",
          href: "/ownership/blackrock",
          kind: "investors",
          votingPower: "9.10%",
          asAt: "2026-10-20",
          age: "",
        },
        {
          name: "MUFG Securities",
          href: null,
          kind: "bank_broker",
          votingPower: "6.50%",
          asAt: "2026-02-01",
          age: "9 mo",
        },
        {
          name: "Swift TV",
          href: "/shorts/SFR/company",
          kind: "corporate",
          votingPower: "5.20%",
          asAt: "2026-10-01",
          age: "",
        },
      ],
    });
  });

  it("resolves null when no holder is current: a real answer", () => {
    expect(
      mapStockRegisterStrip("BHP", { ...ownershipResponse(), holders: [] }),
    ).toBeNull();
  });

  it("throws without a summary, so an empty answer is never cached", () => {
    expect(() =>
      mapStockRegisterStrip("BHP", { ...ownershipResponse(), summary: undefined }),
    ).toThrow("ownership summary missing for BHP");
  });

  it("names an unnamed holder, prints n/a for an unstated sum and no index figure", () => {
    const strip = mapStockRegisterStrip("BHP", {
      asOf: "2026-10-30",
      summary: {
        holders: 1,
        byKind: [{ kind: "other", holders: 1 }],
        hasIndexPct: false,
        indexPct: 0,
      },
      holders: [
        {
          holderKey: "small",
          holderName: " ",
          institutionSlug: "",
          kind: "other",
          votingPowerPct: 7,
          eventDate: "2026-10-29",
          announcedOn: "",
        },
      ],
    });
    expect(strip).toMatchObject({
      disclosed: "n/a",
      indexPct: null,
      rows: [{ name: "Unnamed holder", href: null, votingPower: "7.00%", age: "" }],
    });
  });
});

describe("getStockRegisterStrip", () => {
  beforeEach(() => {
    cacheCalls.length = 0;
    mockGetStockOwnership.mockReset();
    jest.clearAllMocks();
  });

  it("caches under ['stock-register-strip', code, 'v1'] for an hour, tagged for the strip and never 'ownership'", async () => {
    mockGetStockOwnership.mockResolvedValue(ownershipResponse());
    await getStockRegisterStrip("bhp");

    const [, key, opts] = cacheCalls.find(([, k]) => k[0] === "stock-register-strip")!;
    expect(key).toEqual(["stock-register-strip", "BHP", "v1"]);
    expect(opts.revalidate).toBe(3600);
    expect(opts.tags).toEqual(["shorts-data", "stock-page:register-strip:bhp"]);
    expect(opts.tags).not.toContain("ownership");
  });

  it("reads over serverFetchOutsideNextCache for the stock, with a 4 s abort", async () => {
    mockGetStockOwnership.mockResolvedValue(ownershipResponse());
    await getStockRegisterStrip("BHP");

    expect(createConnectTransport).toHaveBeenCalledWith({
      fetch: serverFetchOutsideNextCache,
      baseUrl: SERVER_SHORTS_API_URL,
    });
    const [request, callOptions] = mockGetStockOwnership.mock.calls[0] as [
      unknown,
      { signal: AbortSignal; timeoutMs: number },
    ];
    expect(request).toEqual({ stockCode: "BHP" });
    expect(callOptions.signal).toBeInstanceOf(AbortSignal);
    expect(callOptions.timeoutMs).toBe(REGISTER_STRIP_TIMEOUT_MS);
    expect(REGISTER_STRIP_TIMEOUT_MS).toBe(4000);
  });

  it("aborts a call that outlives 4 s", async () => {
    jest.useFakeTimers();
    try {
      mockGetStockOwnership.mockImplementation(
        (_req: unknown, { signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = getStockRegisterStrip("BHP");
      const assertion = expect(pending).rejects.toThrow("aborted");
      await jest.advanceTimersByTimeAsync(REGISTER_STRIP_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("throws inside the cache on a failed read, so nothing failed is cached", async () => {
    mockGetStockOwnership.mockRejectedValue(new Error("unimplemented"));
    await expect(getStockRegisterStrip("BHP")).rejects.toThrow("unimplemented");

    const [loader] = cacheCalls.find(([, k]) => k[0] === "stock-register-strip")!;
    await expect(loader()).rejects.toThrow("unimplemented");
  });

  it("throws through the cache when the answer carries no summary", async () => {
    mockGetStockOwnership.mockResolvedValue({ holders: [] });
    await expect(getStockRegisterStrip("BHP")).rejects.toThrow(
      "ownership summary missing for BHP",
    );
  });

  it("resolves null through the cache when no holder is current", async () => {
    mockGetStockOwnership.mockResolvedValue({ ...ownershipResponse(), holders: [] });
    await expect(getStockRegisterStrip("BHP")).resolves.toBeNull();
  });

  it("reads no KV entry: the module imports no cache helper", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "getStockRegisterStrip.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/kv-cache|getCached|setCached|CACHE_KEYS/);
  });
});
