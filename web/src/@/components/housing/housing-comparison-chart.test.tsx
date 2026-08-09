import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";
import { GetHousePriceSeriesResponseSchema } from "~/gen/shorts/v1alpha1/housing_pb";
import { HousingComparisonChart } from "./housing-comparison-chart";

const mockHousingMultiLineChart = jest.fn(() => <div>Comparison chart</div>);

jest.mock("~/app/actions/client/getHousingClient", () => ({
  getHousePriceSeriesClient: jest.fn(),
}));

jest.mock("./housing-multi-line-chart", () => ({
  HousingMultiLineChart: (props: unknown) => mockHousingMultiLineChart(props),
}));

const mockGetHousePriceSeriesClient = jest.mocked(getHousePriceSeriesClient);

const definitions = [
  { measure: "cash_rate", label: "Cash rate" },
  { measure: "mortgage_rate_oo", label: "Owner-occupier mortgage rate" },
  { measure: "mortgage_rate_investor", label: "Investor mortgage rate" },
] as const;

function response(
  measure: string,
  points: ReadonlyArray<{ iso: string; value: number }>,
) {
  return create(GetHousePriceSeriesResponseSchema, {
    regionCode: "AUS",
    regionName: "Australia",
    measure,
    dwellingType: "",
    unit: "percent",
    source: "RBA",
    sourceLicence: "CC BY 4.0",
    points: points.map(({ iso, value }) => ({
      period: { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 },
      value,
      isPreliminary: false,
    })),
  });
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("HousingComparisonChart", () => {
  beforeEach(() => {
    mockGetHousePriceSeriesClient.mockReset();
    mockHousingMultiLineChart.mockClear();
  });

  it("requests every measure and preserves a valid series when peers are short or unavailable", async () => {
    mockGetHousePriceSeriesClient.mockImplementation(async (_regionCode, measure) => {
      if (measure === "cash_rate") {
        return response(measure, [
          { iso: "2024-01-01T00:00:00.000Z", value: 4.1 },
          { iso: "2024-02-01T00:00:00.000Z", value: 4.35 },
        ]);
      }
      if (measure === "mortgage_rate_oo") {
        return response(measure, [
          { iso: "2024-01-01T00:00:00.000Z", value: 6.2 },
        ]);
      }
      return undefined;
    });

    renderWithQueryClient(
      <HousingComparisonChart
        regionCode="AUS"
        definitions={definitions}
        ariaLabel="Australian housing rates"
        format="percent"
      />,
    );

    await waitFor(() => expect(mockHousingMultiLineChart).toHaveBeenCalledTimes(1));

    expect(mockGetHousePriceSeriesClient.mock.calls).toEqual([
      ["AUS", "cash_rate", ""],
      ["AUS", "mortgage_rate_oo", ""],
      ["AUS", "mortgage_rate_investor", ""],
    ]);
    expect(mockHousingMultiLineChart).toHaveBeenCalledWith(
      expect.objectContaining({
        ariaLabel: "Australian housing rates",
        format: "percent",
        height: 280,
        series: [
          {
            label: "Cash rate",
            points: [
              { date: new Date("2024-01-01T00:00:00.000Z"), value: 4.1 },
              { date: new Date("2024-02-01T00:00:00.000Z"), value: 4.35 },
            ],
          },
        ],
      }),
    );
  });

  it("passes labelled annual-change points to the renderer", async () => {
    mockGetHousePriceSeriesClient.mockImplementation(async (_regionCode, measure) => {
      if (measure !== "cash_rate") return response(measure, []);
      return response(measure, [
        { iso: "2023-01-01T00:00:00.000Z", value: 100 },
        { iso: "2023-02-01T00:00:00.000Z", value: 200 },
        { iso: "2024-01-01T00:00:00.000Z", value: 110 },
        { iso: "2024-02-01T00:00:00.000Z", value: 250 },
      ]);
    });

    renderWithQueryClient(
      <HousingComparisonChart
        regionCode="AUS"
        definitions={definitions}
        ariaLabel="Annual movement"
        format="percent"
        transform="yoy"
        height={320}
      />,
    );

    await waitFor(() => expect(mockHousingMultiLineChart).toHaveBeenCalledTimes(1));

    expect(mockHousingMultiLineChart).toHaveBeenCalledWith({
      ariaLabel: "Annual movement",
      format: "percent",
      height: 320,
      series: [
        {
          label: "Cash rate",
          points: [
            { date: new Date("2024-01-01T00:00:00.000Z"), value: 10 },
            { date: new Date("2024-02-01T00:00:00.000Z"), value: 25 },
          ],
        },
      ],
    });
  });

  it("renders no data at the requested height when every series is empty", async () => {
    mockGetHousePriceSeriesClient.mockImplementation(async (_regionCode, measure) =>
      measure === "cash_rate"
        ? response(measure, [])
        : measure === "mortgage_rate_oo"
          ? response(measure, [
              { iso: "2024-01-01T00:00:00.000Z", value: 6.2 },
            ])
          : undefined,
    );

    renderWithQueryClient(
      <HousingComparisonChart
        regionCode="AUS"
        definitions={definitions}
        ariaLabel="Australian housing rates"
        format="percent"
        height={333}
      />,
    );

    const noData = await screen.findByText("No data available");
    expect(noData).toHaveStyle({ height: "333px" });
    expect(noData).toHaveAttribute("role", "status");
    expect(noData).toHaveAttribute("aria-busy", "false");
    expect(noData).toHaveClass("motion-reduce:animate-none");
    expect(mockHousingMultiLineChart).not.toHaveBeenCalled();
  });

  it("uses the requested height for its loading skeleton", () => {
    mockGetHousePriceSeriesClient.mockImplementation(() => new Promise(() => undefined));

    const { container } = renderWithQueryClient(
      <HousingComparisonChart
        regionCode="AUS"
        definitions={definitions}
        ariaLabel="Australian housing rates"
        format="percent"
        height={305}
      />,
    );

    expect(container.firstChild).toHaveStyle({ height: "305px" });
    expect(container.firstChild).toHaveClass(
      "animate-pulse",
      "motion-reduce:animate-none",
    );
    expect(container.firstChild).toHaveAttribute("role", "status");
    expect(container.firstChild).toHaveAttribute("aria-busy", "true");
  });
});
