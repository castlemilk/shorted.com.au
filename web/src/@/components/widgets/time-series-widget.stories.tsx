/**
 * TimeSeriesWidget stories — multi-series shorts comparison chart.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising the widget's primary interaction.
 *
 * Data trace (verified against time-series-widget.tsx):
 * - getStockData(code, period) — app/actions/getStockData, one call per
 *   selected stock (Promise.all). Spy-mocked in preview.tsx (same
 *   browser-safe import profile as getStock).
 * - StockSelector (settings popover) calls searchStocksClient only when the
 *   user types a query; no story opens the selector, so no mock setup needed
 *   beyond the preview throwing default.
 * - MultiSeriesChart is pure presentation (visx) — no data calls.
 *
 * Interaction choice (Default): the period ToggleGroup is the widget's
 * primary control. The widget is fully controlled — clicking "6M" does NOT
 * refetch locally, it calls onSettingsChange({ ...settings, period: "6m" })
 * and waits for the dashboard to persist + re-render it. So the play
 * function asserts the settings callback contract, not a re-render.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";

import { TimeSeriesWidget } from "./time-series-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { timeSeriesDataFixture } from "~/@/mocks/fixtures/short-data";
import { getStockData } from "~/app/actions/getStockData";

const meta = {
  title: "Widgets/TimeSeries",
  component: TimeSeriesWidget,
  args: {
    config: makeWidgetConfig(WidgetType.TIME_SERIES_ANALYSIS, {
      stocks: ["PLS", "SYR", "IEL"],
      period: "3m",
      analysisType: "comparison",
    }),
    sizeVariant: "standard",
    // Spy so play functions can assert the controlled-settings contract.
    onSettingsChange: fn(),
  },
  // The chart needs a sized ancestor (ParentSize); medium gives the line
  // chart + brush room to lay out.
  decorators: [withGridCell("medium")],
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof TimeSeriesWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three-stock comparison over 3m. The play function asserts loaded chart
 * geometry (one visx line path per series), the legend's latest-value
 * labels (terminal fixture points are pinned to latestShortPosition), then
 * exercises the period toggle and asserts the onSettingsChange contract.
 */
export const Default: Story = {
  beforeEach: () => {
    mocked(getStockData).mockImplementation((code, period) =>
      Promise.resolve(timeSeriesDataFixture(code, period)),
    );
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    // Data loads: header badge + legend entry both render the code.
    await waitFor(() => {
      expect(canvas.getAllByText("PLS").length).toBeGreaterThanOrEqual(2);
    });
    expect(canvas.getByText("Comparing")).toBeInTheDocument();

    // Legend shows each series' latest short position — fixture terminals
    // are pinned (PLS 19.4 → "19.40%", SYR 15.1 → "15.10%").
    expect(canvas.getByText("19.40%")).toBeInTheDocument();
    expect(canvas.getByText("15.10%")).toBeInTheDocument();

    // Real chart geometry: at least one <path> per series (LinePath), plus
    // the brush mini-chart paths. The chart svg mounts a frame after the
    // legend (ParentSize measures asynchronously), so poll. :not(.lucide)
    // excludes icon svgs, which also contain <path> elements.
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll("svg:not(.lucide) path").length,
      ).toBeGreaterThanOrEqual(3);
    });

    // Primary interaction: period toggle. The widget is controlled, so the
    // click must surface through onSettingsChange with the rest of the
    // settings preserved.
    await userEvent.click(canvas.getByText("6M"));
    await waitFor(() => {
      expect(args.onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          period: "6m",
          stocks: ["PLS", "SYR", "IEL"],
        }),
      );
    });
  },
};

/**
 * Perpetual loading: the promise never settles, so the full-widget skeleton
 * stays up and no chart svg is mounted.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getStockData).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector(".animate-pulse")).toBeTruthy();
    });
    expect(canvasElement.querySelector("svg:not(.lucide) path")).not.toBeInTheDocument();
    expect(
      within(canvasElement).queryByText("Comparing"),
    ).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no dedicated error UI. A rejected getStockData
 * is caught (console.error), loading ends with an empty data map, and the
 * widget renders the same "No Data Available" empty state a successful
 * fetch with zero points would produce — errors are indistinguishable from
 * empty data. (In production getStockData is wrapped in withRetryAndNotFound
 * and resolves undefined on failure, which lands in this same state via the
 * `if (data)` guard.) This story pins the current behavior.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(getStockData).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No Data Available")).toBeInTheDocument();
    });
    expect(
      canvas.getByText(/No short position data found/),
    ).toBeInTheDocument();
    expect(canvasElement.querySelector("svg:not(.lucide) path")).not.toBeInTheDocument();
  },
};

/**
 * No stocks selected: the widget short-circuits before fetching (no mock
 * setup needed — the preview throwing defaults stay untouched) and renders
 * its dedicated zero-state with the settings affordance.
 */
export const Empty: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.TIME_SERIES_ANALYSIS, {
      stocks: [],
      period: "3m",
      analysisType: "comparison",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No Stocks Selected")).toBeInTheDocument();
    });
    expect(
      canvas.getByText(/Click the settings icon to add stocks/),
    ).toBeInTheDocument();
  },
};

/**
 * Compact: the widget does not branch on sizeVariant (fully responsive via
 * ParentSize) — this pins the chart squeezed into a small grid cell. Two
 * stocks keep the header badges from wrapping the chart out of view.
 */
export const Compact: Story = {
  args: {
    sizeVariant: "compact",
    config: makeWidgetConfig(WidgetType.TIME_SERIES_ANALYSIS, {
      stocks: ["PLS", "SYR"],
      period: "3m",
      analysisType: "comparison",
    }),
  },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getStockData).mockImplementation((code, period) =>
      Promise.resolve(timeSeriesDataFixture(code, period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getAllByText("PLS").length).toBeGreaterThanOrEqual(2);
    });
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
  args: {
    config: makeWidgetConfig(WidgetType.TIME_SERIES_ANALYSIS, {
      stocks: ["PLS", "SYR"],
      period: "3m",
      analysisType: "comparison",
    }),
  },
  beforeEach: () => {
    mocked(getStockData).mockImplementation((code, period) =>
      Promise.resolve(timeSeriesDataFixture(code, period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getAllByText("PLS").length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll("svg:not(.lucide) path").length,
      ).toBeGreaterThanOrEqual(2);
    });
  },
};
