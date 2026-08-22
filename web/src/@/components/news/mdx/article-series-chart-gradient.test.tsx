import { render } from "@testing-library/react";
import { LinearGradient } from "@visx/gradient";

// ParentSize measures the DOM and jsdom reports 0, so the chart short-circuits
// to null without a width and there would be nothing to assert against.
jest.mock("@visx/responsive", () => ({
  __esModule: true,
  ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) =>
    children({ width: 800, height: 280 }),
}));

import { ArticleSeriesChart } from "./article-series-chart";

/**
 * Pins the ACTUAL render path for the suburb price chart.
 *
 * A suburb's region code is "SUBURB:NSW-BONDI BEACH", and callers build the
 * gradient id from it. The colon and the space both terminate the reference
 * inside url(#…), so the gradient never resolved, the fill fell back to the SVG
 * default of rgb(0,0,0), and every priced suburb page shipped a solid black slab
 * where its chart should be.
 *
 * The first attempt at this fix went into chart-primitives' SeriesPath, which
 * this chart does not use — so it changed nothing on the page. Hence a test
 * against this component specifically.
 *
 * setup.ts mocks @visx/gradient to render null, so the <linearGradient> element
 * never exists here. The two things that must agree are the id handed to that
 * component and the id referenced by the area's fill — assert on both.
 */
const points = Array.from({ length: 12 }, (_, i) => ({
  date: new Date(2024, i, 1),
  value: 1_000_000 + i * 10_000,
}));

const gradientIdProp = () => {
  const calls = (LinearGradient as unknown as jest.Mock).mock.calls;
  return (calls[calls.length - 1]?.[0] as { id?: string } | undefined)?.id;
};

describe("ArticleSeriesChart gradient id", () => {
  beforeEach(() => (LinearGradient as unknown as jest.Mock).mockClear());

  it("strips the separators that break url(#id), and keeps the fill in sync", () => {
    const { container } = render(
      <ArticleSeriesChart
        points={points}
        ariaLabel="test series"
        gradientId="housing-SUBURB:NSW-BONDI BEACH-median_price"
        height={240}
      />,
    );

    const id = gradientIdProp();
    expect(id).toBe("housing-SUBURB-NSW-BONDI-BEACH-median_price");
    expect(id).not.toMatch(/[:\s]/);
    expect(container.querySelector(`path[fill="url(#${id!})"]`)).not.toBeNull();
  });

  it("leaves an already-safe id alone", () => {
    const { container } = render(
      <ArticleSeriesChart points={points} ariaLabel="t" gradientId="clean-id" height={240} />,
    );
    expect(gradientIdProp()).toBe("clean-id");
    expect(container.querySelector('path[fill="url(#clean-id)"]')).not.toBeNull();
  });
});
