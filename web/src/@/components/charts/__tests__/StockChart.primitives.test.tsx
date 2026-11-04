import { render } from "@testing-library/react";
import { StockChartInner } from "../StockChart";
import type { ChartPoint, ChartSeriesSpec, StockChartProps } from "../types";

// localPoint needs real SVG geometry (getScreenCTM); jsdom has none.
jest.mock("@visx/event", () => ({
  localPoint: (e: { clientX?: number; clientY?: number }) =>
    e.clientX == null ? null : { x: e.clientX, y: e.clientY ?? 0 },
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const WIDTH = 700;
const HEIGHT = 400;

const points = (base: number): ChartPoint[] =>
  Array.from({ length: 12 }, (_, i) => ({ t: T0 + i * DAY, v: base + i }));

const SERIES: ChartSeriesSpec[] = [
  {
    id: "strategy",
    label: "Strategy",
    color: "#123456",
    axis: "left",
    kind: "line",
    points: points(100),
  },
];

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

describe("StockChart series dash", () => {
  it("draws a solid stroke when no dash is set", () => {
    const { container } = renderChart();
    const path = container.querySelector(
      '[data-series="strategy"] path:last-of-type',
    );
    expect(path?.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("draws a dashed stroke when the series asks for one", () => {
    const { container } = renderChart({
      series: [{ ...SERIES[0]!, id: "xjt", color: "#888888", dash: "4,3" }],
    });
    const path = container.querySelector(
      '[data-series="xjt"] path:last-of-type',
    );
    expect(path?.getAttribute("stroke-dasharray")).toBe("4,3");
  });
});

describe("StockChart end labels", () => {
  it("draws no end label unless a series asks for one", () => {
    const { container } = renderChart();
    expect(container.querySelector('[data-chart="end-labels"]')).toBeNull();
  });

  it("writes the final value, formatted by the axis, at the series' end", () => {
    const { container } = renderChart({
      series: [{ ...SERIES[0]!, endLabel: true }],
      leftAxis: { side: "left", format: (v) => `$${v.toFixed(0)}` },
    });
    const label = container.querySelector('[data-chart="end-labels"] text');
    expect(label?.textContent).toBe("$111");
    expect(label?.getAttribute("text-anchor")).toBe("end");
  });
});

describe("StockChart regions", () => {
  it("paints the live tone from a token, not a fixed colour", () => {
    const { container } = renderChart({
      regions: [
        {
          start: T0 + 2 * DAY,
          end: T0 + 8 * DAY,
          tone: "live",
          label: "Recorded",
        },
      ],
    });
    const rect = container.querySelector("rect[style*='--primary']");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("fill")).toBeNull();
    expect(container.innerHTML).not.toMatch(/fill="#ef4444"|fill="#22c55e"/);
  });

  it("keeps the bearish fill a fixed hex for existing charts", () => {
    const { container } = renderChart({
      regions: [{ start: T0 + 2 * DAY, end: T0 + 8 * DAY, tone: "bearish" }],
    });
    expect(container.querySelector('rect[fill="#ef4444"]')).not.toBeNull();
  });
});

describe("StockChart level tags", () => {
  it("boxes a tagged level's label and leaves an untagged one unboxed", () => {
    const { container } = renderChart({
      levels: [
        { axis: "left", value: 105, label: "Pivot 105", color: "#aa0000" },
        {
          axis: "left",
          value: 103,
          label: "Last 103",
          color: "#00aa00",
          tag: true,
        },
      ],
    });
    const tags = container.querySelectorAll("[data-chart-level-tag]");
    expect(tags).toHaveLength(1);
    expect(tags[0]?.getAttribute("stroke")).toBe("#00aa00");
  });
});

describe("StockChart events and annotations", () => {
  const entry = {
    t: T0 + 3 * DAY,
    v: 103,
    tone: "entry" as const,
    label: "Entry",
  };

  it("draws no point mark unless a caller passes one", () => {
    const { container } = renderChart();
    expect(container.querySelector('[data-chart="point-marks"]')).toBeNull();
  });

  it("draws an event as a dot in its tone's token, with its label", () => {
    const { container } = renderChart({ events: [entry] });
    const mark = container.querySelector('[data-chart-mark="event"]');
    expect(mark?.querySelector("circle")?.getAttribute("style")).toContain(
      "--primary",
    );
    expect(mark?.querySelector("text")?.textContent).toBe("Entry");
  });

  it("paints an exit in the clay rust token, not red", () => {
    const { container } = renderChart({
      events: [{ t: T0 + 5 * DAY, v: 105, tone: "exit" }],
    });
    const circle = container.querySelector('[data-chart-mark="event"] circle');
    expect(circle?.getAttribute("style")).toContain("--accent");
    expect(container.innerHTML).not.toMatch(/#ef4444|#22c55e/);
  });

  it("draws an annotation as a dot and its callout", () => {
    const { container } = renderChart({
      annotations: [{ t: T0 + 6 * DAY, v: 104, label: "−18.6%" }],
    });
    const mark = container.querySelector('[data-chart-mark="annotation"]');
    expect(mark?.querySelector("text")?.textContent).toBe("−18.6%");
  });
});
