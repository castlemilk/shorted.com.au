/**
 * @jest-environment node
 */
/**
 * The card route's cache policy: a settled, complete, kept-as-posted card may be
 * held for a month at the CDN; a recent one keeps the live policy; an incomplete
 * one is held for minutes, whatever it is.
 */
const mockLoad = jest.fn();
jest.mock("../load-card", () => ({
  loadChartCard: (...args: unknown[]) => mockLoad(...args),
}));

const imageOptions: Array<{ headers: Record<string, string> }> = [];
jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(_card: unknown, options: { headers: Record<string, string> }) {
      imageOptions.push(options);
    }
  },
}));

import { GET } from "../route";

const CACHE_SETTLED = "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400";
const CACHE_COMPLETE = "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";
const CACHE_INCOMPLETE = "public, max-age=60, s-maxage=300";

function request(query: string) {
  return GET(
    { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as Parameters<typeof GET>[0],
    { params: Promise.resolve({ code: "BHP" }) },
  );
}

beforeEach(() => {
  mockLoad.mockReset();
  imageOptions.length = 0;
  // 10:00 on 4 Nov 2026 in Sydney.
  jest.useFakeTimers({ now: new Date("2026-11-03T23:00:00Z") });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("GET /chart/[code]/image cache policy", () => {
  it("holds a complete card of a settled chart kept as posted for a month", async () => {
    mockLoad.mockResolvedValue({ card: null, complete: true });
    await request("view=combined&period=3m&asof=2026-11-02&shorts=2026-10-29");
    expect(imageOptions[0]!.headers["cache-control"]).toBe(CACHE_SETTLED);
    expect(imageOptions[0]!.headers["x-chart-card"]).toBe("complete");
  });

  it("gives a chart posted in the last two days the live complete policy", async () => {
    mockLoad.mockResolvedValue({ card: null, complete: true });
    await request("asof=2026-11-03");
    expect(imageOptions[0]!.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("gives a live complete card the live complete policy", async () => {
    mockLoad.mockResolvedValue({ card: null, complete: true });
    await request("view=combined&period=1m");
    expect(imageOptions[0]!.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("holds an incomplete settled card for minutes, not a month", async () => {
    mockLoad.mockResolvedValue({ card: null, complete: false });
    await request("asof=2026-11-02&shorts=2026-10-29");
    expect(imageOptions[0]!.headers["cache-control"]).toBe(CACHE_INCOMPLETE);
    expect(imageOptions[0]!.headers["x-chart-card"]).toBe("partial");
  });

  it("passes the anchor to the card, and none for a live chart", async () => {
    mockLoad.mockResolvedValue({ card: null, complete: true });
    await request("view=combined&period=3m&asof=2026-11-02&shorts=2026-10-29");
    expect(mockLoad.mock.calls[0]![0]).toEqual({
      code: "BHP",
      view: "combined",
      period: "3m",
      anchor: { day: "2026-11-02", shorts: "2026-10-29" },
    });
    await request("view=combined&period=3m");
    expect(mockLoad.mock.calls[1]![0].anchor).toBeUndefined();
  });
});
