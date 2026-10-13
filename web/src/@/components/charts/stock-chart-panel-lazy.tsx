"use client";

/**
 * The Overview's price and short-interest chart, fetched once the page is in
 * the browser.
 *
 * The panel reads prices through Connect-RPC and the market-data hooks, so it
 * is client-only (ssr: false). Why the Overview loads it from here and not with
 * a next/dynamic in its own page, as Short interest does: Next 14 merges the
 * Overview page's client manifest into every tab below it, and maps each client
 * module to the whole first-load chunk list of the page that holds it. A
 * next/dynamic in a server component is bundled into that list, so a tab that
 * resolved a shared module (next/link) through the Overview's mapping
 * downloaded the chart: Financials and Community did. Called in a client module,
 * next/dynamic is a real import(): the chart is a chunk of its own, in no list
 * another tab inherits. web/scripts/stock-chart-chunks.mjs checks the build's
 * manifests, and e2e/stock-tabs.spec.ts what each tab downloads.
 *
 * Its placeholder is the panel's own skeleton, the one loading.tsx shows too,
 * so the box is the size the panel lands on and nothing below it moves.
 */

import dynamic from "next/dynamic";
import { activeStockTab } from "@/lib/stocks/stock-tabs";
import { StockChartPanelSkeleton } from "./stock-chart-section";

// Start fetching the panel's code as soon as this module runs on the Overview,
// during hydration, not when the panel first renders after it. On a throttled
// phone (150ms, 1.6 Mbps) that brings the drawn chart back to when it landed
// while it was a first-load chunk, about 4.1s for BHP, from 4.4s.
//
// Only on the Overview, and never on the server, where the panel's Connect-RPC
// imports must not run. This module runs on other tabs too: a tab that resolves
// a shared module through the Overview's chunk lists loads the Overview's page
// chunk, which runs every client module the Overview has. Unguarded, this
// fetched the chart on Financials and Community again (Financials downloaded
// 1341 KiB of JS, against 1113 KiB without it).
if (
  typeof window !== "undefined" &&
  activeStockTab(window.location.pathname) === "overview"
) {
  void import("./StockChartPanel");
}

export const StockChartPanelLazy = dynamic(
  () => import("./StockChartPanel").then((m) => m.StockChartPanel),
  {
    ssr: false,
    loading: () => <StockChartPanelSkeleton />,
  },
);
