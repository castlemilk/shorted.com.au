/**
 * The card's data: a chart kept as posted reads both anchored windows, draws
 * only what its view needs, and reports the newest dates it read. A live chart
 * reads what its view draws, as it always did. The reads are stood in for; the
 * card's props and the loader's result are what is checked.
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
  NO_LOGO: { src: "", aspect: 1 },
  getOgLogo: async () => "logo.png",
  getCompanyLogo: (url: string | undefined) => mockLogo(url),
}));
jest.mock("~/@/lib/og/chart-card", () => ({ OgChartCard: () => null }));

import type { ReactElement } from "react";
import { loadChartCard } from "../load-card";
import type { ChartAnchor } from "~/@/components/charts/chart-anchor";
import type { SeriesPoint } from "~/@/lib/og/chart-image";

const DAY = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const series = (...days: string[]): SeriesPoint[] =>
  days.map((d, i) => ({ t: DAY(d), v: i + 1 }));
const anchor: ChartAnchor = {
  day: "2026-11-04",
  prices: "2026-11-03",
  shorts: "2026-10-28",
};
const NAMED = { name: "BHP GROUP LTD", logoUrl: "https://storage.googleapis.com/logo.png" };

function props(el: unknown): Record<string, any> {
  return (el as ReactElement<Record<string, any>>).props;
}

beforeEach(() => {
  mockShorts.mockReset().mockResolvedValue(series("2026-10-27", "2026-10-28"));
  mockPrices.mockReset().mockResolvedValue(series("2026-11-02", "2026-11-03"));
  mockGetStock.mockReset().mockResolvedValue(NAMED);
  mockLogo.mockReset().mockResolvedValue({ src: "data:image/png;base64,AA", aspect: 1 });
});

describe("loadChartCard: reads", () => {
  it("reads the live windows only what the view draws, with no anchor", async () => {
    const { card, complete } = await loadChartCard(
      { code: "BHP", view: "short", period: "3m" },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", undefined);
    expect(mockPrices).not.toHaveBeenCalled();
    expect(complete).toBe(true);
    expect(props(card).periodPhrase).toBe("past 3 months");
  });

  it("reads both anchored windows in the short view, and draws only the shorts", async () => {
    const { card, complete, pricesThrough, shortsThrough } = await loadChartCard(
      { code: "BHP", view: "short", period: "3m", anchor },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", anchor);
    expect(mockPrices).toHaveBeenCalledWith("BHP", "3m", anchor);
    expect(complete).toBe(true);
    expect(props(card).price).toEqual([]);
    expect(props(card).short.length).toBe(2);
    expect(pricesThrough).toBe("2026-11-03");
    expect(shortsThrough).toBe("2026-10-28");
  });

  it("reads both anchored windows in the price view, and draws only the prices", async () => {
    const { card, pricesThrough, shortsThrough } = await loadChartCard(
      { code: "BHP", view: "price", period: "1m", anchor },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "1m", anchor);
    expect(props(card).short).toEqual([]);
    expect(props(card).price.length).toBe(2);
    expect(pricesThrough).toBe("2026-11-03");
    expect(shortsThrough).toBe("2026-10-28");
  });

  it("says the period as posted, to the day the chart was posted", async () => {
    const { card } = await loadChartCard(
      { code: "BHP", view: "combined", period: "3m", anchor },
      1000,
    );
    expect(props(card).periodPhrase).toBe("3 months to 4 Nov 2026");
  });
});

describe("loadChartCard: complete", () => {
  it("is incomplete when the view's own series is empty, even if the other arrived", async () => {
    mockPrices.mockResolvedValue([]);
    const { complete } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(complete).toBe(false);
  });

  it("is complete in the short view when the prices never arrived, since the view does not draw them", async () => {
    mockPrices.mockResolvedValue([]);
    const { complete } = await loadChartCard(
      { code: "BHP", view: "short", period: "1m", anchor },
      1000,
    );
    expect(complete).toBe(true);
  });
});

describe("loadChartCard: the dates it read", () => {
  it("reports no dates for a live chart", async () => {
    const result = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m" },
      1000,
    );
    expect(result).not.toHaveProperty("pricesThrough", expect.anything());
    expect(result.pricesThrough).toBeUndefined();
    expect(result.shortsThrough).toBeUndefined();
  });

  it("is undefined for a series whose read came back empty", async () => {
    mockShorts.mockResolvedValue([]);
    const { shortsThrough, pricesThrough } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(shortsThrough).toBeUndefined();
    expect(pricesThrough).toBe("2026-11-03");
  });

  it("is the newest point read, whatever order the points came in", async () => {
    mockPrices.mockResolvedValue(series("2026-11-03", "2026-11-02"));
    const { pricesThrough } = await loadChartCard(
      { code: "BHP", view: "price", period: "1m", anchor },
      1000,
    );
    expect(pricesThrough).toBe("2026-11-03");
  });
});

describe("loadChartCard: resolved (may the card be held for a month)", () => {
  it("is resolved when the name and the company's logo both read", async () => {
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(true);
  });

  it("is not resolved when the name did not read", async () => {
    mockGetStock.mockResolvedValue(undefined);
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(false);
  });

  it("is resolved for a company with no logo URL: it has none for good", async () => {
    mockGetStock.mockResolvedValue({ name: "BHP GROUP LTD" });
    mockLogo.mockResolvedValue({ src: "", aspect: 1 });
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(true);
  });

  it("is resolved for a logo URL we never fetch: it can never be read", async () => {
    mockGetStock.mockResolvedValue({ name: "BHP GROUP LTD", logoUrl: "http://evil.example/x.png" });
    mockLogo.mockResolvedValue({ src: "", aspect: 1 });
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(true);
  });

  it("is not resolved when a fetchable logo came back empty: that is a failure", async () => {
    mockLogo.mockResolvedValue({ src: "", aspect: 1 });
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(false);
  });

  it("is not resolved when the logo read threw", async () => {
    mockLogo.mockRejectedValue(new Error("network"));
    const { resolved, card } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(false);
    expect(props(card).brand).toEqual({ src: "", aspect: 1 });
  });
});
