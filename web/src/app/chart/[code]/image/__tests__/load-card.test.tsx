/**
 * The card's data: a chart kept as posted reads its anchored windows and says
 * its period as posted; a live chart reads the live windows, as it always did.
 * The reads and the drawing are stood in for; the card's props are what is
 * checked.
 */
const mockShorts = jest.fn();
const mockPrices = jest.fn();
jest.mock("../chart-data", () => ({
  getChartShorts: (...args: unknown[]) => mockShorts(...args),
  getChartPrices: (...args: unknown[]) => mockPrices(...args),
  withTimeout: (promise: Promise<unknown>) => promise,
}));
jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn(async () => ({ name: "BHP GROUP LTD", logoUrl: undefined })),
}));
jest.mock("~/@/lib/og/card", () => ({
  NO_LOGO: { kind: "none" },
  getOgLogo: jest.fn(async () => "logo.png"),
  getCompanyLogo: jest.fn(async () => ({ kind: "none" })),
}));
jest.mock("~/@/lib/og/chart-card", () => ({ OgChartCard: () => null }));

import type { ReactElement } from "react";
import { loadChartCard } from "../load-card";
import type { ChartAnchor } from "~/@/components/charts/chart-anchor";
import type { SeriesPoint } from "~/@/lib/og/chart-image";

const series: SeriesPoint[] = [
  { t: 1, v: 1 },
  { t: 2, v: 2 },
];
const anchor: ChartAnchor = { day: "2026-11-04", shorts: "2026-10-29" };

beforeEach(() => {
  mockShorts.mockReset().mockResolvedValue(series);
  mockPrices.mockReset().mockResolvedValue(series);
});

function props(el: unknown) {
  return (el as ReactElement<Record<string, unknown>>).props;
}

describe("loadChartCard", () => {
  it("reads the live windows, and says the period in the present tense, with no anchor", async () => {
    const { card, complete } = await loadChartCard(
      { code: "BHP", view: "combined", period: "3m" },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", undefined);
    expect(mockPrices).toHaveBeenCalledWith("BHP", "3m", undefined);
    expect(complete).toBe(true);
    expect(props(card).periodPhrase).toBe("past 3 months");
  });

  it("reads the anchored windows, and says the period as posted, when pinned", async () => {
    const { card, complete } = await loadChartCard(
      { code: "BHP", view: "combined", period: "3m", anchor },
      1000,
    );
    expect(mockShorts).toHaveBeenCalledWith("BHP", "3m", anchor);
    expect(mockPrices).toHaveBeenCalledWith("BHP", "3m", anchor);
    expect(complete).toBe(true);
    expect(props(card).periodPhrase).toBe("3 months to 4 Nov 2026");
  });

  it("reads only the series its view draws, anchored or not", async () => {
    await loadChartCard({ code: "BHP", view: "price", period: "1m", anchor }, 1000);
    expect(mockShorts).not.toHaveBeenCalled();
    expect(mockPrices).toHaveBeenCalledWith("BHP", "1m", anchor);
  });

  it("is incomplete when a pinned series comes back empty", async () => {
    mockPrices.mockResolvedValue([]);
    const { complete } = await loadChartCard(
      { code: "BHP", view: "combined", period: "1m", anchor },
      1000,
    );
    expect(complete).toBe(false);
  });
});
