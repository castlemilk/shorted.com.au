import { sb, mocked } from "storybook/test";

// Module mocks for widget data dependencies. Must be registered at the top of
// the preview file (Storybook's vite plugin statically rewrites these calls).
// Stories override per-story via `mocked(fn).mockResolvedValue(...)` in
// `beforeEach`. See src/@/mocks/STORY_GUIDE.md for the authoring contract.
// Full mock (src/app/actions/__mocks__/getTopShorts.ts): the real module
// imports kv-cache → ioredis (Node-only), which crashes the browser build.
sb.mock(import("../src/app/actions/getTopShorts"));
// Full mock: getIndustryTreeMap imports kv-cache → ioredis (Node-only).
sb.mock(import("../src/app/actions/getIndustryTreeMap"));
// Full mock: getTooltipData imports kv-cache → ioredis. Transitively imported
// by every treemap story (widget → TreemapTooltip → getTooltipData), so the
// mock is needed for the module graph to build, not just for hover behavior.
sb.mock(import("../src/app/actions/tooltip/getTooltipData"));
sb.mock(import("../src/app/actions/getStock"), { spy: true });
// Spy mode is safe: getStockData has the same import profile as getStock
// (connect-web + config + period-utils + withRetry — all browser-safe, no
// kv-cache). TimeSeriesWidget fetches its series through it.
sb.mock(import("../src/app/actions/getStockData"), { spy: true });
// Spy mode is safe here: searchStocks only imports connect-web + config +
// retry (all browser-safe; same import set getStock already proves out).
// MarketWatchlistWidget's add-stock autocomplete calls searchStocksClient.
sb.mock(import("../src/app/actions/searchStocks"), { spy: true });
sb.mock(import("../src/@/lib/stock-data-service"), { spy: true });
sb.mock(import("../src/@/lib/client-api"), { spy: true });

import type { Preview, Decorator } from "@storybook/nextjs-vite";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import "../src/styles/globals.css";

// Lazy imports resolved at runtime after mocks are registered.
// Each key in this record maps to the spy-wrapped export name used in stories.
// getTopShortsData is imported from the __mocks__ file (full mock mode).
import { getTopShortsData } from "../src/app/actions/getTopShorts";
import { getIndustryTreeMap } from "../src/app/actions/getIndustryTreeMap";
import { getTooltipData } from "../src/app/actions/tooltip/getTooltipData";
import {
  getStock,
  getStockOrNotFound,
} from "../src/app/actions/getStock";
import { getStockData } from "../src/app/actions/getStockData";
import {
  searchStocks as searchStocksAction,
  searchStocksClient,
} from "../src/app/actions/searchStocks";
import {
  getMultipleStockQuotes,
  getHistoricalData,
  getStockPrice,
  getCorrelationMatrix,
  getSectorPerformance,
  getServiceStatus,
  searchStocks,
  searchStocksEnriched,
} from "../src/@/lib/stock-data-service";
import {
  fetchStockDetailsClient,
  fetchStockDataClient,
} from "../src/@/lib/client-api";

/** Installs a throwing default so forgotten mocks surface an actionable error. */
const unmocked =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(
      `Unmocked call to ${name}() — add mocked(${name}).mockResolvedValue(...) in your story's beforeEach`,
    );
  };

// Stable QueryClient per story mount: no retries (errors surface immediately),
// no GC churn, infinite staleTime (fixtures never refetch). Client is created
// once per story mount via useRef so re-renders don't discard the cache
// mid-interaction, which would cause flaky play-function tests.
function QueryClientWrapper({ Story }: { Story: React.ComponentType }) {
  const clientRef = React.useRef<QueryClient | null>(null);
  clientRef.current ??= new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  return (
    <QueryClientProvider client={clientRef.current}>
      <Story />
    </QueryClientProvider>
  );
}

const withQueryClient: Decorator = (Story) => <QueryClientWrapper Story={Story} />;

const withTheme: Decorator = (Story) => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <Story />
  </ThemeProvider>
);

const preview: Preview = {
  decorators: [withQueryClient, withTheme],
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
  },
  beforeEach: () => {
    // Install throwing defaults for every spy-wrapped export.
    // Stories MUST call mocked(fn).mockResolvedValue(...) in their own
    // beforeEach, or they will get a descriptive error instead of a silent
    // network request or undefined return.
    mocked(getTopShortsData).mockImplementation(unmocked("getTopShortsData"));
    mocked(getIndustryTreeMap).mockImplementation(unmocked("getIndustryTreeMap"));
    mocked(getTooltipData).mockImplementation(unmocked("getTooltipData"));
    mocked(getStock).mockImplementation(unmocked("getStock"));
    mocked(getStockOrNotFound).mockImplementation(unmocked("getStockOrNotFound"));
    mocked(getStockData).mockImplementation(unmocked("getStockData"));
    // searchStocksAction is the `searchStocks` export of app/actions/searchStocks
    // (aliased to avoid clashing with stock-data-service's searchStocks below).
    mocked(searchStocksAction).mockImplementation(unmocked("searchStocks (app/actions/searchStocks)"));
    mocked(searchStocksClient).mockImplementation(unmocked("searchStocksClient"));
    mocked(getMultipleStockQuotes).mockImplementation(unmocked("getMultipleStockQuotes"));
    mocked(getHistoricalData).mockImplementation(unmocked("getHistoricalData"));
    mocked(getStockPrice).mockImplementation(unmocked("getStockPrice"));
    mocked(getCorrelationMatrix).mockImplementation(unmocked("getCorrelationMatrix"));
    mocked(getSectorPerformance).mockImplementation(unmocked("getSectorPerformance"));
    mocked(getServiceStatus).mockImplementation(unmocked("getServiceStatus"));
    mocked(searchStocks).mockImplementation(unmocked("searchStocks"));
    mocked(searchStocksEnriched).mockImplementation(unmocked("searchStocksEnriched"));
    mocked(fetchStockDetailsClient).mockImplementation(unmocked("fetchStockDetailsClient"));
    mocked(fetchStockDataClient).mockImplementation(unmocked("fetchStockDataClient"));
  },
};
export default preview;
