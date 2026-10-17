import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";

const mockGetPeerComparison = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getPeerComparison: (...args: unknown[]) => mockGetPeerComparison(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));
// @radix-ui/react-avatar does not load under jest (a context-scope version
// mismatch); the avatar is decoration here.
jest.mock("~/@/registry/new-york/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: () => null,
  AvatarFallback: () => null,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { PeerComparisonTable } from "../peer-comparison-table";

function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("PeerComparisonTable", () => {
  it("reads figures it does not hold as n/a, never an em dash", async () => {
    mockGetPeerComparison.mockResolvedValue({
      industry: "Materials",
      subject: {
        stockCode: "BHP",
        companyName: "BHP Group",
        logoUrl: "",
        shortPositionPercent: 1.2,
        priceChange1m: 0,
        marketCap: 0,
        peRatio: 0,
        dividendYield: 0,
      },
      peers: [
        {
          stockCode: "RIO",
          companyName: "Rio Tinto",
          logoUrl: "",
          shortPositionPercent: 0,
          priceChange1m: 2.5,
          marketCap: 180_000_000_000,
          peRatio: 11.2,
          dividendYield: 5.1,
        },
      ],
    });

    const { container } = renderWithQueryClient(<PeerComparisonTable stockCode="BHP" />);

    const bhpRow = (await screen.findByText("BHP")).closest("tr")!;
    // 1M change, market cap, P/E and yield are unknown for BHP here.
    expect(within(bhpRow).getAllByText("n/a")).toHaveLength(4);
    const rioRow = screen.getByText("RIO").closest("tr")!;
    expect(within(rioRow).getAllByText("n/a")).toHaveLength(1); // short %
    expect(within(rioRow).getByText("11.2")).toBeInTheDocument();
    expect(container.textContent).not.toContain("—");
  });

  it("finds no industry peers for a stock the ASX has not classified", async () => {
    // AFI on production (2026-10-14): "5 largest Not Applic peers by market
    // cap", a list of whatever else the ASX left unclassified.
    mockGetPeerComparison.mockResolvedValue({
      industry: "Not Applic",
      subject: {
        stockCode: "AFI",
        companyName: "Australian Foundation Investment Company",
        logoUrl: "",
        shortPositionPercent: 0.01,
        priceChange1m: 0,
        marketCap: 0,
        peRatio: 0,
        dividendYield: 0,
      },
      peers: [
        {
          stockCode: "ARG",
          companyName: "Argo Investments",
          logoUrl: "",
          shortPositionPercent: 0.02,
          priceChange1m: 0,
          marketCap: 0,
          peRatio: 0,
          dividendYield: 0,
        },
      ],
    });

    const { container } = renderWithQueryClient(<PeerComparisonTable stockCode="AFI" />);

    expect(await screen.findByText("No industry peers found")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.textContent).not.toMatch(/not applic/i);
  });
});
