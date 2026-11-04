/**
 * The chart's data hook asks each series for the window a chart kept as posted
 * shows, and for the live window otherwise. The queries themselves are stood in
 * for: this is about which windows the hook asks for. The expected windows are
 * anchoredWindows' own, so the hook and the card cannot drift apart.
 */
const mockShort = jest.fn();
const mockHistorical = jest.fn();
jest.mock("@/hooks/use-stock-queries", () => ({
  useShortTimeSeries: (...args: unknown[]) => mockShort(...args),
  useHistoricalData: (...args: unknown[]) => mockHistorical(...args),
}));

import { renderHook } from "@testing-library/react";
import { useStockChartData } from "../use-stock-chart-data";
import { anchoredWindows, type ChartAnchor } from "../chart-anchor";

const anchor: ChartAnchor = {
  day: "2026-11-04",
  prices: "2026-11-03",
  shorts: "2026-10-28",
};

beforeEach(() => {
  mockShort.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mockHistorical.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
});

describe("useStockChartData", () => {
  it("asks the live queries, with no window, when no anchor is given", () => {
    renderHook(() => useStockChartData("BHP", "3m"));
    expect(mockShort).toHaveBeenCalledWith("BHP", "3m", { window: undefined });
    expect(mockHistorical).toHaveBeenCalledWith("BHP", "3m", { window: undefined });
  });

  it("asks for each series' anchored window, both counted back from the newest close", () => {
    renderHook(() => useStockChartData("BHP", "3m", anchor));
    const w = anchoredWindows("3m", anchor);
    expect(mockShort).toHaveBeenCalledWith("BHP", "3m", { window: w.shorts });
    expect(mockHistorical).toHaveBeenCalledWith("BHP", "3m", { window: w.prices });
    expect(w.prices.to).toBe("2026-11-03");
    expect(w.shorts.to).toBe("2026-10-28");
  });

  it("asks the live queries again once the anchor is taken away", () => {
    const { rerender } = renderHook(
      ({ a }: { a: ChartAnchor | null }) => useStockChartData("BHP", "1y", a),
      { initialProps: { a: anchor as ChartAnchor | null } },
    );
    rerender({ a: null });
    expect(mockShort).toHaveBeenLastCalledWith("BHP", "1y", { window: undefined });
    expect(mockHistorical).toHaveBeenLastCalledWith("BHP", "1y", { window: undefined });
  });
});
