import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

import { EconomyMapExplorer } from "../economy-map-explorer";

const mockReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/housing/use-topojson", () => ({
  useTopojson: () => ({ data: undefined }),
}));
jest.mock("~/app/actions/client/getEconomyClient", () => ({
  getEconomicSeriesClient: jest.fn().mockResolvedValue({ series: [] }),
  getStateCompanyAggregatesClient: jest
    .fn()
    .mockResolvedValue({ aggregates: [] }),
}));
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
}));

describe("EconomyMapExplorer metric switcher", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }),
    });
  });

  it("keeps eight chips visible and swaps an overflow selection into the row", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <EconomyMapExplorer />
      </QueryClientProvider>,
    );

    expect(
      screen.getAllByRole("button").filter((button) =>
        button.className.includes("rounded-full"),
      ),
    ).toHaveLength(9);
    expect(
      screen.queryByRole("button", { name: "Dwelling approvals" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const approvals = await screen.findByRole("menuitem", {
      name: "Dwelling approvals",
    });
    fireEvent.click(approvals);

    expect(
      screen.getByRole("button", { name: "Dwelling approvals" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Goods exports" }),
    ).not.toBeInTheDocument();
  });
});
