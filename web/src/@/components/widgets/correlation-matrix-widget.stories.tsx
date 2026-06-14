/**
 * CorrelationMatrixWidget stories — visx heatmap of pairwise return
 * correlations.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising what the widget really offers.
 *
 * Data trace (verified against correlation-matrix-widget.tsx):
 * - getCorrelationMatrix(stocks, period) — ~/@/lib/stock-data-service,
 *   one call per mount. Spy-mocked in preview.tsx.
 * - No other data calls; the heatmap is rendered inline (no child
 *   components with fetches).
 *
 * Interaction note (KNOWN GAP): the widget has no interactive controls —
 * no settings popover, no onSettingsChange wiring, no clickable cells. Its
 * only affordance is the native SVG <title> tooltip on each cell, which
 * browsers render outside the DOM (not assertable as rendered UI). The
 * Default play therefore hovers a cell and asserts the <title> payload that
 * the browser would display. If real controls are added later, replace the
 * hover with a stronger interaction.
 *
 * KNOWN GAP (widget bug, observed in Storybook): on first render ParentSize
 * reports 0×0, so `size = min(0-60, 0-60)` goes negative and the widget
 * briefly renders rects with width/height -15, logging
 * '<rect> attribute width: A negative value is not valid' to the console
 * before the real measurement lands. Harmless (no pageerror) but the widget
 * should clamp `size` to >= 0.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, userEvent, waitFor, within } from "storybook/test";

import { CorrelationMatrixWidget } from "./correlation-matrix-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { correlationMatrixFixture } from "~/@/mocks/fixtures/short-data";
import { getCorrelationMatrix } from "~/@/lib/stock-data-service";

const STOCKS = ["PLS", "SYR", "IEL", "BOE"];

const meta = {
  title: "Widgets/CorrelationMatrix",
  component: CorrelationMatrixWidget,
  args: {
    config: makeWidgetConfig(WidgetType.CORRELATION_MATRIX, {
      stocks: STOCKS,
      period: "3m",
    }),
    sizeVariant: "standard",
  },
  // The heatmap sizes itself from ParentSize (square cells from the
  // min(width, height) of the chart area) — it needs a sized ancestor.
  decorators: [withGridCell("medium")],
} satisfies Meta<typeof CorrelationMatrixWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded 4×4 matrix. Asserts real heatmap geometry (16 cell rects), the
 * unit diagonal ("1.00" × 4), fixture symmetry (the PLS↔SYR value renders
 * in both mirrored cells), axis labels on both axes, then hovers a cell
 * and asserts its native <title> tooltip payload.
 */
export const Default: Story = {
  beforeEach: () => {
    mocked(getCorrelationMatrix).mockImplementation((codes) =>
      Promise.resolve(correlationMatrixFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => {
      expect(canvas.getByText("Correlation Matrix")).toBeInTheDocument();
    });
    expect(canvas.getByText("Period: 3m")).toBeInTheDocument();
    expect(
      canvas.getByText(/Based on daily return correlations \(4 stocks\)/),
    ).toBeInTheDocument();

    // Real heatmap geometry: 4×4 = 16 cell rects. ParentSize mounts the svg
    // a frame after the data state lands, so poll.
    await waitFor(() => {
      expect(canvasElement.querySelectorAll("svg rect")).toHaveLength(16);
    });

    // Unit diagonal: each stock correlates 1.00 with itself.
    expect(canvas.getAllByText("1.00")).toHaveLength(4);

    // Symmetry: the fixture seeds off-diagonal values by sorted pair, so the
    // PLS↔SYR coefficient renders in both mirrored cells.
    const plsSyr = correlationMatrixFixture(STOCKS).PLS!.SYR!.toFixed(2);
    expect(canvas.getAllByText(plsSyr).length).toBeGreaterThanOrEqual(2);

    // Axis labels: every code appears on the x AND y axis.
    for (const code of STOCKS) {
      expect(canvas.getAllByText(code)).toHaveLength(2);
    }

    // Legend endpoints.
    expect(canvas.getByText(/Strong Negative \(-1\)/)).toBeInTheDocument();
    expect(canvas.getByText(/Strong Positive \(\+1\)/)).toBeInTheDocument();

    // Hover a cell: the only interaction the widget has is the native SVG
    // <title> tooltip. Assert its payload (correlation + strength bucket);
    // the browser-drawn tooltip itself is outside the DOM.
    const firstCell = canvasElement.querySelector("svg g g");
    expect(firstCell).toBeTruthy();
    await userEvent.hover(firstCell!);
    const title = firstCell!.querySelector("title");
    expect(title?.textContent).toContain("PLS vs PLS: 1.000");
    expect(title?.textContent).toContain("Correlation strength: Strong");
  },
};

/**
 * Perpetual loading: the promise never settles, so the skeleton stays up
 * and no heatmap svg is mounted.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getCorrelationMatrix).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector(".animate-pulse")).toBeTruthy();
    });
    expect(canvasElement.querySelector("svg rect")).not.toBeInTheDocument();
    expect(
      within(canvasElement).queryByText("Correlation Matrix"),
    ).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no dedicated error UI. A rejected
 * getCorrelationMatrix is caught (console.error) and correlationData stays
 * {}, so every cell falls back to `?? 0` and the widget renders a fully
 * populated all-zero matrix ("0.00" × 16) — indistinguishable from
 * genuinely uncorrelated stocks. This story pins that current behavior; if
 * an error state is added later, update these assertions to match it.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(getCorrelationMatrix).mockRejectedValue(
      new globalThis.Error("market-data service unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Correlation Matrix")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(canvas.getAllByText("0.00")).toHaveLength(16);
    });
    expect(canvas.queryByText("1.00")).not.toBeInTheDocument();
  },
};

/**
 * Fewer than 2 stocks: the widget renders its dedicated zero-state without
 * fetching (the effect short-circuits, so the preview throwing default is
 * never hit — no mock setup needed).
 */
export const Empty: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.CORRELATION_MATRIX, {
      stocks: ["PLS"],
      period: "3m",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(
        canvas.getByText(/Select at least 2 stocks to show correlations/),
      ).toBeInTheDocument();
    });
    expect(canvasElement.querySelector("svg rect")).not.toBeInTheDocument();
  },
};

/**
 * Compact: the widget does not branch on sizeVariant (cells scale from
 * ParentSize); this pins the matrix squeezed into a small grid cell, where
 * cell value font size shrinks (cellSize / 4 capped at 14px) but all 16
 * cells still render.
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getCorrelationMatrix).mockImplementation((codes) =>
      Promise.resolve(correlationMatrixFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Correlation Matrix")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(canvasElement.querySelectorAll("svg rect")).toHaveLength(16);
    });
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getCorrelationMatrix).mockImplementation((codes) =>
      Promise.resolve(correlationMatrixFixture(codes)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Correlation Matrix")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(canvasElement.querySelectorAll("svg rect")).toHaveLength(16);
    });
  },
};
