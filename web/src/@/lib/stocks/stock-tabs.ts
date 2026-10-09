// The single list of stock-page tabs. Serialisable (no React, no functions in
// data) so pages, metadata, the sitemap and the client tab bar all read it.
export type StockTabId =
  | "overview"
  | "short-interest"
  | "strategy"
  | "financials"
  | "company"
  | "news"
  | "community";

export interface StockTab {
  id: StockTabId;
  label: string;
  /** URL segment under /shorts/{CODE}; "" for the overview. */
  segment: string;
}

export const STOCK_TABS: readonly StockTab[] = [
  { id: "overview", label: "Overview", segment: "" },
  { id: "short-interest", label: "Short interest", segment: "short-interest" },
  { id: "strategy", label: "Strategy", segment: "strategy" },
  { id: "financials", label: "Financials", segment: "financials" },
  { id: "company", label: "Company", segment: "company" },
  { id: "news", label: "News", segment: "news" },
  { id: "community", label: "Community", segment: "community" },
];

export function stockTabHref(code: string, id: StockTabId): string {
  const upper = code.toUpperCase();
  const tab = STOCK_TABS.find((t) => t.id === id);
  return tab?.segment ? `/shorts/${upper}/${tab.segment}` : `/shorts/${upper}`;
}

/** The tab a pathname is on: the first segment after /shorts/{CODE}/, else overview. */
export function activeStockTab(pathname: string): StockTabId {
  const m = /^\/shorts\/[^/]+\/([^/]+)/.exec(pathname);
  if (!m) return "overview";
  const tab = STOCK_TABS.find((t) => t.segment === m[1]);
  return tab ? tab.id : "overview";
}

export function stockTabLabel(id: StockTabId): string {
  return STOCK_TABS.find((t) => t.id === id)?.label ?? "Overview";
}
