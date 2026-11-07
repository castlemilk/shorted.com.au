import { describe, it, expect, beforeEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const mockListMarketMoves = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    listMarketMoves: (...args: unknown[]) => mockListMarketMoves(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/market_pb", () => ({ MarketService: {} }));

type CacheCall = [
  () => Promise<unknown>,
  string[],
  { revalidate: number; tags: string[] },
];
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
  MARKET_MOVES_TIMEOUT_MS,
  getHomeMarketMoves,
  getMarketMovesFeed,
  getStockMarketMoves,
} from "../getMarketMoves";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
} from "../../config";

function apiMove(overrides: Record<string, unknown> = {}) {
  return {
    moveKey: "2026-11-07:bhp:iron-ore",
    kind: "stock",
    stockCode: "BHP",
    companyName: "BHP Group",
    indexCode: "",
    sector: "",
    relatedCodes: [],
    direction: "up",
    changePct: 4.2,
    hasChangePct: true,
    price: 0,
    hasPrice: false,
    volumeRatio: 0,
    hasVolumeRatio: false,
    headline: "BHP jumps as iron ore rallies",
    summary: "Iron ore futures rose 6% overnight.",
    sources: [],
    tags: [],
    significance: 4,
    observedAt: "2026-11-07T03:05:00Z",
    marketDate: "2026-11-07",
    revision: 1,
    publishedAt: "2026-11-07T03:06:00Z",
    updatedAt: "2026-11-07T03:06:00Z",
    model: "",
    ...overrides,
  };
}

beforeEach(() => {
  cacheCalls.length = 0;
  mockListMarketMoves.mockReset();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("market-moves reads", () => {
  it("read the API through the outside-Next-cache transport with a bounded abort", async () => {
    mockListMarketMoves.mockResolvedValue({ moves: [apiMove()] });
    await getMarketMovesFeed();
    expect(createConnectTransport).toHaveBeenCalledWith({
      fetch: serverFetchOutsideNextCache,
      baseUrl: SERVER_SHORTS_API_URL,
    });
    const [, options] = mockListMarketMoves.mock.calls[0] as [
      unknown,
      { signal: AbortSignal; timeoutMs: number },
    ];
    expect(options.timeoutMs).toBe(MARKET_MOVES_TIMEOUT_MS);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("the feed is cached under the market-moves tag for the page's five minutes", async () => {
    mockListMarketMoves.mockResolvedValue({ moves: [apiMove()] });
    const moves = await getMarketMovesFeed();
    expect(mockListMarketMoves.mock.calls[0]![0]).toEqual({ limit: 50 });
    expect(cacheCalls[0]![1]).toEqual(["market-moves-feed", "v1"]);
    expect(cacheCalls[0]![2]).toEqual({
      revalidate: 300,
      tags: ["market-moves"],
    });
    // Plain data, the figure the poster left out kept as null.
    expect(moves).toHaveLength(1);
    expect(moves![0]!.price).toBeNull();
    expect(moves![0]!.changePct).toBe(4.2);
  });

  it("the feed is undefined, not empty, when the moves cannot be read", async () => {
    mockListMarketMoves.mockRejectedValue(new Error("unavailable"));
    await expect(getMarketMovesFeed()).resolves.toBeUndefined();
  });

  it("an empty feed is a real answer", async () => {
    mockListMarketMoves.mockResolvedValue({ moves: [] });
    await expect(getMarketMovesFeed()).resolves.toEqual([]);
  });

  it("the homepage strip asks for notable moves under its own tag and the homepage's window", async () => {
    mockListMarketMoves.mockResolvedValue({ moves: [apiMove()] });
    await getHomeMarketMoves();
    expect(mockListMarketMoves.mock.calls[0]![0]).toEqual({
      minSignificance: 3,
      limit: 4,
    });
    expect(cacheCalls[0]![1]).toEqual(["market-moves-home", "v1"]);
    expect(cacheCalls[0]![2]).toEqual({
      revalidate: 86400,
      tags: ["market-moves:home"],
    });
  });

  it("the homepage strip hides on any failure", async () => {
    mockListMarketMoves.mockRejectedValue(new Error("deadline exceeded"));
    await expect(getHomeMarketMoves()).resolves.toEqual([]);
  });

  it("a stock's moves are read by code under the stock's tag and the stock page's window", async () => {
    mockListMarketMoves.mockResolvedValue({ moves: [apiMove()] });
    await getStockMarketMoves(" bhp ");
    expect(mockListMarketMoves.mock.calls[0]![0]).toEqual({
      stockCode: "BHP",
      limit: 5,
    });
    expect(cacheCalls[0]![1]).toEqual(["market-moves-stock", "BHP", "v1"]);
    expect(cacheCalls[0]![2]).toEqual({
      revalidate: 3600,
      tags: ["market-moves:stock:BHP"],
    });
  });

  it("a stock read for something that is not a stock code asks nothing", async () => {
    await expect(getStockMarketMoves("not a code")).resolves.toEqual([]);
    expect(mockListMarketMoves).not.toHaveBeenCalled();
  });

  it("a stock read hides on any failure", async () => {
    mockListMarketMoves.mockRejectedValue(new Error("unavailable"));
    await expect(getStockMarketMoves("BHP")).resolves.toEqual([]);
  });

  it("the tags are the ones the API revalidates", () => {
    // services/shorts/internal/services/shorts/market_moves_revalidate.go names
    // these three; renaming one here without the other stops the pings landing.
    const goSource = path.join(
      __dirname,
      "../../../../../../services/shorts/internal/services/shorts/market_moves_revalidate.go",
    );
    if (!fs.existsSync(goSource)) return; // the web package checked out alone
    const go = fs.readFileSync(goSource, "utf8");
    expect(go).toContain('"market-moves"');
    expect(go).toContain('"market-moves:home"');
    expect(go).toContain('"market-moves:stock:"');
  });
});
