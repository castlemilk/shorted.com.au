"use client";

import { usePathname } from "next/navigation";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  activeStockTab,
  stockTabHref,
  stockTabLabel,
} from "~/@/lib/stocks/stock-tabs";

/**
 * Stocks › CODE › {Tab} — the tab item is omitted on the overview. Prefetch is
 * off: the trail is on every tab and links to the Overview, so Next's viewport
 * prefetch would fetch (and on a cold cache generate) it on every tab view.
 */
export function StockBreadcrumbs({ stockCode }: { stockCode: string }) {
  const tab = activeStockTab(usePathname() ?? "");
  const items = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: stockTabHref(stockCode, "overview") },
  ];
  if (tab !== "overview") {
    items.push({ label: stockTabLabel(tab), href: stockTabHref(stockCode, tab) });
  }
  return <Breadcrumbs items={items} prefetch={false} />;
}
