/**
 * The chart's data hook asks each series for the window a chart kept as posted
 * shows, and for the live window otherwise. The queries themselves are stood in
 * for: this is about which windows the hook asks for.
 */
const mockShort = jest.fn();
const mockHistorical = jest.fn();
jest.mock("@/hooks/use-stock-queries", () => ({
  useShortTimeSeries: (...args: unknown[]) => mockShort(...args),
  useHistoricalData: (...args: unknown[]) => mockHistorical(...args),
}));

import { renderHook } from "@testing-library/react";
import { useStockChartData } from "../use-stock-chart-data";
import type { ChartAnchor } from "../chart-anchor";

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

  it("asks for each series' anchored window, prices to the day before posting", () => {
    const anchor: ChartAnchor = { day: "2026-11-04", shorts: "2026-10-29" };
    renderHook(() => useStockChartData("BHP", "3m", anchor));
    expect(mockShort).toHaveBeenCalledWith("BHP", "3m", {
      window: { from: "2026-07-30", to: "2026-10-29" },
    });
    expect(mockHistorical).toHaveBeenCalledWith("BHP", "3m", {
      window: { from: "2026-08-04", to: "2026-11-03" },
    });
  });

  it("asks the live queries again once the anchor is taken away", () => {
    const anchor: ChartAnchor = { day: "2026-11-04", shorts: "2026-11-04" };
    const { rerender } = renderHook(
      ({ a }: { a: ChartAnchor | null }) => useStockChartData("BHP", "1y", a),
      { initialProps: { a: anchor } },
    );
    rerender({ a: null });
    expect(mockShort).toHaveBeenLastCalledWith("BHP", "1y", { window: undefined });
    expect(mockHistorical).toHaveBeenLastCalledWith("BHP", "1y", { window: undefined });
  });
});
