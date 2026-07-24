import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  getEconomicSeriesClient,
  listSeriesCorrelationsClient,
} from "~/app/actions/client/getEconomyClient";
import {
  GetEconomicSeriesResponseSchema,
  ListSeriesCorrelationsResponseSchema,
} from "~/gen/shorts/v1alpha1/economy_pb";
import { DualAxisChart } from "../dual-axis-chart";
import { SeriesCorrelation } from "../series-correlation";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn(),
  listSeriesCorrelationsClient: jest.fn(),
}));
jest.mock("../dual-axis-chart", () => ({
  DualAxisChart: jest.fn(
    ({
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
        {primaryLabel}: {formatPrimary(7.25)} / {secondaryLabel}:{" "}
        {formatSecondary(121.4)}
      </div>
    ),
  ),
}));

const mockGetEconomicSeriesClient =
  getEconomicSeriesClient as jest.MockedFunction<
    typeof getEconomicSeriesClient
  >;
const mockListSeriesCorrelationsClient =
  listSeriesCorrelationsClient as jest.MockedFunction<
    typeof listSeriesCorrelationsClient
  >;
const mockDualAxisChart = DualAxisChart as jest.MockedFunction<
  typeof DualAxisChart
>;

function renderCorrelation(requireAnchor = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SeriesCorrelation
        anchor={{
          key: "markets.short_interest_avg.materials.aus",
          label: "Materials short interest",
          format: "percent",
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
    mockListSeriesCorrelationsClient.mockReset();
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

    await waitFor(() =>
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledTimes(2),
    );
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
    expect(primary?.some((point) => point.date.getUTCFullYear() === 1970)).toBe(
      false,
    );
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
    await waitFor(() =>
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledTimes(2),
    );

    view.rerender(
      correlation(
        "markets.short_interest_avg.energy.aus",
        "Energy short interest",
      ),
    );
    await waitFor(() =>
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledTimes(3),
    );

    const overlayCalls = mockGetEconomicSeriesClient.mock.calls.filter(
      ([keys]) =>
        keys.length === 1 && keys[0] === "commodities.price_index.bulk.aus",
    );
    expect(overlayCalls).toHaveLength(1);
  });

  it("keeps the legacy switcher registry-complete and fetches an unavailable selection on demand", async () => {
    const observations = Array.from({ length: 12 }, (_, month) => ({
      period: {
        seconds: BigInt(Math.floor(Date.UTC(2025, month, 1) / 1000)),
      },
      value: month + 1,
    }));
    mockGetEconomicSeriesClient.mockImplementation(async (keys) => {
      const returnedKeys =
        keys.length > 1 ? ["commodities.price_index.bulk.aus"] : keys;
      return create(GetEconomicSeriesResponseSchema, {
        series: returnedKeys.map((key) => ({
          info: { seriesKey: key },
          observations,
        })),
      });
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SeriesCorrelation
          anchor={{
            key: "markets.short_interest_avg.materials.aus",
            label: "Materials short interest",
            format: "percent",
          }}
          overlayCandidates={[
            {
              key: "commodities.price_index.bulk.aus",
              label: "Bulk commodity prices",
              format: "index",
            },
            {
              key: "credit.growth_yoy.business.aus.seasadj",
              label: "Business credit growth",
              format: "percent",
            },
          ]}
          title="Materials short interest vs the economy"
          description="Compare the industry's short interest with national indicators."
          sectionAriaLabel="Materials economy context"
          chartAriaLabel="Materials short interest versus economic context"
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("dual-axis-chart")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Business credit growth" }),
    );
    await waitFor(() =>
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
        "credit.growth_yoy.business.aus.seasadj",
      ]),
    );
  });

  it("uses a partial registry match for precomputed chips and keeps the switcher registry-complete", async () => {
    mockListSeriesCorrelationsClient.mockResolvedValue(
      create(ListSeriesCorrelationsResponseSchema, {
        correlations: [
          {
            overlaySeriesKey: "commodities.price_index.bulk.aus",
            r: -0.81,
            n: 24,
          },
          {
            overlaySeriesKey: "credit.growth_yoy.business.aus.seasadj",
            r: 0.2,
            n: 24,
          },
          {
            overlaySeriesKey: "future.unknown.series",
            r: 0.99,
            n: 24,
          },
        ],
      }),
    );
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
    render(
      <QueryClientProvider client={queryClient}>
        <SeriesCorrelation
          anchor={{
            key: "markets.short_interest_avg.materials.aus",
            label: "Materials short interest",
            format: "percent",
          }}
          overlayCandidates={[
            {
              key: "commodities.price_index.bulk.aus",
              label: "Bulk commodity prices",
              format: "index",
            },
            {
              key: "credit.growth_yoy.business.aus.seasadj",
              label: "Business credit growth",
              format: "percent",
            },
            {
              key: "labour.employment.total.aus.seasadj",
              label: "Employment",
              format: "number",
            },
          ]}
          title="Materials short interest vs the economy"
          description="Compare the industry's short interest with national indicators."
          sectionAriaLabel="Materials economy context"
          chartAriaLabel="Materials short interest versus economic context"
          precomputedBaseKey="markets.short_interest_avg.materials.aus"
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", {
        name: /Bulk commodity prices.*r = −0\.81.*24m/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("future.unknown.series")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Business credit growth.*r = 0\.20.*24m/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Business credit growth" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Employment" }),
    ).toBeInTheDocument();
    expect(mockListSeriesCorrelationsClient).toHaveBeenCalledWith(
      "markets.short_interest_avg.materials.aus",
      24,
      0,
      250,
    );
    expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
      "markets.short_interest_avg.materials.aus",
    ]);
    expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
      "commodities.price_index.bulk.aus",
    ]);
    expect(mockGetEconomicSeriesClient).not.toHaveBeenCalledWith([
      "future.unknown.series",
    ]);
    expect(mockGetEconomicSeriesClient).not.toHaveBeenCalledWith([
      "commodities.price_index.bulk.aus",
      "credit.growth_yoy.business.aus.seasadj",
      "labour.employment.total.aus.seasadj",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Employment" }));
    await waitFor(() =>
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
        "labour.employment.total.aus.seasadj",
      ]),
    );
  });

  it("falls back to the existing batched client-side computation when precomputed rows are empty", async () => {
    mockListSeriesCorrelationsClient.mockResolvedValue(
      create(ListSeriesCorrelationsResponseSchema, { correlations: [] }),
    );
    mockGetEconomicSeriesClient.mockImplementation(async (keys) =>
      create(GetEconomicSeriesResponseSchema, {
        series: keys.map((key) => ({
          info: { seriesKey: key },
          observations: Array.from({ length: 12 }, (_, month) => ({
            period: {
              seconds: BigInt(Math.floor(Date.UTC(2025, month, 1) / 1000)),
            },
            value: month + 1,
          })),
        })),
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SeriesCorrelation
          anchor={{
            key: "markets.short_interest_avg.materials.aus",
            label: "Materials short interest",
            format: "percent",
          }}
          overlayCandidates={[
            {
              key: "commodities.price_index.bulk.aus",
              label: "Bulk commodity prices",
              format: "index",
            },
            {
              key: "credit.growth_yoy.business.aus.seasadj",
              label: "Business credit growth",
              format: "percent",
            },
          ]}
          title="Materials short interest vs the economy"
          description="Compare the industry's short interest with national indicators."
          sectionAriaLabel="Materials economy context"
          chartAriaLabel="Materials short interest versus economic context"
          precomputedBaseKey="markets.short_interest_avg.materials.aus"
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", {
        name: /Bulk commodity prices.*r = 1\.00.*12m/i,
      }),
    ).toBeInTheDocument();
    expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
      "commodities.price_index.bulk.aus",
      "credit.growth_yoy.business.aus.seasadj",
    ]);
  });

  it("falls back to client-side computation when precomputed rows have zero registry intersection", async () => {
    mockListSeriesCorrelationsClient.mockResolvedValue(
      create(ListSeriesCorrelationsResponseSchema, {
        correlations: [
          {
            overlaySeriesKey: "future.unknown.series",
            r: 0.99,
            n: 24,
          },
        ],
      }),
    );
    mockGetEconomicSeriesClient.mockImplementation(async (keys) =>
      create(GetEconomicSeriesResponseSchema, {
        series: keys.map((key) => ({
          info: { seriesKey: key },
          observations: Array.from({ length: 12 }, (_, month) => ({
            period: {
              seconds: BigInt(Math.floor(Date.UTC(2025, month, 1) / 1000)),
            },
            value: month + 1,
          })),
        })),
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SeriesCorrelation
          anchor={{
            key: "markets.short_interest_avg.materials.aus",
            label: "Materials short interest",
            format: "percent",
          }}
          overlayCandidates={[
            {
              key: "commodities.price_index.bulk.aus",
              label: "Bulk commodity prices",
              format: "index",
            },
            {
              key: "credit.growth_yoy.business.aus.seasadj",
              label: "Business credit growth",
              format: "percent",
            },
          ]}
          title="Materials short interest vs the economy"
          description="Compare the industry's short interest with national indicators."
          sectionAriaLabel="Materials economy context"
          chartAriaLabel="Materials short interest versus economic context"
          precomputedBaseKey="markets.short_interest_avg.materials.aus"
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", {
        name: /Bulk commodity prices.*r = 1\.00.*12m/i,
      }),
    ).toBeInTheDocument();
    expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
      "commodities.price_index.bulk.aus",
      "credit.growth_yoy.business.aus.seasadj",
    ]);
  });

  it("fetches precomputed overlays lazily and reuses each overlay query cache", async () => {
    mockListSeriesCorrelationsClient.mockResolvedValue(
      create(ListSeriesCorrelationsResponseSchema, {
        correlations: [
          {
            overlaySeriesKey: "commodities.price_index.bulk.aus",
            r: 0.82,
            n: 24,
          },
          {
            overlaySeriesKey: "credit.growth_yoy.business.aus.seasadj",
            r: -0.71,
            n: 22,
          },
        ],
      }),
    );
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
    render(
      <QueryClientProvider client={queryClient}>
        <SeriesCorrelation
          anchor={{
            key: "markets.short_interest_avg.materials.aus",
            label: "Materials short interest",
            format: "percent",
          }}
          overlayCandidates={[
            {
              key: "commodities.price_index.bulk.aus",
              label: "Bulk commodity prices",
              format: "index",
            },
            {
              key: "credit.growth_yoy.business.aus.seasadj",
              label: "Business credit growth",
              format: "percent",
            },
          ]}
          title="Materials short interest vs the economy"
          description="Compare the industry's short interest with national indicators."
          sectionAriaLabel="Materials economy context"
          chartAriaLabel="Materials short interest versus economic context"
          precomputedBaseKey="markets.short_interest_avg.materials.aus"
        />
      </QueryClientProvider>,
    );

    await screen.findByTestId("dual-axis-chart");
    expect(mockGetEconomicSeriesClient).not.toHaveBeenCalledWith([
      "credit.growth_yoy.business.aus.seasadj",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Business credit growth" }),
    );
    await waitFor(() =>
      expect(mockGetEconomicSeriesClient).toHaveBeenCalledWith([
        "credit.growth_yoy.business.aus.seasadj",
      ]),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Bulk commodity prices" }),
    );
    await waitFor(() =>
      expect(
        mockGetEconomicSeriesClient.mock.calls.filter(
          ([keys]) =>
            keys.length === 1 && keys[0] === "commodities.price_index.bulk.aus",
        ),
      ).toHaveLength(1),
    );
  });
});
