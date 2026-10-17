import { STOCK_TABS, activeStockTab, stockTabHref, stockTabLabel } from "../stock-tabs";

describe("stock tabs", () => {
  it("lists the seven tabs in display order", () => {
    expect(STOCK_TABS.map((t) => t.id)).toEqual([
      "overview", "short-interest", "strategy", "financials", "company", "news", "community",
    ]);
    expect(STOCK_TABS.map((t) => t.label)).toEqual([
      "Overview", "Short interest", "Strategy", "Financials", "Company", "News", "Community",
    ]);
  });

  it("builds hrefs with the overview at the segment root", () => {
    expect(stockTabHref("BHP", "overview")).toBe("/shorts/BHP");
    expect(stockTabHref("bhp", "strategy")).toBe("/shorts/BHP/strategy");
    expect(stockTabHref("BHP", "short-interest")).toBe("/shorts/BHP/short-interest");
  });

  it("reads the active tab from a pathname, including nested community threads", () => {
    expect(activeStockTab("/shorts/BHP")).toBe("overview");
    expect(activeStockTab("/shorts/BHP/")).toBe("overview");
    expect(activeStockTab("/shorts/BHP/financials")).toBe("financials");
    expect(activeStockTab("/shorts/BHP/community/thread-1")).toBe("community");
    expect(activeStockTab("/shorts/BHP/not-a-tab")).toBe("overview");
    expect(activeStockTab("/stocks")).toBe("overview");
  });

  it("labels", () => {
    expect(stockTabLabel("short-interest")).toBe("Short interest");
  });
});
