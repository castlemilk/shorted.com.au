import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import {
  GetEconomicSeriesResponseSchema,
  type GetEconomicSeriesResponse,
} from "~/gen/shorts/v1alpha1/economy_pb";
import { StateCrimeCard } from "../state-crime-card";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn(),
}));
jest.mock("../economy-charts", () => ({
  EconomySeriesChartView: ({
    points,
    seriesKey,
    ariaLabel,
    format,
  }: {
    points: { value: number }[];
    seriesKey: string;
    ariaLabel: string;
    format: string;
  }) => (
    <div
      role="img"
      aria-label={ariaLabel}
      data-series-key={seriesKey}
      data-format={format}
      data-first-value={points[0]?.value}
      data-last-value={points[points.length - 1]?.value}
    />
  ),
}));

const mockGetEconomicSeriesClient =
  getEconomicSeriesClient as jest.MockedFunction<
    typeof getEconomicSeriesClient
  >;

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function crimeSeries(
  seriesKey: string,
  values = [12, 14],
): GetEconomicSeriesResponse["series"][number] {
  return {
    info: { seriesKey },
    observations: [
      { period: { seconds: 1_672_531_200n }, value: values[0] },
      { period: { seconds: 1_704_067_200n }, value: values[1] },
    ],
  } as GetEconomicSeriesResponse["series"][number];
}

function crimeResponse(): GetEconomicSeriesResponse {
  return create(GetEconomicSeriesResponseSchema, {
    series: [
      crimeSeries("crime.victims.homicide.nsw"),
      crimeSeries("crime.victims_rate_100k.homicide.nsw", [1.46, 1.52]),
      crimeSeries("crime.victims.assault.nsw"),
      crimeSeries("crime.victims_rate_100k.assault.nsw"),
      crimeSeries("crime.victims.sexual-assault.nsw"),
      crimeSeries("crime.victims_rate_100k.sexual-assault.nsw"),
      crimeSeries("crime.victims.robbery.nsw"),
      crimeSeries("crime.victims_rate_100k.robbery.nsw"),
    ],
  });
}

describe("StateCrimeCard", () => {
  beforeEach(() => {
    mockGetEconomicSeriesClient.mockReset();
  });

  it("switches the active series by offence and count/rate controls", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(crimeResponse());
    const user = userEvent.setup();
    renderWithQueryClient(<StateCrimeCard state="nsw" />);

    const offence = await screen.findByLabelText("Offence");
    expect(screen.getAllByRole("option")).toHaveLength(7);
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-series-key",
      "crime.victims.homicide.nsw",
    );
    expect(screen.getByRole("img")).toHaveAttribute("data-format", "number");

    await user.click(screen.getByRole("button", { name: "Rate per 100,000" }));
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-series-key",
      "crime.victims_rate_100k.homicide.nsw",
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-format",
      "rate",
    );
    expect(screen.getByRole("img")).toHaveAttribute("data-first-value", "1.46");
    expect(screen.getByRole("img")).toHaveAttribute("data-last-value", "1.52");

    await user.selectOptions(offence, "robbery");
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-series-key",
      "crime.victims_rate_100k.robbery.nsw",
    );
  });

  it.each(["assault", "sexual-assault"])(
    "shows the within-state comparability caveat for %s",
    async (offence) => {
      mockGetEconomicSeriesClient.mockResolvedValue(crimeResponse());
      const user = userEvent.setup();
      renderWithQueryClient(<StateCrimeCard state="nsw" />);

      await user.selectOptions(
        await screen.findByLabelText("Offence"),
        offence,
      );
      expect(
        screen.getByText(/compare trends within this state only/i),
      ).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText("Offence"), "robbery");
      expect(
        screen.queryByText(/compare trends within this state only/i),
      ).not.toBeInTheDocument();
    },
  );

  it("hides the card when the state has no crime series", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, { series: [] }),
    );
    const { container } = renderWithQueryClient(<StateCrimeCard state="nt" />);

    await waitFor(() => expect(mockGetEconomicSeriesClient).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
