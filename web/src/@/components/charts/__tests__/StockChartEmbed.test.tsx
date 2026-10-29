import { fireEvent, render, screen } from "@testing-library/react";
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

// A phone held upright gives the chart a tall, narrow plot, and with rotation
// locked the reader cannot turn it (reported 2026-10-19, WBT opened from
// Discord). The landscape mode draws the chart sideways instead.
describe("StockChartEmbed: landscape mode", () => {
  const box = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it("is offered only where the chart is the page", () => {
    render(<StockChartEmbed stockCode="BHP" />);
    expect(screen.queryByRole("button", { name: /landscape/i })).not.toBeInTheDocument();
  });

  it("turns the chart's box sideways on a portrait screen, and back", () => {
    const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape />);
    const toggle = screen.getByRole("button", { name: "Rotate chart to landscape" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(box(container)).not.toHaveAttribute("data-landscape");

    fireEvent.click(toggle);
    expect(box(container)).toHaveAttribute("data-landscape", "true");
    // Rotated only while the viewport is portrait; a landscape viewport (the
    // phone turned with rotation unlocked) gets the same box, unrotated.
    expect(box(container).className).toContain("portrait:rotate-90");
    expect(box(container).className).toContain("fixed");
    // The way back stays on screen whatever the viewport does.
    const back = screen.getByRole("button", { name: "Back to portrait" });
    expect(back).toHaveAttribute("aria-pressed", "true");
    expect(back.className).not.toMatch(/(^|\s)hidden(\s|$)/);

    fireEvent.click(back);
    expect(box(container)).not.toHaveAttribute("data-landscape");
  });

  describe("opened sideways (a link from Discord, whose browser keeps to portrait)", () => {
    const realMatchMedia = window.matchMedia;
    const screenIs = (portraitPhone: boolean) => {
      window.matchMedia = ((query: string) => ({
        matches: portraitPhone && query.includes("orientation: portrait"),
        media: query,
      })) as unknown as typeof window.matchMedia;
    };
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it("starts turned on a phone held upright", () => {
      screenIs(true);
      const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape startLandscape />);
      expect(box(container)).toHaveAttribute("data-landscape", "true");
      expect(screen.getByRole("button", { name: "Back to portrait" })).toBeInTheDocument();
    });

    it("leaves any other screen as it is", () => {
      screenIs(false);
      const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape startLandscape />);
      expect(box(container)).not.toHaveAttribute("data-landscape");
    });

    it("needs landscape mode to be offered at all", () => {
      screenIs(true);
      const { container } = render(<StockChartEmbed stockCode="WBT" startLandscape />);
      expect(box(container)).not.toHaveAttribute("data-landscape");
    });
  });

  it("leaves with Escape", () => {
    const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(box(container)).not.toHaveAttribute("data-landscape");
  });
});

describe("StockChartEmbed: open full screen (framed)", () => {
  it("links to the share page at the period on screen", () => {
    render(<StockChartEmbed stockCode="WBT" defaultView="combined" defaultPeriod="1m" expandable />);
    const link = screen.getByRole("link", { name: "Open WBT chart full screen" });
    expect(link).toHaveAttribute(
      "href",
      "https://shorted.com.au/chart/WBT?view=combined&period=1m",
    );
    expect(link).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("button", { name: "6m" }));
    expect(link).toHaveAttribute(
      "href",
      "https://shorted.com.au/chart/WBT?view=combined&period=6m",
    );
  });

  it("is absent unless asked for", () => {
    render(<StockChartEmbed stockCode="WBT" />);
    expect(screen.queryByRole("link", { name: /full screen/ })).not.toBeInTheDocument();
  });
});

// A publisher's embed keeps the view they chose; the Discord Activity hands the
// view to the reader.
describe("StockChartEmbed: selectableView", () => {
  it("offers no view control by default", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="short" />);
    expect(screen.queryByRole("group", { name: "View" })).not.toBeInTheDocument();
  });

  it("switches the chart between the views when the reader picks one", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="short" selectableView />);
    const views = screen.getByRole("group", { name: "View" });
    expect(views).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Short" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");

    fireEvent.click(screen.getByRole("button", { name: "Combined" }));
    expect(screen.getByRole("button", { name: "Combined" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Short" })).toHaveAttribute("aria-pressed", "false");
    // Price and short interest together, the strip holding both rows.
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "2");
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-reserve", "2");
  });
});
