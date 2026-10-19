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
