import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import { StockDetailsSchema } from "~/gen/stocks/v1alpha1/stocks_pb";

// The twin's data hook and its client reader. The hook is the only thing that
// decides which card the twin draws, so each test hands it one state.
const mockUseClientRetry = jest.fn();
jest.mock("@/hooks/use-client-retry", () => ({
  useClientRetry: (...args: unknown[]) => mockUseClientRetry(...args),
}));
jest.mock("~/app/actions/client/getStockDetails", () => ({
  fetchStockDetailsClient: jest.fn(),
}));

import { CompanyInfoSkeleton, CompanyInfoView } from "../company-info-view";
import { CompanyInfoWithRetry } from "../company-info-with-retry";

/**
 * The Overview's right-rail card (website, address, social links) is titled
 * "Company details". The Overview's own About card (page.tsx) holds the
 * description, and a second "About" heading made the page read as a repeat
 * (spec D4, "Names"). The card has five faces, three in the server view and two
 * more in the client twin that draws them when the server read failed; every
 * one carries the new title, or the repeat comes back on the day a read fails.
 */
describe("the right-rail company card's title", () => {
  const details = create(StockDetailsSchema, {
    productCode: "BHP",
    website: "https://www.bhp.com",
    address: "171 Collins Street, Melbourne",
  });
  const title = () => screen.getByText("Company details");

  afterEach(() => {
    mockUseClientRetry.mockReset();
  });

  it("is Company details on the card with data", () => {
    render(<CompanyInfoView stockDetails={details} />);
    expect(title()).toBeInTheDocument();
    expect(screen.getByText("bhp.com")).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });

  it("is Company details on the card with nothing to show", () => {
    render(
      <CompanyInfoView
        stockDetails={create(StockDetailsSchema, { productCode: "BHP" })}
      />,
    );
    expect(title()).toBeInTheDocument();
    expect(
      screen.getByText("Company information is being updated. Check back soon."),
    ).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });

  it("is Company details on the skeleton, with and without the retry spinner", () => {
    const { container, rerender } = render(<CompanyInfoSkeleton />);
    expect(title()).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();

    rerender(<CompanyInfoSkeleton isRetrying />);
    expect(title()).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });

  it("is Company details on the twin's card for a read that returned nothing", () => {
    mockUseClientRetry.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      retry: jest.fn(),
      isRetrying: false,
      rateLimitInfo: null,
    });
    render(<CompanyInfoWithRetry stockCode="BHP" initialData={null} />);
    expect(title()).toBeInTheDocument();
    expect(
      screen.getByText("Company information not available"),
    ).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });

  it("is Company details on the twin's card for a read that failed", () => {
    mockUseClientRetry.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error("unavailable"),
      retry: jest.fn(),
      isRetrying: false,
      rateLimitInfo: null,
    });
    render(<CompanyInfoWithRetry stockCode="BHP" initialData={null} />);
    expect(title()).toBeInTheDocument();
    expect(
      screen.getByText("Failed to load company information for BHP."),
    ).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });

  it("is Company details on the twin's loading card and on the card it hands the data to", () => {
    mockUseClientRetry.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      retry: jest.fn(),
      isRetrying: false,
      rateLimitInfo: null,
    });
    const { rerender } = render(
      <CompanyInfoWithRetry stockCode="BHP" initialData={null} />,
    );
    expect(title()).toBeInTheDocument();

    mockUseClientRetry.mockReturnValue({
      data: details,
      isLoading: false,
      error: null,
      retry: jest.fn(),
      isRetrying: false,
      rateLimitInfo: null,
    });
    rerender(<CompanyInfoWithRetry stockCode="BHP" initialData={null} />);
    expect(title()).toBeInTheDocument();
    expect(screen.getByText("bhp.com")).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });
});
