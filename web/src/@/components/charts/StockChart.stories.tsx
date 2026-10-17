import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, waitFor, within } from "storybook/test";
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
const shortFmt = (v: number) => `${v.toFixed(2)}%`; // as chart-views.ts

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
    // The readout shows both series, and has left the resting reading for the hover.
    await waitFor(() => {
      const readout = canvasElement.querySelector("[data-chart-readout]");
      expect(readout?.getAttribute("data-readout-state")).toBe("hover");
      expect(readout?.textContent).toMatch(/Price/);
      expect(readout?.textContent).toMatch(/Short %/);
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
    readout: "tooltip", // the floating card is what this story is about
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
      expect(text).toMatch(/[+\u2212]\d/); // a signed change for each series (a fall carries U+2212)
      expect(text).not.toMatch(/-\d/); // never the ASCII hyphen
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

// Phone: press the chart, scrub, lift — the reading stays pinned, docked in the
// top corner away from the finger (never under the thumb). Tap the same point
// again (or the ×, or anywhere off the chart) to release it.
export const MobileTouchPinned: Story = {
  name: "Mobile (touch, pinned)",
  tags: ["no-visual"], // interaction-only; the static frame matches Mobile
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [priceSeries("PLS", "3m"), shortSeries("PLS", "3m")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 300,
    readout: "tooltip", // the docked card is what this story is about
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 320 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    const rect = capture(canvasElement);
    const box = rect.getBoundingClientRect();
    // A real browser's TouchEvent constructor insists on real Touch objects
    // (a plain {clientX, clientY} throws "Failed to convert value to 'Touch'"
    // under the Vitest browser runner); jsdom has no Touch and accepts the
    // plain shape, so build whichever the runtime supports.
    const touch = (fx: number) => {
      const init = {
        identifier: 1,
        target: rect,
        clientX: box.left + box.width * fx,
        clientY: box.top + box.height * 0.6,
      };
      return typeof Touch === "function"
        ? new Touch(init)
        : (init as unknown as Touch);
    };
    fireEvent.touchStart(rect, { touches: [touch(0.25)], changedTouches: [touch(0.25)] });
    fireEvent.touchMove(rect, { touches: [touch(0.3)], changedTouches: [touch(0.3)] });
    fireEvent.touchEnd(rect, { touches: [], changedTouches: [touch(0.3)] });
    // Still visible after the lift, pinned, and docked away from the finger.
    await waitFor(() => {
      const tip = canvasElement.querySelector("[data-chart-tooltip]");
      expect(tip).toBeTruthy();
      expect(tip!.hasAttribute("data-pinned")).toBe(true);
      expect(tip!.hasAttribute("data-docked")).toBe(true);
    });
  },
};

// The readout strip's contract, in a real browser with the real CSS: it takes the
// same height whatever it shows (the resting reading, a hover, a pin), the plot
// never moves while it changes, nothing is drawn over the plot, and the svg sits
// below the strip rather than under it. Each entry also keeps its place from the
// resting reading to a hover to a pin. On a phone (`oneRow` false) every series
// has a row of its own, under the headline row, so the entries are stacked.
async function playReadoutStrip(
  canvasElement: HTMLElement,
  stripHeight: number,
  total: number,
  oneRow: boolean,
) {
  await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
  const rect = capture(canvasElement);
  const strip = () => canvasElement.querySelector<HTMLElement>("[data-chart-readout]")!;
  const svg = () => canvasElement.querySelector("svg")!;
  const box = (el: Element) => el.getBoundingClientRect();
  const state = () => strip().getAttribute("data-readout-state");
  // Where the second series' entry starts: whatever precedes it shifts it.
  const secondEntry = () => strip().querySelectorAll("[data-readout-entry]")[1]!.getBoundingClientRect();
  const secondEntryLeft = () => secondEntry().left;
  const secondEntryTop = () => secondEntry().top;

  const stripBefore = box(strip());
  const secondBefore = secondEntryLeft();
  const secondTopBefore = secondEntryTop();
  // On a phone each series has a row to itself: the second is below the first.
  if (!oneRow) {
    const [first, second] = Array.from(strip().querySelectorAll("[data-readout-entry]"));
    expect(box(second!).top).toBeGreaterThanOrEqual(box(first!).bottom - 0.5);
    expect(box(first!).top).toBeGreaterThanOrEqual(stripBefore.top - 0.5);
    expect(box(second!).bottom).toBeLessThanOrEqual(stripBefore.bottom + 0.5);
  }
  const plotBefore = box(rect);
  expect(state()).toBe("latest");
  expect(stripBefore.height).toBe(stripHeight);
  // The strip and the svg add up to the chart's height, the svg below the strip.
  expect(box(svg()).top).toBeGreaterThanOrEqual(stripBefore.bottom - 0.5);
  expect(stripBefore.height + box(svg()).height).toBeCloseTo(total, 0);

  // Hover.
  const at = (fx: number, fy: number) => ({
    clientX: plotBefore.left + plotBefore.width * fx,
    clientY: plotBefore.top + plotBefore.height * fy,
  });
  fireEvent.mouseMove(rect, at(0.5, 0.5));
  await waitFor(() => expect(state()).toBe("hover"));
  expect(box(strip()).height).toBe(stripBefore.height);
  expect(box(rect).top).toBe(plotBefore.top);
  expect(canvasElement.querySelector("[data-chart-tooltip]")).toBeNull();
  expect(secondEntryLeft()).toBeCloseTo(secondBefore, 1);
  expect(secondEntryTop()).toBeCloseTo(secondTopBefore, 1);
  // React derives onMouseLeave from mouseout; the DOM's own mouseleave is not it.
  fireEvent.mouseOut(rect, { relatedTarget: document.body });
  await waitFor(() => expect(state()).toBe("latest"));

  // Pin by touch: scrub, lift. (A real browser's TouchEvent constructor insists
  // on real Touch objects; jsdom has none and accepts the plain shape.)
  const touch = (fx: number) => {
    const init = {
      identifier: 1,
      target: rect,
      ...at(fx, 0.6),
    };
    return typeof Touch === "function" ? new Touch(init) : (init as unknown as Touch);
  };
  fireEvent.touchStart(rect, { touches: [touch(0.4)], changedTouches: [touch(0.4)] });
  fireEvent.touchMove(rect, { touches: [touch(0.45)], changedTouches: [touch(0.45)] });
  fireEvent.touchEnd(rect, { touches: [], changedTouches: [touch(0.45)] });
  await waitFor(() => expect(state()).toBe("pinned"));
  expect(strip().hasAttribute("data-pinned")).toBe(true);
  expect(box(strip()).height).toBe(stripBefore.height);
  expect(secondEntryLeft()).toBeCloseTo(secondBefore, 1);
  expect(secondEntryTop()).toBeCloseTo(secondTopBefore, 1);
  // The plot has not moved a pixel, and nothing floats over it.
  expect(box(rect).top).toBe(plotBefore.top);
  expect(box(rect).height).toBe(plotBefore.height);
  expect(box(svg()).top).toBeGreaterThanOrEqual(box(strip()).bottom - 0.5);
  expect(canvasElement.querySelector("[data-chart-tooltip]")).toBeNull();
  // The Pinned chip and its release button are inside the strip.
  const release = within(canvasElement).getByRole("button", { name: "Release pinned reading" });
  expect(box(release).bottom).toBeLessThanOrEqual(box(strip()).bottom + 0.5);
  expect(box(release).top).toBeGreaterThanOrEqual(box(strip()).top - 0.5);
  expect(box(release).height).toBeGreaterThanOrEqual(24);
  expect(box(release).width).toBeGreaterThanOrEqual(24);

  // Release: back to the resting reading at the same height, focus on the chart.
  fireEvent.click(release);
  await waitFor(() => expect(state()).toBe("latest"));
  expect(box(strip()).height).toBe(stripBefore.height);
  expect(box(rect).top).toBe(plotBefore.top);
  expect(document.activeElement).toBe(canvasElement.querySelector("[data-chart-container]"));
}

// A phone chart is the viewport less the page's 2rem of padding: 296px at 360
// and 326px at 390. At those widths each series has a row to itself, and the
// readout must hold what the busiest reading has: a label whole (an ellipsis
// means the row ran short), every value, change and date note inside the strip,
// and the date a lagging series carries, which is the longest entry there is.
// Checked at rest, under a pointer and pinned.
async function playPhoneWidths(canvasElement: HTMLElement, widths: number[]) {
  // The decorator's frame pads 8px and borders 1px on each side: 18px in all.
  const frame = canvasElement
    .querySelector("[data-chart-container]")!
    .closest<HTMLElement>(".rounded-lg")!;
  const svg = () => canvasElement.querySelector("svg")!;
  const strip = () => canvasElement.querySelector<HTMLElement>("[data-chart-readout]")!;
  const state = () => strip().getAttribute("data-readout-state");
  const resizeTo = async (chartWidth: number) => {
    frame.style.width = `${chartWidth + 18}px`;
    await waitFor(() => expect(Number(svg().getAttribute("width"))).toBe(chartWidth));
  };
  // The width the text asks for, whether or not its box has shrunk to cut it.
  const textWidth = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  };
  const expectReadoutWhole = () => {
    const stripBox = strip().getBoundingClientRect();
    expect(stripBox.height).toBe(62);
    const entries = Array.from(strip().querySelectorAll<HTMLElement>("[data-readout-entry]"));
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      // Dot, label, value, then a change and a date note when it has them.
      for (const part of Array.from(entry.children)) {
        const box = part.getBoundingClientRect();
        expect(box.right).toBeLessThanOrEqual(stripBox.right + 0.5);
        expect(box.left).toBeGreaterThanOrEqual(stripBox.left - 0.5);
      }
      const label = entry.children[1]!;
      expect(label.textContent).not.toBe("");
      // Whole: its box is as wide as its text, so there is no ellipsis.
      expect(textWidth(label)).toBeLessThanOrEqual(label.getBoundingClientRect().width + 0.01);
    }
    // The lagging series is dated, and the date is inside the strip.
    const note = entries[1]!.querySelector("[data-readout-date-note]");
    expect(note).not.toBeNull();
    expect(note!.textContent).toMatch(/^· \d{1,2} [A-Z][a-z]+$/);
    expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth);
  };

  // At rest, and under a pointer near the newest end (where the lagging series
  // is still dated). All the mouse readings first: StockChart ignores mouse
  // events for 800ms after a touch (the browser replays a tap as a click), and
  // whatever ran before this ended on one.
  await new Promise((resolve) => setTimeout(resolve, 850));
  for (const w of widths) {
    await resizeTo(w);
    await waitFor(() => expect(state()).toBe("latest"));
    expectReadoutWhole();

    const rect = capture(canvasElement);
    const plot = rect.getBoundingClientRect();
    fireEvent.mouseMove(rect, {
      clientX: plot.left + plot.width * 0.995,
      clientY: plot.top + plot.height * 0.5,
    });
    await waitFor(() => expect(state()).toBe("hover"));
    expectReadoutWhole();
    // React derives onMouseLeave from mouseout; the DOM's own mouseleave is not it.
    fireEvent.mouseOut(rect, { relatedTarget: document.body });
    await waitFor(() => expect(state()).toBe("latest"));
  }

  // Then pinned by a touch. (A real browser's TouchEvent constructor insists on
  // real Touch objects; jsdom has none and accepts the plain shape.)
  for (const w of widths) {
    await resizeTo(w);
    const rect = capture(canvasElement);
    const plot = rect.getBoundingClientRect();
    const init = {
      identifier: 1,
      target: rect,
      clientX: plot.left + plot.width * 0.995,
      clientY: plot.top + plot.height * 0.6,
    };
    const touch = typeof Touch === "function" ? new Touch(init) : (init as unknown as Touch);
    fireEvent.touchStart(rect, { touches: [touch], changedTouches: [touch] });
    fireEvent.touchEnd(rect, { touches: [], changedTouches: [touch] });
    await waitFor(() => expect(state()).toBe("pinned"));
    expectReadoutWhole();
    fireEvent.click(within(canvasElement).getByRole("button", { name: "Release pinned reading" }));
    await waitFor(() => expect(state()).toBe("latest"));
  }
}

export const ReadoutStrip: Story = {
  name: "Readout strip",
  tags: ["no-visual"], // interaction-only; the static frame is covered by DualAxis
  args: {
    series: [priceSeries("PLS", "6m"), shortSeries("PLS", "6m")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 400,
  },
  // The default decorator makes the chart 854px wide: one 28px row.
  play: ({ canvasElement }) => playReadoutStrip(canvasElement, 28, 400, true),
};

// Short interest is published days after the day it describes (ASIC's lag), so
// production's short series ends before the price, and its entry carries its
// own date: the widest thing a phone strip has to hold.
const lagged = (s: ChartSeriesSpec, days: number): ChartSeriesSpec => ({
  ...s,
  points: s.points.slice(0, s.points.length - days),
});

export const ReadoutStripPhone: Story = {
  name: "Readout strip (phone)",
  tags: ["no-visual"], // interaction-only
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [priceSeries("PLS", "3m"), lagged(shortSeries("PLS", "3m"), 4)],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 360,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 380 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  // 342px wide: a headline row and a row for each of the two series, 62px.
  play: async ({ canvasElement }) => {
    await playReadoutStrip(canvasElement, 62, 360, false);
    // Then the widths a phone chart really has.
    await playPhoneWidths(canvasElement, [342, 326, 296]);
  },
};

// A click is a press and a release that do not zoom. The press clears the hover
// (a measure is starting), so in strip mode the release has to read the point
// under the pointer, or the strip would sit on "Latest" until the next move. Here
// in a real browser, where the point comes from the svg's own geometry and not a
// test's stand-in for it.
export const ReadoutStripClick: Story = {
  name: "Readout strip (click)",
  tags: ["no-visual"], // interaction-only
  args: {
    series: [priceSeries("PLS", "6m"), shortSeries("PLS", "6m")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 400,
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    const rect = capture(canvasElement);
    const plot = rect.getBoundingClientRect();
    const strip = () => canvasElement.querySelector<HTMLElement>("[data-chart-readout]")!;
    const state = () => strip().getAttribute("data-readout-state");
    const headline = () => strip().querySelector("[data-readout-headline]")?.textContent ?? "";
    const points = () => Number(canvasElement.querySelector("svg")!.getAttribute("data-points"));
    const dots = () => canvasElement.querySelectorAll("[data-chart-container] svg circle");
    const at = (fx: number) => ({
      clientX: plot.left + plot.width * fx,
      clientY: plot.top + plot.height * 0.5,
    });
    const before = points();
    expect(state()).toBe("latest");

    // A click: press and release on the plot. The strip is on the point under it,
    // and the crosshair is drawn there, within a point's width of the pointer.
    fireEvent.mouseDown(rect, { ...at(0.3), button: 0 });
    fireEvent.mouseUp(rect, at(0.3));
    await waitFor(() => expect(state()).toBe("hover"));
    expect(headline()).not.toContain("Latest");
    expect(dots()).toHaveLength(2);
    const dot = dots()[0]!.getBoundingClientRect();
    expect(Math.abs(dot.left + dot.width / 2 - at(0.3).clientX)).toBeLessThanOrEqual(
      plot.width / before,
    );
    expect(points()).toBe(before); // nothing was zoomed

    // The pointer leaving takes the hover away, as ever. (React derives
    // onMouseLeave from mouseout; the DOM's own mouseleave is not it.)
    fireEvent.mouseOut(rect, { relatedTarget: document.body });
    await waitFor(() => expect(state()).toBe("latest"));
    expect(dots()).toHaveLength(0);

    // A release that is not on the plot leaves no hover behind to hang there.
    fireEvent.mouseDown(rect, { ...at(0.4), button: 0 });
    fireEvent.mouseUp(strip(), at(0.4));
    await waitFor(() => expect(state()).toBe("latest"));
    expect(dots()).toHaveLength(0);

    // A drag that zooms ends on the zoomed view's resting reading, not a hover.
    fireEvent.mouseDown(rect, { ...at(0.2), button: 0 });
    fireEvent.mouseMove(rect, at(0.6));
    await waitFor(() => expect(state()).toBe("measure"));
    fireEvent.mouseUp(rect, at(0.6));
    await waitFor(() => expect(points()).toBeLessThan(before));
    expect(state()).toBe("latest");
    expect(headline()).not.toContain("Latest"); // a date alone, once zoomed
    expect(dots()).toHaveLength(0);

    // A click in the zoomed view reads a point of it; the reset that follows a
    // double-click does not keep that reading for the whole view it brings back.
    fireEvent.mouseDown(rect, { ...at(0.5), button: 0 });
    fireEvent.mouseUp(rect, at(0.5));
    await waitFor(() => expect(state()).toBe("hover"));
    fireEvent.doubleClick(rect, at(0.5));
    await waitFor(() => expect(points()).toBe(before));
    expect(state()).toBe("latest");
    expect(headline()).toContain("Latest");
    expect(dots()).toHaveLength(0);
  },
};

// A value that changes length as the pointer moves: a price crossing $100 goes
// from "$99.99" to "$100.00". On one row the entry after the price keeps its
// place, because the price holds the room of the widest value it can show.
const crossing = (f: (i: number) => number) =>
  Array.from({ length: 60 }, (_, i) => ({ t: Date.UTC(2026, 5, 1) + i * 86_400_000, v: f(i) }));

export const ReadoutStripDigitBoundary: Story = {
  name: "Readout strip (digit boundary)",
  tags: ["no-visual"], // interaction-only
  args: {
    series: [
      {
        id: "XYZ:price",
        label: "Price",
        color: seriesColor("price"),
        axis: "left",
        kind: "area",
        points: crossing((i) => 90 + (i * 20) / 59), // $90.00 to $110.00
      },
      {
        id: "XYZ:short",
        label: "Short %",
        color: seriesColor("short"),
        axis: "right",
        kind: "line",
        points: crossing((i) => 2 + (i % 7) * 0.3),
        measureMode: "absolute",
        measureUnit: "pp",
      },
    ],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 400,
  },
  // The default decorator makes the chart 854px wide: one row.
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
    const rect = capture(canvasElement);
    const strip = () => canvasElement.querySelector<HTMLElement>("[data-chart-readout]")!;
    const priceText = () =>
      strip().querySelector("[data-readout-entry] [data-readout-value]")!.textContent;
    const secondEntryLeft = () =>
      strip().querySelectorAll("[data-readout-entry]")[1]!.getBoundingClientRect().left;
    const box = rect.getBoundingClientRect();
    const at = (fx: number) => ({
      clientX: box.left + box.width * fx,
      clientY: box.top + box.height * 0.5,
    });

    // Resting: the newest price, "$110.00", seven characters.
    expect(priceText()).toBe("$110.00");
    const resting = secondEntryLeft();

    // Under $100 (six characters), then over it (seven): nothing after it moves.
    fireEvent.mouseMove(rect, at(0.2));
    await waitFor(() => expect(strip().getAttribute("data-readout-state")).toBe("hover"));
    expect(priceText()).toMatch(/^\$9\d\.\d\d$/);
    expect(secondEntryLeft()).toBeCloseTo(resting, 1);
    fireEvent.mouseMove(rect, at(0.8));
    await waitFor(() => expect(priceText()).toMatch(/^\$10\d\.\d\d$/));
    expect(secondEntryLeft()).toBeCloseTo(resting, 1);
  },
};

// Whatever an axis prints has to be inside the svg that draws it, because the svg
// clips the rest. Two things set that on a phone. The time axis' last label is
// centred on its tick, so when that tick is the newest day half of it hangs past
// the plot: with 12px beside the plot of a chart with no right axis, the Short
// interest tab (it opens on that view) cut "October" to "Octobe". And short
// interest to two decimals ("12.00%") is six characters, as wide as a price under
// $100, so a label there needs 46px of margin where it had 44. A price of $100 or
// more is a seventh character, 6px more: the margin follows the widest label the
// axis prints (axis-margin.ts), and "$140.00" needs 52px (it gets 53), not 48.
//
// A year of days to the first of October, so the newest day is itself a tick of
// the (quarterly) time axis, at the very edge of the plot: the worst case.
const FIRST_OF_OCTOBER = Date.UTC(2026, 9, 1);
const yearTo = (end: number, f: (i: number) => number) =>
  Array.from({ length: 366 }, (_, i) => ({ t: end - (365 - i) * 86_400_000, v: f(i) }));
const shortYear = (axis: "left" | "right"): ChartSeriesSpec => ({
  id: "XYZ:short",
  label: "Short %",
  color: seriesColor("short"),
  axis,
  kind: axis === "left" ? "area" : "line",
  points: yearTo(FIRST_OF_OCTOBER, (i) => 12.25 + (i % 11) * 0.43), // 12.25 to 16.55: two-digit
  measureMode: "absolute",
  measureUnit: "pp",
});
const priceYear: ChartSeriesSpec = {
  id: "XYZ:price",
  label: "Price",
  color: seriesColor("price"),
  axis: "left",
  kind: "area",
  points: yearTo(FIRST_OF_OCTOBER, (i) => 40.5 + (i % 17) * 0.3), // $40.50 to $45.30: six characters
};
// A large cap (CBA's range): "$140.00" to "$180.00", seven characters. The margin
// that held six began them outside the svg, and cut off the "$1".
const expensiveYear: ChartSeriesSpec = {
  ...priceYear,
  id: "XYZ:price",
  points: yearTo(FIRST_OF_OCTOBER, (i) => 140.4 + (i % 17) * 3.1), // $140.40 to $190.00
};

/** The text the chart's svg draws that does not lie wholly inside it. */
function labelsOutside(canvasElement: HTMLElement): string[] {
  const svg = canvasElement.querySelector("[data-chart-container] svg")!;
  const box = svg.getBoundingClientRect();
  return Array.from(svg.querySelectorAll<SVGTextElement>("text"))
    .filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
    })
    .map((t) => `${t.textContent} (${t.getBoundingClientRect().left - box.left}, ${box.right - t.getBoundingClientRect().right})`);
}

/**
 * At each chart width a phone has: 326px in a 390px viewport, 296px in a 360px one.
 * `wide` is the value label this is about, which has to be drawn for the check to
 * mean anything: a six-character one by default, "$40.00" or "12.00%".
 */
async function playLabelsWhole(canvasElement: HTMLElement, wide = /^\$?\d\d\.\d\d%?$/) {
  await waitFor(() => expect(capture(canvasElement)).toBeTruthy());
  const svg = () => canvasElement.querySelector<SVGSVGElement>("[data-chart-container] svg")!;
  // The decorator's frame pads 8px and borders 1px on each side: 18px in all.
  const frame = svg().closest<HTMLElement>(".rounded-lg")!;
  for (const chartWidth of [326, 296]) {
    frame.style.width = `${chartWidth + 18}px`;
    await waitFor(() => expect(Number(svg().getAttribute("width"))).toBe(chartWidth));
    const printed = Array.from(svg().querySelectorAll("text"), (t) => t.textContent);
    // The label this is about is there to be cut, and so is the value label.
    expect(printed.filter((t) => t === "October").length).toBeGreaterThanOrEqual(1);
    expect(printed.some((t) => wide.test(t ?? ""))).toBe(true);
    expect(labelsOutside(canvasElement), `at ${chartWidth}px wide`).toEqual([]);
  }
}

export const LabelsWholeShortOnly: Story = {
  name: "Axis labels whole (short only, phone)",
  tags: ["no-visual"], // interaction-only
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [shortYear("left")],
    leftAxis: { side: "left", format: shortFmt },
    height: 360,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 344, height: 380 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  play: ({ canvasElement }) => playLabelsWhole(canvasElement),
};

export const LabelsWholeCombined: Story = {
  name: "Axis labels whole (price and short, phone)",
  tags: ["no-visual"], // interaction-only
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [priceYear, shortYear("right")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 360,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 344, height: 380 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  play: ({ canvasElement }) => playLabelsWhole(canvasElement),
};

export const LabelsWholeLargeCap: Story = {
  name: "Axis labels whole (price of $100 or more, phone)",
  tags: ["no-visual"], // interaction-only
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [expensiveYear],
    leftAxis: { side: "left", format: priceFmt },
    height: 360,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 344, height: 380 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  play: ({ canvasElement }) => playLabelsWhole(canvasElement, /^\$\d{3}\.\d\d$/),
};

export const LabelsWholeLargeCapCombined: Story = {
  name: "Axis labels whole (price of $100 or more and short, phone)",
  tags: ["no-visual"], // interaction-only
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    series: [expensiveYear, shortYear("right")],
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
    height: 360,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 344, height: 380 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
  play: ({ canvasElement }) => playLabelsWhole(canvasElement, /^\$\d{3}\.\d\d$/),
};

export const Empty: Story = {
  args: { series: [], height: 300 },
  play: async ({ canvasElement }) => {
    // No crash; renders an svg (or nothing) without throwing.
    await waitFor(() => expect(canvasElement).toBeTruthy());
  },
};
