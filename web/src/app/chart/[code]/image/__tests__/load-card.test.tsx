/**
 * The card's data: a chart reads only the series its view draws, anchored or
 * not, as the live card always did. The card is complete when the view's own
 * series arrived, and resolved only when the site logo, the company name and
 * the company's logo (when it has one) all loaded. The reads are stood in for;
 * the card's props and the loader's result are what is checked.
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
const mockSiteLogo = jest.fn();
jest.mock("~/@/lib/og/card", () => ({
  NO_LOGO: { src: "", aspect: 1 },
  getOgLogo: () => mockSiteLogo(),
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
const NAMED = {
  name: "BHP GROUP LTD",
  logoUrl: "https://storage.googleapis.com/logo.png",
};
const LOADED_LOGO = { src: "data:image/png;base64,AA", aspect: 1 };
const NO_LOGO_VALUE = { src: "", aspect: 1 };
// The card's props are the card's own; read loosely here.
function props(el: unknown): Record<string, any> {
  return (el as ReactElement<Record<string, any>>).props;
}

beforeEach(() => {
  mockShorts.mockReset().mockResolvedValue(series("2026-10-27", "2026-10-28"));
  mockPrices.mockReset().mockResolvedValue(series("2026-11-02", "2026-11-03"));
  mockGetStock.mockReset().mockResolvedValue(NAMED);
  mockLogo.mockReset().mockResolvedValue(LOADED_LOGO);
  mockSiteLogo.mockReset().mockResolvedValue("data:image/png;base64,SITE");
});

describe("loadChartCard: reads only what the view draws", () => {
  it("reads only the short series in the short view, with no anchor", async () => {
    const { card, complete } = await loadChartCard(
      { code: "BHP", view: "short", period: "3m" },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", undefined);
    expect(mockPrices).not.toHaveBeenCalled();
    expect(complete).toBe(true);
    expect(props(card).periodPhrase).toBe("past 3 months");
  });

  it("reads only the prices in the price view, anchored", async () => {
    const { card, complete } = await loadChartCard(
      { code: "BHP", view: "price", period: "1m", anchor },
      1000,
    );
    expect(mockPrices).toHaveBeenCalledWith("BHP", "1m", anchor);
    expect(mockShorts).not.toHaveBeenCalled();
    expect(complete).toBe(true);
    expect(props(card).short).toEqual([]);
    expect(props(card).price.length).toBe(2);
  });

  it("reads only the shorts in the short view, anchored, and draws them", async () => {
    const { card, complete } = await loadChartCard(
      { code: "BHP", view: "short", period: "3m", anchor },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", anchor);
    expect(mockPrices).not.toHaveBeenCalled();
    expect(complete).toBe(true);
    expect(props(card).price).toEqual([]);
    expect(props(card).short.length).toBe(2);
  });

  it("reads both series in the combined view, anchored", async () => {
    await loadChartCard({ code: "BHP", view: "combined", period: "3m", anchor }, 1000);
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", anchor);
    expect(mockPrices).toHaveBeenCalledWith("BHP", "3m", anchor);
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
  it("is incomplete when the view's own series is empty", async () => {
    mockPrices.mockResolvedValue([]);
    const { complete } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(complete).toBe(false);
  });

  it("is complete in the short view, which never reads the prices", async () => {
    mockPrices.mockResolvedValue([]);
    const { complete } = await loadChartCard(
      { code: "BHP", view: "short", period: "1m", anchor },
      1000,
    );
    expect(complete).toBe(true);
  });
});

describe("loadChartCard: resolved (may the card be held for a month)", () => {
  it("is resolved when the site logo, the name and the company logo all loaded", async () => {
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(true);
  });

  it("is not resolved when the site logo did not load", async () => {
    mockSiteLogo.mockResolvedValue("");
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(false);
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
    mockLogo.mockResolvedValue(NO_LOGO_VALUE);
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(true);
  });

  it("is resolved for a logo URL we never fetch: it can never be read", async () => {
    mockGetStock.mockResolvedValue({
      name: "BHP GROUP LTD",
      logoUrl: "http://evil.example/x.png",
    });
    mockLogo.mockResolvedValue(NO_LOGO_VALUE);
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(true);
  });

  it("is not resolved when a fetchable logo came back empty: that is a failure", async () => {
    mockLogo.mockResolvedValue(NO_LOGO_VALUE);
    const { resolved } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(false);
  });

  it("is not resolved when the logo read threw, and draws no brand", async () => {
    mockLogo.mockRejectedValue(new Error("network"));
    const { resolved, card } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(resolved).toBe(false);
    expect(props(card).brand).toEqual(NO_LOGO_VALUE);
  });
});
