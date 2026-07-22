import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import { GetEconomicSeriesResponseSchema } from "~/gen/shorts/v1alpha1/shorts_pb";
import { StateCorrelations } from "../state-correlations";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn(),
}));
jest.mock("../dual-axis-chart", () => ({
  DualAxisChart: ({ formatSecondary }: { formatSecondary: (value: number) => string }) => (
    <div>{formatSecondary(8_641_085)}</div>
  ),
}));

const mockGetEconomicSeriesClient =
  getEconomicSeriesClient as jest.MockedFunction<typeof getEconomicSeriesClient>;

describe("StateCorrelations candidates", () => {
  beforeEach(() => {
    mockGetEconomicSeriesClient.mockReset();
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, { series: [] }),
    );
  });

  it("requests retail, dwelling approvals, and population alongside established candidates", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <StateCorrelations state="nsw" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockGetEconomicSeriesClient).toHaveBeenCalled());
    expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith(
      expect.arrayContaining([
        "retail.turnover.total.nsw.seasadj",
        "approvals.dwelling_units.total.nsw",
        "population.erp.total.nsw",
      ]),
    );
  });

  it("formats population candidates as a compact count", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, {
        series: [
          {
            info: { seriesKey: "markets.short_interest_wavg.nsw" },
            observations: [
              { period: { seconds: 1_700_000_000n }, value: 4.2 },
              { period: { seconds: 1_702_700_000n }, value: 4.3 },
            ],
          },
          {
            info: { seriesKey: "population.erp.total.nsw" },
            observations: [
              { period: { seconds: 1_700_000_000n }, value: 8_600_000 },
              { period: { seconds: 1_702_700_000n }, value: 8_641_085 },
            ],
          },
        ],
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <StateCorrelations state="nsw" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("8.6M")).toBeInTheDocument();
  });
});
