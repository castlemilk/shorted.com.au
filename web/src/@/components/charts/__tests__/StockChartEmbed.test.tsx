import { render, screen } from "@testing-library/react";
import { StockChartEmbed } from "../StockChartEmbed";
import type { StockChartData } from "../use-stock-chart-data";
import type { ChartPoint } from "../types";

// The data hook is the embed's only source of numbers, the element-size hook its
// only measurement, and the chart its only drawing: all three are stood in for,
// so these tests are about what the embed hands the chart.
const mockChartData = jest.fn<StockChartData, [string, string]>();
jest.mock("../use-stock-chart-data", () => ({
  useStockChartData: (code: string, period: string) => mockChartData(code, period),
}));

// jsdom has no layout: the chart's box is given. The embed draws nothing until it
// has been measured, and picks its readout from the height.
let mockChartBox = { width: 420, height: 400 };
jest.mock("@/hooks/use-element-size", () => ({
  useElementSize: () => [jest.fn(), mockChartBox],
}));

jest.mock("../StockChart", () => ({
  StockChart: (props: {
    height?: number;
    series: unknown[];
    readout?: string;
    readoutReserveSeries?: number;
  }) => (
    <div
      data-testid="stock-chart"
      data-series={props.series.length}
      data-readout={props.readout}
      // Absent when the embed holds no readout rows for series still to come.
      data-reserve={props.readoutReserveSeries === undefined ? "" : String(props.readoutReserveSeries)}
    />
  ),
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const line = (n: number, from: number, step: number): ChartPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, v: from + i * step }));

function data(over: Partial<StockChartData> = {}): StockChartData {
  return {
    short: line(40, 2, 0.05),
    price: line(40, 10, 0.2),
    volume: line(40, 1000, 0),
    correlation: 0.55,
    anyLoading: false,
    isError: false,
    ...over,
  };
}

beforeEach(() => {
  mockChartBox = { width: 420, height: 400 };
  mockChartData.mockReset();
  mockChartData.mockImplementation(() => data());
});

// A narrow frame (an iframe on a phone) reads through a strip with a row for each
// series, 18px apiece. The price and the short series load separately, so the
// second to land would add a row and move the plot under the reader.
describe("StockChartEmbed: the readout's rows", () => {
  const reserve = () => screen.getByTestId("stock-chart").getAttribute("data-reserve");

  it("holds both series' rows in the Combined view, so the strip is as tall before the second series lands", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(reserve()).toBe("2");
  });

  it("holds them while only one of the two has arrived, which is when it matters", () => {
    mockChartData.mockImplementation(() => data({ short: [], anyLoading: true }));
    const { rerender } = render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    // The price alone: one series, two rows held.
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");
    expect(reserve()).toBe("2");

    mockChartData.mockImplementation(() => data());
    rerender(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "2");
    expect(reserve()).toBe("2");
  });

  it("holds them the other way round too: the short series first, the price after", () => {
    mockChartData.mockImplementation(() => data({ price: [], volume: [], anyLoading: true }));
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");
    expect(reserve()).toBe("2");
  });

  it("holds them whichever readout the frame's height picks", () => {
    mockChartBox = { width: 420, height: 400 };
    const tall = render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-readout", "strip");
    expect(reserve()).toBe("2");
    tall.unmount();

    mockChartBox = { width: 420, height: 200 };
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-readout", "tooltip");
    expect(reserve()).toBe("2");
  });

  it.each([["short"], ["price"]] as const)("holds none in the %s view: it has the one row", (view) => {
    render(<StockChartEmbed stockCode="BHP" defaultView={view} />);
    expect(reserve()).toBe("");
  });

  it("holds none by default: the default view is the short interest one", () => {
    render(<StockChartEmbed stockCode="BHP" />);
    expect(reserve()).toBe("");
  });
});
