/**
 * TopShortsWidget stories — the exemplar widget story file.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus play
 * functions exercising the widget's primary interaction.
 *
 * Interaction choice (Default): the standard table's only interactive
 * element besides row navigation is the "Short" column sort button
 * (columns.tsx, column id "shorted", accessor latestShortPosition).
 * First click calls column.toggleSorting(false) → ascending, so SLX
 * (lowest short position in the fixture, 5.9%) moves to the first data
 * row and PLS (highest, 19.4%) leaves it. Row-click navigation also
 * exists, but sorting is fully assertable from the DOM without spying
 * on the router, so it is the stronger contract test.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { create } from "@bufbuild/protobuf";
import { expect, mocked, userEvent, waitFor, within } from "storybook/test";

import { TopShortsWidget } from "./top-shorts-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { topShortsResponseFixture } from "~/@/mocks/fixtures/short-data";
import { fetchTopShortsClient } from "@/lib/client-api";
import { GetTopShortsResponseSchema } from "~/gen/shorts/v1alpha1/market_pb";

const meta = {
  title: "Widgets/TopShorts",
  component: TopShortsWidget,
  args: {
    config: makeWidgetConfig(WidgetType.TOP_SHORTS, {
      period: "3m",
      limit: 10,
    }),
    sizeVariant: "standard",
  },
  decorators: [withGridCell("medium")],
  // The widget calls useRouter() from next/navigation (App Router).
  // @storybook/nextjs-vite only mounts the app-router mock when
  // nextjs.appDirectory is set; without it stories crash with
  // "invariant expected app router to be mounted".
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof TopShortsWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded table with all 10 fixture rows. The play function sorts by the
 * "Short" column header and asserts the row order flips (ascending puts
 * SLX first; the default API order puts PLS first).
 */
export const Default: Story = {
  beforeEach: () => {
    mocked(fetchTopShortsClient).mockResolvedValue(topShortsResponseFixture());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Data loads: PLS (fixture rank 1) renders in the first data row.
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    const rows = canvas.getAllByRole("row");
    // rows[0] is the header row.
    expect(within(rows[1]!).getByText("PLS")).toBeInTheDocument();
    expect(canvas.getByText("Pilbara Minerals Limited")).toBeInTheDocument();

    // Primary interaction: sort by the "Short" column. First click sorts
    // ascending, so SLX (lowest latestShortPosition) becomes the first row.
    await userEvent.click(canvas.getByRole("button", { name: /short/i }));
    await waitFor(() => {
      const sorted = canvas.getAllByRole("row");
      expect(within(sorted[1]!).getByText("SLX")).toBeInTheDocument();
    });

    // Second click flips to descending — PLS returns to the top.
    await userEvent.click(canvas.getByRole("button", { name: /short/i }));
    await waitFor(() => {
      const sorted = canvas.getAllByRole("row");
      expect(within(sorted[1]!).getByText("PLS")).toBeInTheDocument();
    });
  },
};

/**
 * Perpetual loading: the promise never settles, so the skeleton table
 * stays up. The skeleton branch renders static headers ("Rank") that the
 * loaded table does not, which makes the state assertable.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(fetchTopShortsClient).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Rank")).toBeInTheDocument();
    });
    expect(canvas.queryByText(/failed to load/i)).not.toBeInTheDocument();
  },
};

export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(fetchTopShortsClient).mockRejectedValue(
      new globalThis.Error("backend unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText(/failed to load data/i)).toBeInTheDocument();
    });
  },
};

export const Empty: Story = {
  beforeEach: () => {
    mocked(fetchTopShortsClient).mockResolvedValue(
      create(GetTopShortsResponseSchema, { timeSeries: [] }),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText(/no results/i)).toBeInTheDocument();
    });
  },
};

/**
 * Compact variant: horizontal scroll cards instead of the table.
 * Asserts the card layout renders rank + code + percentageShorted
 * (PLS fixture: 19.4%).
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(fetchTopShortsClient).mockResolvedValue(topShortsResponseFixture());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    expect(canvas.getByText("#1")).toBeInTheDocument();
    expect(canvas.getByText("19.4%")).toBeInTheDocument();
    // Table-only affordances must not leak into compact mode.
    expect(canvas.queryByRole("table")).not.toBeInTheDocument();
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(fetchTopShortsClient).mockResolvedValue(topShortsResponseFixture());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
  },
};
