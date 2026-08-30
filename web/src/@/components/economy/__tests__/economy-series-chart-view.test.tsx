import { render, screen } from "@testing-library/react";

import { EconomySeriesChartView } from "../economy-series-chart-view";

const articleSeriesChart = jest.fn(
  ({ ariaLabel }: { ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} />
  ),
);

jest.mock("@/components/news/mdx/article-series-chart", () => ({
  ArticleSeriesChart: (props: unknown) => articleSeriesChart(props),
}));

describe("EconomySeriesChartView", () => {
  beforeEach(() => {
    articleSeriesChart.mockClear();
  });

  it("hydrates serializable ISO dates inside the client-only chart boundary", () => {
    render(
      <EconomySeriesChartView
        points={[
          { date: "2025-01-01", value: 100 },
          { date: "2025-04-01", value: 102 },
        ]}
        seriesKey="wages.wpi.wa"
        ariaLabel="Western Australia wage price index history"
        format="index"
      />,
    );

    expect(
      screen.getByRole("img", {
        name: "Western Australia wage price index history",
      }),
    ).toBeInTheDocument();
    expect(articleSeriesChart).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          { date: new Date("2025-01-01T00:00:00.000Z"), value: 100 },
          { date: new Date("2025-04-01T00:00:00.000Z"), value: 102 },
        ],
      }),
    );
  });
});
