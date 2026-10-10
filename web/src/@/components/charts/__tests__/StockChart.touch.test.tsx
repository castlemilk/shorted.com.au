import { act, fireEvent, render, within } from "@testing-library/react";
import { StockChartInner } from "../StockChart";
import * as chartLevels from "../chart-levels";
import * as chartReadout from "../chart-readout";
import type { ChartSeriesSpec, StockChartProps } from "../types";

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

/** Client x (== chart-local x in the mocked localPoint) of point index i, at a chart `width` wide. */
const xAt = (width: number, i: number) =>
  M.left + ((width - M.left - M.right) * i) / 9;
const xOf = (i: number) => xAt(WIDTH, i);

type Mode = "strip" | "tooltip";
const MODES: readonly Mode[] = ["strip", "tooltip"];

// The strip prints a date in en-AU on the Sydney calendar; the floating card
// prints it in the browser's locale. Neither is taken from the code under test.
const sydneyDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});
const stripDate = (i: number) => sydneyDate.format(T0 + i * DAY);
const cardDate = (i: number) =>
  new Date(T0 + i * DAY).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
/** The date of point `i` as the reading in `mode` prints it. */
const dateLabel = (mode: Mode, i: number) =>
  mode === "strip" ? stripDate(i) : cardDate(i);

function renderChart(
  series = SERIES,
  readout: Mode = "strip",
  props: Partial<StockChartProps> = {},
) {
  const utils = render(
    <StockChartInner
      width={WIDTH}
      height={HEIGHT}
      series={series}
      readout={readout}
      {...props}
    />,
  );
  const plot = utils.container.querySelector("[data-chart-capture]") as SVGRectElement;
  expect(plot).toBeTruthy();
  /**
   * The hovered or pinned reading on screen, else null: the floating card in
   * tooltip mode; in strip mode the strip once it has left the resting reading.
   */
  const reading = () => {
    if (readout === "tooltip") {
      return utils.container.querySelector<HTMLElement>("[data-chart-tooltip]");
    }
    const strip = utils.container.querySelector<HTMLElement>("[data-chart-readout]");
    const state = strip?.getAttribute("data-readout-state");
    return state === "hover" || state === "pinned" ? strip : null;
  };
  return { ...utils, plot, reading };
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

// Pin, release, re-tap, a press outside and a mouse hover work the same whether
// the reading is the strip above the plot or the card that follows the cursor.
describe.each(MODES)("StockChart touch (%s): scrub, lift to pin, re-tap to release", (mode) => {
  it("keeps the reading visible after the finger lifts", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    fireEvent.touchStart(plot, { touches: [pt(xOf(1))], changedTouches: [pt(xOf(1))] });
    // A tap shows the reading immediately, before any movement.
    expect(reading()).not.toBeNull();
    // Scrub to point 3, then lift.
    fireEvent.touchMove(plot, { touches: [pt(xOf(3))], changedTouches: [pt(xOf(3))] });
    fireEvent.touchEnd(plot, { touches: [], changedTouches: [pt(xOf(3))] });

    const el = reading();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain(dateLabel(mode, 3));
    expect(el!.textContent).toContain("Price");
    expect(el!.textContent).toContain("Short %");
    expect(el!.hasAttribute("data-pinned")).toBe(true);
  });

  it("a second tap on the pinned point releases it", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(4));
    expect(reading()).not.toBeNull();
    now += 2000;
    tap(plot, xOf(4));
    expect(reading()).toBeNull();
  });

  it("a tap elsewhere moves the pin instead of releasing it", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(2));
    now += 2000;
    tap(plot, xOf(7));
    expect(reading()).not.toBeNull();
    expect(reading()!.textContent).toContain(dateLabel(mode, 7));
  });

  it("the release button unpins", () => {
    const { plot, reading, getByRole } = renderChart(SERIES, mode);
    tap(plot, xOf(5));
    fireEvent.click(getByRole("button", { name: /release pinned reading/i }));
    expect(reading()).toBeNull();
  });

  it("a press outside the chart releases the pin", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(5));
    expect(reading()).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(reading()).toBeNull();

    tap(plot, xOf(6));
    expect(reading()).not.toBeNull();
    act(() => {
      fireEvent.touchStart(document.body, { touches: [pt(5, 5)] });
    });
    expect(reading()).toBeNull();
  });

  it("changing the series drops the pin", () => {
    const { plot, reading, rerender } = renderChart(SERIES, mode);
    tap(plot, xOf(5));
    expect(reading()).not.toBeNull();
    rerender(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={[mk("price-1y", "Price", "left", 40), SERIES[1]!]}
        readout={mode}
      />,
    );
    expect(reading()).toBeNull();
  });

  it("touchcancel drops the live reading but keeps an existing pin", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.touchStart(plot, { touches: [pt(xOf(8))], changedTouches: [pt(xOf(8))] });
    expect(reading()!.textContent).toContain(dateLabel(mode, 8));
    fireEvent.touchCancel(plot, { touches: [], changedTouches: [] });
    expect(reading()!.textContent).toContain(dateLabel(mode, 2));
  });

  it("ignores the browser's synthetic mouse replay of a tap", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(5));
    // Replayed mousemove/mousedown arrive within ms of touchend.
    now += 50;
    fireEvent.mouseMove(plot, pt(xOf(5)));
    fireEvent.mouseDown(plot, { ...pt(xOf(5)), button: 0 });
    fireEvent.mouseUp(window);
    const el = reading();
    expect(el).not.toBeNull();
    expect(el!.hasAttribute("data-pinned")).toBe(true);
  });
});

describe.each(MODES)("StockChart mouse (%s): unchanged desktop hover", (mode) => {
  it("shows on move, hides on leave, never pins", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    fireEvent.mouseMove(plot, pt(xOf(3), 50));
    const el = reading();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain(dateLabel(mode, 3));
    expect(el!.hasAttribute("data-pinned")).toBe(false);
    fireEvent.mouseLeave(plot);
    expect(reading()).toBeNull();
  });

  it("a live mouse hover overrides a pin, and the pin returns on leave", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.mouseMove(plot, pt(xOf(7), 50));
    expect(reading()!.textContent).toContain(dateLabel(mode, 7));
    fireEvent.mouseLeave(plot);
    expect(reading()!.textContent).toContain(dateLabel(mode, 2));
  });

  it("starting a drag-measure releases a pin", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.mouseDown(plot, { ...pt(xOf(4)), button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseLeave(plot);
    expect(reading()).toBeNull();
  });

  it("double-click reset releases a pin", () => {
    const { plot, reading } = renderChart(SERIES, mode);
    tap(plot, xOf(2));
    now += 2000;
    fireEvent.doubleClick(plot, pt(xOf(4)));
    expect(reading()).toBeNull();
  });
});

// The floating card's own behaviour: it is the tooltip mode's alone.
describe("StockChart tooltip placement", () => {
  it("fine pointer: the tooltip follows the cursor (cy + 14)", () => {
    mockMatchMedia(false);
    const { plot, reading } = renderChart(SERIES, "tooltip");
    fireEvent.mouseMove(plot, pt(xOf(3), 50));
    expect(reading()!.style.top).toBe(`${50 + 14}px`);
    expect(reading()!.hasAttribute("data-docked")).toBe(false);
  });

  it("coarse pointer: the tooltip docks in the top corner away from the finger", () => {
    mockMatchMedia(true);
    const { plot, reading } = renderChart(SERIES, "tooltip");
    // Crosshair on the left half -> tooltip on the right.
    tap(plot, xOf(2), 200);
    let el = reading()!;
    expect(el.style.top).toBe(`${M.top + 4}px`);
    expect(el.style.left).toBe(`${WIDTH - 168 - 4}px`);
    // Crosshair on the right half -> tooltip on the left.
    now += 2000;
    tap(plot, xOf(8), 200);
    el = reading()!;
    expect(el.style.top).toBe(`${M.top + 4}px`);
    expect(el.style.left).toBe(`${M.left + 4}px`);
  });

  it("touch on a fine-pointer device (touchscreen laptop) still docks", () => {
    mockMatchMedia(false);
    const { plot, reading } = renderChart(SERIES, "tooltip");
    tap(plot, xOf(2), 200);
    expect(reading()!.style.top).toBe(`${M.top + 4}px`);
  });

  it("a pinned card is a live region with a release button, and a hover never takes the pointer", () => {
    const { plot, reading } = renderChart(SERIES, "tooltip");
    fireEvent.mouseMove(plot, pt(xOf(3), 50));
    expect(reading()!.style.pointerEvents).toBe("none");
    fireEvent.mouseLeave(plot);

    tap(plot, xOf(3));
    const el = reading()!;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.style.pointerEvents).toBe("auto");
    expect(el.textContent).toContain("Pinned · tap chart to move, tap again to release");
  });
});

describe("StockChart reference levels, bands and markers", () => {
  it("draws reference bands under the series and levels/markers over it, clipped to the plot", () => {
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        bands={[{ axis: "left", low: 41, high: 44, from: T0 - 5 * DAY, to: T0 + 3 * DAY, color: "#00f", label: "base" }]}
        levels={[
          { axis: "left", value: 45, label: "Pivot $45", color: "#f90" },
          { axis: "left", value: 999, label: "off the plot", color: "#f90" },
        ]}
        markers={[{ t: T0 + 2 * DAY, label: "breakout", color: "#0f0" }, { t: T0 + 40 * DAY, label: "outside", color: "#0f0" }]}
      />,
    );
    expect(container.querySelectorAll("[data-chart-band]")).toHaveLength(1);
    expect(container.querySelector("[data-chart-band]")).toHaveAttribute("x", "0");
    expect(container.querySelectorAll("[data-chart-level]")).toHaveLength(1);
    expect(container.querySelector("[data-chart-level] text")).toHaveTextContent("Pivot $45");
    expect(container.querySelectorAll("[data-chart-marker]")).toHaveLength(1);

    // SVG paints in document order: the band sits under every series, the level
    // and marker over them, and the pointer-capture rect stays on top of all.
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const band = container.querySelector("[data-chart-band]")!;
    const level = container.querySelector("[data-chart-level]")!;
    const marker = container.querySelector("[data-chart-marker]")!;
    const capture = container.querySelector("[data-chart-capture]")!;
    const drawn = Array.from(container.querySelectorAll("[data-series]"));
    expect(drawn).toHaveLength(SERIES.length);
    for (const s of drawn) {
      expect(follows(band, s)).toBe(true);
      expect(follows(s, level)).toBe(true);
      expect(follows(s, marker)).toBe(true);
    }
    expect(follows(level, capture)).toBe(true);
    expect(follows(marker, capture)).toBe(true);
  });

  it.each(MODES)("the %s reading ignores levels, bands and markers", (mode) => {
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        readout={mode}
        bands={[{ axis: "left", low: 41, high: 44, from: T0, to: T0 + 5 * DAY, color: "#00f", label: "Base 41-44" }]}
        levels={[{ axis: "left", value: 45, label: "Pivot $45", color: "#f90" }]}
        markers={[{ t: T0 + 3 * DAY, label: "Breakout", color: "#0f0" }]}
      />,
    );
    fireEvent.mouseMove(container.querySelector("[data-chart-capture]")!, pt(xOf(3), 50));
    const reading = container.querySelector<HTMLElement>(
      mode === "strip" ? "[data-chart-readout]" : "[data-chart-tooltip]",
    );
    expect(reading).not.toBeNull();
    expect(reading!.textContent).toContain("Price");
    expect(reading!.textContent).toContain("Short %");
    for (const label of ["Pivot", "Base 41-44", "Breakout"]) {
      expect(reading!.textContent).not.toContain(label);
    }
  });

  it("places a level on the axis it names, never below the plot floor, and a marker at its session", () => {
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        leftAxis={{ side: "left", domain: [40, 50] }}
        rightAxis={{ side: "right", domain: [0, 10] }}
        levels={[
          { axis: "left", value: 45, label: "left 45", color: "#f90" },
          { axis: "right", value: 45, label: "right 45", color: "#f90" }, // far above the right scale
          { axis: "right", value: 5, label: "right 5", color: "#f90" },
          { axis: "left", value: 5, label: "left 5", color: "#f90" }, // far below the left scale
          { axis: "left", value: 39, label: "under the floor", color: "#f90" }, // in the x-axis margin
        ]}
        markers={[{ t: T0 + 2 * DAY, label: "breakout", color: "#0f0" }]}
      />,
    );
    const labels = Array.from(container.querySelectorAll("[data-chart-level] text")).map((t) => t.textContent);
    expect(labels).toEqual(["left 45", "right 5"]);
    const markerX = Number(container.querySelector("[data-chart-marker] line")!.getAttribute("x1"));
    expect(markerX).toBeCloseTo((INNER_W * 2) / 9, 5);
  });

  it("draws nothing for a level, band or marker the scale cannot place, never at a plot edge", () => {
    // The scale answers undefined for a NaN; coalescing that to 0 would draw a labelled line
    // along the top or left edge, so each unplaceable one sits beside a placeable one.
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        bands={[
          { axis: "left", low: NaN, high: 44, from: T0, to: T0 + 5 * DAY, color: "#00f", label: "no low" },
          { axis: "left", low: 41, high: NaN, from: T0, to: T0 + 5 * DAY, color: "#00f", label: "no high" },
          { axis: "left", low: 41, high: 44, from: NaN, to: T0 + 5 * DAY, color: "#00f", label: "no start" },
          { axis: "left", low: 41, high: 44, from: T0, to: T0 + 5 * DAY, color: "#00f", label: "base" },
        ]}
        levels={[
          { axis: "left", value: NaN, label: "no value", color: "#f90" },
          { axis: "left", value: 45, label: "no start", color: "#f90", from: NaN, to: T0 + 5 * DAY },
          { axis: "left", value: 45, label: "Pivot $45", color: "#f90" },
        ]}
        markers={[
          { t: NaN, label: "no session", color: "#0f0" },
          { t: T0 + 2 * DAY, label: "breakout", color: "#0f0" },
        ]}
      />,
    );
    const drawn = (selector: string) => Array.from(container.querySelectorAll(selector), (el) => el.textContent);
    expect({
      bands: drawn("[data-chart-band] title"),
      levels: drawn("[data-chart-level] text"),
      markers: drawn("[data-chart-marker] text"),
    }).toEqual({ bands: ["base"], levels: ["Pivot $45"], markers: ["breakout"] });
  });

  it("draws crowded level labels apart with every line at its own value, and a marker label inside the plot", () => {
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        levels={[
          { axis: "left", value: 45, label: "SMA 50 $45", color: "#f90" },
          { axis: "left", value: 45.1, label: "SMA 150 $45.1", color: "#09f" },
          { axis: "left", value: 45.2, label: "SMA 200 $45.2", color: "#0f9" },
        ]}
        markers={[
          { t: T0 + 2 * DAY, label: "Breakout", color: "#0f0" },
          { t: T0 + 8.5 * DAY, label: "Late breakout", color: "#0f0" },
        ]}
      />,
    );
    const rows = Array.from(container.querySelectorAll("[data-chart-level]"), (g) => ({
      line: Number(g.querySelector("line")!.getAttribute("y1")),
      line2: Number(g.querySelector("line")!.getAttribute("y2")),
      label: Number(g.querySelector("text")!.getAttribute("y")),
    })).sort((a, b) => a.line - b.line);
    expect(rows).toHaveLength(3);
    // The lines are a few px apart (they would overlap their labels) and flat, each at its own value.
    expect(rows[1]!.line - rows[0]!.line).toBeGreaterThan(0);
    expect(rows[2]!.line - rows[0]!.line).toBeLessThan(11);
    for (const r of rows) expect(r.line2).toBe(r.line);
    // The top label keeps its place 4 px above its line; the rest are at least 11 px below the one above.
    expect(rows[0]!.label).toBeCloseTo(rows[0]!.line - 4, 5);
    expect(rows[1]!.label - rows[0]!.label).toBeGreaterThanOrEqual(11);
    expect(rows[2]!.label - rows[1]!.label).toBeGreaterThanOrEqual(11);

    // "Late breakout" has no room on the right of a line near the plot's right edge.
    const markers = Array.from(container.querySelectorAll("[data-chart-marker] text"));
    expect(markers.map((t) => t.getAttribute("text-anchor"))).toEqual(["start", "end"]);
    const lateX = Number(markers[1]!.getAttribute("x"));
    expect(lateX).toBeCloseTo((INNER_W * 8.5) / 9 - 4, 5);
    expect(lateX).toBeLessThanOrEqual(INNER_W);
  });

  it("draws the label of a short level inside the plot instead of in the axis margin", () => {
    // The line ends 6.9 px into the plot; "Pivot $45" is about 54 px wide, so its right edge
    // moves to 54 rather than sitting 4 px inside the line's end.
    const { container } = render(
      <StockChartInner
        width={WIDTH}
        height={HEIGHT}
        series={SERIES}
        levels={[{ axis: "left", value: 45, label: "Pivot $45", color: "#f90", from: T0 - 5 * DAY, to: T0 + 0.2 * DAY }]}
      />,
    );
    const label = container.querySelector("[data-chart-level] text")!;
    expect(label).toHaveTextContent("Pivot $45");
    expect(label.getAttribute("text-anchor")).toBe("end");
    expect(Number(label.getAttribute("x"))).toBe(54);
  });

  it("does not lay the reference geometry out again when a re-render changes nothing", () => {
    // Omitted levels, bands and markers must default to the same arrays every render.
    const layout = jest.spyOn(chartLevels, "layoutLevels");
    try {
      const { rerender } = render(<StockChartInner width={WIDTH} height={HEIGHT} series={SERIES} />);
      rerender(<StockChartInner width={WIDTH} height={HEIGHT} series={SERIES} />);
      expect(layout).toHaveBeenCalledTimes(1);
    } finally {
      layout.mockRestore();
    }
  });
});

// Both homes of the drag-measure reading, the strip and the floating card, go
// through one model: the same dates (en-AU, Sydney), the same numbers, and red
// or green only for a change that is market direction.
describe.each(MODES)("StockChart drag-measure readout (%s)", (mode) => {
  // Short interest is already a percentage, so it measures in points; price in percent.
  const SHORT_PP: ChartSeriesSpec = {
    ...SERIES[1]!,
    measureMode: "absolute",
    measureUnit: "pp",
  };
  const SHORT_FALLING_PP: ChartSeriesSpec = {
    ...SHORT_PP,
    points: Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: 12 - i })),
  };
  const FALLING: ChartSeriesSpec = {
    ...SERIES[0]!,
    points: Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: 50 - i })),
  };
  const RED = "rgb(220, 38, 38)";
  const GREEN = "rgb(22, 163, 74)";

  /**
   * Press at point `from`, drag to point `to`, and return the readout.
   * Keep the right-axis series in: xOf() is laid out for a chart that has one.
   */
  function measure(series: ChartSeriesSpec[], from: number, to: number) {
    const { plot, container } = renderChart(series, mode);
    fireEvent.mouseDown(plot, { ...pt(xOf(from)), button: 0 });
    fireEvent.mouseMove(plot, pt(xOf(to)));
    const readout = container.querySelector<HTMLElement>('[data-chart="measure-readout"]');
    expect(readout).not.toBeNull();
    return readout!;
  }

  it("reports price as a percent and short interest as points to two decimals", () => {
    // Price 42 -> 46; short 4 -> 8. The strip adds an arrow before a points change.
    const readout = measure([SERIES[0]!, SHORT_PP], 2, 6);
    const arrow = mode === "strip" ? "▲" : "";
    expect(readout.textContent).toBe(
      `${stripDate(2)} → ${stripDate(6)}Price+9.5%Short %${arrow}+4.00 pp`,
    );
  });

  it("dates both ends in en-AU on the Sydney calendar, never in the browser's locale", () => {
    // This environment's own locale is en-AU, so stub the API that follows the
    // browser's: the old card read its dates through it.
    const browserLocale = jest
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("BROWSER-LOCALE-DATE");
    try {
      const readout = measure([SERIES[0]!, SHORT_PP], 1, 7);
      expect(readout.textContent).toContain(`${stripDate(1)} → ${stripDate(7)}`);
      expect(readout.textContent).not.toContain("BROWSER-LOCALE-DATE");
    } finally {
      browserLocale.mockRestore();
    }
  });

  it("colours a rise green", () => {
    const readout = measure([SERIES[0]!, SHORT_PP], 2, 6);
    expect(within(readout).getByText("+9.5%").style.color).toBe(GREEN);
  });

  it("colours a fall red", () => {
    // Price 48 -> 44.
    const readout = measure([FALLING, SHORT_PP], 2, 6);
    expect(within(readout).getByText("-8.3%").style.color).toBe(RED);
  });

  it.each([
    ["rising", SHORT_PP, "+4.00 pp"],
    ["falling", SHORT_FALLING_PP, "-4.00 pp"],
  ] as const)(
    "keeps a %s percentage-point change in the foreground, never red or green",
    (_, short, text) => {
      const readout = measure([SERIES[0]!, short], 2, 6);
      const color = within(readout).getByText(text).style.color;
      expect([GREEN, RED]).not.toContain(color);
    },
  );
});

const sydneyDay = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  timeZone: "Australia/Sydney",
});
const stripDay = (i: number) => sydneyDay.format(T0 + i * DAY);

/** A series with an open, high, low and close on points 0 to `upTo` - 1. */
const withOhlc = (s: ChartSeriesSpec, upTo = 5): ChartSeriesSpec => ({
  ...s,
  points: s.points.map((p, i) =>
    i < upTo ? { ...p, open: p.v - 1, high: p.v + 1, low: p.v - 2, close: p.v } : p,
  ),
});

describe("StockChart readout strip", () => {
  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-chart-readout]")!;
  const stateOf = (c: HTMLElement) => strip(c).getAttribute("data-readout-state");
  const headline = (c: HTMLElement) =>
    strip(c).querySelector("[data-readout-headline]")?.textContent ?? null;
  const entryOf = (c: HTMLElement, id: string) =>
    c.querySelector<HTMLElement>(`[data-readout-entry="${id}"]`)!;
  // The strip holds no svg, so the first svg in the container is the chart's.
  const svgOf = (c: HTMLElement) => c.querySelector("svg")!;
  const GREEN = "rgb(22, 163, 74)";

  describe("what it is and where it sits", () => {
    it("is the default reading", () => {
      const { container } = render(
        <StockChartInner width={WIDTH} height={HEIGHT} series={SERIES} />,
      );
      expect(strip(container)).not.toBeNull();
    });

    it("is the first child of the container, before the svg", () => {
      const { container } = renderChart();
      const root = container.querySelector("[data-chart-container]")!;
      expect(root.firstElementChild).toBe(strip(container));
      expect(
        strip(container).compareDocumentPosition(svgOf(container)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("is not announced as it changes", () => {
      const { container } = renderChart();
      expect(strip(container).getAttribute("aria-live")).toBe("off");
    });

    it("hides its colour dots from assistive technology", () => {
      const { container } = renderChart();
      const dot = entryOf(container, "price").firstElementChild!;
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    });

    it("leaves tooltip mode as it was: no strip, the svg takes the whole height", () => {
      const { container } = renderChart(SERIES, "tooltip");
      expect(container.querySelector("[data-chart-readout]")).toBeNull();
      expect(svgOf(container).getAttribute("height")).toBe(String(HEIGHT));
      expect(svgOf(container).hasAttribute("style")).toBe(false);
    });
  });

  describe("its height depends on the chart's width and nothing else", () => {
    it.each([
      [360, 44],
      [900, 28],
    ])("at %ipx wide the svg is the height prop minus the %ipx strip", (width, stripH) => {
      const { container } = render(
        <StockChartInner width={width} height={400} series={SERIES} />,
      );
      expect(svgOf(container).getAttribute("height")).toBe(String(400 - stripH));
      expect(strip(container).style.height).toBe(`${stripH}px`);
      // The two add up to the component's total, so nothing below the chart moves.
      expect(svgOf(container).style.display).toBe("block");
    });

    it("is the same in the latest, hover, pinned and measure states", () => {
      const { container, plot } = renderChart();
      const seen: [string | null, string][] = [];
      const note = () => seen.push([stateOf(container), strip(container).style.height]);

      note(); // latest
      fireEvent.mouseMove(plot, pt(xOf(3), 50));
      note(); // hover
      fireEvent.mouseLeave(plot);
      tap(plot, xOf(4));
      note(); // pinned
      now += 2000;
      fireEvent.mouseDown(plot, { ...pt(xOf(2)), button: 0 });
      fireEvent.mouseMove(plot, pt(xOf(6)));
      note(); // measure
      fireEvent.mouseUp(window);

      expect(seen.map(([state]) => state)).toEqual(["latest", "hover", "pinned", "measure"]);
      expect(new Set(seen.map(([, h]) => h))).toEqual(new Set(["44px"]));
    });

    it("is the same hovering a point with OHLC and one without", () => {
      const WIDE = 900;
      const { container } = render(
        <StockChartInner
          width={WIDE}
          height={400}
          series={[withOhlc(SERIES[0]!), SERIES[1]!]}
        />,
      );
      const plot = container.querySelector("[data-chart-capture]")!;
      fireEvent.mouseMove(plot, pt(xAt(WIDE, 2), 50));
      expect(container.querySelector("[data-readout-ohlc]")).not.toBeNull();
      const withIt = strip(container).style.height;
      fireEvent.mouseMove(plot, pt(xAt(WIDE, 8), 50));
      expect(container.querySelector("[data-readout-ohlc]")).toBeNull();
      expect(strip(container).style.height).toBe(withIt);
      expect(withIt).toBe("28px");
    });

    it.each([
      [639, 2],
      [640, 1],
    ])("is %ipx wide in %i row(s)", (width, rows) => {
      const { container } = render(
        <StockChartInner width={width} height={400} series={SERIES} />,
      );
      expect(container.querySelectorAll("[data-readout-row]")).toHaveLength(rows);
    });

    it("puts the headline and the Pinned chip on the first of two rows, the entries on the second", () => {
      const { container, plot } = renderChart();
      tap(plot, xOf(5));
      const [first, second] = Array.from(
        container.querySelectorAll<HTMLElement>("[data-readout-row]"),
      );
      expect(first!.querySelector("[data-readout-headline]")).not.toBeNull();
      expect(first!.querySelector("[data-readout-chip]")).not.toBeNull();
      expect(first!.querySelector("[data-readout-entries]")).toBeNull();
      expect(second!.querySelector("[data-readout-entries]")).not.toBeNull();
    });

    it("puts everything on one row from 640px, the Pinned chip last", () => {
      const WIDE = 700;
      const { container } = render(
        <StockChartInner width={WIDE} height={400} series={SERIES} />,
      );
      fireEvent.touchStart(container.querySelector("[data-chart-capture]")!, {
        touches: [pt(xAt(WIDE, 5))],
        changedTouches: [pt(xAt(WIDE, 5))],
      });
      fireEvent.touchEnd(container.querySelector("[data-chart-capture]")!, {
        touches: [],
        changedTouches: [pt(xAt(WIDE, 5))],
      });
      const row = container.querySelector<HTMLElement>("[data-readout-row]")!;
      const order = Array.from(row.children, (el) => Object.keys((el as HTMLElement).dataset)[0]);
      expect(order).toEqual(["readoutHeadline", "readoutEntries", "readoutChip"]);
    });

    it.each([
      [899, false],
      [900, true],
    ])("at %ipx wide shows open, high, low and close: %s", (width, shown) => {
      const { container } = render(
        <StockChartInner
          width={width}
          height={400}
          series={[withOhlc(SERIES[0]!, 10), SERIES[1]!]}
        />,
      );
      // The resting reading is the newest point, and it has all four.
      expect(container.querySelector("[data-readout-ohlc]") !== null).toBe(shown);
      if (shown) {
        expect(container.querySelector("[data-readout-ohlc]")!.textContent).toBe(
          "O 48.00 H 50.00 L 47.00 C 49.00",
        );
      }
    });
  });

  describe("nothing floats over the plot", () => {
    const absolute = (c: HTMLElement) =>
      Array.from(c.querySelectorAll<HTMLElement | SVGElement>("[data-chart-container] *")).filter(
        (el) => el.style.position === "absolute",
      );

    it("has no absolutely positioned layer while hovering or pinned, where the tooltip has one", () => {
      const strip_ = renderChart(SERIES, "strip");
      fireEvent.mouseMove(strip_.plot, pt(xOf(3), 50));
      expect(stateOf(strip_.container)).toBe("hover");
      expect(absolute(strip_.container)).toHaveLength(0);
      fireEvent.mouseLeave(strip_.plot);
      tap(strip_.plot, xOf(5));
      expect(stateOf(strip_.container)).toBe("pinned");
      expect(absolute(strip_.container)).toHaveLength(0);
      strip_.unmount();

      // The control: the same check finds the card in tooltip mode.
      const card = renderChart(SERIES, "tooltip");
      fireEvent.mouseMove(card.plot, pt(xOf(3), 50));
      expect(absolute(card.container)).toHaveLength(1);
    });

    it("measures in the strip: it carries the readout and no card floats", () => {
      const { container, plot } = renderChart();
      fireEvent.mouseDown(plot, { ...pt(xOf(2)), button: 0 });
      fireEvent.mouseMove(plot, pt(xOf(6)));
      const readouts = container.querySelectorAll('[data-chart="measure-readout"]');
      expect(readouts).toHaveLength(1);
      expect(readouts[0]).toBe(strip(container));
      expect(stateOf(container)).toBe("measure");
      expect(absolute(container)).toHaveLength(0);
      fireEvent.mouseUp(window);
      // Not measuring any more: the attribute goes with the state.
      expect(strip(container).hasAttribute("data-chart")).toBe(false);
    });
  });

  describe("the latest reading", () => {
    it("shows each series' newest value and its change over the range", () => {
      const { container } = renderChart();
      expect(headline(container)).toBe(`Latest · ${stripDate(9)}`);
      const price = entryOf(container, "price");
      expect(within(price).getByText("Price")).toBeTruthy();
      expect(within(price).getByText("49.00")).toBeTruthy();
      // 40 -> 49 is +22.5%, a change in price: green.
      expect(within(price).getByText("+22.5%").style.color).toBe(GREEN);
      expect(within(entryOf(container, "short")).getByText("11.00")).toBeTruthy();
    });

    it("names the date of the newest visible point only, once the view is zoomed", () => {
      const { container, plot } = renderChart();
      expect(headline(container)).toContain("Latest");
      // Drag from just before point 2 to between points 6 and 7, and release.
      fireEvent.mouseDown(plot, { ...pt(xOf(2) - 4), button: 0 });
      fireEvent.mouseMove(plot, pt((xOf(6) + xOf(7)) / 2));
      fireEvent.mouseUp(window);
      expect(stateOf(container)).toBe("latest");
      expect(headline(container)).toBe(stripDate(6));
      // The change is now over the zoomed range: 42 -> 46.
      expect(within(entryOf(container, "price")).getByText("46.00")).toBeTruthy();
      expect(within(entryOf(container, "price")).getByText("+9.5%")).toBeTruthy();
      // A double-click resets the zoom, and the headline with it.
      fireEvent.doubleClick(plot, pt(xOf(4)));
      expect(headline(container)).toBe(`Latest · ${stripDate(9)}`);
    });

    it("shows no change in the normalised view", () => {
      const absolute = renderChart();
      expect(absolute.container.querySelectorAll("[data-readout-change]")).toHaveLength(2);
      absolute.unmount();

      const { container } = renderChart(SERIES, "strip", { viewMode: "normalized" });
      expect(container.querySelectorAll("[data-readout-change]")).toHaveLength(0);
      // The values are still there.
      expect(entryOf(container, "price").querySelector("[data-readout-value]")!.textContent).not.toBe("—");
    });

    it("keeps the row of a series with no points in the zoomed range, with a dash", () => {
      const early: ChartSeriesSpec = { ...SERIES[1]!, points: SERIES[1]!.points.slice(0, 3) };
      const { container, plot } = renderChart([SERIES[0]!, early]);
      // Zoom to points 5 to 7, where the second series has none.
      fireEvent.mouseDown(plot, { ...pt(xOf(5) - 4), button: 0 });
      fireEvent.mouseMove(plot, pt(xOf(7) + 4));
      fireEvent.mouseUp(window);
      expect(container.querySelectorAll("[data-readout-entry]")).toHaveLength(2);
      const short = entryOf(container, "short");
      expect(within(short).getByText("Short %")).toBeTruthy();
      expect(within(short).getByText("—")).toBeTruthy();
      expect(short.querySelector("[data-readout-change]")).toBeNull();
    });

    it("keeps the row of a series with no points at all, with a dash", () => {
      const { container } = renderChart([SERIES[0]!, { ...SERIES[1]!, points: [] }]);
      expect(headline(container)).toBe(`Latest · ${stripDate(9)}`);
      expect(within(entryOf(container, "short")).getByText("—")).toBeTruthy();
    });

    it("dates a value that is not from the headline's day, the way the short series lags", () => {
      // Short interest is published days after the day it describes.
      const lagged: ChartSeriesSpec = { ...SERIES[1]!, points: SERIES[1]!.points.slice(0, 6) };
      const { container } = renderChart([SERIES[0]!, lagged]);
      expect(entryOf(container, "price").querySelector("[data-readout-date-note]")).toBeNull();
      expect(
        entryOf(container, "short").querySelector("[data-readout-date-note]")!.textContent,
      ).toBe(`· ${stripDay(5)}`);
    });

    it("reads a points series in the foreground with an arrow, not in red or green", () => {
      const short: ChartSeriesSpec = {
        ...SERIES[1]!,
        measureMode: "absolute",
        measureUnit: "pp",
      };
      const { container } = renderChart([SERIES[0]!, short]);
      const change = within(entryOf(container, "short")).getByText("+9.00 pp");
      expect(change.style.color).toBe("");
      const arrow = change.previousElementSibling!;
      expect(arrow.textContent).toBe("▲");
      expect(arrow.getAttribute("aria-hidden")).toBe("true");
    });
  });

  describe("the hovered and pinned readings", () => {
    it("follows the state: latest, hover, latest, pinned, hover over the pin, pinned, latest", () => {
      const { container, plot } = renderChart();
      const trace: (string | null)[] = [stateOf(container)];
      fireEvent.mouseMove(plot, pt(xOf(3), 50));
      trace.push(stateOf(container));
      fireEvent.mouseLeave(plot);
      trace.push(stateOf(container));
      tap(plot, xOf(5));
      trace.push(stateOf(container));
      now += 2000;
      fireEvent.mouseMove(plot, pt(xOf(7), 50));
      trace.push(stateOf(container));
      fireEvent.mouseLeave(plot);
      trace.push(stateOf(container));
      fireEvent.click(container.querySelector("[data-readout-chip] button")!);
      trace.push(stateOf(container));
      expect(trace).toEqual([
        "latest",
        "hover",
        "latest",
        "pinned",
        "hover",
        "pinned",
        "latest",
      ]);
    });

    it("carries the Pinned chip, and data-pinned, only while pinned", () => {
      const { container, plot } = renderChart();
      const chip = () => container.querySelector("[data-readout-chip]");
      expect(chip()).toBeNull();
      fireEvent.mouseMove(plot, pt(xOf(3), 50));
      expect(chip()).toBeNull();
      fireEvent.mouseLeave(plot);
      tap(plot, xOf(5));
      expect(chip()).not.toBeNull();
      expect(chip()!.textContent).toContain("Pinned");
      expect(strip(container).hasAttribute("data-pinned")).toBe(true);
    });

    it("is part of the chart: a press on the strip does not count as a press outside it", () => {
      const { container, plot } = renderChart();
      tap(plot, xOf(5));
      expect(stateOf(container)).toBe("pinned");
      act(() => {
        fireEvent.mouseDown(strip(container));
        fireEvent.touchStart(strip(container), { touches: [pt(5, 5)] });
      });
      expect(stateOf(container)).toBe("pinned");
      // The same press on the page outside it still releases.
      act(() => {
        fireEvent.mouseDown(document.body);
      });
      expect(stateOf(container)).toBe("latest");
    });

    it("labels the release button and explains how to move or release the pin", () => {
      const { plot, getByRole } = renderChart();
      tap(plot, xOf(5));
      const button = getByRole("button", { name: "Release pinned reading" });
      expect(button.getAttribute("title")).toBe(
        "Tap the chart to move the reading; tap it again to release",
      );
    });

    it("has no guidance sentence: that is the tooltip's", () => {
      const { container, plot } = renderChart();
      tap(plot, xOf(5));
      expect(strip(container).textContent).not.toContain("tap again to release");
    });

    it("heads a hover with the first series' date and dates the ones on another day", () => {
      const lagged: ChartSeriesSpec = { ...SERIES[1]!, points: SERIES[1]!.points.slice(0, 6) };
      const { container, plot } = renderChart([SERIES[0]!, lagged]);
      fireEvent.mouseMove(plot, pt(xOf(8), 50));
      expect(headline(container)).toBe(stripDate(8));
      expect(within(entryOf(container, "price")).getByText("48.00")).toBeTruthy();
      expect(
        entryOf(container, "short").querySelector("[data-readout-date-note]")!.textContent,
      ).toBe(`· ${stripDay(5)}`);
      // A reading at a point names no change.
      expect(container.querySelectorAll("[data-readout-change]")).toHaveLength(0);
    });
  });

  describe("what it costs", () => {
    it("builds the resting reading once, however the pointer moves or the chart re-renders unchanged", () => {
      const build = jest.spyOn(chartReadout, "buildLatestReadout");
      try {
        const { plot, rerender } = renderChart();
        expect(build).toHaveBeenCalledTimes(1);
        fireEvent.mouseMove(plot, pt(xOf(3), 50));
        fireEvent.mouseMove(plot, pt(xOf(4), 50));
        fireEvent.mouseLeave(plot);
        tap(plot, xOf(5));
        rerender(
          <StockChartInner width={WIDTH} height={HEIGHT} series={SERIES} readout="strip" />,
        );
        expect(build).toHaveBeenCalledTimes(1);
      } finally {
        build.mockRestore();
      }
    });

    it("builds it again when the view, the zoom or the series change", () => {
      const build = jest.spyOn(chartReadout, "buildLatestReadout");
      try {
        const { plot, rerender } = renderChart();
        rerender(
          <StockChartInner
            width={WIDTH}
            height={HEIGHT}
            series={SERIES}
            readout="strip"
            viewMode="normalized"
          />,
        );
        expect(build).toHaveBeenCalledTimes(2);
        fireEvent.mouseDown(plot, { ...pt(xOf(2)), button: 0 });
        fireEvent.mouseMove(plot, pt(xOf(6)));
        fireEvent.mouseUp(window); // commits the zoom
        expect(build).toHaveBeenCalledTimes(3);
      } finally {
        build.mockRestore();
      }
    });

    it("does not build it at all when the tooltip shows the reading", () => {
      const build = jest.spyOn(chartReadout, "buildLatestReadout");
      try {
        const { plot } = renderChart(SERIES, "tooltip");
        fireEvent.mouseMove(plot, pt(xOf(3), 50));
        expect(build).not.toHaveBeenCalled();
      } finally {
        build.mockRestore();
      }
    });
  });

  describe("falling back to the tooltip", () => {
    it("shows the tooltip when the plot left under the strip would be under 160px", () => {
      // 200 - 44 (strip) - 32 (margins) = 124 < 160.
      const { container } = render(
        <StockChartInner width={WIDTH} height={200} series={SERIES} />,
      );
      expect(container.querySelector("[data-chart-readout]")).toBeNull();
      expect(svgOf(container).getAttribute("height")).toBe("200");
      fireEvent.mouseMove(
        container.querySelector("[data-chart-capture]")!,
        pt(xOf(3), 50),
      );
      expect(container.querySelector("[data-chart-tooltip]")).not.toBeNull();
    });

    it("keeps the strip when exactly 160px is left", () => {
      // 236 - 44 - 32 = 160.
      const { container } = render(
        <StockChartInner width={WIDTH} height={236} series={SERIES} />,
      );
      expect(container.querySelector("[data-chart-readout]")).not.toBeNull();
      expect(svgOf(container).getAttribute("height")).toBe("192");
    });
  });
});

// Pinning and releasing are spoken in both modes; a scrub never is.
describe.each(MODES)("StockChart announcer (%s)", (mode) => {
  const say = (c: HTMLElement) =>
    c.querySelector<HTMLElement>("[data-chart-announcer]")!.textContent;

  it("is a persistent, visually hidden status region", () => {
    const { container } = renderChart(SERIES, mode);
    const announcer = container.querySelector("[data-chart-announcer]")!;
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.classList.contains("sr-only")).toBe(true);
    expect(say(container)).toBe("");
  });

  it("says nothing for a scrub", () => {
    const { container, plot } = renderChart(SERIES, mode);
    fireEvent.mouseMove(plot, pt(xOf(3), 50));
    fireEvent.mouseMove(plot, pt(xOf(4), 50));
    fireEvent.mouseLeave(plot);
    expect(say(container)).toBe("");
    // A touch scrub is no different until the finger lifts.
    fireEvent.touchStart(plot, { touches: [pt(xOf(2))], changedTouches: [pt(xOf(2))] });
    fireEvent.touchMove(plot, { touches: [pt(xOf(3))], changedTouches: [pt(xOf(3))] });
    expect(say(container)).toBe("");
  });

  it("says what was pinned, then that it was released", () => {
    const { container, plot } = renderChart(SERIES, mode);
    tap(plot, xOf(6));
    // Default axis format: two decimals. Price 40 + 6, short 2 + 6.
    expect(say(container)).toBe(`Pinned ${stripDate(6)}: Price 46.00, Short % 8.00`);
    now += 2000;
    tap(plot, xOf(6)); // a re-tap releases
    expect(say(container)).toBe("Reading released");
  });

  it("says the new reading when the pin moves", () => {
    const { container, plot } = renderChart(SERIES, mode);
    tap(plot, xOf(2));
    now += 2000;
    tap(plot, xOf(7));
    expect(say(container)).toBe(`Pinned ${stripDate(7)}: Price 47.00, Short % 9.00`);
  });

  it("says a release made by the button, a press outside or the series changing", () => {
    const { container, plot, getByRole } = renderChart(SERIES, mode);
    tap(plot, xOf(4));
    fireEvent.click(getByRole("button", { name: /release pinned reading/i }));
    expect(say(container)).toBe("Reading released");

    tap(plot, xOf(5));
    expect(say(container)).toContain("Pinned");
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(say(container)).toBe("Reading released");
  });
});

describe("StockChart focus after release", () => {
  it("moves to the chart when Escape releases a pin from the release button", () => {
    const { container, plot, getByRole } = renderChart(SERIES, "strip");
    tap(plot, xOf(5));
    const button = getByRole("button", { name: /release pinned reading/i });
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(container.querySelector("[data-readout-chip]")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("[data-chart-container]"));
  });

  it("moves to the chart when the release button is used", () => {
    const { container, plot, getByRole } = renderChart(SERIES, "strip");
    tap(plot, xOf(5));
    const button = getByRole("button", { name: /release pinned reading/i });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    // The button is gone; focus is on the chart, not lost to <body>.
    expect(container.querySelector("[data-readout-chip]")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("[data-chart-container]"));
  });
});

// The chart is reachable and drivable without a pointer, in both modes.
describe.each(MODES)("StockChart keyboard (%s)", (mode) => {
  function setup(series = SERIES) {
    const r = renderChart(series, mode);
    const root = r.container.querySelector<HTMLElement>("[data-chart-container]")!;
    root.focus();
    /** Returns false when the page's own handling of the key was prevented. */
    const press = (key: string, init: KeyboardEventInit = {}) =>
      fireEvent.keyDown(root, { key, ...init });
    /** The date of the pinned reading, or null while nothing is pinned. */
    const pinnedOn = () => {
      const el = r.reading();
      return el && el.hasAttribute("data-pinned") ? el.textContent : null;
    };
    return { ...r, root, press, pinnedOn };
  }

  it("makes the chart a focusable, labelled group", () => {
    const { root } = setup();
    expect(root.getAttribute("tabindex")).toBe("0");
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe(
      "Chart. Use the left and right arrow keys to step through readings, Escape to release.",
    );
    expect(root.className).toContain("focus-visible:ring-2");
  });

  it("ArrowLeft with nothing pinned pins the point before the last", () => {
    const { press, pinnedOn } = setup();
    expect(pinnedOn()).toBeNull();
    expect(press("ArrowLeft")).toBe(false); // handled: the page must not scroll
    expect(pinnedOn()).toContain(dateLabel(mode, 8));
  });

  it("ArrowRight with nothing pinned pins the last point, as there is no next", () => {
    const { press, pinnedOn } = setup();
    expect(press("ArrowRight")).toBe(false);
    expect(pinnedOn()).toContain(dateLabel(mode, 9));
  });

  it("steps one point at a time and stops at both ends", () => {
    const { press, pinnedOn } = setup();
    press("ArrowLeft"); // 8
    press("ArrowLeft"); // 7
    expect(pinnedOn()).toContain(dateLabel(mode, 7));
    press("ArrowRight"); // 8
    expect(pinnedOn()).toContain(dateLabel(mode, 8));
    press("Home");
    expect(pinnedOn()).toContain(dateLabel(mode, 0));
    press("ArrowLeft"); // no point before the first
    expect(pinnedOn()).toContain(dateLabel(mode, 0));
    press("End");
    expect(pinnedOn()).toContain(dateLabel(mode, 9));
    press("ArrowRight"); // no point after the last
    expect(pinnedOn()).toContain(dateLabel(mode, 9));
  });

  it("steps from a pinned touch reading, not from the end", () => {
    const { press, pinnedOn, plot } = setup();
    tap(plot, xOf(4));
    press("ArrowRight");
    expect(pinnedOn()).toContain(dateLabel(mode, 5));
  });

  it("takes the screen from a live mouse hover, so what is said is what is shown", () => {
    const { press, pinnedOn, plot, container } = setup();
    fireEvent.mouseMove(plot, pt(xOf(2), 50));
    expect(pinnedOn()).toBeNull(); // a hover, not a pin
    press("ArrowRight"); // nothing pinned: the last point
    // The pin is on screen, where it is announced; the hover no longer hides it.
    expect(pinnedOn()).toContain(dateLabel(mode, 9));
    expect(container.querySelector("[data-chart-announcer]")!.textContent).toContain(
      `Pinned ${stripDate(9)}`,
    );
    // The pointer leaving changes nothing: the pin is what was on screen.
    fireEvent.mouseLeave(plot);
    expect(pinnedOn()).toContain(dateLabel(mode, 9));
  });

  it("steps through the series with the most points, whichever comes first", () => {
    const sparse: ChartSeriesSpec = { ...SERIES[1]!, points: SERIES[1]!.points.slice(0, 4) };
    const { press, container } = setup([sparse, SERIES[0]!]);
    press("ArrowLeft");
    // The price series has the ten points: 40 + 8.
    expect(container.textContent).toContain("48.00");
    press("ArrowLeft");
    expect(container.textContent).toContain("47.00");
  });

  it("Escape releases a pin, and leaves a bare Escape to whoever else wants it", () => {
    const { press, pinnedOn } = setup();
    expect(press("Escape")).toBe(true); // nothing pinned: not ours
    press("ArrowLeft");
    expect(pinnedOn()).not.toBeNull();
    expect(press("Escape")).toBe(false);
    expect(pinnedOn()).toBeNull();
  });

  it("leaves other keys and chords alone", () => {
    const { press, pinnedOn } = setup();
    expect(press("a")).toBe(true);
    expect(press("Enter")).toBe(true);
    expect(press("ArrowLeft", { altKey: true })).toBe(true); // the browser's Back
    expect(press("ArrowRight", { metaKey: true })).toBe(true);
    expect(press("Home", { ctrlKey: true })).toBe(true);
    expect(press("ArrowLeft", { shiftKey: true })).toBe(true);
    expect(pinnedOn()).toBeNull();
  });

  it("says each step, as it says a pin", () => {
    const { press, container } = setup();
    press("ArrowLeft");
    const say = () => container.querySelector("[data-chart-announcer]")!.textContent;
    expect(say()).toBe(`Pinned ${stripDate(8)}: Price 48.00, Short % 10.00`);
    press("Home");
    expect(say()).toBe(`Pinned ${stripDate(0)}: Price 40.00, Short % 2.00`);
    press("Escape");
    expect(say()).toBe("Reading released");
  });
});

describe("StockChart keyboard in tooltip mode", () => {
  it("docks the card in a corner, as there is no pointer to follow", () => {
    const { container, reading } = renderChart(SERIES, "tooltip");
    const root = container.querySelector<HTMLElement>("[data-chart-container]")!;
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(reading()!.hasAttribute("data-pinned")).toBe(true);
    expect(reading()!.hasAttribute("data-docked")).toBe(true);
    expect(reading()!.style.top).toBe(`${M.top + 4}px`);
  });
});
