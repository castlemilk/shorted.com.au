/**
 * SectorPerformanceWidget stories — visx pie / bar / heatmap of ASX sector
 * performance.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus BarChart and
 * Heatmap stories covering the two non-default displayType settings, and a
 * play function exercising what the widget really offers.
 *
 * Data trace (verified against sector-performance-widget.tsx):
 * - getSectorPerformance(period) — ~/@/lib/stock-data-service, called once
 *   per mount in a useEffect plus a 5-minute setInterval refresh (inert in
 *   stories). Spy-mocked in preview.tsx.
 * - No visibility gating (no useWidgetVisibility) and no other data calls;
 *   the real implementation would fan out to getMultipleStockQuotes, but the
 *   spy on getSectorPerformance intercepts above that.
 *
 * Interaction notes (KNOWN GAPs):
 * - The widget has NO interactive controls: period and displayType come only
 *   from config.settings (no in-widget toggle, no settings popover, no
 *   onSettingsChange wiring). The Default play therefore hovers a pie
 *   segment and pins that nothing happens (no tooltip, no highlight class) —
 *   unlike the treemap widgets, pie arcs have no handlers. If a displayType
 *   toggle is added later, replace the hover with it.
 * - A rejected getSectorPerformance is caught (console.error) and sectorData
 *   stays [] — the Error story renders the SAME "No sector data available"
 *   zero-state as Empty. Indistinguishable to users.
 * - sizeVariant is not read at all (the component destructures only
 *   `config`), so Compact pins the standard layout squeezed into a small
 *   grid cell.
 * - bar and heatmap views drop the "Sector Performance" header + legend that
 *   the pie view renders (bar is a bare chart svg).
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, userEvent, waitFor, within } from "storybook/test";

import { SectorPerformanceWidget } from "./sector-performance-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { sectorPerformanceFixture } from "~/@/mocks/fixtures/short-data";
import { getSectorPerformance } from "~/@/lib/stock-data-service";

const SECTORS = [
  "Financials",
  "Materials",
  "Healthcare",
  "Consumer Staples",
  "Energy",
  "Technology",
];

/** formatPercent twin of the widget's own helper, fed from the fixture. */
const pct = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const meta = {
  title: "Widgets/SectorPerformance",
  component: SectorPerformanceWidget,
  args: {
    config: makeWidgetConfig(WidgetType.SECTOR_PERFORMANCE, {
      period: "1w",
      displayType: "pie",
    }),
    sizeVariant: "standard",
  },
  // Pie/bar size themselves from ParentSize — they need a sized ancestor.
  decorators: [withGridCell("medium")],
} satisfies Meta<typeof SectorPerformanceWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default pie view. Asserts the header, the period subtitle, six donut arcs,
 * and the full legend (sector swatch + signed badge for every sector), then
 * hovers an arc and pins the no-op (KNOWN GAP above).
 */
export const Default: Story = {
  beforeEach: () => {
    mocked(getSectorPerformance).mockImplementation((period) =>
      Promise.resolve(sectorPerformanceFixture(period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => {
      expect(canvas.getByText("Sector Performance")).toBeInTheDocument();
    });
    expect(canvas.getByText("Period: 1w")).toBeInTheDocument();

    // Legend: every sector renders with its signed performance badge.
    // (getAllByText: large arcs also render the same percent inside the pie.)
    const fixture = sectorPerformanceFixture("1w");
    for (const sector of fixture) {
      expect(canvas.getByText(sector.sector)).toBeInTheDocument();
      expect(
        canvas.getAllByText(pct(sector.performance)).length,
      ).toBeGreaterThanOrEqual(1);
    }

    // Real donut geometry: six arc paths. ParentSize mounts the svg a frame
    // after the data state lands, so poll.
    await waitFor(() => {
      expect(canvasElement.querySelectorAll("svg g path")).toHaveLength(6);
    });

    // Primary "interaction" (KNOWN GAP): arcs have no handlers — hovering
    // must not surface a tooltip or change the DOM.
    const arc = canvasElement.querySelector("svg g path")!;
    await userEvent.hover(arc);
    expect(document.querySelector('[role="tooltip"]')).not.toBeInTheDocument();
    expect(canvasElement.querySelectorAll("svg g path")).toHaveLength(6);
  },
};

/**
 * displayType: "bar" — vertical bars with a zero baseline. The bar view is a
 * bare svg (no header/legend — KNOWN GAP above); sector names render as
 * x-axis tick labels and the y axis is in percent.
 */
export const BarChart: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.SECTOR_PERFORMANCE, {
      period: "1w",
      displayType: "bar",
    }),
  },
  beforeEach: () => {
    mocked(getSectorPerformance).mockImplementation((period) =>
      Promise.resolve(sectorPerformanceFixture(period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Six bar rects (GridRows draws lines, not rects).
    await waitFor(() => {
      expect(canvasElement.querySelectorAll("svg rect")).toHaveLength(6);
    });
    for (const sector of SECTORS) {
      expect(canvas.getByText(sector)).toBeInTheDocument();
    }
    // Bare-chart view: no header.
    expect(canvas.queryByText("Sector Performance")).not.toBeInTheDocument();
  },
};

/**
 * displayType: "heatmap" — a 2-column tile grid where tile colour encodes
 * sign/intensity and each tile shows the signed percent plus volume in
 * billions ("Vol: X.XB").
 */
export const Heatmap: Story = {
  args: {
    config: makeWidgetConfig(WidgetType.SECTOR_PERFORMANCE, {
      period: "1w",
      displayType: "heatmap",
    }),
  },
  beforeEach: () => {
    mocked(getSectorPerformance).mockImplementation((period) =>
      Promise.resolve(sectorPerformanceFixture(period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Sector Performance")).toBeInTheDocument();
    });
    const fixture = sectorPerformanceFixture("1w");
    for (const sector of fixture) {
      expect(canvas.getByText(sector.sector)).toBeInTheDocument();
      expect(canvas.getByText(pct(sector.performance))).toBeInTheDocument();
      expect(
        canvas.getByText(`Vol: ${(sector.volume / 1e9).toFixed(1)}B`),
      ).toBeInTheDocument();
    }
    // Heatmap is DOM tiles, not an svg chart.
    expect(canvasElement.querySelector("svg path")).not.toBeInTheDocument();
  },
};

/**
 * Perpetual loading: the promise never settles, so the skeleton stays up and
 * no chart or zero-state is mounted.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getSectorPerformance).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector(".animate-pulse")).toBeTruthy();
    });
    expect(
      within(canvasElement).queryByText("Sector Performance"),
    ).not.toBeInTheDocument();
    expect(
      within(canvasElement).queryByText(/no sector data/i),
    ).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no dedicated error UI. A rejected
 * getSectorPerformance is caught (console.error) and sectorData stays [],
 * so the user sees the SAME "No sector data available" zero-state as Empty.
 * This story pins that current behavior; if an error state is added later,
 * update these assertions to match it.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(getSectorPerformance).mockRejectedValue(
      new globalThis.Error("market-data service unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No sector data available")).toBeInTheDocument();
    });
    expect(canvasElement.querySelector("svg path")).not.toBeInTheDocument();
  },
};

/** Empty payload renders the dedicated zero-state. */
export const Empty: Story = {
  beforeEach: () => {
    mocked(getSectorPerformance).mockResolvedValue([]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No sector data available")).toBeInTheDocument();
    });
  },
};

/**
 * Compact: KNOWN GAP — the widget never reads sizeVariant, so this pins the
 * standard pie layout squeezed into a small grid cell (legend still renders
 * all six sectors; the donut shrinks via ParentSize).
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getSectorPerformance).mockImplementation((period) =>
      Promise.resolve(sectorPerformanceFixture(period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Sector Performance")).toBeInTheDocument();
    });
    for (const sector of SECTORS) {
      expect(canvas.getByText(sector)).toBeInTheDocument();
    }
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getSectorPerformance).mockImplementation((period) =>
      Promise.resolve(sectorPerformanceFixture(period)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Sector Performance")).toBeInTheDocument();
    });
  },
};
