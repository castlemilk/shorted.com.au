/**
 * IndustryTreemapWidget stories — the Visx-visualization exemplar.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play
 * function exercising the treemap's primary interaction (cell hover →
 * rich tooltip).
 *
 * Visx learnings encoded here (apply to other chart widgets):
 * - The widget sizes its <svg> from @visx/responsive's ParentSize, which
 *   measures the nearest sized ancestor. withGridCell provides explicit
 *   pixel dimensions; without it the chart renders 0×0. Treemaps need
 *   room for the squarified layout, so Default uses withGridCell("large").
 * - The hover tooltip (TreemapTooltip) renders via
 *   createPortal(..., document.body) — OUTSIDE canvasElement. Tooltip
 *   assertions must query within(document.body), not the canvas.
 * - The tooltip itself fetches: TreemapTooltip calls the getTooltipData
 *   server action on mount. It is a static import of the widget module,
 *   so it is full-mocked in preview.tsx and any story that hovers a cell
 *   must mock it in beforeEach.
 * - Geometry assertions: cell labels only render when a cell is >50px
 *   wide, and sector header labels truncate to fit ("Consumer
 *   Discretionary" → "Consumer Discretio..."), so assert long industry
 *   names with a prefix regex, never exact text.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { create } from "@bufbuild/protobuf";
import { expect, mocked, userEvent, waitFor, within } from "storybook/test";

import { IndustryTreemapWidget } from "./industry-treemap-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import {
  industryTreemapFixture,
  tooltipDataFixture,
} from "~/@/mocks/fixtures/short-data";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";
import { getTooltipData } from "~/app/actions/tooltip/getTooltipData";
import { IndustryTreeMapSchema } from "~/gen/stocks/v1alpha1/stocks_pb";

const meta = {
  title: "Widgets/IndustryTreemap",
  component: IndustryTreemapWidget,
  args: {
    config: makeWidgetConfig(WidgetType.INDUSTRY_TREEMAP, {
      period: "3m",
      viewMode: "CURRENT_CHANGE",
      showSectorGrouping: true,
    }),
    sizeVariant: "standard",
  },
  // Treemaps need space: the squarified layout degenerates into sliver
  // cells (no labels, unhoverable) below ~700px wide.
  decorators: [withGridCell("large")],
  // The widget calls useRouter() (cell click → /shorts/<code>); without
  // nextjs.appDirectory the story crashes with "invariant expected app
  // router to be mounted".
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof IndustryTreemapWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded treemap: 10 fixture stocks across 4 industry groups. The play
 * function asserts real geometry (>5 svg rects: 10 stock cells + sector
 * header bars), then exercises the primary interaction — hovering the PLS
 * cell to open the rich tooltip, which portals into document.body and
 * fetches company details through getTooltipData.
 */
export const Default: Story = {
  beforeEach: () => {
    mocked(getIndustryTreeMap).mockResolvedValue(industryTreemapFixture());
    mocked(getTooltipData).mockImplementation((code) =>
      Promise.resolve(tooltipDataFixture(code)),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Data loads: the largest cell's label renders inside the svg.
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });

    // Actual treemap geometry, not just text: 10 stock cells plus 4 sector
    // header bars — assert colored rectangles exist.
    expect(
      canvasElement.querySelectorAll("svg rect").length,
    ).toBeGreaterThan(5);

    // Sector group labels render. "Consumer Discretionary" truncates to fit
    // its header bar, so match by prefix.
    expect(canvas.getByText("Materials")).toBeInTheDocument();
    expect(canvas.getByText(/^Consumer/)).toBeInTheDocument();

    // Primary interaction: hover the PLS cell. The cell <g> carries
    // role="link" + aria-label "PLS — 19.4% short interest".
    const cell = canvas.getByRole("link", { name: /PLS/ });
    await userEvent.hover(cell);

    // The tooltip portals to document.body — query the document, NOT the
    // canvas (within(canvasElement) would never find it).
    const body = within(document.body);
    await waitFor(() => {
      expect(body.getByText("Pilbara Minerals Limited")).toBeInTheDocument();
    });
    expect(body.getByText("Short Position")).toBeInTheDocument();
    expect(body.getByText("19.40%")).toBeInTheDocument();

    // Unhover: the tooltip hides (after the widget's 100ms grace timeout),
    // restoring a deterministic end state for visual snapshots.
    await userEvent.unhover(cell);
    await waitFor(() => {
      expect(
        body.queryByText("Pilbara Minerals Limited"),
      ).not.toBeInTheDocument();
    });
  },
};

/**
 * Perpetual loading: the promise never settles, so the pulse placeholder
 * stays up and no svg is mounted.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(getIndustryTreeMap).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText(/loading industry data/i)).toBeInTheDocument();
    });
    expect(canvasElement.querySelector("svg")).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no dedicated error UI. On rejection it logs to
 * console and stays on the loading placeholder forever
 * (industry-treemap-widget.tsx renders the same fallback for
 * `loading || !treeMapData`). This story pins that current behavior; if an
 * error state is added later, update these assertions to match it.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(getIndustryTreeMap).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText(/loading industry data/i)).toBeInTheDocument();
    });
    // No chart is rendered from the failed fetch.
    expect(canvasElement.querySelector("svg")).not.toBeInTheDocument();
  },
};

/**
 * Empty dataset: the widget renders a bare svg with the root node only —
 * no cells, no sector labels, no crash (stratify accepts a lone root).
 */
export const Empty: Story = {
  beforeEach: () => {
    mocked(getIndustryTreeMap).mockResolvedValue(
      create(IndustryTreeMapSchema, { industries: [], stocks: [] }),
    );
  },
  play: async ({ canvasElement }) => {
    // The svg mounting (vs. the loading placeholder) is the discriminator
    // that data resolved.
    await waitFor(() => {
      expect(canvasElement.querySelector("svg")).toBeInTheDocument();
    });
    expect(canvasElement.querySelectorAll("svg rect")).toHaveLength(0);
    expect(within(canvasElement).queryByText("PLS")).not.toBeInTheDocument();
  },
};

/**
 * Compact: this widget does not branch on sizeVariant (it is fully
 * responsive via ParentSize), so compact === the standard chart squeezed
 * into a small grid cell. Cells under 50px wide drop their text labels;
 * PLS (largest cell) keeps its label at 360×240.
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getIndustryTreeMap).mockResolvedValue(industryTreemapFixture());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    expect(
      canvasElement.querySelectorAll("svg rect").length,
    ).toBeGreaterThan(5);
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getIndustryTreeMap).mockResolvedValue(industryTreemapFixture());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    expect(
      canvasElement.querySelectorAll("svg rect").length,
    ).toBeGreaterThan(5);
  },
};
