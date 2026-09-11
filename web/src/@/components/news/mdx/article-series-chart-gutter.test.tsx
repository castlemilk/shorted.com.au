import { render } from "@testing-library/react";

// ParentSize measures the DOM and jsdom reports 0, so without a width the chart
// short-circuits to null and there is nothing to assert against.
jest.mock("@visx/responsive", () => ({
  __esModule: true,
  ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) =>
    children({ width: 800, height: 280 }),
}));

import { ArticleSeriesChart, leftGutterFor } from "./article-series-chart";
import { ECONOMY_SERIES_FORMATTERS } from "@/lib/economy/map-metrics";

// Every widely-deployed chart (housing, news, the Australian economy series)
// was drawn with a fixed 44px gutter. Those must not move.
describe("leftGutterFor", () => {
  it("keeps the original 44px for labels that already fit", () => {
    expect(leftGutterFor(["$200", "$150", "$100", "$50.0", "$0.00"])).toBe(44);
    expect(leftGutterFor(["4.5%", "4.0%", "3.5%"])).toBe(44);
    expect(leftGutterFor(["$1.2M", "$900K"])).toBe(44);
    expect(leftGutterFor([])).toBe(44);
  });

  // The regression: gold's axis read "6,000" because the "$" fell outside a
  // 44px gutter. A price axis that drops its currency sign looks fine and is
  // wrong, which is why this is asserted rather than eyeballed.
  it("widens for world commodity prices so the currency sign survives", () => {
    const usd = ECONOMY_SERIES_FORMATTERS.usd_price;
    const gold = [6000, 4000, 2000, 0].map(usd);
    const tin = [60000, 40000, 20000, 0].map(usd);
    expect(gold[0]).toBe("$6,000");
    expect(leftGutterFor(gold)).toBeGreaterThan(44);
    expect(leftGutterFor(tin)).toBeGreaterThan(leftGutterFor(gold));
  });

  it("sizes to the widest label, not the first", () => {
    expect(leftGutterFor(["$0", "$60,000", "$20"])).toBe(leftGutterFor(["$60,000"]));
  });
});

// The helper being right proves nothing if the chart still translates the plot
// by the old constant. Assert on the rendered SVG itself.
function plotOffsetX(container: HTMLElement): number {
  const g = [...container.querySelectorAll("g[transform]")].find((el) =>
    /^translate\(\d+(\.\d+)?,8\)$/.test(el.getAttribute("transform") ?? ""),
  );
  if (!g) throw new Error("plot group not found");
  return Number(/translate\(([\d.]+),/.exec(g.getAttribute("transform")!)![1]);
}

const monthly = (values: number[]) =>
  values.map((value, i) => ({ date: new Date(2020, i, 1), value }));

describe("ArticleSeriesChart gutter, as rendered", () => {
  it("offsets the plot past a gold-sized price axis", () => {
    const { container } = render(
      <ArticleSeriesChart
        points={monthly([1800, 2500, 3300, 4411, 5200])}
        formatValue={ECONOMY_SERIES_FORMATTERS.usd_price}
        ariaLabel="gold"
        height={240}
      />,
    );
    expect(plotOffsetX(container)).toBeGreaterThan(44);
  });

  it("leaves a narrow-label chart at exactly 44px", () => {
    const { container } = render(
      <ArticleSeriesChart
        points={monthly([3.1, 3.4, 3.9, 4.2, 4.35])}
        formatValue={ECONOMY_SERIES_FORMATTERS.percent}
        ariaLabel="cash rate"
        height={240}
      />,
    );
    expect(plotOffsetX(container)).toBe(44);
  });
});
