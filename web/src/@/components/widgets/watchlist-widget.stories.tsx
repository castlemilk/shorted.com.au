/**
 * WatchlistWidget stories.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising the widget's primary interaction.
 *
 * Data calls traced (watchlist-widget.tsx):
 * - useWatchlistData (use-stock-queries.ts) →
 *   getMultipleStockQuotes + getHistoricalData (@/lib/stock-data-service)
 *   and fetchStockClient (@/lib/client-api) — all spy-mocked in preview.tsx.
 * - No search action: unlike MarketWatchlistWidget, adding a stock is a raw
 *   code input with no API call.
 *
 * Interaction choice (Default): the add-stock flow (+ → code input → Enter)
 * is the widget's only interaction that round-trips through
 * onSettingsChange with user-entered data, so the play function adds "MIN"
 * and asserts the settings callback. Row remove (X) exists but is a weaker
 * subset of the same updateWatchlist path.
 *
 * Settings note: unlike MarketWatchlist/PortfolioSummary, this widget reads
 * settings through getTypedSettings, which spread-merges over defaults — so
 * `watchlist: []` is NOT replaced by the default list and the real empty UI
 * is reachable (see Empty).
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import { WatchlistWidget } from "./watchlist-widget";
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
} from "~/@/mocks/fixtures/short-data";
import {
  getHistoricalData,
  getMultipleStockQuotes,
} from "@/lib/stock-data-service";
import { fetchStockClient } from "@/lib/client-api";

/** Resolves every useWatchlistData dependency from the deterministic fixtures. */
function mockWatchlistData() {
  mocked(getMultipleStockQuotes).mockImplementation((codes) =>
    Promise.resolve(stockQuotesFixture(codes)),
  );
  mocked(getHistoricalData).mockImplementation((code, period) =>
    Promise.resolve(historicalDataFixture(code, period)),
  );
  mocked(fetchStockClient).mockImplementation((code) =>
    Promise.resolve(stockFixture(code)),
  );
}

const meta = {
  title: "Widgets/Watchlist",
  component: WatchlistWidget,
  args: {
    config: makeWidgetConfig(WidgetType.WATCHLIST, {
      watchlist: ["PLS", "SYR", "FLT"],
      timeInterval: "1m",
    }),
    sizeVariant: "standard",
    onSettingsChange: fn(),
  },
  decorators: [withGridCell("medium")],
  // The widget renders next/link rows; appDirectory mounts the app-router
  // context Link needs.
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof WatchlistWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded watchlist: 3 fixture rows with quote, short-position badge and
 * sparkline. The play function exercises the add-stock flow: open the input
 * (+), type a code, press Enter, and assert onSettingsChange receives the
 * appended watchlist.
 */
export const Default: Story = {
  beforeEach: () => {
    mockWatchlistData();
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    // Data loads: header + all three symbols render.
    await waitFor(() => {
      expect(canvas.getByText("Watchlist")).toBeInTheDocument();
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    expect(canvas.getByText("SYR")).toBeInTheDocument();
    expect(canvas.getByText("FLT")).toBeInTheDocument();

    // Quote price flowed through getMultipleStockQuotes (same Intl format as
    // the widget; fixture price is deterministic). Symbols render before the
    // queries resolve (rows map over settings directly), so data-derived
    // text needs its own waitFor.
    const plsQuote = stockQuotesFixture(["PLS"]).get("PLS")!;
    const fmt = new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    await waitFor(() => {
      expect(canvas.getByText(fmt.format(plsQuote.price))).toBeInTheDocument();
      // Short position flowed through fetchStockClient (PLS badge "19.40%").
      expect(canvas.getByText("19.40%")).toBeInTheDocument();
    });

    // Primary interaction: add a stock. The + toggle is the first element
    // with role button — the interval SelectTrigger before it has role
    // combobox, and the per-row remove X buttons come later in the DOM.
    await userEvent.click(canvas.getAllByRole("button")[0]!);
    const input = await canvas.findByPlaceholderText("Stock code (e.g., CBA)");
    await userEvent.type(input, "MIN{Enter}");

    // KNOWN BUG (pinned): queryKeys.stock.quotes does `codes.sort()`, which
    // sorts IN PLACE. useStockQuotes receives the settings array by
    // reference (getTypedSettings spread copies the reference), so the
    // configured order ["PLS","SYR","FLT"] is alphabetized to
    // ["FLT","PLS","SYR"] before MIN is appended. When query-keys.ts is
    // fixed to copy before sorting, this expectation should become
    // ["PLS","SYR","FLT","MIN"].
    await waitFor(() => {
      expect(args.onSettingsChange).toHaveBeenCalledWith({
        watchlist: ["FLT", "PLS", "SYR", "MIN"],
        timeInterval: "1m",
      });
    });
  },
};

/**
 * Perpetual loading: none of the three data promises settle, so the
 * skeleton-row branch stays up (one pulse row per watchlist entry, no
 * header, no symbols).
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockReturnValue(never());
    mocked(getHistoricalData).mockReturnValue(never());
    mocked(fetchStockClient).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll(".animate-pulse").length,
      ).toBeGreaterThanOrEqual(3);
    });
    expect(canvas.queryByText("Watchlist")).not.toBeInTheDocument();
    expect(canvas.queryByText("PLS")).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no error UI. useWatchlistData exposes isError
 * but the widget never reads it — on rejection isLoading flips false and the
 * full layout renders with empty data: every row shows its symbol with a
 * perpetual "Loading..." placeholder where the quote should be. This story
 * pins that current behavior; if an error state is added later, update these
 * assertions to match it.
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
    mocked(fetchStockClient).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Watchlist")).toBeInTheDocument();
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    // One stuck quote placeholder per row, and no price ever renders.
    expect(canvas.getAllByText("Loading...")).toHaveLength(3);
    expect(canvas.queryByText(/\$/)).not.toBeInTheDocument();
  },
};

/**
 * Real empty state: `watchlist: []` survives getTypedSettings (spread merge,
 * no length-based fallback), all queries are disabled (no mocks needed), and
 * the dedicated empty UI renders.
 */
export const Empty: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.WATCHLIST, {
      watchlist: [],
      timeInterval: "1m",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No stocks in watchlist")).toBeInTheDocument();
    });
    expect(canvas.getByText("Click + to add stocks")).toBeInTheDocument();
  },
};

/**
 * Compact variant: a real sizeVariant branch — simplified link rows (symbol,
 * short badge at 1 decimal, price, change badge) with no header, no interval
 * select and no add/remove controls.
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mockWatchlistData();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Symbols render before data resolves, so wait for the data-derived
    // badge: compact renders it with one decimal ("19.4%"), not two.
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
      expect(canvas.getByText("19.4%")).toBeInTheDocument();
    });
    // Standard-only affordances must not leak into compact mode.
    expect(canvas.queryByText("Watchlist")).not.toBeInTheDocument();
    expect(canvas.queryByRole("combobox")).not.toBeInTheDocument();
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
