/**
 * PortfolioSummaryWidget stories.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising the widget's primary interaction.
 *
 * Data calls traced (portfolio-summary-widget.tsx):
 * - getMultipleStockQuotes (~/@/lib/stock-data-service) — the ONLY data
 *   call, spy-mocked in preview.tsx. No useWatchlistData, no getStock, no
 *   visibility gating (fetches immediately on mount).
 * - useAsyncErrorHandler (~/@/hooks/use-async-error): on rejection it
 *   re-throws INTO RENDER so the nearest error boundary catches — see Error.
 * - settings.refreshInterval is read by nothing: the widget hardcodes a
 *   5-minute setInterval. Stories set refreshInterval: 0 anyway per the
 *   no-polling contract.
 *
 * Interaction choice (Default): the holdings editor is the widget's core
 * interaction surface — the play function expands "Show Holdings", opens the
 * per-holding share editor (the only control with an accessible name:
 * "Edit shares for PLS"), commits a new share count, and asserts
 * onSettingsChange receives the updated portfolio.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import React from "react";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import { PortfolioSummaryWidget } from "./portfolio-summary-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { stockQuotesFixture } from "~/@/mocks/fixtures/short-data";
import { getMultipleStockQuotes } from "~/@/lib/stock-data-service";
import { WidgetErrorBoundary } from "~/@/components/ui/error-boundary";

const PORTFOLIO = [
  { symbol: "PLS", shares: 100 },
  { symbol: "SYR", shares: 200 },
  { symbol: "FLT", shares: 50 },
];

/** Same Intl options as the widget's formatCurrency (whole dollars). */
const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const meta = {
  title: "Widgets/PortfolioSummary",
  component: PortfolioSummaryWidget,
  args: {
    config: makeWidgetConfig(WidgetType.PORTFOLIO_SUMMARY, {
      portfolio: PORTFOLIO,
      refreshInterval: 0,
    }),
    sizeVariant: "standard",
    onSettingsChange: fn(),
  },
  decorators: [withGridCell("medium")],
  // The widget renders next/link symbols; appDirectory mounts the app-router
  // context Link needs.
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof PortfolioSummaryWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded summary: total value / daily change cards plus top gainer & loser
 * computed from the deterministic fixture quotes. The play function expands
 * the holdings list, edits PLS's share count and asserts onSettingsChange
 * receives the updated portfolio.
 */
export const Default: Story = {
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockImplementation((codes) =>
      Promise.resolve(stockQuotesFixture(codes)),
    );
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => {
      expect(canvas.getByText("Total Value")).toBeInTheDocument();
    });

    // Summary math flowed through the fixture quotes: total value is
    // Σ price × shares, formatted with the widget's own Intl options.
    const quotes = stockQuotesFixture(PORTFOLIO.map((p) => p.symbol));
    const totalValue = PORTFOLIO.reduce(
      (sum, { symbol, shares }) => sum + quotes.get(symbol)!.price * shares,
      0,
    );
    expect(canvas.getByText(formatCurrency(totalValue))).toBeInTheDocument();

    // Top gainer / loser are the best and worst fixture changePercent.
    const bySign = [...quotes.entries()].sort(
      (a, b) => b[1].changePercent - a[1].changePercent,
    );
    const gainer = bySign[0]![0];
    const loser = bySign[bySign.length - 1]![0];
    expect(canvas.getByText("Top Gainer")).toBeInTheDocument();
    expect(canvas.getByText(gainer)).toBeInTheDocument();
    expect(canvas.getByText("Top Loser")).toBeInTheDocument();
    expect(canvas.getByText(loser)).toBeInTheDocument();

    // Primary interaction: expand holdings and edit PLS's share count.
    await userEvent.click(
      canvas.getByRole("button", { name: /show holdings \(3\)/i }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit shares for PLS" }),
    );
    const sharesInput = canvas.getByRole("spinbutton");
    await userEvent.clear(sharesInput);
    await userEvent.type(sharesInput, "150{Enter}");

    await waitFor(() => {
      expect(args.onSettingsChange).toHaveBeenCalledWith({
        portfolio: [
          { symbol: "PLS", shares: 150 },
          { symbol: "SYR", shares: 200 },
          { symbol: "FLT", shares: 50 },
        ],
        refreshInterval: 0,
      });
    });
  },
};

/**
 * Perpetual loading: the quotes promise never settles, so the four summary
 * skeletons stay up and no card labels render.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvasElement.querySelectorAll(".animate-pulse")).toHaveLength(4);
    });
    expect(canvas.queryByText("Total Value")).not.toBeInTheDocument();
  },
};

/**
 * Error contract: the widget has no internal error UI — useAsyncErrorHandler
 * re-throws the fetch error into render so the nearest error boundary owns
 * it. The dashboard composes every widget through withErrorBoundary
 * (with-error-boundary.tsx → WidgetErrorBoundary), so this story pins the
 * real composed behavior by wrapping the story in the same boundary and
 * asserting its fallback.
 */
export const Error: Story = {
  decorators: [
    (Story) => (
      <WidgetErrorBoundary widgetName="Portfolio Summary">
        <Story />
      </WidgetErrorBoundary>
    ),
  ],
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(getMultipleStockQuotes).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(
        canvas.getByText("Error loading Portfolio Summary"),
      ).toBeInTheDocument();
    });
    expect(canvas.queryByText("Total Value")).not.toBeInTheDocument();
  },
};

/**
 * Empty dataset: quotes resolve to an empty Map, so every holding prices at
 * zero — Total Value renders "$0" and gainer/loser fall back to their "-"
 * placeholders.
 *
 * KNOWN GAP: the dedicated "No holdings in portfolio" empty UI is
 * unreachable via settings — `portfolio: []` falls back to
 * DEFAULT_PORTFOLIO in the widget's `portfolio` memo, which also makes the
 * `portfolio.length === 0` early-return (the only writer of
 * portfolioData=null) dead code. If the fallback is ever removed, add a
 * story asserting the real empty UI.
 */
export const Empty: Story = {
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockResolvedValue(new Map());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("$0")).toBeInTheDocument();
    });
    // Gainer and loser placeholders ("-") — one each.
    expect(canvas.getAllByText("-")).toHaveLength(2);
  },
};

/**
 * Compact: this widget does not branch on sizeVariant, so compact === the
 * standard summary grid squeezed into a small grid cell.
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockImplementation((codes) =>
      Promise.resolve(stockQuotesFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Total Value")).toBeInTheDocument();
    });
    expect(canvas.getByText("Daily Change")).toBeInTheDocument();
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getMultipleStockQuotes).mockImplementation((codes) =>
      Promise.resolve(stockQuotesFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Total Value")).toBeInTheDocument();
    });
  },
};
