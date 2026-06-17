import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, waitFor } from "storybook/test";
import { StockChart } from "./StockChart";
import { seriesColor } from "./chart-theme";
import { shortSeriesToPoints, historicalToPoints } from "./adapters";
import { calculateSMA } from "./indicators";
import type { ChartSeriesSpec, SeriesIndicator } from "./types";
import {
  timeSeriesDataFixture,
  historicalDataFixture,
} from "~/@/mocks/fixtures/short-data";

const shortPoints = (code: string, period: string) =>
  shortSeriesToPoints(timeSeriesDataFixture(code, period));
const priceParts = (code: string, period: string) =>
  historicalToPoints(historicalDataFixture(code, period));

function priceSeries(code: string, period: string): ChartSeriesSpec {
  return {
    id: `${code}:price`,
    label: "Price",
    color: seriesColor("price"),
    axis: "left",
    kind: "area",
    points: priceParts(code, period).price,
  };
}
function shortSeries(code: string, period: string): ChartSeriesSpec {
  return {
    id: `${code}:short`,
    label: "Short %",
    color: seriesColor("short"),
    axis: "right",
    kind: "line",
    points: shortPoints(code, period),
    // Mirror production: short interest is already a percentage, so the
    // drag-measure readout reports point delta ("pp"), not relative %.
    measureMode: "absolute",
    measureUnit: "pp",
  };
}

const priceFmt = (v: number) => `$${v.toFixed(2)}`;
const shortFmt = (v: number) => `${v.toFixed(1)}%`;

const meta = {
  title: "Charts/StockChart",
  component: StockChart,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ width: 880, height: 460 }} className="rounded-lg border bg-background p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StockChart>;
export default meta;
type Story = StoryObj<typeof meta>;

const capture = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<SVGRectElement>('rect[fill="transparent"]')!;

export const SingleSeries: Story = {
  args: {
    series: [shortSeries("PLS", "6m")],
    leftAxis: { side: "left", format: shortFmt },
    height: 400,
  },
};

export const DualAxis: Story = {
  args: {
    series: [priceSeries("PLS", "6m"), shortSeries("PLS", "6m")],
    volume: priceParts("PLS", "6m").volume,
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 400,
  },
  play: async ({ canvasElement }) => {
    // Wait for ParentSize to size the chart (the capture rect exists).
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    const rect = capture(canvasElement);
    const box = rect.getBoundingClientRect();
    fireEvent.mouseMove(rect, {
      clientX: box.left + box.width * 0.5,
      clientY: box.top + box.height * 0.5,
    });
    // Crosshair dots (one per series) appear on hover.
    await waitFor(() =>
      expect(canvasElement.querySelectorAll("circle").length).toBeGreaterThanOrEqual(2),
    );
    // Tooltip shows both series labels.
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Price/);
      expect(document.body.textContent).toMatch(/Short %/);
    });
  },
};

// Short-vs-price divergence shading: bearish (red) where shorts build into a
// rally, bullish (green) where shorts cover into a slide. Explicit regions here
// for a deterministic visual; the computation is unit-tested in divergence.test.
export const WithDivergenceRegions: Story = {
  tags: ["no-visual"], // interaction-only until a visual baseline is generated
  args: {
    series: [priceSeries("PLS", "1y"), shortSeries("PLS", "1y")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    regions: (() => {
      const price = priceParts("PLS", "1y").price;
      const t0 = price[0]?.t ?? 0;
      const t1 = price[price.length - 1]?.t ?? 0;
      const span = t1 - t0;
      return [
        { start: t0 + span * 0.08, end: t0 + span * 0.34, tone: "bearish" as const, label: "Shorts building into price strength" },
        { start: t0 + span * 0.55, end: t0 + span * 0.82, tone: "bullish" as const, label: "Shorts covering into price weakness" },
      ];
    })(),
    height: 400,
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    // One bearish (red) + one bullish (green) band rendered under the series.
    expect(canvasElement.querySelector('rect[fill="#ef4444"]')).toBeTruthy();
    expect(canvasElement.querySelector('rect[fill="#22c55e"]')).toBeTruthy();
  },
};

// Regression: the tooltip must follow the cursor vertically (not sit at a fixed
// top anchor). A fixed anchor detaches the tooltip from the hovered point and,
// on scrolled/sticky-header pages, floats it above the chart entirely.
export const TooltipTracksCursor: Story = {
  tags: ["no-visual"], // interaction-only regression; visuals covered by DualAxis
  args: {
    series: [priceSeries("PLS", "6m"), shortSeries("PLS", "6m")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 400,
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    const rect = capture(canvasElement);
    const box = rect.getBoundingClientRect();
    const tipTop = () =>
      canvasElement
        .querySelector("[data-chart-tooltip]")
        ?.getBoundingClientRect().top ?? null;

    fireEvent.mouseMove(rect, {
      clientX: box.left + box.width * 0.5,
      clientY: box.top + box.height * 0.25,
    });
    let highTop: number | null = null;
    await waitFor(() => {
      highTop = tipTop();
      expect(highTop).not.toBeNull();
    });

    fireEvent.mouseMove(rect, {
      clientX: box.left + box.width * 0.5,
      clientY: box.top + box.height * 0.75,
    });
    await waitFor(() => {
      const lowTop = tipTop();
      expect(lowTop).not.toBeNull();
      // Tooltip moved down with the cursor.
      expect(lowTop!).toBeGreaterThan(highTop! + 20);
    });
    // And it stays within the chart container (never floats above it).
    const containerTop = canvasElement
      .querySelector("[data-chart-container]")!
      .getBoundingClientRect().top;
    expect(highTop!).toBeGreaterThanOrEqual(containerTop - 1);
  },
};

export const WithVolume: Story = {
  args: {
    series: [priceSeries("BHP", "1y")],
    volume: priceParts("BHP", "1y").volume,
    leftAxis: { side: "left", format: priceFmt },
    height: 400,
  },
  play: async ({ canvasElement }) => {
    // Volume is ONE path, not one node per point.
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll('[data-chart="volume"] path').length,
      ).toBe(1),
    );
  },
};

export const WithIndicators: Story = {
  args: {
    series: [priceSeries("PLS", "1y")],
    leftAxis: { side: "left", format: priceFmt },
    height: 400,
    indicators: ((): SeriesIndicator[] => {
      const pts = priceParts("PLS", "1y").price;
      const closes = pts.map((p) => p.v);
      return [
        {
          id: "sma20",
          seriesId: "PLS:price",
          label: "SMA 20",
          color: "#f59e0b",
          values: calculateSMA(closes, 20),
        },
        {
          id: "sma50",
          seriesId: "PLS:price",
          label: "SMA 50",
          color: "#a855f7",
          values: calculateSMA(closes, 50),
          dash: "4,3",
        },
      ];
    })(),
  },
};

export const Normalized: Story = {
  args: {
    series: [priceSeries("PLS", "1y"), priceSeries("BHP", "1y")].map((s, i) => ({
      ...s,
      id: i === 0 ? "PLS:price" : "BHP:price",
      label: i === 0 ? "PLS" : "BHP",
      color: seriesColor("series", i),
      axis: "left",
    })),
    viewMode: "normalized",
    leftAxis: { side: "left", format: (v) => `${v.toFixed(0)}%` },
    height: 400,
  },
};

export const LargeHistory: Story = {
  // Small width + max-period fixture (756 pts) forces decimation to trigger.
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 300 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  args: {
    series: [shortSeries("PLS", "max")],
    leftAxis: { side: "left", format: shortFmt },
    showBrush: false,
    height: 280,
    // 0.5 pt/px guarantees threshold < 756 (the raw max-period count) at any
    // realistic render width, so decimation deterministically triggers.
    decimationTargetPerPx: 0.5,
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const svg = canvasElement.querySelector("svg");
      expect(svg).toBeTruthy();
      const n = Number(svg!.getAttribute("data-points"));
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(756); // decimated below the raw point count
    });
  },
};

export const MeasureAndZoom: Story = {
  tags: ["no-visual"], // interaction-only (overlay shows on drag); no static baseline
  args: {
    series: [priceSeries("BHP", "3m"), shortSeries("BHP", "3m")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 420,
  },
  decorators: [
    (Story) => (
      <div
        style={{ width: 640, height: 440 }}
        className="rounded-lg border bg-background p-2"
      >
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    const rect = capture(canvasElement);
    const points = () =>
      Number(canvasElement.querySelector("svg")!.getAttribute("data-points"));
    const before = await waitFor(() => {
      const n = points();
      expect(n).toBeGreaterThan(4);
      return n;
    });
    const box = rect.getBoundingClientRect();
    const y = box.top + box.height * 0.5;

    // Press-drag across the middle third of the plot.
    fireEvent.mouseDown(rect, { clientX: box.left + box.width * 0.3, clientY: y, button: 0 });
    fireEvent.mouseMove(rect, { clientX: box.left + box.width * 0.7, clientY: y });

    // Shaded measure region + a point-to-point readout (price "%" and short "pp").
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-chart="measure"]')).toBeTruthy();
      const readout = document.querySelector('[data-chart="measure-readout"]');
      expect(readout).toBeTruthy();
      const text = readout!.textContent ?? "";
      expect(text).toMatch(/[+-]\d/); // a signed change for each series
      expect(text).toMatch(/%/); // price → relative %
      expect(text).toMatch(/pp/); // short → point delta
    });

    // Release → zoom into the dragged range (fewer points than the full view).
    fireEvent.mouseUp(rect, { clientX: box.left + box.width * 0.7, clientY: y });
    await waitFor(() => expect(points()).toBeLessThan(before));

    // Double-click resets back to the full view.
    fireEvent.doubleClick(rect, { clientX: box.left + box.width * 0.5, clientY: y });
    await waitFor(() => expect(points()).toBe(before));
  },
};

export const Compact: Story = {
  args: {
    series: [priceSeries("PLS", "3m"), shortSeries("PLS", "3m")],
    variant: "compact",
    height: 200,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 220 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [priceSeries("PLS", "3m"), shortSeries("PLS", "3m")],
    volume: priceParts("PLS", "3m").volume,
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 300,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 320 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
};

export const Empty: Story = {
  args: { series: [], height: 300 },
  play: async ({ canvasElement }) => {
    // No crash; renders an svg (or nothing) without throwing.
    await waitFor(() => expect(canvasElement).toBeTruthy());
  },
};
