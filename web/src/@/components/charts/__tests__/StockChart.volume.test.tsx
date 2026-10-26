import { fireEvent, render } from "@testing-library/react";
import { StockChartInner, brushOverviewPoints } from "../StockChart";
import { readoutStripHeight } from "../chart-readout";
import type { ChartPoint, ChartSeriesSpec, StockChartProps } from "../types";

// localPoint needs real SVG geometry (getScreenCTM); jsdom has none. Read a
// mouse event's client coords as the chart-local point.
jest.mock("@visx/event", () => ({
  localPoint: (e: { clientX?: number; clientY?: number }) =>
    e.clientX == null ? null : { x: e.clientX, y: e.clientY ?? 0 },
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
// Past MOBILE_MAX (500px), where the chart draws volume, and past 640px, where
// the strip is one row.
const WIDTH = 700;
const HEIGHT = 400;
// Both axes' widest label is six characters ("$49.00", "11.00%"): 48px a side.
const M = { left: 48, right: 48 };
const xOf = (i: number, width = WIDTH) => M.left + ((width - M.left - M.right) * i) / 9;

const mk = (id: string, label: string, axis: "left" | "right", base: number): ChartSeriesSpec => ({
  id,
  label,
  color: "#123456",
  axis,
  kind: "line",
  points: Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: base + i })),
});
const SERIES = [mk("price", "Price", "left", 40), mk("short", "Short %", "right", 2)];
// 1.0M, 1.2M, ... 2.8M shares, one a session, on the price's own days.
const VOLUME: ChartPoint[] = Array.from({ length: 10 }, (_, i) => ({
  t: T0 + i * DAY,
  v: 1_000_000 + i * 200_000,
}));

function renderChart(props: Partial<StockChartProps> & { width?: number } = {}) {
  const { width = WIDTH, ...rest } = props;
  const utils = render(
    <StockChartInner
      width={width}
      height={HEIGHT}
      series={SERIES}
      volume={VOLUME}
      {...rest}
    />,
  );
  const plot = utils.container.querySelector("[data-chart-capture]") as SVGRectElement;
  const volumeValue = () =>
    utils.container.querySelector("[data-readout-volume-value]")?.textContent ?? null;
  const activeBar = () => utils.container.querySelector('[data-chart="volume-active"]');
  return { ...utils, plot, volumeValue, activeBar };
}

describe("StockChart volume", () => {
  it("draws a bar per session, all in one path", () => {
    const { container } = renderChart();
    const paths = container.querySelectorAll('[data-chart="volume"] path');
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute("d")!.match(/Z/g)).toHaveLength(VOLUME.length);
  });

  it("names the newest session's volume at rest, and highlights no bar", () => {
    const { volumeValue, activeBar } = renderChart();
    expect(volumeValue()).toBe("2.8M");
    expect(activeBar()).toBeNull();
  });

  it("names the hovered session's volume and highlights that session's bar", () => {
    const { plot, volumeValue, activeBar, container } = renderChart();
    fireEvent.mouseMove(plot, { clientX: xOf(3), clientY: 50 });
    expect(container.querySelector("[data-chart-readout]")!.getAttribute("data-readout-state")).toBe(
      "hover",
    );
    expect(volumeValue()).toBe("1.6M");
    const bar = activeBar()!;
    expect(bar).toBeTruthy();
    const centre = Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) / 2;
    expect(centre).toBeCloseTo(xOf(3) - M.left, 0);

    fireEvent.mouseLeave(plot);
    expect(volumeValue()).toBe("2.8M");
    expect(activeBar()).toBeNull();
  });

  it("names the volume in the hover card when the reading floats", () => {
    const { plot, container } = renderChart({ readout: "tooltip" });
    fireEvent.mouseMove(plot, { clientX: xOf(5), clientY: 50 });
    const row = container.querySelector("[data-chart-tooltip] [data-tooltip-volume]");
    expect(row?.textContent).toBe("Volume2.0M");
  });

  it("leaves volume out of a measure: it names changes, and volume has none", () => {
    const { plot, container, activeBar } = renderChart();
    fireEvent.mouseDown(plot, { clientX: xOf(2), clientY: 50, button: 0 });
    fireEvent.mouseMove(plot, { clientX: xOf(6), clientY: 50 });
    expect(container.querySelector("[data-chart-readout]")!.getAttribute("data-readout-state")).toBe(
      "measure",
    );
    expect(container.querySelector("[data-readout-volume]")).toBeNull();
    expect(activeBar()).toBeNull();
  });

  it("keeps the strip's height, on a phone strip as on one row", () => {
    for (const width of [560, WIDTH]) {
      const { container, unmount } = renderChart({ width });
      const strip = container.querySelector<HTMLElement>("[data-chart-readout]")!;
      expect(strip.style.height).toBe(`${readoutStripHeight(width, SERIES.length)}px`);
      expect(container.querySelector("[data-readout-volume]")).toBeTruthy();
      unmount();
    }
  });

  it("names no volume where the chart draws none: a narrow chart, or no volume given", () => {
    for (const props of [{ width: 400 }, { volume: undefined }]) {
      const { container, unmount } = renderChart(props);
      expect(container.querySelector('[data-chart="volume"]')).toBeNull();
      expect(container.querySelector("[data-readout-volume]")).toBeNull();
      unmount();
    }
  });
});

describe("brushOverviewPoints", () => {
  it("draws one series, never every series' points merged into one line", () => {
    // Merged, a $40 price and a 2% short position alternate day by day: a comb.
    const pts = brushOverviewPoints(SERIES);
    expect(pts).toBe(SERIES[0]!.points);
  });

  it("takes the series that spans the most time, the first of equals", () => {
    const longShort: ChartSeriesSpec = {
      ...SERIES[1]!,
      points: Array.from({ length: 20 }, (_, i) => ({ t: T0 - 10 * DAY + i * DAY, v: 2 })),
    };
    expect(brushOverviewPoints([SERIES[0]!, longShort])).toBe(longShort.points);
    expect(brushOverviewPoints([SERIES[1]!, SERIES[0]!])).toBe(SERIES[1]!.points);
  });

  it("is empty when no series has a point", () => {
    expect(brushOverviewPoints([{ ...SERIES[0]!, points: [] }])).toEqual([]);
  });
});
