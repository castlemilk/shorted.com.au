/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
// Any client island the layout loaded through next/dynamic would draw this
// stand-in. The layout loads none: its charts moved onto their own tabs.
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: jest.fn(() => () => <div data-testid="chart-panel" />),
}));
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
}));
jest.mock("~/app/actions/getLatestShortDate", () => ({
  getLatestShortDate: jest.fn().mockResolvedValue(new Date("2026-10-02T00:00:00Z")),
}));
jest.mock("../short-interest-summary", () => ({
  ShortInterestSummary: () => <p data-testid="summary" />,
  getShortInterestDeltas: jest.fn().mockResolvedValue({ change30d: 0.42 }),
}));
// The header stand-in shows what the layout handed it: the props are what is
// under test, the header's own markup has its own suite.
jest.mock("~/@/components/company/stock-header", () => ({
  StockHeader: ({
    stockCode,
    stock,
    change30d,
    asOf,
  }: {
    stockCode: string;
    stock: { name: string };
    change30d: number | null;
    asOf: Date | null;
  }) => (
    <header
      data-testid="header"
      data-code={stockCode}
      data-name={stock.name}
      data-change30d={String(change30d)}
      data-as-of={asOf ? asOf.toISOString() : "none"}
    />
  ),
}));
jest.mock("~/@/components/company/stock-tab-nav", () => ({
  StockTabNav: ({ stockCode }: { stockCode: string }) => <nav data-testid="tab-nav">{stockCode}</nav>,
}));
jest.mock("~/@/components/company/stock-breadcrumbs", () => ({
  StockBreadcrumbs: () => <div data-testid="breadcrumbs" />,
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import nextDynamic from "next/dynamic";
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

  it("renders the chrome in order, then the page beneath the tab bar", async () => {
    mockGetStockOrNotFound.mockResolvedValue(stock);
    const el = await StockLayout({
      params: Promise.resolve({ stockCode: "bhp" }),
      children: <div data-testid="child" />,
    });
    const { container } = render(el);
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["breadcrumbs", "header", "tab-nav", "child"]);
    expect(screen.getByTestId("tab-nav")).toHaveTextContent("BHP");
    expect(mockGetStockOrNotFound).toHaveBeenCalledWith("BHP");
  });

  it("hands the header the upper-cased code, the stock it read and the figures behind its readout", async () => {
    mockGetStockOrNotFound.mockResolvedValue(stock);
    render(
      await StockLayout({
        params: Promise.resolve({ stockCode: "bhp" }),
        children: null,
      }),
    );
    const header = screen.getByTestId("header");
    expect(header).toHaveAttribute("data-code", "BHP");
    expect(header).toHaveAttribute("data-name", "BHP GROUP LIMITED ORDINARY");
    expect(header).toHaveAttribute("data-as-of", "2026-10-02T00:00:00.000Z");
    expect(header).toHaveAttribute("data-change30d", "0.42");
  });

  it("hands the header no 30-day change when the series could not give one", async () => {
    jest.mocked(getShortInterestDeltas).mockResolvedValueOnce({
      change7d: null,
      change30d: null,
      change90d: null,
      peakPct: null,
      peakDate: null,
    });
    mockGetStockOrNotFound.mockResolvedValue(stock);
    render(
      await StockLayout({
        params: Promise.resolve({ stockCode: "BHP" }),
        children: null,
      }),
    );
    expect(screen.getByTestId("header")).toHaveAttribute("data-change30d", "null");
  });

  // The charts, the summary prose and the theme chips each moved onto the tab
  // that is about them (the Overview, Short interest). The layout is on every
  // tab, so one left here would be paid for on all seven.
  it("loads no chart panel and renders none of the Overview's prose, chips or sign-in slot", async () => {
    mockGetStockOrNotFound.mockResolvedValue(stock);
    const { container } = render(
      await StockLayout({
        params: Promise.resolve({ stockCode: "BHP" }),
        children: <div data-testid="child" />,
      }),
    );
    expect(nextDynamic).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chart-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("summary")).not.toBeInTheDocument();
    expect(container.querySelector(".login-slot")).toBeNull();
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

  it("hands the header no as-of date when the report date cannot be read, rather than failing the render", async () => {
    jest.mocked(getLatestShortDate).mockRejectedValueOnce(new Error("series unavailable"));
    mockGetStockOrNotFound.mockResolvedValue(stock);
    const el = await StockLayout({
      params: Promise.resolve({ stockCode: "BHP" }),
      children: null,
    });
    render(el);
    // No date: the header leaves its "as of" out rather than inventing one.
    expect(screen.getByTestId("header")).toHaveAttribute("data-as-of", "none");
    expect(screen.getByTestId("header")).toHaveAttribute("data-change30d", "0.42");
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
      expect(screen.getByTestId("header")).toHaveAttribute("data-as-of", "2026-10-02T00:00:00.000Z");
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
