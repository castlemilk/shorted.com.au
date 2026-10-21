import { render } from "@testing-library/react";

/**
 * /insider-trading/[stockCode] is on-demand ISR, and ISR caches whatever a
 * regeneration renders. A failed read must FAIL the render, which keeps the
 * last good page: cached, a failed trades read said "No director trades
 * recorded" with zero totals, and a failed stock read put the ticker where the
 * company name goes, for the hour. Only a code the API does not know is a 404.
 */

const getStockOrNotFound = jest.fn();
const getDirectorTrades = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// Both stock reads answer alike, so a page that went back to getStock (which
// returns undefined for NotFound and for a failure) fails here rather than
// throwing for a missing mock.
jest.mock("~/app/actions/getStock", () => ({
  getStock: (...args: unknown[]) => getStockOrNotFound(...args),
  getStockOrNotFound: (...args: unknown[]) => getStockOrNotFound(...args),
}));
jest.mock("~/app/actions/getDirectorTrades", () => ({
  getDirectorTrades: (...args: unknown[]) => getDirectorTrades(...args),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));

import { NotFoundError } from "~/app/actions/withRetry";
import StockInsiderTradingPage from "../page";

const BHP = { name: "BHP Group", industry: "Materials", percentageShorted: 0.4 };

function trade(id: string, tradeDate: string, tradeType = "buy") {
  return {
    id,
    stockCode: "BHP",
    directorName: `Director ${id}`,
    tradeType,
    sharesTraded: 1_000,
    pricePerShare: 40,
    totalValue: 40_000,
    tradeDate,
  };
}

const params = (stockCode: string) => ({ params: Promise.resolve({ stockCode }) });

function articleSchema(container: HTMLElement): Record<string, unknown> {
  const found = Array.from(container.querySelectorAll('script[type="application/ld+json"]'))
    .map((script) => JSON.parse(script.innerHTML) as Record<string, unknown>)
    .find((json) => json["@type"] === "Article");
  if (!found) throw new Error("the page renders no Article");
  return found;
}

describe("insider trading page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    getStockOrNotFound.mockResolvedValue(BHP);
    // The API's order: newest first.
    getDirectorTrades.mockResolvedValue({
      trades: [trade("t2", "2026-10-01"), trade("t1", "2026-08-14", "sell")],
      totalCount: 2,
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("names the company and lists the trades", async () => {
    const { getByRole, getAllByRole } = render(await StockInsiderTradingPage(params("BHP")));

    expect(getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) Director Trades");
    expect(getAllByRole("row")).toHaveLength(3);
    expect(getStockOrNotFound).toHaveBeenCalledWith("BHP");
    expect(getDirectorTrades).toHaveBeenCalledWith("BHP", 100);
  });

  // They were `new Date()`, so every regeneration read as a new article.
  it("dates its Article from the oldest and newest trade shown", async () => {
    const { container } = render(await StockInsiderTradingPage(params("BHP")));

    expect(articleSchema(container)).toMatchObject({
      datePublished: "2026-08-14",
      dateModified: "2026-10-01",
    });
  });

  it("states no Article dates without a trade", async () => {
    getDirectorTrades.mockResolvedValue({ trades: [], totalCount: 0 });
    const { container, getByText } = render(await StockInsiderTradingPage(params("BHP")));

    const article = articleSchema(container);
    expect(article).not.toHaveProperty("datePublished");
    expect(article).not.toHaveProperty("dateModified");
    // An empty list the API answered is a real answer, and renders as one.
    expect(getByText(/No director trades recorded for BHP yet/)).toBeInTheDocument();
  });

  it("fails the render when the trades cannot be read", async () => {
    getDirectorTrades.mockResolvedValue(undefined);

    await expect(StockInsiderTradingPage(params("BHP"))).rejects.toThrow(
      /director trades transiently unavailable/,
    );
  });

  it("fails the render when the stock cannot be read", async () => {
    getStockOrNotFound.mockResolvedValue(undefined);

    await expect(StockInsiderTradingPage(params("BHP"))).rejects.toThrow(
      /stock data transiently unavailable/,
    );
  });

  it("answers 404 for a code the API does not know", async () => {
    getStockOrNotFound.mockRejectedValue(new NotFoundError("stock not found: ZZZZ"));
    getDirectorTrades.mockResolvedValue({ trades: [], totalCount: 0 });

    await expect(StockInsiderTradingPage(params("ZZZZ"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each(["AB", "ABCDE", "B-H"])("answers 404 for %s without a read: the API rejects the code", async (code) => {
    await expect(StockInsiderTradingPage(params(code))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getStockOrNotFound).not.toHaveBeenCalled();
    expect(getDirectorTrades).not.toHaveBeenCalled();
  });

  it("lets any other error through untouched", async () => {
    const outage = new Error("socket hang up");
    getStockOrNotFound.mockRejectedValue(outage);

    await expect(StockInsiderTradingPage(params("BHP"))).rejects.toBe(outage);
  });
});
