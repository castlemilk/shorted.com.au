import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockClient = { getViewerStrategyPicks: jest.fn() };

jest.mock("@connectrpc/connect", () => {
  const actual = jest.requireActual("@connectrpc/connect");
  return { ...actual, createClient: () => mockClient };
});

const mockTransportOptions: {
  current?: { interceptors?: Array<(next: unknown) => unknown> };
} = {};
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (options: {
    interceptors?: Array<(next: unknown) => unknown>;
  }) => {
    mockTransportOptions.current = options;
    return {};
  },
}));

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

const mockLookupAccount = jest.fn(async (_uid: string) => null);
jest.mock("~/server/account-verification", () => ({
  lookupAccountVerification: (uid: string) => mockLookupAccount(uid),
}));

jest.mock("../../config", () => ({
  SHORTS_API_URL: "https://api.test",
  serverFetchWithUserAgent: jest.fn(),
}));

// The shared caches this module must never reach. Each records a call, and the
// behavioural guard below runs the action and asserts none happened.
const mockSharedCache = jest.fn();
jest.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => {
    mockSharedCache("next/cache");
    return fn;
  },
}));
jest.mock("~/@/lib/kv-cache", () => ({
  getCached: (...args: unknown[]) => mockSharedCache("kv-cache", ...args),
  setCached: (...args: unknown[]) => mockSharedCache("kv-cache", ...args),
}));
jest.mock("~/@/lib/cache", () => ({
  memoryCache: {
    get: (...args: unknown[]) => mockSharedCache("memory", ...args),
  },
}));
jest.mock("../../shared-read", () => ({
  sharedRead: (...args: unknown[]) => mockSharedCache("shared-read", ...args),
}));

import { auth } from "~/server/auth";
import { getSignalsForViewer } from "../viewer";

const mockAuth = auth as unknown as jest.Mock;
const SIGNED_IN = { user: { id: "u1", email: "trader@example.com" } };
const ORIGINAL_ENV = { ...process.env };

/** A wire pick, the shape the API answers with. */
function wirePick(index: number, code = `C${index}`) {
  return {
    rank: index + 1,
    stockCode: code,
    companyName: `Company ${index}`,
    status: index < 2 ? "triggered" : "setup",
    score: 50,
    rules: [],
  };
}

const SNAPSHOT = {
  sessionDate: "2026-11-04",
  asOf: "2026-11-04",
  version: { label: "v1", rulesHash: "3f9a1c2e0000", strategyId: "canslim" },
  stale: false,
};

/** One page of a list. The snapshot defaults to the same one for every page. */
function page(
  start: number,
  count: number,
  total: number,
  snapshot: Partial<typeof SNAPSHOT> = {},
) {
  return {
    picks: Array.from({ length: count }, (_, i) => wirePick(start + i)),
    totalCount: total,
    statusCounts: { triggered: 2, setup: total - 2, watch: 0, unknown: 0 },
    ...SNAPSHOT,
    ...snapshot,
  };
}

/** Answers every page of a list of `total` picks, from the request's offset. */
function serveList(total: number, snapshot: Partial<typeof SNAPSHOT> = {}) {
  mockClient.getViewerStrategyPicks.mockImplementation(
    async (request: { offset: number; limit: number }) => {
      const count = Math.max(
        0,
        Math.min(request.limit, total - request.offset),
      );
      return page(request.offset, count, total, snapshot);
    },
  );
}

/** Runs the transport's interceptors over an empty request and returns its headers. */
async function headersSentToTheAPI(): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const req = {
    header: {
      set(name: string, value: string) {
        values[name] = value;
      },
    },
  };
  const interceptors = mockTransportOptions.current?.interceptors ?? [];
  const chain = interceptors.reduceRight<(r: unknown) => unknown>(
    (next, interceptor) => interceptor(next) as (r: unknown) => unknown,
    async (r: unknown) => r,
  );
  await chain(req);
  return values;
}

describe("getSignalsForViewer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue(SIGNED_IN);
    process.env.INTERNAL_SERVICE_SECRET = "test-secret";
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("answers signed-out without calling the API", async () => {
    mockAuth.mockResolvedValue(null);
    expect(
      await getSignalsForViewer({ strategyId: "crowded-short-breakout" }),
    ).toEqual({
      ok: false,
      reason: "signed-out",
    });
    expect(mockClient.getViewerStrategyPicks).not.toHaveBeenCalled();
  });

  it("refuses a malformed strategy id without calling the API", async () => {
    expect(await getSignalsForViewer({ strategyId: "../etc/passwd" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(mockClient.getViewerStrategyPicks).not.toHaveBeenCalled();
  });

  it("reads the list once, in rank order, with identity and no address", async () => {
    serveList(3);
    const result = await getSignalsForViewer({
      strategyId: "crowded-short-breakout",
    });

    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(1);
    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledWith({
      strategyId: "crowded-short-breakout",
      limit: 100,
      offset: 0,
      status: "",
      sortBy: "",
      requireFundamentals: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.code)).toEqual(["C0", "C1", "C2"]);
    expect(result.totalCount).toBe(3);
    expect(result.statusCounts).toEqual({
      triggered: 2,
      setup: 1,
      watch: 0,
      unknown: 0,
    });
    expect(result.snapshot).toMatchObject({
      sessionDate: "2026-11-04",
      asOf: "2026-11-04",
      stale: false,
      version: { rulesHash: "3f9a1c2e0000" },
    });

    const headers = await headersSentToTheAPI();
    expect(headers["x-user-id"]).toBe("u1");
    expect(headers).not.toHaveProperty("x-user-email");
    expect(headers).not.toHaveProperty("x-user-email-verified");
    expect(mockLookupAccount).not.toHaveBeenCalled();
  });

  it("pages until the whole list is read", async () => {
    serveList(150);
    const result = await getSignalsForViewer({ strategyId: "canslim" });

    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(2);
    expect(mockClient.getViewerStrategyPicks.mock.calls[1]![0]).toMatchObject({
      offset: 100,
      sortBy: "",
    });
    expect(result.ok && result.rows).toHaveLength(150);
  });

  it("reads a list longer than 1,000 rows in full", async () => {
    // The minervini list in production is 1,601 picks: every row must be read.
    serveList(1601);
    const result = await getSignalsForViewer({
      strategyId: "minervini-trend-template",
    });

    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(17);
    expect(result.ok && result.totalCount).toBe(1601);
    expect(result.ok && result.rows).toHaveLength(1601);
    expect(result.ok && result.rows.at(-1)?.code).toBe("C1600");
  });

  it("keeps the first copy of a code that a later page repeats", async () => {
    mockClient.getViewerStrategyPicks
      .mockResolvedValueOnce(page(0, 100, 150))
      .mockResolvedValueOnce({
        ...page(100, 0, 150),
        picks: [wirePick(5, "C5"), wirePick(100, "C100")],
      })
      .mockResolvedValueOnce(page(102, 48, 150));
    const result = await getSignalsForViewer({ strategyId: "canslim" });

    expect(mockClient.getViewerStrategyPicks.mock.calls[1]![0]).toMatchObject({
      offset: 100,
    });
    expect(mockClient.getViewerStrategyPicks.mock.calls[2]![0]).toMatchObject({
      offset: 102,
    });
    expect(result.ok && result.rows).toHaveLength(149);
  });

  it("reads again when the pages come from two snapshots, then answers", async () => {
    mockClient.getViewerStrategyPicks
      .mockResolvedValueOnce(page(0, 100, 150))
      .mockResolvedValueOnce(page(100, 50, 150, { sessionDate: "2026-11-05" }))
      .mockResolvedValueOnce(page(0, 100, 150, { sessionDate: "2026-11-05" }))
      .mockResolvedValueOnce(page(100, 50, 150, { sessionDate: "2026-11-05" }));
    const result = await getSignalsForViewer({ strategyId: "canslim" });

    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(4);
    expect(result.ok && result.snapshot.sessionDate).toBe("2026-11-05");
    expect(result.ok && result.rows).toHaveLength(150);
  });

  it("answers unavailable when the pages never agree on a snapshot", async () => {
    mockClient.getViewerStrategyPicks
      .mockResolvedValueOnce(page(0, 100, 150))
      .mockResolvedValueOnce(page(100, 50, 150, { sessionDate: "2026-11-05" }))
      .mockResolvedValueOnce(page(0, 100, 150))
      .mockResolvedValueOnce(page(100, 50, 150, { sessionDate: "2026-11-05" }));
    expect(await getSignalsForViewer({ strategyId: "canslim" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("answers unavailable, never a cut-short list, past the read bound", async () => {
    serveList(6000);
    expect(await getSignalsForViewer({ strategyId: "canslim" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(50);
  });

  it("stops when a page comes back empty, so a shrinking list cannot loop", async () => {
    mockClient.getViewerStrategyPicks
      .mockResolvedValueOnce(page(0, 100, 500))
      .mockResolvedValueOnce(page(100, 0, 500));
    const result = await getSignalsForViewer({ strategyId: "canslim" });
    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(2);
    expect(result.ok && result.rows).toHaveLength(100);
  });

  it("reports unavailable, and logs no address, when the API fails", async () => {
    mockClient.getViewerStrategyPicks.mockRejectedValueOnce(new Error("boom"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await getSignalsForViewer({ strategyId: "canslim" })).toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "trader@example.com",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("viewer.ts keeps per-viewer data out of shared caches", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue(SIGNED_IN);
    process.env.INTERNAL_SERVICE_SECRET = "test-secret";
  });

  it("runs a signed-in read without touching any shared cache", async () => {
    serveList(3);
    await getSignalsForViewer({ strategyId: "canslim" });
    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalled();
    expect(mockSharedCache).not.toHaveBeenCalled();
  });

  const source = readFileSync(join(__dirname, "..", "viewer.ts"), "utf8");

  it("names no cache anywhere in its source, not only in its imports", () => {
    expect(source).not.toMatch(
      /next\/cache|unstable_cache|sharedRead|shared-read|kv-cache|getCached|setCached|getOrSetCached|memoryCache|lib\/cache|\bkv\b|upstash|redis/i,
    );
  });

  it("imports only the modules it is allowed to read per-viewer data with", () => {
    const allowed = new Set([
      "@connectrpc/connect",
      "../auth-transport",
      "~/@/lib/strategies/map",
      "~/@/lib/strategies/types",
      "~/gen/shorts/v1alpha1/strategies_pb",
      "~/server/auth",
    ]);
    const specs = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(allowed.has(spec)).toBe(true);
  });
});
