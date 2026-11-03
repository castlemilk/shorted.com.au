/**
 * The chart share page exists to unfurl: a link pasted into Discord, Slack, X
 * or LinkedIn shows its card. So the card must be the chart (./image) at the
 * view and period in the link, the page must stay out of the index, and a
 * stock read that fails must not cost the card.
 */
const mockGetStock = jest.fn();
jest.mock("~/app/actions/getStock", () => ({
  getStock: (code: string) => mockGetStock(code),
}));
// The page body is a client island; metadata is all this file is about.
jest.mock("../chart-share-view", () => ({ ChartShareView: () => null }));

const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));

import ChartSharePage, { generateMetadata } from "../page";

const props = (code: string, query: Record<string, string> = {}) => ({
  params: Promise.resolve({ code }),
  searchParams: Promise.resolve(query),
});

beforeEach(() => {
  mockGetStock.mockReset();
  mockGetStock.mockResolvedValue({
    name: "WEEBIT NANO LTD",
    percentageShorted: 3.21,
  });
});

describe("chart share page metadata", () => {
  it("names the chart and uses the chart itself as the card", async () => {
    const m = await generateMetadata(
      props("wbt", { view: "combined", period: "1m" }),
    );
    expect(m.title).toBe(
      "WBT share price and short interest chart, past month",
    );
    expect(m.description).toContain("(ASX:WBT)");
    expect(m.description).toContain(
      "ASIC short position reports and end-of-day ASX prices",
    );
    const og = m.openGraph as { url: string; images: { url: string }[] };
    expect(og.url).toBe(
      "https://shorted.com.au/chart/WBT?view=combined&period=1m",
    );
    expect(og.images[0]!.url).toBe(
      "https://shorted.com.au/chart/WBT/image?view=combined&period=1m",
    );
    const tw = m.twitter as { card: string; images: { url: string }[] };
    expect(tw.card).toBe("summary_large_image");
    expect(tw.images[0]!.url).toBe(og.images[0]!.url);
  });

  it("is noindex but followed", async () => {
    const m = await generateMetadata(props("BHP"));
    expect(m.robots).toMatchObject({ index: false, follow: true });
  });

  it("keeps its card when the stock read fails", async () => {
    mockGetStock.mockRejectedValue(new Error("upstream"));
    const m = await generateMetadata(props("BHP", { period: "6m" }));
    expect(m.title).toBe("BHP short interest chart, past 6 months");
    expect(m.description).toContain("ASX:BHP");
    expect((m.openGraph as { images: { url: string }[] }).images[0]!.url).toBe(
      "https://shorted.com.au/chart/BHP/image?period=6m",
    );
  });

  it("is a 404 for a path that is not a stock code", async () => {
    await expect(ChartSharePage(props("not-a-code"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    const m = await generateMetadata(props("not-a-code"));
    expect(m.openGraph).toBeUndefined();
  });
});

describe("chart share page metadata, kept as posted", () => {
  const pinned = {
    view: "combined",
    period: "3m",
    asof: "2026-11-04",
    shorts: "2026-10-29",
  };
  // Today (Sydney) is 4 Nov, so a chart posted that day is not in the future.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-11-04T02:00:00Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("names the period as posted, and drops the daily promise", async () => {
    const m = await generateMetadata(props("WBT", pinned));
    expect(m.title).toBe(
      "WBT share price and short interest chart, 3 months to 4 Nov 2026",
    );
    expect(m.description).toContain("3 months to 4 Nov 2026");
    expect(m.description).toContain("The chart as posted on 4 Nov 2026.");
    expect(m.description).not.toContain("Updated daily.");
  });

  it("points the link and the card at the pinned chart", async () => {
    const m = await generateMetadata(props("WBT", pinned));
    const og = m.openGraph as { url: string; images: { url: string }[] };
    expect(og.url).toContain("https://shorted.com.au/chart/WBT?");
    expect(og.url).toContain("asof=2026-11-04");
    expect(og.url).toContain("shorts=2026-10-29");
    expect(og.images[0]!.url).toContain("https://shorted.com.au/chart/WBT/image?");
    expect(og.images[0]!.url).toContain("asof=2026-11-04");
    const tw = m.twitter as { images: { url: string }[] };
    expect(tw.images[0]!.url).toBe(og.images[0]!.url);
  });

  it("is live for a chart dated after today", async () => {
    const m = await generateMetadata(
      props("WBT", { view: "combined", period: "3m", asof: "2026-11-05" }),
    );
    expect(m.title).toBe("WBT share price and short interest chart, past 3 months");
  });

  it("keeps a live page's title, description and links unchanged", async () => {
    const m = await generateMetadata(props("WBT", { view: "combined", period: "3m" }));
    expect(m.title).toBe("WBT share price and short interest chart, past 3 months");
    expect(m.description).toContain("Updated daily.");
    expect(m.description).not.toContain("as posted");
    const og = m.openGraph as { url: string };
    expect(og.url).not.toContain("asof=");
  });
});

