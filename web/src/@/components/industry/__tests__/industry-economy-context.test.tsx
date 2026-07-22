import { render, screen } from "@testing-library/react";

import { SeriesCorrelation } from "@/components/economy/series-correlation";
import { IndustryEconomyContext } from "../industry-economy-context";

jest.mock("@/components/economy/series-correlation", () => ({
  SeriesCorrelation: jest.fn(() => <div data-testid="series-correlation" />),
}));

const mockSeriesCorrelation = SeriesCorrelation as jest.MockedFunction<
  typeof SeriesCorrelation
>;

describe("IndustryEconomyContext", () => {
  beforeEach(() => {
    mockSeriesCorrelation.mockClear();
  });

  it("bridges the industry name to the derived anchor and national overlays", () => {
    render(<IndustryEconomyContext industryName="Software & Services" />);

    expect(screen.getByTestId("series-correlation")).toBeInTheDocument();
    expect(mockSeriesCorrelation.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        anchor: {
          key: "markets.short_interest_avg.software-services.aus",
          label: "Software & Services short interest",
          format: "percent",
        },
        overlayCandidates: expect.arrayContaining([
          expect.objectContaining({ key: "commodities.price_index.bulk.aus" }),
          expect.objectContaining({ key: "commodities.price_index.all_items.aus" }),
          expect.objectContaining({ key: "credit.growth_yoy.business.aus.seasadj" }),
          expect.objectContaining({ key: "labour.job_vacancies.aus" }),
          expect.objectContaining({ key: "wages.wpi_yoy.aus" }),
          expect.objectContaining({ key: "cpi.annual_change.all_groups.aus" }),
        ]),
        defaultOverlayKey: "commodities.price_index.bulk.aus",
        requireAnchor: true,
      }),
    );
  });

  it("renders the empty state without mounting the query surface for an unpinned industry", () => {
    render(<IndustryEconomyContext industryName="Future GICS Group" />);

    expect(mockSeriesCorrelation).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "No derived short-interest history is available for Future GICS Group yet. Smaller industries may not meet the current constituent threshold.",
      ),
    ).toBeInTheDocument();
  });
});
