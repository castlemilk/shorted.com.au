/**
 * StockChartWidget stories — the dual-source (shorts + market price) visx
 * chart with brush, indicators, and per-stock settings.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising the widget's primary interaction.
 *
 * Data trace (verified against stock-chart-widget.tsx):
 * - fetchStockDataClient(code, period) — ~/@/lib/client-api, per stock,
 *   only when dataTypes includes "shorts". Spy-mocked in preview.tsx.
 * - getStock(code) — app/actions/getStock, per stock alongside the shorts
 *   fetch (header name + "% shorted" badge). Spy-mocked in preview.tsx.
 * - getMultipleStockQuotes(stocks) — ~/@/lib/stock-data-service, one call
 *   per shorts fetch (header price badge + legend). Spy-mocked.
 * - getHistoricalData(code, period) — ~/@/lib/stock-data-service, per
 *   stock, only when dataTypes includes "market". Spy-mocked.
 * - Transitive: StockSelector (settings popover) calls searchStocksClient
 *   only when the user types; IndicatorPanel and MultiSeriesChart are pure
 *   presentation. No story opens the popover, so no extra mocks needed.
 *
 * Determinism scoping: the brush (drag-to-zoom) and indicator overlays are
 * not exercised — brush interaction needs pixel-coordinate drags that are
 * too geometry-dependent to stay stable across grid-cell sizes, and the
 * indicator panel lives behind the settings popover whose StockSelector
 * autocomplete debounce makes plays timing-sensitive. The period toggle is
 * the widget's primary control and is fully deterministic, so Default
 * exercises it; brush/indicator coverage belongs in a dedicated
 * MultiSeriesChart story (not yet written).
 *
 * Interaction choice (Default): clicking a period toggle. Like the other
 * chart widgets this one is controlled — the click does not refetch
 * locally, it calls onSettingsChange({ ...settings, period }) for the
 * dashboard to persist, so the play asserts the callback contract.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import { StockChartWidget } from "./stock-chart-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import {
  historicalDataFixture,
  stockFixture,
  stockQuotesFixture,
  timeSeriesDataFixture,
} from "~/@/mocks/fixtures/short-data";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { getStock } from "~/app/actions/getStock";
import {
  getHistoricalData,
  getMultipleStockQuotes,
} from "~/@/lib/stock-data-service";

/** Mirrors the widget's formatPrice so quote assertions match exactly. */
const formatPrice = (price: number) =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);

/** Installs the full happy-path mock set (shorts + market + quotes + info). */
const mockAllData = () => {
  mocked(fetchStockDataClient).mockImplementation((code, period) =>
    Promise.resolve(timeSeriesDataFixture(code, period)),
  );
  mocked(getStock).mockImplementation((code) =>
    Promise.resolve(stockFixture(code)),
  );
  mocked(getMultipleStockQuotes).mockImplementation((codes) =>
    Promise.resolve(stockQuotesFixture(codes)),
  );
  mocked(getHistoricalData).mockImplementation((code, period) =>
    Promise.resolve(historicalDataFixture(code, period)),
  );
};

const meta = {
  title: "Widgets/StockChart",
  component: StockChartWidget,
  args: {
    config: makeWidgetConfig(WidgetType.STOCK_CHART, {
      stocks: ["PLS"],
      period: "1y",
      viewMode: "absolute",
      dataTypes: ["shorts", "market"],
      indicators: [],
      stockShortsVisibility: {},
    }),
    sizeVariant: "standard",
    // Spy so play functions can assert the controlled-settings contract.
    onSettingsChange: fn(),
  },
  // The chart needs a sized ancestor (ParentSize); medium gives the dual-axis
  // chart + brush room to lay out.
  decorators: [withGridCell("medium")],
  // The widget renders next/link (header stock link → /shorts/<code>);
  // appDirectory mounts the app-router context it needs.
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof StockChartWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Single stock, dual view (shorts + market over 1y) — exercises all four
 * data calls. Asserts the header (name, quote price, "% shorted" and "Dual
 * View" badges), legend entries for both series, real chart geometry, then
 * clicks the 1M period toggle and asserts the onSettingsChange contract.
 */
export const Default: Story = {
  beforeEach: mockAllData,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    // Shorts fetch lands: header link + name + "% shorted" badge.
    await waitFor(() => {
      expect(canvas.getByText("Pilbara Minerals Limited")).toBeInTheDocument();
    });
    expect(canvas.getByText("19.40% shorted")).toBeInTheDocument();
    expect(canvas.getByText("📊💰 Dual View")).toBeInTheDocument();

    // Quote badge: fixture terminal price formatted exactly as the widget
    // does (en-AU AUD). Appears in the header and the market legend entry.
    const quote = stockQuotesFixture(["PLS"]).get("PLS")!;
    expect(
      canvas.getAllByText(formatPrice(quote.price)).length,
    ).toBeGreaterThanOrEqual(1);

    // Legend: one entry per series — "PLS" renders for the shorts series
    // AND the market series (PRICE:PLS strips its prefix), plus the header
    // link.
    expect(canvas.getAllByText("PLS").length).toBeGreaterThanOrEqual(3);

    // Real chart geometry: at least one <path> per series (shorts line +
    // price line) plus brush paths. The svg mounts a frame after data lands
    // (ParentSize measures asynchronously); :not(.lucide) excludes icon
    // svgs, which also contain <path> elements.
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll("svg:not(.lucide) path").length,
      ).toBeGreaterThanOrEqual(2);
    });

    // Primary interaction: period toggle. Controlled widget — the click
    // surfaces through onSettingsChange with the rest of the settings
    // preserved rather than refetching locally.
    await userEvent.click(canvas.getByText("1M"));
    await waitFor(() => {
      expect(args.onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          period: "1m",
          stocks: ["PLS"],
          dataTypes: ["shorts", "market"],
        }),
      );
    });
  },
};

/**
 * Perpetual loading: none of the four fetches settle, so the header shows
 * skeleton chips, the chart area shows its skeleton, and no chart svg
 * mounts. (The period toggles and Clear/Reset buttons render regardless —
 * the widget keeps its chrome during loads.)
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(fetchStockDataClient).mockReturnValue(never());
    mocked(getStock).mockReturnValue(never());
    mocked(getMultipleStockQuotes).mockReturnValue(never());
    mocked(getHistoricalData).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll(".animate-pulse").length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(
      canvasElement.querySelector("svg:not(.lucide) path"),
    ).not.toBeInTheDocument();
    expect(canvas.queryByText("Pilbara Minerals Limited")).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no dedicated error UI. Every fetch is wrapped
 * in a per-call .catch (null / new Map() / []), so total backend failure is
 * swallowed silently — no console noise, no error message — and the widget
 * renders the same "No data available" empty state as a stock with no data.
 * This story pins that current behavior; if an error state is added later,
 * update these assertions to match it.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    const failure = new globalThis.Error("backend unavailable");
    mocked(fetchStockDataClient).mockRejectedValue(failure);
    mocked(getStock).mockRejectedValue(failure);
    mocked(getMultipleStockQuotes).mockRejectedValue(failure);
    mocked(getHistoricalData).mockRejectedValue(failure);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No Data Available")).toBeInTheDocument();
    });
    expect(
      canvas.getByText(/No data available for selected stocks/),
    ).toBeInTheDocument();
    expect(
      canvasElement.querySelector("svg:not(.lucide) path"),
    ).not.toBeInTheDocument();
  },
};

/**
 * Empty data, shorts-only: fetchStockDataClient resolves undefined (the
 * real client's not-found behavior) while stock info and quotes still load,
 * so the header stays fully populated (name, quote, "% shorted" badge) but
 * the chart area shows the shorts-specific empty message. getHistoricalData
 * is never called (dataTypes excludes "market"), so its preview throwing
 * default stays untouched.
 */
export const Empty: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.STOCK_CHART, {
      stocks: ["PLS"],
      period: "1y",
      viewMode: "absolute",
      dataTypes: ["shorts"],
      indicators: [],
      stockShortsVisibility: {},
    }),
  },
  beforeEach: () => {
    mocked(fetchStockDataClient).mockResolvedValue(undefined);
    mocked(getStock).mockImplementation((code) =>
      Promise.resolve(stockFixture(code)),
    );
    mocked(getMultipleStockQuotes).mockImplementation((codes) =>
      Promise.resolve(stockQuotesFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Header still renders from getStock + quotes.
    await waitFor(() => {
      expect(canvas.getByText("Pilbara Minerals Limited")).toBeInTheDocument();
    });
    expect(canvas.getByText("19.40% shorted")).toBeInTheDocument();
    // Chart area falls back to the shorts-specific empty message.
    expect(
      canvas.getByText("No shorts data available for selected stocks."),
    ).toBeInTheDocument();
    expect(
      canvasElement.querySelector("svg:not(.lucide) path"),
    ).not.toBeInTheDocument();
  },
};

/**
 * Compact: the widget does not branch on sizeVariant (fully responsive via
 * ParentSize). This story also covers the multi-stock comparison header
 * ("Comparing" + one badge per code) in a small cell, shorts-only.
 */
export const Compact: Story = {
  args: {
    sizeVariant: "compact",
    config: makeWidgetConfig(WidgetType.STOCK_CHART, {
      stocks: ["PLS", "SYR"],
      period: "1y",
      viewMode: "absolute",
      dataTypes: ["shorts"],
      indicators: [],
      stockShortsVisibility: {},
    }),
  },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(fetchStockDataClient).mockImplementation((code, period) =>
      Promise.resolve(timeSeriesDataFixture(code, period)),
    );
    mocked(getStock).mockImplementation((code) =>
      Promise.resolve(stockFixture(code)),
    );
    mocked(getMultipleStockQuotes).mockImplementation((codes) =>
      Promise.resolve(stockQuotesFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Comparing")).toBeInTheDocument();
    });
    // Header badge + legend entry per code.
    expect(canvas.getAllByText("PLS").length).toBeGreaterThanOrEqual(2);
    expect(canvas.getAllByText("SYR").length).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll("svg:not(.lucide) path").length,
      ).toBeGreaterThanOrEqual(2);
    });
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: mockAllData,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Pilbara Minerals Limited")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll("svg:not(.lucide) path").length,
      ).toBeGreaterThanOrEqual(2);
    });
  },
};
