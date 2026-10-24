import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import type { ReactNode } from "react";
import { cn } from "~/@/lib/utils";
import { ChatDataTable, type ChatDataTableColumn } from "./chat-data-table";
import { DirectorTradesTable, PeersTable, TopShortsTable } from "./chat-rich-tables";
import {
  parseDirectorTrades,
  parsePeers,
  parseTopShorts,
} from "./chat-tool-data";
import topShorts10 from "./__fixtures__/tool-results/get_top_shorts-10.json";
import topShorts50 from "./__fixtures__/tool-results/get_top_shorts-50.json";
import peersBhp from "./__fixtures__/tool-results/get_peer_comparison-bhp.json";
import tradesBhp from "./__fixtures__/tool-results/get_director_trades-bhp.json";
import tradesNone from "./__fixtures__/tool-results/get_director_trades-glc-none.json";
import tradesBhp50 from "./__fixtures__/tool-results/get_director_trades-bhp-50.json";

// The fixtures are the recorded results, re-serialised: the parsers see the same
// JSON text the chat receives.
const recorded = (value: unknown) => JSON.stringify(value);

/**
 * The table at an exact width, with no padding around it. The widths are the ones the
 * table is drawn at: 223px on a 320px phone's bubble, 270px on a 375px phone, 333px in
 * the desktop sidebar, and 620px on the /chat page. The table's region is 2px narrower
 * (its border), so a fit is measured inside that.
 */
/** The classic scrollbar a long table is given in a story: 15px, the width Linux Chromium draws. */
const STORY_SCROLLBAR_PX = 15;

/**
 * A story's frame. `width` is the table's usable width, what the story is about: the frame
 * is widened by the scrollbar's width when `classicScrollbar` is set, so the table's
 * region keeps that usable width. A long table (over ten rows) reserves a scrollbar gutter,
 * and macOS hides classic scrollbars while Linux draws them, so an unforced frame drew a
 * different tier on each platform. `::-webkit-scrollbar` makes Chromium draw a classic
 * scrollbar of the stated width on every OS; the `scrollbar-width` line keeps Firefox and
 * Safari on their own default rather than a thin or hidden one.
 */
function tableAt(
  theme: "light" | "dark",
  width: number,
  { classicScrollbar = false }: { classicScrollbar?: boolean } = {},
) {
  const frame = classicScrollbar ? width + STORY_SCROLLBAR_PX : width;
  return function TableFrame(Story: () => ReactNode) {
    return (
      <div className={theme === "dark" ? "dark" : undefined}>
        {classicScrollbar && (
          <style>{`
            .chat-story-classic-scrollbar, .chat-story-classic-scrollbar * { scrollbar-width: auto; }
            .chat-story-classic-scrollbar ::-webkit-scrollbar { width: ${STORY_SCROLLBAR_PX}px; height: ${STORY_SCROLLBAR_PX}px; }
          `}</style>
        )}
        <div
          className={cn(
            "bg-background p-0 text-foreground",
            classicScrollbar && "chat-story-classic-scrollbar",
          )}
          style={{ width: frame, fontFamily: APP_FONT }}
        >
          <Story />
        </div>
      </div>
    );
  };
}

/**
 * The app sets its text in IBM Plex Mono, a monospace face, and the table's widths are
 * the widths of that text. Storybook does not load the app's font variable, so the frame
 * sets the same face's stack: Plex Mono's advance is 0.6em, the same as Menlo's and Monaco's.
 */
const APP_FONT = '"IBM Plex Mono", ui-monospace, Menlo, Monaco, monospace';

const meta = {
  title: "Chat/Tool tables",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A table's screen-reader text is absolutely positioned, and it must be positioned
 * against the scroll region. Positioned against the wrapper around the region, it
 * widens the page's scrollable area, and the conversation scrolls into the empty
 * space below a long table. Each such text's offset parent must sit inside the region.
 */
async function expectHiddenTextInRegion(canvasElement: HTMLElement, regionName: string) {
  const canvas = within(canvasElement);
  const region = await canvas.findByRole("region", { name: regionName });
  const hidden = region.querySelectorAll<HTMLElement>(".sr-only");
  expect(hidden.length).toBeGreaterThan(0);
  for (const element of hidden) {
    expect(region.contains(element.offsetParent)).toBe(true);
  }
}

/**
 * The table fits its region at this width: no sideways scroll, so every column that the
 * width draws is in view, and no fade says otherwise. The sparklines load on demand, and
 * their widths count, so the check waits for them when the table draws any.
 */
async function expectFitsWithoutScroll(
  canvasElement: HTMLElement,
  regionName: string,
  sparklines: boolean,
) {
  const canvas = within(canvasElement);
  const region = await canvas.findByRole("region", { name: regionName });
  // A slow runner draws the sparklines late, after the tier that draws them is chosen, so the
  // wait for them is longer than the default.
  if (sparklines) await canvas.findAllByRole("group", { name: /short interest/ }, { timeout: 5000 });
  // The widths and the fade are read once the layout has settled, not at the first paint.
  await waitFor(() => {
    expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
    expect(canvas.queryByTestId("chat-table-more")).toBeNull();
  });
}

/** The most-shorted answer with 10 rows and a sparkline on each. Recorded 2026-10-24. */
export const TopShortsLight: Story = {
  decorators: [tableAt("light", 720)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table", { name: "Most shorted ASX stocks" })).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "DRO" })).toHaveAttribute("href", "/shorts/DRO");
  },
};

export const TopShortsDark: Story = {
  decorators: [tableAt("dark", 720)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
};

/**
 * Fifty rows: the budget cleared the sparklines below the top seven, so those rows read
 * as dashes. The window holds the table to a scrolling region, and the region names the
 * rest with a fade at its foot.
 */
export const TopShortsFifty: Story = {
  decorators: [tableAt("light", 720, { classicScrollbar: true })],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    await expectHiddenTextInRegion(canvasElement, "Most shorted ASX stocks");
    const canvas = within(canvasElement);
    await expect(await canvas.findByTestId("chat-table-more-below")).toBeInTheDocument();
  },
};

/**
 * A row can be inside a scroll region and still under its sticky header: the browser sees it
 * as visible, and does not scroll it. The region is scrolled so the row's link sits 10px below
 * the region's top edge, where the header covers it. Focusing the link must bring it clear of
 * the header, not leave it under it.
 */
export const TopShortsFocusUnderHeader: Story = {
  decorators: [tableAt("light", 333, { classicScrollbar: true })],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name: "Most shorted ASX stocks" });
    const code = topShorts50.timeSeries[6]!.productCode;
    const link = await canvas.findByRole("link", { name: code });
    const header = canvas.getByRole("columnheader", { name: "Stock" });
    const headerBottom = () => header.getBoundingClientRect().bottom;
    const offsetInRegion = () => link.getBoundingClientRect().top - region.getBoundingClientRect().top;

    region.scrollTop += offsetInRegion() - 10;
    await waitFor(() => expect(offsetInRegion()).toBeLessThan(headerBottom() - region.getBoundingClientRect().top));

    link.focus();
    await waitFor(() => expect(link.getBoundingClientRect().top).toBeGreaterThanOrEqual(headerBottom() - 1));
  },
};

/**
 * A phone-width bubble (about 223px on a 320px phone): the essentials, the stock, the
 * short position and the change, fit without a sideways scroll. The trend, a sparkline,
 * is left out at this width, rather than cut off.
 */
export const TopShortsSmallPhone: Story = {
  decorators: [tableAt("light", 223)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Most shorted ASX stocks", false);
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("columnheader", { name: "Trend" })).toBeNull();
  },
};

/** A 375px phone's bubble, about 270px: the same essentials, with the figures' room to breathe. */
export const TopShortsPhoneLight: Story = {
  decorators: [tableAt("light", 270)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Most shorted ASX stocks", false);
  },
};

/**
 * The sidebar's real width: about 333px after the thread, bubble and tool padding. The
 * standard table shows the code, company, short position, change and a 64px trend, and
 * all of it fits without a sideways scroll.
 */
export const TopShortsSidebarLight: Story = {
  decorators: [tableAt("light", 333)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Most shorted ASX stocks", true);
  },
};

export const TopShortsSidebarDark: Story = {
  decorators: [tableAt("dark", 333)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
};

/**
 * The director trades answer at the sidebar's width: the director, shares and value fit. The
 * notice is the director's link, since the Notice column is not drawn below the full width.
 */
export const DirectorTradesSidebarLight: Story = {
  decorators: [tableAt("light", 333)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Director trades in BHP", false);
  },
};

export const DirectorTradesSidebarDark: Story = {
  decorators: [tableAt("dark", 333)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
};

/**
 * On a phone the director trades table keeps the director and the value. The director's name
 * is the notice's link, and a trade with no value shows its share count.
 */
export const DirectorTradesPhoneLight: Story = {
  decorators: [tableAt("light", 223)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Director trades in BHP", false);
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("columnheader", { name: "Shares" })).toBeNull();
    await expect(canvas.queryByRole("columnheader", { name: "Notice" })).toBeNull();
    await expect(canvas.getAllByRole("link", { name: /opens in a new tab/ }).length).toBeGreaterThan(0);
  },
};

/**
 * The fifty-row answer the budget trimmed to thirty-six trades: the footer names the
 * eight left out. Every row's Notice link carries screen-reader text, which must stay
 * inside the scrolling region rather than widen the conversation.
 */
export const DirectorTradesTrimmedLight: Story = {
  decorators: [tableAt("light", 333, { classicScrollbar: true })],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp50))!} code="BHP" />
  ),
  play: async ({ canvasElement }) => {
    await expectHiddenTextInRegion(canvasElement, "Director trades in BHP");
  },
};

/**
 * A synthetic answer whose budget left out every trade: 44 reported, none sent. The
 * table keeps its header and names the 44 in its footer, as the chat's prompt describes
 * a table for these results. Synthetic: no recorded answer has this shape.
 */
export const DirectorTradesAllTrimmed: Story = {
  decorators: [tableAt("light", 333)],
  render: () => (
    <DirectorTradesTable
      view={parseDirectorTrades(recorded({ trades: [], totalCount: 44, omittedTrades: 44 }))!}
      code="BHP"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table", { name: "Director trades in BHP" })).toBeInTheDocument();
    await expect(canvas.getByText("44 more not shown")).toBeInTheDocument();
  },
};

/** The peers with the subject first and marked, at the sidebar's width. Recorded 2026-10-24. */
export const PeersSidebarLight: Story = {
  decorators: [tableAt("light", 333)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Peers of BHP in Materials", false);
  },
};

/** The peers at a phone's bubble: the stock, its short position and market cap fit. */
export const PeersPhoneLight: Story = {
  decorators: [tableAt("light", 223)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Peers of BHP in Materials", false);
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("columnheader", { name: "1-month price" })).toBeNull();
  },
};

/** The tool left stocks out of the answer. Synthetic: no recorded answer carries omittedStocks. */
export const TopShortsOmitted: Story = {
  decorators: [tableAt("light", 720)],
  render: () => (
    <TopShortsTable
      view={
        parseTopShorts(
          recorded({
            timeSeries: topShorts10.timeSeries.slice(0, 3),
            omittedStocks: 40,
          }),
        )!
      }
    />
  ),
};

/** The full peers table on the /chat page, with the one-month price column. */
export const PeersLight: Story = {
  decorators: [tableAt("light", 720)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
};

export const PeersDark: Story = {
  decorators: [tableAt("dark", 720)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
};

/** The director trades on the /chat page: every column, the price included. */
export const DirectorTradesLight: Story = {
  decorators: [tableAt("light", 720)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table", { name: "Director trades in BHP" })).toBeInTheDocument();
    await expect(canvas.getByRole("columnheader", { name: "Price" })).toBeInTheDocument();
  },
};

export const DirectorTradesDark: Story = {
  decorators: [tableAt("dark", 720)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
};

/** The documented empty answer, {}: a sentence, not a table. */
export const DirectorTradesEmpty: Story = {
  decorators: [tableAt("light", 720)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesNone))!} code="GLC" />
  ),
};

/** The table on its own, for the semantics a reader relies on. */
export const GenericTable: Story = {
  decorators: [tableAt("light", 480)],
  render: () => {
    interface Pair {
      name: string;
      value: string;
    }
    const columns: ChatDataTableColumn<Pair>[] = [
      { id: "name", header: "Name", rowHeader: true, cell: (row) => row.name },
      { id: "value", header: "Value", numeric: true, cell: (row) => row.value },
    ];
    return (
      <ChatDataTable
        caption="Two readings"
        columns={columns}
        rows={[
          { name: "Alpha", value: "12.50%" },
          { name: "Beta", value: "3.00%" },
        ]}
        rowKey={(row) => row.name}
        notShown={2}
      />
    );
  },
};

/**
 * The desktop sidebar's real table width: 276px (see chat-layout.ts). The most-shorted
 * table draws its compact columns, the stock, the short position and the change, all in
 * view without a sideways scroll, and says which rows have a change and a trend.
 */
export const TopShortsDesktopSidebarLight: Story = {
  decorators: [tableAt("light", 276, { classicScrollbar: true })],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Most shorted ASX stocks", false);
    const canvas = within(canvasElement);
    // The trend is not drawn at this width, so the footnote names the change alone.
    await expect(canvas.getByText("Change is shown for the top 7 only.")).toBeInTheDocument();
    await expect(canvas.queryByRole("columnheader", { name: "Trend" })).toBeNull();
  },
};

/**
 * The same table at 263px: the desktop sidebar with a classic scrollbar taking its 13-15px.
 * Every column is still in view without a sideways scroll.
 */
export const TopShortsDesktopClassicScrollbar: Story = {
  decorators: [tableAt("light", 263, { classicScrollbar: true })],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Most shorted ASX stocks", false);
  },
};

/**
 * The fifty-row table at 330px, the narrowest the standard columns are drawn at. A long
 * table takes a scrollbar gutter, so the tier is chosen from the width the table has, and
 * the trend fits beside the figures without a sideways scroll.
 */
export const TopShortsFiftyStandardWidth: Story = {
  // The table's usable width is 330px: the frame is 332px less the scrollbar's 15px, plus the
  // scrollbar the frame is widened by. The region's 1px border on each side is in the 332.
  decorators: [tableAt("light", 332, { classicScrollbar: true })],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Most shorted ASX stocks", true);
  },
};

/**
 * The director's name is the row's identity, so at the desktop sidebar's width it takes the
 * room the figures leave: "Mark Vassella" and "Michelle Hinchliffe" are whole. The date and
 * the trade type share a single line beneath, so no row grows to three or four lines.
 */
export const DirectorTradesDesktopSidebarLight: Story = {
  decorators: [tableAt("light", 276, { classicScrollbar: true })],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp50))!} code="BHP" />
  ),
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Director trades in BHP", false);
    const canvas = within(canvasElement);
    // Each name is checked wherever the fixture repeats it: none is cut short.
    for (const name of ["Mark Vassella", "Michelle Hinchliffe"]) {
      for (const cell of await canvas.findAllByText(name)) {
        await expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth);
      }
    }
  },
};

/**
 * The subject of a peer comparison has a visible mark at the desktop sidebar's width, where
 * the "This stock" badge is screen-reader only: a primary bar on its first cell.
 */
export const PeersDesktopSidebarLight: Story = {
  decorators: [tableAt("light", 276)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
  play: async ({ canvasElement }) => {
    await expectFitsWithoutScroll(canvasElement, "Peers of BHP in Materials", false);
    const canvas = within(canvasElement);
    const subject = (await canvas.findByRole("rowheader", { name: /BHP/ })).closest("tr")!;
    await expect(subject.className).toContain("bg-primary/10");
    const header = subject.querySelector("th")!;
    await expect(getComputedStyle(header).boxShadow).not.toBe("none");
    await expect(within(subject).getByText("This stock", { selector: ".sr-only" })).toBeInTheDocument();
  },
};

/**
 * A focused link near the foot of a long table is scrolled clear of the fade on the foot,
 * not left under it. The region is scrolled so the link (the ninth row) sits in the bottom
 * 10px, where the fade covers it. Focusing the link brings it up above the fade.
 */
export const TopShortsFocusAboveFade: Story = {
  decorators: [tableAt("light", 333, { classicScrollbar: true })],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name: "Most shorted ASX stocks" });
    const code = topShorts50.timeSeries[8]!.productCode;
    const link = await canvas.findByRole("link", { name: code });
    const regionBottom = () => region.getBoundingClientRect().bottom;
    const linkBottom = () => link.getBoundingClientRect().bottom;

    region.scrollTop += linkBottom() - regionBottom() + 10;
    await waitFor(() => expect(linkBottom()).toBeGreaterThan(regionBottom() - 24));

    link.focus();
    // The fade covers the foot's bottom 24px, so a focused link ends above that line.
    await waitFor(() => expect(linkBottom()).toBeLessThanOrEqual(regionBottom() - 24 + 1));
  },
};
