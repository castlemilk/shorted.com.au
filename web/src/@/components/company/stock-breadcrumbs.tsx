"use client";

import { usePathname } from "next/navigation";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  activeStockTab,
  stockTabHref,
  stockTabLabel,
} from "~/@/lib/stocks/stock-tabs";

/** Stocks › CODE › {Tab} — the tab item is omitted on the overview. */
export function StockBreadcrumbs({ stockCode }: { stockCode: string }) {
  const tab = activeStockTab(usePathname() ?? "");
  const items = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: stockTabHref(stockCode, "overview") },
  ];
  if (tab !== "overview") {
    items.push({ label: stockTabLabel(tab), href: stockTabHref(stockCode, tab) });
  }
  return <Breadcrumbs items={items} />;
}
