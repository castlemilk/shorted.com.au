import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import { GetEconomicSeriesResponseSchema } from "~/gen/shorts/v1alpha1/economy_pb";
import { DualAxisChart } from "../dual-axis-chart";
import { SeriesCorrelation } from "../series-correlation";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn(),
}));
jest.mock("../dual-axis-chart", () => ({
  DualAxisChart: jest.fn(({
    primaryLabel,
    secondaryLabel,
    formatPrimary,
    formatSecondary,
  }: {
    primaryLabel: string;
    secondaryLabel: string;
    formatPrimary: (value: number) => string;
    formatSecondary: (value: number) => string;
  }) => (
    <div data-testid="dual-axis-chart">
      {primaryLabel}: {formatPrimary(7.25)} / {secondaryLabel}: {formatSecondary(121.4)}
    </div>
  )),
}));

const mockGetEconomicSeriesClient =
  getEconomicSeriesClient as jest.MockedFunction<typeof getEconomicSeriesClient>;
const mockDualAxisChart = DualAxisChart as jest.MockedFunction<
  typeof DualAxisChart
>;

function renderCorrelation(requireAnchor = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SeriesCorrelation
        anchor={{
          key: "markets.short_interest_avg.materials.aus",
          label: "Materials short interest",
          format: "percent"
        }}
        overlayCandidates={[
          {
            key: "commodities.price_index.bulk.aus",
            label: "Bulk commodity prices",
            format: "index",
          },
        ]}
        title="Materials short interest vs the economy"
        description="Compare the industry's short interest with national indicators."
        sectionAriaLabel="Materials economy context"
        chartAriaLabel="Materials short interest versus economic context"
        requireAnchor={requireAnchor}
        missingAnchorMessage="No derived short-interest history is available for Materials yet."
      />
    </QueryClientProvider>,
  );
}

describe("SeriesCorrelation", () => {
  beforeEach(() => {
    mockGetEconomicSeriesClient.mockReset();
    mockDualAxisChart.mockClear();
  });

  it("accepts an arbitrary anchor series and overlay candidates", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, {
        series: [
          {
            info: { seriesKey: "markets.short_interest_avg.materials.aus" },
            observations: [
              { period: { seconds: 1_700_000_000n }, value: 7.1 },
              { period: { seconds: 1_702_700_000n }, value: 7.25 },
            ],
          },
          {
            info: { seriesKey: "commodities.price_index.bulk.aus" },
            observations: [
              { period: { seconds: 1_700_000_000n }, value: 120 },
              { period: { seconds: 1_702_700_000n }, value: 121.4 },
            ],
          },
        ],
      }),
    );

    renderCorrelation();

    await waitFor(() => expect(mockGetEconomicSeriesClient).toHaveBeenCalledTimes(2));
    expect(mockGetEconomicSeriesClient).toHaveBeenNthCalledWith(1, [
      "markets.short_interest_avg.materials.aus",
    ]);
    expect(mockGetEconomicSeriesClient).toHaveBeenNthCalledWith(2, [
      "commodities.price_index.bulk.aus",
    ]);
    expect(await screen.findByTestId("dual-axis-chart")).toHaveTextContent(
      "Materials short interest: 7.3% / Bulk commodity prices: 121.4",
    );
  });

  it("excludes pre-anchor overlay points from the chart without changing the correlation chip", async () => {
    const monthly = (year: number, month: number, value: number) => ({
      period: {
        seconds: BigInt(Math.floor(Date.UTC(year, month, 1) / 1000)),
      },
      value,
    });
    const anchor = Array.from({ length: 12 }, (_, month) =>
      monthly(2025, month, month + 1),
    );
    const alignedOverlay = Array.from({ length: 12 }, (_, month) =>
      monthly(2025, month, (month + 1) * 10),
    );
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, {
        series: [
          {
            info: { seriesKey: "markets.short_interest_avg.materials.aus" },
            observations: anchor,
          },
          {
            info: { seriesKey: "commodities.price_index.bulk.aus" },
            observations: [monthly(1982, 0, 999), ...alignedOverlay],
          },
        ],
      }),
    );

    renderCorrelation();

    expect(await screen.findByTestId("dual-axis-chart")).toBeInTheDocument();
    const chartProps = mockDualAxisChart.mock.calls[0]?.[0];
    expect(chartProps?.secondary).toHaveLength(12);
    expect(chartProps?.secondary[0]?.date).toEqual(
      new Date(Date.UTC(2025, 0, 1)),
    );
    expect(
      screen.getByRole("button", {
        name: /Bulk commodity prices.*r = 1\.00.*12m/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows the supplied empty state when a required anchor is absent", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, {
        series: [
          {
            info: { seriesKey: "commodities.price_index.bulk.aus" },
            observations: [
              { period: { seconds: 1_700_000_000n }, value: 120 },
              { period: { seconds: 1_702_700_000n }, value: 121.4 },
            ],
          },
        ],
      }),
    );

    renderCorrelation(true);

    expect(
      await screen.findByText(
        "No derived short-interest history is available for Materials yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("dual-axis-chart")).not.toBeInTheDocument();
  });

  it("drops observations whose protobuf period is unset", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, {
        series: [
          {
            info: { seriesKey: "markets.short_interest_avg.materials.aus" },
            observations: [
              { value: 99 },
              { period: { seconds: 1_700_000_000n }, value: 7.1 },
              { period: { seconds: 1_702_700_000n }, value: 7.25 },
            ],
          },
          {
            info: { seriesKey: "commodities.price_index.bulk.aus" },
            observations: [
              { period: { seconds: 1_700_000_000n }, value: 120 },
              { period: { seconds: 1_702_700_000n }, value: 121.4 },
            ],
          },
        ],
      }),
    );

    renderCorrelation();

    expect(await screen.findByTestId("dual-axis-chart")).toBeInTheDocument();
    const primary = mockDualAxisChart.mock.calls[0]?.[0].primary;
    expect(primary).toHaveLength(2);
    expect(primary?.some((point) => point.date.getUTCFullYear() === 1970)).toBe(false);
  });

  it("reuses the stable overlay query when only the anchor changes", async () => {
    mockGetEconomicSeriesClient.mockImplementation(async (keys) =>
      create(GetEconomicSeriesResponseSchema, {
        series: keys.map((key) => ({
          info: { seriesKey: key },
          observations: [
            { period: { seconds: 1_700_000_000n }, value: 1 },
            { period: { seconds: 1_702_700_000n }, value: 2 },
          ],
        })),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overlayCandidates = [
      {
        key: "commodities.price_index.bulk.aus",
        label: "Bulk commodity prices",
        format: "index" as const,
      },
    ];
    const correlation = (anchorKey: string, anchorLabel: string) => (
      <QueryClientProvider client={queryClient}>
        <SeriesCorrelation
          anchor={{ key: anchorKey, label: anchorLabel, format: "percent" }}
          overlayCandidates={overlayCandidates}
          title="Industry short interest vs the economy"
          description="Compare industry short interest with national indicators."
          sectionAriaLabel="Industry economy context"
          chartAriaLabel="Industry short interest versus economic context"
          requireAnchor
        />
      </QueryClientProvider>
    );

    const view = render(
      correlation(
        "markets.short_interest_avg.materials.aus",
        "Materials short interest",
      ),
    );
    await waitFor(() => expect(mockGetEconomicSeriesClient).toHaveBeenCalledTimes(2));

    view.rerender(
      correlation(
        "markets.short_interest_avg.energy.aus",
        "Energy short interest",
      ),
    );
    await waitFor(() => expect(mockGetEconomicSeriesClient).toHaveBeenCalledTimes(3));

    const overlayCalls = mockGetEconomicSeriesClient.mock.calls.filter(
      ([keys]) => keys.length === 1 && keys[0] === "commodities.price_index.bulk.aus",
    );
    expect(overlayCalls).toHaveLength(1);
  });
});
