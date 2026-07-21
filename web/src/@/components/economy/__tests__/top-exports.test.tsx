import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import {
  GetEconomicSeriesResponseSchema,
  type GetEconomicSeriesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { TopExports } from "../top-exports";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn(),
}));

const mockGetEconomicSeriesClient =
  getEconomicSeriesClient as jest.MockedFunction<typeof getEconomicSeriesClient>;

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function series(seriesKey: string, value: number) {
  return {
    info: { seriesKey },
    observations: [{ period: { seconds: 1_700_000_000n }, value }],
  };
}

function waExports(): GetEconomicSeriesResponse {
  return create(GetEconomicSeriesResponseSchema, {
    series: [
      series("trade.export_value.mineral_fuels_lubricants_and_related_materials.wa", 5_000_000_000),
      series("trade.export_value.crude_materials_inedible_except_fuels.wa", 12_000_000_000),
      series("trade.export_value.food_and_live_animals.wa", 1_000_000_000),
    ],
  });
}

describe("TopExports", () => {
  beforeEach(() => mockGetEconomicSeriesClient.mockClear());

  it("renders commodity rows ranked by latest value (largest first)", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(waExports());
    renderWithQueryClient(<TopExports state="wa" />);

    await waitFor(() =>
      expect(screen.getByText("Top export commodities")).toBeInTheDocument(),
    );
    // Crude materials is the largest → its row exists; labels map from slugs.
    expect(screen.getByText("Crude materials")).toBeInTheDocument();
    expect(screen.getByText("Mineral fuels")).toBeInTheDocument();
    expect(screen.getByText("Food & live animals")).toBeInTheDocument();

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Crude materials"); // ranked first
  });

  it("renders nothing when no series carry observations", async () => {
    mockGetEconomicSeriesClient.mockResolvedValue(
      create(GetEconomicSeriesResponseSchema, { series: [] }),
    );
    const { container } = renderWithQueryClient(<TopExports state="nt" />);
    await waitFor(() => expect(mockGetEconomicSeriesClient).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
