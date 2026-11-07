import { render } from "@testing-library/react";
import { StockChartInner } from "../StockChart";
import type {
  ChartPoint,
  ChartSeriesSpec,
  OscillatorSpec,
  StockChartProps,
} from "../types";

jest.mock("@visx/event", () => ({
  localPoint: (e: { clientX?: number; clientY?: number }) =>
    e.clientX == null ? null : { x: e.clientX, y: e.clientY ?? 0 },
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const N = 10;
const WIDTH = 700;
const HEIGHT = 420;

const pts: ChartPoint[] = Array.from({ length: N }, (_, i) => ({
  t: T0 + i * DAY,
  v: 100 + i,
}));
const SERIES: ChartSeriesSpec[] = [
  {
    id: "strategy",
    label: "Strategy",
    color: "#123456",
    axis: "left",
    kind: "line",
    points: pts,
  },
];
// Drawdown: zero at the top of the panel, falling to -30 by the trough.
const DRAWDOWN: number[] = [0, -2, -5, -10, -18, -30, -22, -12, -6, -1];

const area = (over: Partial<OscillatorSpec> = {}): OscillatorSpec => ({
  id: "dd",
  label: "Drawdown",
  color: "#aa3333",
  values: DRAWDOWN,
  domain: [-30, 0],
  reference: [-30, -20, -10, 0],
  kind: "area",
  unit: "%",
  ...over,
});

function renderChart(props: Partial<StockChartProps> = {}) {
  return render(
    <StockChartInner
      width={WIDTH}
      height={HEIGHT}
      series={SERIES}
      {...props}
    />,
  );
}

/** The numbers of a path's `d`, as [x, y] pairs in order. */
function pairs(d: string): number[][] {
  return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
}

describe("StockChart oscillator area", () => {
  it("draws the line as a line when no kind is set, with no area", () => {
    const { container } = renderChart({
      oscillators: [{ ...area(), kind: undefined }],
    });
    expect(container.querySelector("[data-chart-osc-area]")).toBeNull();
  });

  it("fills the area down to zero, the top of a drawdown panel", () => {
    const { container } = renderChart({ oscillators: [area()] });
    const path = container.querySelector("[data-chart-osc-area]");
    expect(path).not.toBeNull();
    const ys = pairs(path!.getAttribute("d") ?? "").map(([, y]) => y);
    // The area closes on the zero line at the top of the panel (y = 0), so it
    // is not filled from the panel's bottom. The trough reaches the bottom (72px:
    // the 84px panel less its 12px gutter).
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(72, 5);
    expect(path!.getAttribute("fill")).toBe("#aa3333");
  });

  it("labels the domain's ticks with the unit", () => {
    const { container } = renderChart({ oscillators: [area()] });
    const labels = [
      ...container.querySelectorAll("[data-chart='oscillator'] text"),
    ].map((t) => t.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["−30%", "−20%", "−10%", "0%"]),
    );
  });

  it("keeps the top tick of a drawdown inside the panel, below its line", () => {
    const { container } = renderChart({ oscillators: [area()] });
    const zero = [
      ...container.querySelectorAll("[data-chart='oscillator'] text"),
    ].find((t) => t.textContent === "0%")!;
    // The line sits at y = 0 (the panel's top edge); its label must not be above it.
    expect(Number(zero.getAttribute("y"))).toBeGreaterThanOrEqual(9);
  });

  it("draws the chart's regions in the sub-panel as well as the plot", () => {
    const { container } = renderChart({
      oscillators: [area()],
      regions: [{ start: T0 + 2 * DAY, end: T0 + 6 * DAY, tone: "live" }],
    });
    expect(container.querySelectorAll("[data-chart-osc-region]")).toHaveLength(
      1,
    );
  });

  it("draws a trough callout on the panel, on the panel's own domain", () => {
    const { container } = renderChart({
      oscillators: [
        area({
          // The trough is the fifth session, at -30 (the panel's floor).
          annotations: [{ t: T0 + 5 * DAY, v: -30, label: "−30.0%" }],
        }),
      ],
    });
    const panel = container.querySelector("[data-chart='oscillator']")!;
    const mark = panel.querySelector("[data-chart-mark='annotation']");
    expect(mark).not.toBeNull();
    // The panel is 72px: -30 on a [-30, 0] domain sits on its bottom edge.
    expect(
      Number(mark!.querySelector("circle")!.getAttribute("cy")),
    ).toBeCloseTo(72, 5);
    expect(mark!.querySelector("text")!.textContent).toBe("−30.0%");
  });

  it("draws no callout on the panel when none is given", () => {
    const { container } = renderChart({ oscillators: [area()] });
    expect(container.querySelector("[data-chart-osc-annotations]")).toBeNull();
  });

  it("draws no sub-panel region for a line oscillator", () => {
    const { container } = renderChart({
      oscillators: [{ ...area(), kind: "line" }],
      regions: [{ start: T0 + 2 * DAY, end: T0 + 6 * DAY, tone: "live" }],
    });
    expect(container.querySelectorAll("[data-chart-osc-region]")).toHaveLength(
      0,
    );
  });
});
