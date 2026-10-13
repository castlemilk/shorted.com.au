import { fireEvent, render, screen, within } from "@testing-library/react";
import { StockChartPanel } from "../StockChartPanel";
import {
  CHART_BOX_HEIGHT_CLASS,
  StockChartPanelSkeleton,
} from "../stock-chart-section";
import { resetChartPrefsForTests } from "../chart-prefs";
import type { StockChartData } from "../use-stock-chart-data";
import type { ChartPoint } from "../types";

// The data hook is the panel's only source of numbers, and the chart its only
// drawing: both are stood in for, so these tests are about what the panel does
// with them (which controls, which choices, which box).
const mockChartData = jest.fn<StockChartData, [string, string]>();
jest.mock("../use-stock-chart-data", () => ({
  useStockChartData: (code: string, period: string) => mockChartData(code, period),
}));

jest.mock("../StockChart", () => ({
  StockChart: (props: {
    height?: number;
    series: unknown[];
    readoutReserveSeries?: number;
  }) => (
    <div
      data-testid="stock-chart"
      data-series={props.series.length}
      // Absent when the panel gave it no height: the chart then takes its box's.
      data-height={props.height === undefined ? "" : String(props.height)}
      // Absent when the panel holds no readout rows for series still to come.
      data-reserve={props.readoutReserveSeries === undefined ? "" : String(props.readoutReserveSeries)}
    />
  ),
}));

jest.mock("~/@/components/ui/embed-dialog", () => ({
  EmbedDialog: (props: { target: { view?: string; period?: string } }) => (
    <button type="button" data-testid="embed" data-view={props.target.view} data-period={props.target.period}>
      Embed
    </button>
  ),
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const line = (n: number, from: number, step: number): ChartPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, v: from + i * step }));

// Price and short interest both rising: shorts building into a rally, which is
// a divergence region.
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
const NO_DATA = { short: [], price: [], volume: [], correlation: null };

beforeEach(() => {
  resetChartPrefsForTests();
  mockChartData.mockReset();
  mockChartData.mockImplementation(() => data());
});

// jsdom applies no CSS, so a segmented button holds both its long and its short
// label here, and its name is the two run together: match the start of it.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const viewButton = (label: string) =>
  within(screen.getByRole("group", { name: "Chart view" })).getByRole("button", {
    name: new RegExp(`^${escapeRe(label)}`),
  });
const periodButton = (label: string) =>
  within(screen.getByRole("group", { name: "Period" })).getByRole("button", {
    name: new RegExp(`^${escapeRe(label)}$`, "i"),
  });

/** The element a grid area was given to. */
const area = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[class*="[grid-area:${name}]"]`);

describe("StockChartPanel: settings", () => {
  it("restores the period when remounted with the same prefsKey", () => {
    const first = render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    expect(periodButton("1y")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(periodButton("6m"));
    expect(periodButton("6m")).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    expect(periodButton("6m")).toHaveAttribute("aria-pressed", "true");
    expect(periodButton("1y")).toHaveAttribute("aria-pressed", "false");
    // And the data is asked for in it.
    expect(mockChartData).toHaveBeenLastCalledWith("BHP", "6m");
  });

  it("restores the view and both toggles too", () => {
    const first = render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    fireEvent.click(screen.getByRole("button", { name: /Divergence/ }));
    fireEvent.click(screen.getByRole("button", { name: /SMA 20/ }));
    fireEvent.click(viewButton("Price & Volume"));
    first.unmount();

    render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    expect(viewButton("Price & Volume")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /SMA 20/ })).toHaveAttribute("aria-pressed", "true");
    // Divergence belongs to the combined view; its choice is still kept.
    fireEvent.click(viewButton("Combined"));
    expect(screen.getByRole("button", { name: /Divergence/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens Short interest on its default view when its key is empty, on the shared period", () => {
    const overview = render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    fireEvent.click(viewButton("Price & Volume"));
    fireEvent.click(periodButton("6m"));
    overview.unmount();

    render(
      <StockChartPanel stockCode="BHP" prefsKey="BHP:short-interest" defaultView="short" />,
    );
    // Its own default, not what Overview was left on.
    expect(viewButton("Short Interest")).toHaveAttribute("aria-pressed", "true");
    expect(viewButton("Price & Volume")).toHaveAttribute("aria-pressed", "false");
    // The period is the stock's, shared by both tabs.
    expect(periodButton("6m")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a choice made on Short interest off Overview", () => {
    const shortInterest = render(
      <StockChartPanel stockCode="BHP" prefsKey="BHP:short-interest" defaultView="short" />,
    );
    fireEvent.click(viewButton("Price & Volume"));
    shortInterest.unmount();

    render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    expect(viewButton("Combined")).toHaveAttribute("aria-pressed", "true");
  });

  it("remembers nothing without a prefsKey", () => {
    const first = render(<StockChartPanel stockCode="BHP" />);
    fireEvent.click(periodButton("6m"));
    fireEvent.click(viewButton("Price & Volume"));
    first.unmount();

    const second = render(<StockChartPanel stockCode="BHP" />);
    expect(periodButton("1y")).toHaveAttribute("aria-pressed", "true");
    expect(viewButton("Combined")).toHaveAttribute("aria-pressed", "true");
    second.unmount();

    // Nor did it leave anything for a keyed panel to find.
    render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    expect(periodButton("1y")).toHaveAttribute("aria-pressed", "true");
  });

  it("starts from defaultPeriod and defaultView", () => {
    render(<StockChartPanel stockCode="BHP" defaultPeriod="3m" defaultView="price" />);
    expect(periodButton("3m")).toHaveAttribute("aria-pressed", "true");
    expect(viewButton("Price & Volume")).toHaveAttribute("aria-pressed", "true");
    expect(mockChartData).toHaveBeenLastCalledWith("BHP", "3m");
  });

  it("reads the new stock's choices when it is pointed at another, and asks for nothing in the old period", () => {
    const { rerender } = render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    fireEvent.click(periodButton("6m"));

    rerender(<StockChartPanel stockCode="CBA" prefsKey="CBA:overview" />);
    expect(periodButton("1y")).toHaveAttribute("aria-pressed", "true");
    expect(periodButton("6m")).toHaveAttribute("aria-pressed", "false");
    expect(mockChartData).toHaveBeenLastCalledWith("CBA", "1y");
    // Not even for a render React went on to throw away.
    expect(mockChartData).not.toHaveBeenCalledWith("CBA", "6m");
  });

  it("hands the embed button the view and period on screen", () => {
    render(<StockChartPanel stockCode="BHP" prefsKey="BHP:overview" />);
    fireEvent.click(viewButton("Price & Volume"));
    fireEvent.click(periodButton("2y"));
    const embed = screen.getByTestId("embed");
    expect(embed).toHaveAttribute("data-view", "price");
    expect(embed).toHaveAttribute("data-period", "2y");
  });
});

describe("StockChartPanel: controls", () => {
  it("renders one of each control", () => {
    render(<StockChartPanel stockCode="BHP" />);
    expect(screen.getAllByRole("group", { name: "Chart view" })).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "Period" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /SMA 20/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Divergence/ })).toHaveLength(1);
    expect(screen.getAllByTestId("embed")).toHaveLength(1);
  });

  it("exposes the six periods, each with aria-pressed", () => {
    render(<StockChartPanel stockCode="BHP" />);
    const buttons = within(screen.getByRole("group", { name: "Period" })).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["1m", "3m", "6m", "1y", "2y", "max"]);
    for (const b of buttons) expect(b).toHaveAttribute("aria-pressed");
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("places each control in a grid area", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" />);
    for (const name of ["view", "toggles", "period", "embed", "chart"]) {
      expect(area(container, name)).not.toBeNull();
    }
    // The controls are placed by the same element they are, not copied per breakpoint.
    expect(area(container, "view")).toBe(screen.getByRole("group", { name: "Chart view" }));
    expect(area(container, "period")).toBe(screen.getByRole("group", { name: "Period" }));
    expect(area(container, "embed")).toContainElement(screen.getByTestId("embed"));
  });

  it("gives 40px controls and a 36px toggles row below xl, and the one 32px row from it", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" />);
    const view = screen.getByRole("group", { name: "Chart view" });
    const period = screen.getByRole("group", { name: "Period" });
    expect(view).toHaveClass("h-10", "xl:h-auto");
    expect(period).toHaveClass("h-10", "xl:h-auto");
    expect(area(container, "embed")).toHaveClass("h-10", "xl:h-8");
    expect(area(container, "toggles")).toHaveClass("h-9", "xl:h-8", "flex-nowrap", "overflow-x-auto");
    // Targets: 40px below xl, today's size from it.
    for (const b of [...within(view).getAllByRole("button"), ...within(period).getAllByRole("button")]) {
      expect(b).toHaveClass("min-h-10", "xl:min-h-0");
    }
    // The periods share the full width below xl.
    for (const b of within(period).getAllByRole("button")) expect(b).toHaveClass("flex-1");
  });

  it("hides the toggles row's scrollbar: a classic one would cut the buttons", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" />);
    // Still a row that scrolls sideways when it must, at every width.
    expect(area(container, "toggles")).toHaveClass(
      "overflow-x-auto",
      "[scrollbar-width:none]",
      "[&::-webkit-scrollbar]:hidden",
    );
  });

  it("shows the toggles each view has, and keeps the toggles row for the one with none", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" defaultView="combined" />);
    expect(screen.getByText(/corr \+0\.55/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SMA 20/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Divergence/ })).toBeInTheDocument();

    fireEvent.click(viewButton("Price & Volume"));
    expect(screen.queryByText(/corr/)).toBeNull();
    expect(screen.getByRole("button", { name: /SMA 20/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Divergence/ })).toBeNull();

    fireEvent.click(viewButton("Short Interest"));
    expect(screen.queryByRole("button", { name: /SMA 20/ })).toBeNull();
    // Nothing in it, and still there: the row is part of the skeleton's footprint.
    const toggles = area(container, "toggles");
    expect(toggles).not.toBeNull();
    expect(toggles!.children).toHaveLength(0);
  });
});

describe("StockChartPanel: divergence legend", () => {
  it("takes a row of the grid only while it shows", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" />);
    const grid = container.firstElementChild as HTMLElement;
    expect(screen.queryByText(/Shorts building into price strength/)).toBeNull();
    expect(grid.className).not.toContain("'legend_legend'");

    fireEvent.click(screen.getByRole("button", { name: /Divergence/ }));
    expect(screen.getByText(/Shorts building into price strength/)).toBeInTheDocument();
    expect(area(container, "legend")).not.toBeNull();
    // Below sm and from sm, the legend sits between the controls and the chart.
    expect(grid.className).toContain("'view_embed'_'legend_legend'_'chart_chart'");
    expect(grid.className).toContain("'view_toggles_period_embed'_'legend_legend_legend_legend'_'chart_chart_chart_chart'");

    fireEvent.click(screen.getByRole("button", { name: /Divergence/ }));
    expect(screen.queryByText(/Shorts building into price strength/)).toBeNull();
    expect(grid.className).not.toContain("'legend_legend'");
  });

  it("shows no legend, and takes no row, when divergence is on but no span was found", () => {
    mockChartData.mockImplementation(() =>
      data({ short: line(40, 2, 0), price: line(40, 10, 0) }),
    );
    const { container } = render(<StockChartPanel stockCode="BHP" />);
    fireEvent.click(screen.getByRole("button", { name: /Divergence/ }));
    expect(screen.getByRole("button", { name: /Divergence/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Shorts building into price strength/)).toBeNull();
    expect((container.firstElementChild as HTMLElement).className).not.toContain("'legend_legend'");
  });
});

describe("StockChartPanel: the readout's rows", () => {
  const reserve = () => screen.getByTestId("stock-chart").getAttribute("data-reserve");

  it("holds both series' rows in the Combined view, so the strip is as tall before the second series lands", () => {
    render(<StockChartPanel stockCode="BHP" />);
    expect(reserve()).toBe("2");
  });

  it("holds them while only one of the two has arrived, which is when it matters", () => {
    mockChartData.mockImplementation(() => data({ short: [], anyLoading: true }));
    const { rerender } = render(<StockChartPanel stockCode="BHP" />);
    // The price alone: one series, two rows held.
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");
    expect(reserve()).toBe("2");

    mockChartData.mockImplementation(() => data());
    rerender(<StockChartPanel stockCode="BHP" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "2");
    expect(reserve()).toBe("2");
  });

  it("holds none in the views of one series: they have the one row", () => {
    render(<StockChartPanel stockCode="BHP" />);
    fireEvent.click(viewButton("Short Interest"));
    expect(reserve()).toBe("");
    fireEvent.click(viewButton("Price & Volume"));
    expect(reserve()).toBe("");
    fireEvent.click(viewButton("Combined"));
    expect(reserve()).toBe("2");
  });
});

describe("StockChartPanel: the chart box", () => {
  const classes = CHART_BOX_HEIGHT_CLASS.split(" ");

  it("is CHART_BOX_HEIGHT_CLASS, and the chart gets no height of its own", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" />);
    const box = area(container, "chart")!;
    expect(box).toHaveClass(...classes);
    expect(box.style.height).toBe("");
    expect(within(box).getByTestId("stock-chart")).toHaveAttribute("data-height", "");
  });

  it("is the height it is given, with no class, and the chart gets that height", () => {
    const { container } = render(<StockChartPanel stockCode="BHP" height={300} />);
    const box = area(container, "chart")!;
    expect(box.style.height).toBe("300px");
    for (const c of classes) expect(box).not.toHaveClass(c);
    expect(within(box).getByTestId("stock-chart")).toHaveAttribute("data-height", "300");
  });

  it.each([
    ["loaded", {}],
    ["loading", { ...NO_DATA, anyLoading: true }],
    ["empty", { ...NO_DATA }],
    ["failed", { ...NO_DATA, isError: true }],
  ])("keeps the box's height while %s, by class and by px", (_state, over) => {
    mockChartData.mockImplementation(() => data(over));
    const byClass = render(<StockChartPanel stockCode="BHP" />);
    expect(area(byClass.container, "chart")).toHaveClass(...classes);
    byClass.unmount();

    const byPx = render(<StockChartPanel stockCode="BHP" height={300} />);
    expect(area(byPx.container, "chart")!.style.height).toBe("300px");
  });

  it("says what is wrong when there is nothing to draw", () => {
    mockChartData.mockImplementation(() => data({ ...NO_DATA, isError: true }));
    const failed = render(<StockChartPanel stockCode="BHP" />);
    expect(screen.getByText(/Unable to load chart data/)).toBeInTheDocument();
    failed.unmount();

    mockChartData.mockImplementation(() => data({ ...NO_DATA }));
    render(<StockChartPanel stockCode="BHP" />);
    expect(screen.getByText(/No chart data available for BHP in this period/)).toBeInTheDocument();
  });

  it("is the same class the skeleton's box has", () => {
    const skeleton = render(<StockChartPanelSkeleton />);
    const box = Array.from(skeleton.container.querySelectorAll("div")).find((el) =>
      classes.every((c) => el.classList.contains(c)),
    );
    expect(box).toBeDefined();
    skeleton.unmount();

    const panel = render(<StockChartPanel stockCode="BHP" />);
    expect(area(panel.container, "chart")).toHaveClass(...classes);
  });
});
