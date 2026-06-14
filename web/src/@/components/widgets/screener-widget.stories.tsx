/**
 * ScreenerWidget stories — compact top-shorted table with row navigation.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play function
 * exercising the widget's row-click navigation.
 *
 * Data trace (verified against screener-widget.tsx):
 * - screenStocks(undefined, SHORT_PCT, DESC, limit, 0) — ~/app/actions/
 *   screenStocks, called once per mount (and again if sizeVariant changes).
 *   limit is 5 for compact, 10 otherwise. Spy-mocked in preview.tsx (the
 *   module imports connect-web + React cache + withRetry — browser-safe, no
 *   kv-cache, so no __mocks__ file is needed).
 * - No visibility gating and no other data calls.
 *
 * KNOWN GAPs pinned below:
 * - config is ignored entirely (destructured as `_config`), so the
 *   ScreenerSettings `limit` setting has NO effect — the request limit comes
 *   only from sizeVariant. Stories still pass valid settings for realism.
 * - Errors are swallowed (`catch {}`): a rejected screenStocks renders the
 *   SAME headers-plus-footer empty table as a genuinely empty response — no
 *   error copy, no retry affordance.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, mocked, userEvent, waitFor, within } from "storybook/test";
import { create } from "@bufbuild/protobuf";

import { ScreenerWidget } from "./screener-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { screenerResponseFixture } from "~/@/mocks/fixtures/short-data";
import { screenStocks } from "~/app/actions/screenStocks";
import { ScreenStocksResponseSchema } from "~/gen/shorts/v1alpha1/shorts_pb";

/** formatPercent twin of the widget's own helper (signed, 2 dp). */
const signedPct = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

/** Honour the widget's requested limit so Compact really gets 5 rows. */
const resolveFixture = () => {
  mocked(screenStocks).mockImplementation(
    // The spy replaces the whole cache()-wrapped export, so the mock receives
    // the widget's real call args; narrow `limit` defensively before using it.
    (_filters, _sortField, _sortDirection, limit) =>
      Promise.resolve(
        screenerResponseFixture(typeof limit === "number" ? limit : 10),
      ),
  );
};

const meta = {
  title: "Widgets/Screener",
  component: ScreenerWidget,
  args: {
    config: makeWidgetConfig(WidgetType.SCREENER, { limit: 10 }),
    sizeVariant: "standard",
  },
  decorators: [withGridCell("medium")],
  // The widget calls useRouter() from next/navigation (App Router).
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof ScreenerWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded table with 10 fixture rows ordered by descending short %. Asserts
 * the header cells, the PLS top row values ("19.40%" + signed 4W change),
 * the "Open full screener" footer link, then clicks the PLS row and asserts
 * the App Router mock received the /shorts/PLS navigation.
 */
export const Default: Story = {
  beforeEach: resolveFixture,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixture = screenerResponseFixture(10);

    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    // Column headers.
    expect(canvas.getByText("Stock")).toBeInTheDocument();
    expect(canvas.getByText("Short %")).toBeInTheDocument();
    expect(canvas.getByText("4W Chg")).toBeInTheDocument();

    // 1 header row + 10 data rows, in fixture (descending short %) order.
    const rows = canvas.getAllByRole("row");
    expect(rows).toHaveLength(11);
    expect(within(rows[1]!).getByText("PLS")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("19.40%")).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText(signedPct(fixture.stocks[0]!.shortPctChange4w)),
    ).toBeInTheDocument();
    expect(within(rows[10]!).getByText("SLX")).toBeInTheDocument();

    // Footer link to the full screener page.
    expect(
      canvas.getByRole("link", { name: /open full screener/i }),
    ).toHaveAttribute("href", "/screener");

    // Primary interaction: clicking a row pushes its shorts page.
    await userEvent.click(within(rows[1]!).getByText("PLS"));
    const router = getRouter();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalled();
    });
    expect(mocked(router.push).mock.calls[0]![0]).toBe("/shorts/PLS");
  },
};

/**
 * Perpetual loading: the promise never settles, so the 5-row pulse skeleton
 * stays up and neither the table nor the footer link is mounted.
 */
export const Loading: Story = {
  beforeEach: () => {
    mocked(screenStocks).mockReturnValue(never());
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll(".animate-pulse"),
      ).toHaveLength(5);
    });
    expect(within(canvasElement).queryByRole("table")).not.toBeInTheDocument();
    expect(
      within(canvasElement).queryByText(/open full screener/i),
    ).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: errors are swallowed (`catch {}` + stocks stays []), so a
 * failed screenStocks renders the SAME empty table (headers + footer link,
 * zero data rows) as the Empty story — no error copy anywhere. This story
 * pins that behavior; if an error state is added later, update these
 * assertions to match it.
 */
export const Error: Story = {
  beforeEach: () => {
    // globalThis.Error: the exported story const shadows the Error
    // constructor inside this module.
    mocked(screenStocks).mockRejectedValue(
      new globalThis.Error("shorts API unavailable"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Stock")).toBeInTheDocument();
    });
    // Header row only — no data rows, no error message.
    expect(canvas.getAllByRole("row")).toHaveLength(1);
    expect(
      canvas.getByRole("link", { name: /open full screener/i }),
    ).toBeInTheDocument();
  },
};

/** Empty response: header row + footer link, zero data rows. */
export const Empty: Story = {
  beforeEach: () => {
    mocked(screenStocks).mockResolvedValue(
      create(ScreenStocksResponseSchema, { stocks: [], totalCount: 0 }),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Stock")).toBeInTheDocument();
    });
    expect(canvas.getAllByRole("row")).toHaveLength(1);
    expect(
      canvas.getByRole("link", { name: /open full screener/i }),
    ).toBeInTheDocument();
  },
};

/**
 * Compact: the widget requests limit 5 instead of 10 (the only thing
 * sizeVariant changes — the table layout itself is identical).
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: resolveFixture,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
    // 1 header row + 5 data rows (the compact limit), ending at FLT.
    const rows = canvas.getAllByRole("row");
    expect(rows).toHaveLength(6);
    expect(within(rows[5]!).getByText("FLT")).toBeInTheDocument();
    expect(canvas.queryByText("SLX")).not.toBeInTheDocument();
  },
};

export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    nextjs: { appDirectory: true },
  },
  decorators: [withGridCell("small")],
  beforeEach: resolveFixture,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("PLS")).toBeInTheDocument();
    });
  },
};
