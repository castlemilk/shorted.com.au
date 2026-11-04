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

import { auth } from "~/server/auth";
import { getSignalsForViewer } from "../viewer";

const mockAuth = auth as unknown as jest.Mock;
const SIGNED_IN = { user: { id: "u1", email: "trader@example.com" } };

/** A wire pick, the shape the API answers with. */
function wirePick(index: number) {
  return {
    rank: index + 1,
    stockCode: `C${index}`,
    companyName: `Company ${index}`,
    status: index < 2 ? "triggered" : "setup",
    score: 50,
    rules: [],
  };
}

function page(start: number, count: number, total: number) {
  return {
    picks: Array.from({ length: count }, (_, i) => wirePick(start + i)),
    totalCount: total,
    statusCounts: { triggered: 2, setup: total - 2, watch: 0, unknown: 0 },
  };
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
  });

  it("answers signed-out without calling the API", async () => {
    mockAuth.mockResolvedValue(null);
    expect(
      await getSignalsForViewer({ strategyId: "crowded-short-breakout" }),
    ).toEqual({ ok: false, reason: "signed-out" });
    expect(mockClient.getViewerStrategyPicks).not.toHaveBeenCalled();
  });

  it("refuses a malformed strategy id or sort key without calling the API", async () => {
    expect(
      await getSignalsForViewer({ strategyId: "../etc/passwd" }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await getSignalsForViewer({
        strategyId: "canslim",
        sortBy: "name" as never,
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(mockClient.getViewerStrategyPicks).not.toHaveBeenCalled();
  });

  it("reads the full list through the private RPC, with identity and no address", async () => {
    mockClient.getViewerStrategyPicks.mockResolvedValueOnce(page(0, 3, 3));

    const result = await getSignalsForViewer({
      strategyId: "crowded-short-breakout",
      sortBy: "roe",
    });

    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(1);
    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledWith({
      strategyId: "crowded-short-breakout",
      limit: 100,
      offset: 0,
      status: "",
      sortBy: "roe",
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

    const headers = await headersSentToTheAPI();
    expect(headers["x-user-id"]).toBe("u1");
    expect(headers).not.toHaveProperty("x-user-email");
    expect(headers).not.toHaveProperty("x-user-email-verified");
    expect(mockLookupAccount).not.toHaveBeenCalled();
  });

  it("pages until the whole list is read, at the same sort", async () => {
    mockClient.getViewerStrategyPicks
      .mockResolvedValueOnce(page(0, 100, 150))
      .mockResolvedValueOnce(page(100, 50, 150));

    const result = await getSignalsForViewer({
      strategyId: "canslim",
      sortBy: "",
    });

    expect(mockClient.getViewerStrategyPicks).toHaveBeenCalledTimes(2);
    expect(mockClient.getViewerStrategyPicks.mock.calls[1]![0]).toMatchObject({
      offset: 100,
      sortBy: "",
    });
    expect(result.ok && result.rows).toHaveLength(150);
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
      expect(
        await getSignalsForViewer({ strategyId: "canslim" }),
      ).toEqual({ ok: false, reason: "unavailable" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "trader@example.com",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("viewer.ts keeps per-viewer data out of shared caches", () => {
  const source = readFileSync(join(__dirname, "..", "viewer.ts"), "utf8");
  const imports = source
    .split("\n")
    .filter((line) => /^\s*(import|export .* from)\b/.test(line) || /from "/.test(line));

  it("imports neither unstable_cache nor a KV or Redis helper", () => {
    const specs = imports.join("\n");
    expect(specs).not.toMatch(/unstable_cache/);
    expect(specs).not.toMatch(/next\/cache/);
    expect(specs).not.toMatch(/\bkv\b|upstash|redis/i);
    expect(imports.length).toBeGreaterThan(0);
  });
});
