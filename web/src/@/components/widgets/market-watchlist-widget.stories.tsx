/**
 * MarketWatchlistWidget stories.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising the widget's primary interaction.
 *
 * Data calls traced (market-watchlist-widget.tsx):
 * - useWatchlistData (use-stock-queries.ts) →
 *   getMultipleStockQuotes + getHistoricalData (~/@/lib/stock-data-service)
 *   and getStock (~/app/actions/getStock) — all spy-mocked in preview.tsx.
 * - searchStocksClient (~/app/actions/searchStocks) — the add-stock
 *   autocomplete. Spy-mocked in preview.tsx (browser-safe module: connect-web
 *   + config + retry, same import set as getStock).
 *
 * Interaction choice (Default): the search-and-add autocomplete is this
 * widget's distinguishing feature versus the plain WatchlistWidget (which
 * adds by raw code with no search), so the play function opens the search,
 * types a query, picks a result from the dropdown, and asserts
 * onSettingsChange receives the appended watchlist. Row remove (X) and the
 * interval Select also exist but are weaker contracts.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import { MarketWatchlistWidget } from "./market-watchlist-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import {
  historicalDataFixture,
  searchStocksResponseFixture,
  stockFixture,
  stockQuotesFixture,
} from "~/@/mocks/fixtures/short-data";
import {
  getHistoricalData,
  getMultipleStockQuotes,
} from "~/@/lib/stock-data-service";
import { getStock } from "~/app/actions/getStock";
import { searchStocksClient } from "~/app/actions/searchStocks";

/** Resolves every useWatchlistData dependency from the deterministic fixtures. */
function mockWatchlistData() {
  mocked(getMultipleStockQuotes).mockImplementation((codes) =>
    Promise.resolve(stockQuotesFixture(codes)),
  );
  mocked(getHistoricalData).mockImplementation((code, period) =>
    Promise.resolve(historicalDataFixture(code, period)),
  );
  mocked(getStock).mockImplementation((code) =>
    Promise.resolve(stockFixture(code)),
  );
}

const meta = {
  title: "Widgets/MarketWatchlist",
  component: MarketWatchlistWidget,
  args: {
    // Fixture codes only (SYR deliberately excluded so the play function can
    // add it through search). refreshInterval 0: no polling in stories.
    config: makeWidgetConfig(WidgetType.MARKET_WATCHLIST, {
      stocks: ["PLS", "IEL", "FLT"],
      timeInterval: "1m",
      refreshInterval: 0,
    }),
    sizeVariant: "standard",
    onSettingsChange: fn(),
  },
  decorators: [withGridCell("medium")],
  // The widget renders next/link rows; appDirectory mounts the app-router
  // context Link needs.
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof MarketWatchlistWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded watchlist: 3 fixture rows with quote, short-position badge and
 * sparkline. The play function exercises the search-and-add flow: open
 * search (+), type "SYR", click the dropdown option, and assert
 * onSettingsChange is called with SYR appended.
 */
export const Default: Story = {
  beforeEach: () => {
    mockWatchlistData();
    mocked(searchStocksClient).mockImplementation((query) =>
      Promise.resolve(searchStocksResponseFixture(query)),
    );
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    // Data loads: header + all three symbols render.
    await waitFor(() => {
      expect(canvas.getByText("Market Watchlist")).toBeInTheDocument();
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    expect(canvas.getByText("IEL")).toBeInTheDocument();
    expect(canvas.getByText("FLT")).toBeInTheDocument();

    // Quote price flowed through getMultipleStockQuotes (same Intl format as
    // the widget; fixture price is deterministic).
    const plsQuote = stockQuotesFixture(["PLS"]).get("PLS")!;
    const fmt = new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(canvas.getByText(fmt.format(plsQuote.price))).toBeInTheDocument();
    // Short position flowed through getStock ("19.40% shorted" for PLS).
    expect(canvas.getByText("19.40% shorted")).toBeInTheDocument();

    // Primary interaction: search-and-add. The + toggle is the first
    // element with role button — the interval SelectTrigger before it has
    // role combobox, and the per-row remove X buttons come later in the DOM.
    await userEvent.click(canvas.getAllByRole("button")[0]!);
    const input = await canvas.findByPlaceholderText("Search stocks to add...");
    await userEvent.type(input, "SYR");

    // Debounced (300ms) searchStocksClient resolves with the SYR match.
    const option = await canvas.findByRole(
      "option",
      { name: /Syrah Resources/ },
      { timeout: 2000 },
    );
    await userEvent.click(option);

    // KNOWN BUG (pinned): queryKeys.stock.quotes does `codes.sort()`, which
    // sorts IN PLACE. useStockQuotes receives the settings array by
    // reference, so the configured order ["PLS","IEL","FLT"] is alphabetized
    // to ["FLT","IEL","PLS"] before SYR is appended. When query-keys.ts is
    // fixed to copy before sorting, this expectation should become
    // ["PLS","IEL","FLT","SYR"].
    await waitFor(() => {
      expect(args.onSettingsChange).toHaveBeenCalledWith({
        stocks: ["FLT", "IEL", "PLS", "SYR"],
        timeInterval: "1m",
        refreshInterval: 0,
      });
    });
  },
};

/**
 * Perpetual loading: none of the three data promises settle, so the
 * skeleton-row branch stays up (no header, no symbols, pulse placeholders).
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockReturnValue(never());
    mocked(getHistoricalData).mockReturnValue(never());
    mocked(getStock).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll(".animate-pulse").length,
      ).toBeGreaterThanOrEqual(4);
    });
    expect(canvas.queryByText("Market Watchlist")).not.toBeInTheDocument();
    expect(canvas.queryByText("PLS")).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no error UI. useWatchlistData exposes isError
 * but the widget never reads it — on rejection isLoading flips false and the
 * full layout renders with empty data: symbols and header show, but no
 * prices, no "% shorted" badges, and sparkline slots fall back to skeletons.
 * This story pins that current behavior; if an error state is added later,
 * update these assertions to match it.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(getMultipleStockQuotes).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
    mocked(getHistoricalData).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
    mocked(getStock).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Market Watchlist")).toBeInTheDocument();
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    // No quote/short data rendered from the failed fetches.
    expect(canvas.queryByText(/\$/)).not.toBeInTheDocument();
    expect(canvas.queryByText(/% shorted/)).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the dedicated "No stocks in watchlist" empty UI is unreachable
 * via settings — `settings.stocks: []` falls back to DEFAULT_WATCHLIST
 * (CBA/BHP/CSL/WBC/ANZ) in the widget's `watchlist` memo, so the list is
 * never empty. This story pins that fallback behavior: empty settings render
 * the five default symbols (fixtures fall back to seeded generic values for
 * non-fixture codes). If the fallback is ever removed, update this story to
 * assert the real empty UI.
 */
export const Empty: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.MARKET_WATCHLIST, {
      stocks: [],
      timeInterval: "1m",
      refreshInterval: 0,
    }),
  },
  beforeEach: () => {
    mockWatchlistData();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("CBA")).toBeInTheDocument();
    });
    expect(canvas.getByText("ANZ")).toBeInTheDocument();
    expect(
      canvas.queryByText("No stocks in watchlist"),
    ).not.toBeInTheDocument();
  },
};

/**
 * Compact: this widget does not branch on sizeVariant (it only destructures
 * config/onSettingsChange), so compact === the standard layout squeezed into
 * a small grid cell.
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mockWatchlistData();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    expect(canvas.getByText("Market Watchlist")).toBeInTheDocument();
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mockWatchlistData();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
  },
};
