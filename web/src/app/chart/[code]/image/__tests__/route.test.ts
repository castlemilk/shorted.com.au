/**
 * @jest-environment node
 */
/**
 * The card route, with the real loader. Only the data reads, the stock read,
 * the logo fetch and the image renderer are stood in for, so the cache header
 * is decided by what the loader actually reports (complete, resolved, the
 * dates read), not by a mocked answer.
 */
const mockShorts = jest.fn();
const mockPrices = jest.fn();
jest.mock("../chart-data", () => ({
  getChartShorts: (...args: unknown[]) => mockShorts(...args),
  getChartPrices: (...args: unknown[]) => mockPrices(...args),
  withTimeout: (promise: Promise<unknown>, _ms: number, fallback: unknown) =>
    promise.catch(() => fallback),
}));
const mockGetStock = jest.fn();
jest.mock("~/app/actions/getStock", () => ({
  getStock: (code: string) => mockGetStock(code),
}));
const mockLogo = jest.fn();
jest.mock("~/@/lib/og/card", () => ({
  OG_SIZE: { width: 1200, height: 630 },
  NO_LOGO: { src: "", aspect: 1 },
  getOgLogo: async () => "logo.png",
  getCompanyLogo: (url: string | undefined) => mockLogo(url),
}));
jest.mock("~/@/lib/og/chart-card", () => ({ OgChartCard: () => null }));

const rendered: Array<{ card: { props: Record<string, unknown> }; options: { headers: Record<string, string> } }> = [];
jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(card: unknown, options: { headers: Record<string, string> }) {
      rendered.push({ card: card as never, options });
    }
  },
}));

import { GET } from "../route";

const CACHE_SETTLED = "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400";
const CACHE_COMPLETE = "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";
const CACHE_INCOMPLETE = "public, max-age=60, s-maxage=300";

const DAY = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const points = (...days: string[]) => days.map((d, i) => ({ t: DAY(d), v: i + 1 }));
const WITH_LOGO = { name: "BHP GROUP LTD", logoUrl: "https://storage.googleapis.com/logo.png" };

function request(query: string) {
  return GET(
    { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as Parameters<typeof GET>[0],
    { params: Promise.resolve({ code: "BHP" }) },
  );
}

const last = () => rendered[rendered.length - 1]!;

beforeEach(() => {
  rendered.length = 0;
  mockShorts.mockReset().mockResolvedValue(points("2026-10-27", "2026-10-28"));
  mockPrices.mockReset().mockResolvedValue(points("2026-11-02", "2026-11-03"));
  mockGetStock.mockReset().mockResolvedValue(WITH_LOGO);
  mockLogo.mockReset().mockResolvedValue({ src: "data:image/png;base64,AA", aspect: 1 });
  // 10:00 on 4 Nov 2026 in Sydney.
  jest.useFakeTimers({ now: new Date("2026-11-03T23:00:00Z") });
});

afterEach(() => {
  jest.useRealTimers();
});

const SETTLED_QUERY = "view=combined&period=3m&asof=2026-10-20&prices=2026-10-19&shorts=2026-10-14";
const RECENT_QUERY = "view=combined&period=3m&asof=2026-11-04&prices=2026-11-03&shorts=2026-10-28";

describe("GET /chart/[code]/image: the cache policy the loader decides", () => {
  it("holds a complete, resolved, settled chart kept as posted for a month", async () => {
    await request(SETTLED_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_SETTLED);
    expect(last().options.headers["x-chart-card"]).toBe("complete");
  });

  it("holds a settled card for a company with no logo URL, which has none for good", async () => {
    mockGetStock.mockResolvedValue({ name: "BHP GROUP LTD" });
    mockLogo.mockResolvedValue({ src: "", aspect: 1 });
    await request(SETTLED_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_SETTLED);
  });

  it("does not hold a settled card for a month when the name did not read", async () => {
    mockGetStock.mockResolvedValue(undefined);
    await request(SETTLED_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("does not hold a settled card for a month when a fetchable logo failed", async () => {
    mockLogo.mockResolvedValue({ src: "", aspect: 1 });
    await request(SETTLED_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("does not hold a settled card for a month when the logo read threw", async () => {
    mockLogo.mockRejectedValue(new Error("network"));
    await request(SETTLED_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("gives a recent chart (its shorts newer than eight days) the live complete policy", async () => {
    await request(RECENT_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("gives a chart posted in the last two days the live complete policy, whatever its shorts", async () => {
    await request("asof=2026-11-03&prices=2026-11-02&shorts=2026-10-01");
    expect(last().options.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("gives a live complete card the live complete policy", async () => {
    await request("view=combined&period=1m");
    expect(last().options.headers["cache-control"]).toBe(CACHE_COMPLETE);
  });

  it("holds an incomplete settled card for minutes, not a month", async () => {
    mockShorts.mockResolvedValue([]);
    await request(SETTLED_QUERY);
    expect(last().options.headers["cache-control"]).toBe(CACHE_INCOMPLETE);
    expect(last().options.headers["x-chart-card"]).toBe("partial");
  });
});

describe("GET /chart/[code]/image: the dates the card read", () => {
  it("sends the newest close and the newest short report of an anchored card", async () => {
    await request(RECENT_QUERY);
    expect(last().options.headers["x-chart-prices-through"]).toBe("2026-11-03");
    expect(last().options.headers["x-chart-shorts-through"]).toBe("2026-10-28");
  });

  it("sends the dates for a short-view card too, since the bot needs both", async () => {
    await request("view=short&asof=2026-11-04&prices=2026-11-03&shorts=2026-10-28");
    expect(last().options.headers["x-chart-prices-through"]).toBe("2026-11-03");
    expect(last().options.headers["x-chart-shorts-through"]).toBe("2026-10-28");
  });

  it("omits a date whose read came back empty", async () => {
    mockPrices.mockResolvedValue([]);
    await request(RECENT_QUERY);
    expect(last().options.headers).not.toHaveProperty("x-chart-prices-through");
    expect(last().options.headers["x-chart-shorts-through"]).toBe("2026-10-28");
  });

  it("sends no dates for a live card", async () => {
    await request("view=combined&period=1m");
    expect(last().options.headers).not.toHaveProperty("x-chart-prices-through");
    expect(last().options.headers).not.toHaveProperty("x-chart-shorts-through");
  });
});

describe("GET /chart/[code]/image: what the anchor selects", () => {
  it("reads the anchored windows for an anchored card and the live ones otherwise", async () => {
    await request(RECENT_QUERY);
    expect(mockShorts.mock.calls[0]![2]).toEqual({
      day: "2026-11-04",
      prices: "2026-11-03",
      shorts: "2026-10-28",
    });
    await request("view=combined&period=3m");
    expect(mockShorts.mock.calls[1]![2]).toBeUndefined();
  });

  it("draws the period as posted for an anchored card", async () => {
    await request(RECENT_QUERY);
    expect(last().card.props.periodPhrase).toBe("3 months to 4 Nov 2026");
  });
});
