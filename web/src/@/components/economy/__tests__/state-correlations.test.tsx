import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import {
  getEconomicSeriesClient,
  listSeriesCorrelationsClient,
} from "~/app/actions/client/getEconomyClient";
import {
  GetEconomicSeriesResponseSchema,
  ListSeriesCorrelationsResponseSchema,
} from "~/gen/shorts/v1alpha1/economy_pb";
import { StateCorrelations } from "../state-correlations";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn(),
  listSeriesCorrelationsClient: jest.fn(),
}));
jest.mock("../dual-axis-chart", () => ({
  DualAxisChart: ({
    formatSecondary,
  }: {
    formatSecondary: (value: number) => string;
  }) => <div>{formatSecondary(8_641_085)}</div>,
}));

const mockGetEconomicSeriesClient =
  getEconomicSeriesClient as jest.MockedFunction<
    typeof getEconomicSeriesClient
  >;
const mockListSeriesCorrelationsClient =
  listSeriesCorrelationsClient as jest.MockedFunction<
    typeof listSeriesCorrelationsClient
  >;

describe("StateCorrelations candidates", () => {
  beforeEach(() => {
    mockGetEconomicSeriesClient.mockReset();
    mockListSeriesCorrelationsClient.mockReset();
    mockListSeriesCorrelationsClient.mockResolvedValue(
      create(ListSeriesCorrelationsResponseSchema, { correlations: [] }),
    );
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, { series: [] }),
    );
  });

  it("uses the state's short-interest series as the precomputed base", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <StateCorrelations state="nsw" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(mockListSeriesCorrelationsClient).toHaveBeenCalledWith(
        "markets.short_interest_wavg.nsw",
        24,
        0,
        250,
      ),
    );
  });

  it("requests retail, dwelling approvals, and population alongside established candidates", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
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

  it.each(["wa", "qld"] as const)(
    "requests national flagship overlays and local labour/wage series for %s",
    async (state) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <StateCorrelations state={state} />
        </QueryClientProvider>,
      );

      await waitFor(() =>
        expect(mockGetEconomicSeriesClient).toHaveBeenCalled(),
      );
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith(
        expect.arrayContaining([
          "commodities.price_index.bulk.aus",
          "commodities.price_index.all_items.aus",
          "credit.growth_yoy.business.aus.seasadj",
          "credit.growth_yoy.housing.aus.seasadj",
          `labour.job_vacancies.${state}`,
          `wages.wpi_yoy.${state}`,
          `wages.real_wpi_yoy.${state}`,
        ]),
      );
    },
  );

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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <StateCorrelations state="nsw" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("8.6M")).toBeInTheDocument();
  });
});
