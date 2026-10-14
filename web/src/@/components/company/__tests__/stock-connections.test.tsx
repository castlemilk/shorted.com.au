import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

const mockGetStockGraph = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockGraph: (...args: unknown[]) => mockGetStockGraph(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { StockConnections } from "../stock-connections";

function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("StockConnections", () => {
  it("badges a peer's industry, and gives one the ASX has not classified no badge", async () => {
    // AFI's Company tab on production (2026-10-14) listed its peers, all
    // listed investment companies, as "Not Applic".
    mockGetStockGraph.mockResolvedValue({
      similarCompanies: [
        { stockCode: "ARG", companyName: "Argo Investments", industry: "Not Applic", similarity: 0.73 },
        { stockCode: "BKI", companyName: "BKI Investment", industry: "Class Pend", similarity: 0.7 },
        { stockCode: "MQG", companyName: "Macquarie Group", industry: "Diversified Financials", similarity: 0.6 },
      ],
    });

    const { container } = renderWithQueryClient(<StockConnections stockCode="AFI" />);

    expect(await screen.findByText("Argo Investments")).toBeInTheDocument();
    expect(screen.getByText("Diversified Financials")).toBeInTheDocument();
    expect(screen.getByText("73% match")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/not applic|class pend/i);
  });
});
