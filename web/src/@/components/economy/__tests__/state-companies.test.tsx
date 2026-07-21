import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { listStateCompaniesClient } from "~/app/actions/client/getEconomyClient";
import {
  ListStateCompaniesResponseSchema,
  type ListStateCompaniesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { StateCompanies } from "../state-companies";

jest.mock("~/app/actions/client/getEconomyClient", () => ({
  listStateCompaniesClient: jest.fn(),
}));

// StockLogoImg routes allowlisted-host logos (storage.googleapis.com) through
// next/image, which crashes in jsdom — substitute a plain <img>.
jest.mock("next/image", () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));

const mockListStateCompaniesClient =
  listStateCompaniesClient as jest.MockedFunction<
    typeof listStateCompaniesClient
  >;

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function waCompanies(): ListStateCompaniesResponse {
  return create(ListStateCompaniesResponseSchema, {
    companies: [
      {
        stockCode: "FMG",
        companyName: "Fortescue Ltd",
        industry: "Materials",
        weight: 0.85,
        basis: "Pilbara iron ore operations",
        marketCap: 60_000_000_000,
        shortPercent: 9.4,
        logoUrl: "https://storage.googleapis.com/shorted-logos/FMG.png",
        source: "llm",
      },
      {
        stockCode: "WES",
        companyName: "Wesfarmers Limited",
        industry: "Consumer Discretionary",
        weight: 0.3,
        basis: "",
        marketCap: 80_000_000_000,
        shortPercent: 0,
        logoUrl: "",
        source: "hq_fallback",
      },
    ],
  });
}

describe("StateCompanies", () => {
  beforeEach(() => mockListStateCompaniesClient.mockClear());

  it("renders rows with weight badge, short chip, and /shorts links", async () => {
    mockListStateCompaniesClient.mockResolvedValue(waCompanies());
    renderWithQueryClient(<StateCompanies state="wa" />);

    await waitFor(() => expect(screen.getByText("FMG")).toBeInTheDocument());
    expect(mockListStateCompaniesClient).toHaveBeenCalledWith("wa", 8);
    expect(screen.getByText("Operating here")).toBeInTheDocument();
    expect(screen.getByText("Fortescue Ltd")).toBeInTheDocument();
    // weight badges use the state's abbreviation
    expect(screen.getByText("WA 85%")).toBeInTheDocument();
    expect(screen.getByText("WA 30%")).toBeInTheDocument();
    // short chip only for non-zero short interest
    expect(screen.getByText("9.4% short")).toBeInTheDocument();
    expect(screen.queryByText("0.0% short")).not.toBeInTheDocument();
    // hq_fallback rows get the muted HQ tag
    expect(screen.getByText("HQ")).toBeInTheDocument();
    // rows link to the stock page
    const link = screen.getByText("FMG").closest("a");
    expect(link).toHaveAttribute("href", "/shorts/FMG");
    // attribution footnote
    expect(
      screen.getByText(/Operations-weighted, AI-estimated/i),
    ).toBeInTheDocument();
  });

  it("renders nothing when the state has no companies", async () => {
    mockListStateCompaniesClient.mockResolvedValue(
      create(ListStateCompaniesResponseSchema, { companies: [] }),
    );
    const { container } = renderWithQueryClient(<StateCompanies state="nt" />);
    await waitFor(() =>
      expect(mockListStateCompaniesClient).toHaveBeenCalled(),
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
