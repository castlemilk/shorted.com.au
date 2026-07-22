import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { getCompanyTaxProfileClient } from "~/app/actions/client/getCompanyTaxProfileClient";
import { GetCompanyTaxProfileResponseSchema, type GetCompanyTaxProfileResponse } from "~/gen/shorts/v1alpha1/stock_pb";
import { CompanyTaxCard } from "../company-tax-card";

jest.mock("~/app/actions/client/getCompanyTaxProfileClient", () => ({
  getCompanyTaxProfileClient: jest.fn(),
}));

const mockGetCompanyTaxProfileClient =
  getCompanyTaxProfileClient as jest.MockedFunction<
    typeof getCompanyTaxProfileClient
  >;

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function taxProfile(): GetCompanyTaxProfileResponse {
  return create(GetCompanyTaxProfileResponseSchema, {
    entityName: "BHP GROUP LIMITED",
    abn: "49004028077",
    sourceAttribution:
      "ATO Corporate Tax Transparency (data.gov.au), CC BY 3.0 AU",
    years: [
      {
        incomeYear: 2024,
        totalIncome: 79_000_000_000,
        hasTaxableIncome: false,
        taxableIncome: 0,
        hasTaxPayable: false,
        taxPayable: 0,
      },
      {
        incomeYear: 2023,
        totalIncome: 85_000_000_000,
        hasTaxableIncome: true,
        taxableIncome: 42_000_000_000,
        hasTaxPayable: true,
        taxPayable: 0,
      },
    ],
  });
}

describe("CompanyTaxCard", () => {
  beforeEach(() => {
    mockGetCompanyTaxProfileClient.mockReset();
  });

  it("distinguishes absent tax payable from a reported zero", async () => {
    mockGetCompanyTaxProfileClient.mockResolvedValueOnce(taxProfile());

    renderWithQueryClient(<CompanyTaxCard stockCode="BHP" />);

    expect(await screen.findByText("Tax paid")).toBeInTheDocument();
    expect(screen.getByText("not reported")).toBeInTheDocument();
    expect(screen.getByText("nil tax payable")).toBeInTheDocument();
    expect(screen.getAllByText("nil tax payable")).toHaveLength(1);
    expect(mockGetCompanyTaxProfileClient).toHaveBeenCalledWith("BHP");
  });
});
