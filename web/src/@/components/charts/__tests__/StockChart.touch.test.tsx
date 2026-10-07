import { act, fireEvent, render } from "@testing-library/react";
import { StockChartInner } from "../StockChart";
import type { ChartSeriesSpec } from "../types";

// localPoint needs real SVG geometry (getScreenCTM); jsdom has none. Resolve a
// touch/mouse event's client coords as the chart-local point.
jest.mock("@visx/event", () => ({
  localPoint: (e: {
    touches?: ArrayLike<{ clientX: number; clientY: number }>;
    changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
    clientX?: number;
    clientY?: number;
  }) => {
    const t = e.touches?.[0] ?? e.changedTouches?.[0];
    if (t) return { x: t.clientX, y: t.clientY };
    if (e.clientX == null) return null;
    return { x: e.clientX, y: e.clientY ?? 0 };
  },
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const WIDTH = 400;
const HEIGHT = 300;
// StockChart margins with a right axis, full variant.
const M = { top: 8, left: 44, right: 44 };
const INNER_W = WIDTH - M.left - M.right; // 312 -> 10 points, ~34.7px apart

const mk = (id: string, label: string, axis: "left" | "right", base: number): ChartSeriesSpec => ({
  id,
  label,
  color: "#123456",
  axis,
  kind: "line",
  points: Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: base + i })),
});
const SERIES = [mk("price", "Price", "left", 40), mk("short", "Short %", "right", 2)];

/** Client x (== chart-local x in the mocked localPoint) of point index i. */
const xOf = (i: number) => M.left + (INNER_W * i) / 9;
const dateLabel = (i: number) =>
  new Date(T0 + i * DAY).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

function renderChart(series = SERIES) {
  const utils = render(
    <StockChartInner width={WIDTH} height={HEIGHT} series={series} />,
  );
  const plot = utils.container.querySelector("[data-chart-capture]") as SVGRectElement;
  expect(plot).toBeTruthy();
  const tip = () => utils.container.querySelector<HTMLElement>("[data-chart-tooltip]");
  return { ...utils, plot, tip };
}

const pt = (x: number, y = 120) => ({ clientX: x, clientY: y });

function tap(plot: Element, x: number, y = 120) {
  fireEvent.touchStart(plot, { touches: [pt(x, y)], changedTouches: [pt(x, y)] });
  fireEvent.touchEnd(plot, { touches: [], changedTouches: [pt(x, y)] });
}

function mockMatchMedia(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  });
}

let nowSpy: jest.SpyInstance<number, []>;
let now = 1_000_000;
beforeEach(() => {
  // Mouse events right after a touch are treated as the browser's synthetic
  // replay of the tap and ignored; drive the clock explicitly.
  now = 1_000_000;
  nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  nowSpy.mockRestore();
  // @ts-expect-error -- jsdom has no matchMedia by default; restore that.
  delete window.matchMedia;
});

describe("StockChart touch: scrub, lift to pin, re-tap to release", () => {
  it("keeps the reading visible after the finger lifts", () => {
    const { plot, tip } = renderChart();
    fireEvent.touchStart(plot, { touches: [pt(xOf(1))], changedTouches: [pt(xOf(1))] });
    // A tap shows the reading immediately, before any movement.
    expect(tip()).not.toBeNull();
    // Scrub to point 3, then lift.
    fireEvent.touchMove(plot, { touches: [pt(xOf(3))], changedTouches: [pt(xOf(3))] });
    fireEvent.touchEnd(plot, { touches: [], changedTouches: [pt(xOf(3))] });

    const el = tip();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain(dateLabel(3));
    expect(el!.textContent).toContain("Price");
    expect(el!.textContent).toContain("Short %");
    expect(el!.hasAttribute("data-pinned")).toBe(true);
    expect(el!.getAttribute("role")).toBe("status");
    expect(el!.style.pointerEvents).toBe("auto");
  });

  it("a second tap on the pinned point releases it", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(4));
    expect(tip()).not.toBeNull();
    now += 2000;
    tap(plot, xOf(4));
    expect(tip()).toBeNull();
  });

  it("a tap elsewhere moves the pin instead of releasing it", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(2));
    now += 2000;
    tap(plot, xOf(7));
    expect(tip()).not.toBeNull();
    expect(tip()!.textContent).toContain(dateLabel(7));
  });

  it("the release button unpins", () => {
    const { plot, tip, getByRole } = renderChart();
    tap(plot, xOf(5));
    fireEvent.click(getByRole("button", { name: /release pinned reading/i }));
    expect(tip()).toBeNull();
  });

  it("a press outside the chart releases the pin", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(5));
    expect(tip()).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(tip()).toBeNull();

    tap(plot, xOf(6));
    expect(tip()).not.toBeNull();
    act(() => {
      fireEvent.touchStart(document.body, { touches: [pt(5, 5)] });
    });
    expect(tip()).toBeNull();
  });

  it("changing the series drops the pin", () => {
    const { plot, tip, rerender } = renderChart();
    tap(plot, xOf(5));
    expect(tip()).not.toBeNull();
    rerender(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={[mk("price-1y", "Price", "left", 40), SERIES[1]!]}
      />,
    );
    expect(tip()).toBeNull();
  });

  it("touchcancel drops the live reading but keeps an existing pin", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.touchStart(plot, { touches: [pt(xOf(8))], changedTouches: [pt(xOf(8))] });
    expect(tip()!.textContent).toContain(dateLabel(8));
    fireEvent.touchCancel(plot, { touches: [], changedTouches: [] });
    expect(tip()!.textContent).toContain(dateLabel(2));
  });

  it("ignores the browser's synthetic mouse replay of a tap", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(5));
    // Replayed mousemove/mousedown arrive within ms of touchend.
    now += 50;
    fireEvent.mouseMove(plot, pt(xOf(5)));
    fireEvent.mouseDown(plot, { ...pt(xOf(5)), button: 0 });
    fireEvent.mouseUp(window);
    const el = tip();
    expect(el).not.toBeNull();
    expect(el!.hasAttribute("data-pinned")).toBe(true);
  });
});

describe("StockChart mouse: unchanged desktop hover", () => {
  it("shows on move, hides on leave, never pins", () => {
    const { plot, tip } = renderChart();
    fireEvent.mouseMove(plot, pt(xOf(3), 50));
    const el = tip();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain(dateLabel(3));
    expect(el!.hasAttribute("data-pinned")).toBe(false);
    expect(el!.style.pointerEvents).toBe("none");
    fireEvent.mouseLeave(plot);
    expect(tip()).toBeNull();
  });

  it("a live mouse hover overrides a pin, and the pin returns on leave", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.mouseMove(plot, pt(xOf(7), 50));
    expect(tip()!.textContent).toContain(dateLabel(7));
    fireEvent.mouseLeave(plot);
    expect(tip()!.textContent).toContain(dateLabel(2));
  });

  it("starting a drag-measure releases a pin", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.mouseDown(plot, { ...pt(xOf(4)), button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseLeave(plot);
    expect(tip()).toBeNull();
  });

  it("double-click reset releases a pin", () => {
    const { plot, tip } = renderChart();
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.doubleClick(plot, pt(xOf(4)));
    expect(tip()).toBeNull();
  });
});

describe("StockChart tooltip placement", () => {
  it("fine pointer: the tooltip follows the cursor (cy + 14)", () => {
    mockMatchMedia(false);
    const { plot, tip } = renderChart();
    fireEvent.mouseMove(plot, pt(xOf(3), 50));
    expect(tip()!.style.top).toBe(`${50 + 14}px`);
    expect(tip()!.hasAttribute("data-docked")).toBe(false);
  });

  it("coarse pointer: the tooltip docks in the top corner away from the finger", () => {
    mockMatchMedia(true);
    const { plot, tip } = renderChart();
    // Crosshair on the left half -> tooltip on the right.
    tap(plot, xOf(2), 200);
    let el = tip()!;
    expect(el.style.top).toBe(`${M.top + 4}px`);
    expect(el.style.left).toBe(`${WIDTH - 168 - 4}px`);
    // Crosshair on the right half -> tooltip on the left.
    now += 2000;
    tap(plot, xOf(8), 200);
    el = tip()!;
    expect(el.style.top).toBe(`${M.top + 4}px`);
    expect(el.style.left).toBe(`${M.left + 4}px`);
  });

  it("touch on a fine-pointer device (touchscreen laptop) still docks", () => {
    mockMatchMedia(false);
    const { plot, tip } = renderChart();
    tap(plot, xOf(2), 200);
    expect(tip()!.style.top).toBe(`${M.top + 4}px`);
  });
});
