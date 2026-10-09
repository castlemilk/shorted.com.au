/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
jest.mock("next/dynamic", () => () => () => <div data-testid="chart-panel" />);
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
}));
jest.mock("~/app/actions/getLatestShortDate", () => ({
  getLatestShortDate: jest.fn().mockResolvedValue(new Date("2026-10-02T00:00:00Z")),
}));
jest.mock("../short-interest-summary", () => ({
  ShortInterestSummary: ({ asOfClause }: { asOfClause: string }) => (
    <p data-testid="summary">{asOfClause}</p>
  ),
  getShortInterestDeltas: jest.fn().mockResolvedValue({}),
}));
jest.mock("~/@/components/company/stock-tab-nav", () => ({
  StockTabNav: ({ stockCode }: { stockCode: string }) => <nav data-testid="tab-nav">{stockCode}</nav>,
}));
jest.mock("~/@/components/company/stock-breadcrumbs", () => ({
  StockBreadcrumbs: () => <div data-testid="breadcrumbs" />,
}));
jest.mock("~/@/components/themes/theme-chips", () => ({ StockThemeChips: () => <div data-testid="chips" /> }));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("~/@/components/ui/companyProfile", () => ({
  __esModule: true, default: () => <div data-testid="profile" />, CompanyProfilePlaceholder: () => null,
}));
jest.mock("~/@/components/ui/companyStats", () => ({
  __esModule: true, default: () => <div data-testid="stats" />, CompanyStatsPlaceholder: () => null,
}));
jest.mock("~/@/components/ui/login-prompt-banner", () => ({ LoginPromptBanner: () => null }));
jest.mock("~/@/components/ui/session-gates", () => ({ SignedOutOnly: () => null }));

import StockLayout from "../layout";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { getShortInterestDeltas } from "../short-interest-summary";
import { NotFoundError } from "~/app/actions/withRetry";

const stock = { name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58, reportedShortPositions: 80_000_000 };

describe("stock layout", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockNotFound.mockClear();
  });

  it("renders the chrome in order and the page beneath the tab bar", async () => {
    mockGetStockOrNotFound.mockResolvedValue(stock);
    const el = await StockLayout({
      params: Promise.resolve({ stockCode: "bhp" }),
      children: <div data-testid="child" />,
    });
    const { container } = render(el);
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["breadcrumbs", "profile", "stats", "summary", "chips", "chart-panel", "tab-nav", "child"]);
    expect(screen.getByTestId("summary")).toHaveTextContent("as of 2 Oct 2026");
    expect(screen.getByTestId("tab-nav")).toHaveTextContent("BHP");
    expect(mockGetStockOrNotFound).toHaveBeenCalledWith("BHP");
  });

  it("404s a malformed code before any fetch", async () => {
    await expect(
      StockLayout({ params: Promise.resolve({ stockCode: "not-a-code" }), children: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetStockOrNotFound).not.toHaveBeenCalled();
  });

  it("404s a code the API does not know", async () => {
    mockGetStockOrNotFound.mockRejectedValue(new NotFoundError("ZZZZ"));
    await expect(
      StockLayout({ params: Promise.resolve({ stockCode: "ZZZZ" }), children: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails the ISR render on a transient read instead of caching a degraded shell", async () => {
    mockGetStockOrNotFound.mockResolvedValue(undefined);
    await expect(
      StockLayout({ params: Promise.resolve({ stockCode: "BHP" }), children: null }),
    ).rejects.toThrow(/transiently unavailable/);
  });

  it("degrades the as-of clause when the report date cannot be read, rather than failing the render", async () => {
    jest.mocked(getLatestShortDate).mockRejectedValueOnce(new Error("series unavailable"));
    mockGetStockOrNotFound.mockResolvedValue(stock);
    const el = await StockLayout({
      params: Promise.resolve({ stockCode: "BHP" }),
      children: null,
    });
    render(el);
    expect(screen.getByTestId("summary")).toHaveTextContent("in the latest ASIC report");
  });

  // The report-date and delta reads need only the code, so the layout starts
  // them before it waits for the stock: a regeneration then pays for the slower
  // of the two round-trips, not for one after the other.
  describe("the series reads", () => {
    it("start before the stock read settles", async () => {
      let settleStock!: (value: unknown) => void;
      mockGetStockOrNotFound.mockReturnValue(
        new Promise((resolve) => {
          settleStock = resolve;
        }),
      );
      jest.mocked(getLatestShortDate).mockClear();
      jest.mocked(getShortInterestDeltas).mockClear();

      const rendering = StockLayout({
        params: Promise.resolve({ stockCode: "bhp" }),
        children: null,
      });
      // Let the layout run as far as the stock read, which is still pending.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockGetStockOrNotFound).toHaveBeenCalledWith("BHP");
      expect(getLatestShortDate).toHaveBeenCalledWith("BHP");
      expect(getShortInterestDeltas).toHaveBeenCalledWith("BHP");

      settleStock(stock);
      render(await rendering);
      expect(screen.getByTestId("summary")).toHaveTextContent("as of 2 Oct 2026");
    });

    it("are not waited on by a 404", async () => {
      jest.mocked(getLatestShortDate).mockReturnValueOnce(new Promise(() => undefined));
      jest.mocked(getShortInterestDeltas).mockReturnValueOnce(new Promise(() => undefined));
      mockGetStockOrNotFound.mockRejectedValue(new NotFoundError("ZZZZ"));
      await expect(
        StockLayout({ params: Promise.resolve({ stockCode: "ZZZZ" }), children: null }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
    });

    it("are not waited on by a transient stock read, which still fails the render", async () => {
      jest.mocked(getLatestShortDate).mockReturnValueOnce(new Promise(() => undefined));
      jest.mocked(getShortInterestDeltas).mockReturnValueOnce(new Promise(() => undefined));
      mockGetStockOrNotFound.mockResolvedValue(undefined);
      await expect(
        StockLayout({ params: Promise.resolve({ stockCode: "BHP" }), children: null }),
      ).rejects.toThrow(/transiently unavailable/);
    });
  });
});
