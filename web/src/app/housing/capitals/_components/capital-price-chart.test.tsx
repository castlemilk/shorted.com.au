import { render } from "@testing-library/react";

import { CapitalPriceChart } from "./capital-price-chart";

const housingMultiLineChart = jest.fn(() => <div />);

jest.mock("~/@/components/housing/housing-multi-line-chart", () => ({
  HousingMultiLineChart: (props: unknown) => {
    housingMultiLineChart(props);
    return <div />;
  },
}));

describe("CapitalPriceChart", () => {
  beforeEach(() => {
    housingMultiLineChart.mockClear();
  });

  it("converts serializable ISO observations for the existing housing chart", () => {
    render(
      <CapitalPriceChart
        ariaLabel="Greater Melbourne house and unit prices"
        format="aud"
        height={320}
        series={[
          {
            label: "Established houses",
            points: [
              { period: "2025-12-31", value: 800_000 },
              { period: "2026-03-31", value: 850_000 },
              { period: "invalid", value: 900_000 },
            ],
          },
        ]}
      />,
    );

    expect(housingMultiLineChart).toHaveBeenCalledWith({
      ariaLabel: "Greater Melbourne house and unit prices",
      format: "aud",
      height: 320,
      series: [
        {
          label: "Established houses",
          points: [
            { date: new Date("2025-12-31T00:00:00.000Z"), value: 800_000 },
            { date: new Date("2026-03-31T00:00:00.000Z"), value: 850_000 },
          ],
        },
      ],
    });
  });
});
