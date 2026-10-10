import { render, screen } from "@testing-library/react";

// The query is the table's only collaborator. It is answered here, so the
// table can be held in each state; the transport and the generated service are
// stand-ins for modules that are never called.
const mockUseQuery = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));

import { DirectorTradesSkeleton } from "../director-trades-skeleton";
import { DirectorTradesTable } from "../director-trades-table";

const trade = {
  id: "t1",
  tradeDate: "2026-09-30",
  directorName: "Jane Citizen",
  tradeType: "buy",
  sharesTraded: "12000",
  pricePerShare: 43.21,
  totalValue: "518520",
  announcementUrl: "https://announcements.example/t1.pdf",
};

describe("DirectorTradesTable", () => {
  beforeEach(() => mockUseQuery.mockReset());

  it("draws the skeleton card while its query loads, to the byte", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const loading = render(<DirectorTradesTable stockCode="BHP" />);
    const skeleton = render(<DirectorTradesSkeleton />);
    expect(loading.container.innerHTML).not.toBe("");
    expect(loading.container.innerHTML).toBe(skeleton.container.innerHTML);
  });

  it("says there are none when the query fails or returns no trades", () => {
    for (const result of [
      { data: undefined, isLoading: false, isError: true },
      { data: { trades: [], totalCount: 0 }, isLoading: false, isError: false },
    ]) {
      mockUseQuery.mockReturnValue(result);
      const { unmount } = render(<DirectorTradesTable stockCode="BHP" />);
      expect(screen.getByText("No director trades found")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Director trades" })).toBeInTheDocument();
      unmount();
    }
  });

  it("lists the trades with their count once they have loaded", () => {
    mockUseQuery.mockReturnValue({
      data: { trades: [trade], totalCount: 1 },
      isLoading: false,
      isError: false,
    });
    render(<DirectorTradesTable stockCode="BHP" />);
    expect(screen.getByText("1 trade recorded")).toBeInTheDocument();
    expect(screen.getByText("Jane Citizen")).toBeInTheDocument();
    expect(screen.getByText("$43.210")).toBeInTheDocument();
    expect(screen.queryByText("No director trades found")).toBeNull();
  });
});
