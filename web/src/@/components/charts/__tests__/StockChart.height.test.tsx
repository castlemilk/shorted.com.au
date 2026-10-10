import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { StockChart } from "../StockChart";
import { READOUT_MIN_PLOT, readoutStripHeight } from "../chart-readout";
import type { ChartSeriesSpec } from "../types";

// ParentSize measures the DOM, which jsdom cannot; it is the one thing stood in
// for. The component reports a size it is told (as it would after layout) and
// otherwise does what it does: `children` receives it.
let mockSize = { width: 400, height: 300 };
jest.mock("@visx/responsive", () => ({
  ParentSize: ({
    children,
  }: {
    children: (size: { width: number; height: number }) => ReactNode;
  }) => children(mockSize),
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const SERIES: ChartSeriesSpec[] = [
  {
    id: "price",
    label: "Price",
    color: "#123456",
    axis: "left",
    kind: "line",
    points: Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: 40 + i })),
  },
];

function renderChart(props: { height?: number } = {}) {
  const utils = render(<StockChart series={SERIES} {...props} />);
  /** The wrapper StockChart itself renders around ParentSize. */
  const wrapper = utils.container.firstElementChild as HTMLElement;
  const chart = () => utils.container.querySelector("[data-chart-container]");
  const svg = () => utils.container.querySelector("svg");
  const strip = () => utils.container.querySelector<HTMLElement>("[data-chart-readout]");
  /** Everything the chart is, top to bottom: the strip, if any, and the svg. */
  const total = () =>
    Number(svg()?.getAttribute("height") ?? NaN) +
    Number(strip()?.style.height.replace("px", "") || 0);
  return { ...utils, wrapper, chart, svg, strip, total };
}

beforeEach(() => {
  mockSize = { width: 400, height: 300 };
});

describe("StockChart without a height", () => {
  it("fills its parent: the wrapper is 100% tall", () => {
    const { wrapper } = renderChart();
    expect(wrapper.style.width).toBe("100%");
    expect(wrapper.style.height).toBe("100%");
  });

  it("draws at the height ParentSize measures, strip and svg together", () => {
    mockSize = { width: 400, height: 300 };
    const { chart, strip, svg, total } = renderChart();
    expect(chart()).not.toBeNull();
    // The strip is there and the two add up to what was measured.
    expect(strip()).not.toBeNull();
    expect(total()).toBe(300);
    // Its height is the one the readout maths gives for this width: a measured
    // height changes the plot, not the strip.
    expect(strip()!.style.height).toBe(`${readoutStripHeight(400, 1)}px`);
    expect(Number(svg()!.getAttribute("height"))).toBe(300 - readoutStripHeight(400, 1));
  });

  it("follows a new measurement, as it does across a breakpoint", () => {
    mockSize = { width: 400, height: 300 };
    const { rerender, total } = renderChart();
    expect(total()).toBe(300);

    mockSize = { width: 400, height: 360 };
    rerender(<StockChart series={SERIES} />);
    expect(total()).toBe(360);
  });

  it.each([0, 1, 9])("draws nothing while the measured height is %i", (height) => {
    mockSize = { width: 400, height };
    const { chart, svg } = renderChart();
    expect(chart()).toBeNull();
    expect(svg()).toBeNull();
  });

  it("draws from 10px", () => {
    mockSize = { width: 400, height: 10 };
    expect(renderChart().chart()).not.toBeNull();
  });

  it("makes the same choice between the strip and the tooltip as a fixed height of that size", () => {
    // 1 series at 400px wide: its strip, the plot's 8px and 24px of margin (no
    // brush that narrow), and the plot must keep READOUT_MIN_PLOT.
    const needed = readoutStripHeight(400, 1) + 8 + 24 + READOUT_MIN_PLOT;

    mockSize = { width: 400, height: needed };
    const roomy = renderChart();
    expect(roomy.strip()).not.toBeNull();
    roomy.unmount();

    mockSize = { width: 400, height: needed - 1 };
    const cramped = renderChart();
    expect(cramped.strip()).toBeNull();
    // The tooltip costs the plot nothing: the svg is the whole height.
    expect(Number(cramped.svg()!.getAttribute("height"))).toBe(needed - 1);
  });
});

describe("StockChart with a height", () => {
  it("is that height: the wrapper's and the chart's, whatever ParentSize measures", () => {
    mockSize = { width: 400, height: 999 };
    const { wrapper, total } = renderChart({ height: 250 });
    expect(wrapper.style.height).toBe("250px");
    expect(total()).toBe(250);
  });

  it("is not held to the minimum a measured height is", () => {
    mockSize = { width: 400, height: 0 };
    const { chart, total } = renderChart({ height: 250 });
    expect(chart()).not.toBeNull();
    expect(total()).toBe(250);
  });
});
