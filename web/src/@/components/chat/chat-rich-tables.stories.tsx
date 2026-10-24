import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";
import type { ReactNode } from "react";
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

/** Light is the default page; dark is the `.dark` theme the app applies. */
function themed(theme: "light" | "dark", width: number) {
  return function ThemedStory(Story: () => ReactNode) {
    return (
      <div className={theme === "dark" ? "dark" : undefined}>
        <div className="bg-background p-4 text-foreground" style={{ width }}>
          <Story />
        </div>
      </div>
    );
  };
}

const meta = {
  title: "Chat/Tool tables",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The most-shorted answer with 10 rows and a sparkline on each. Recorded 2026-10-24. */
export const TopShortsLight: Story = {
  decorators: [themed("light", 720)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table", { name: "Most shorted ASX stocks" })).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "DRO" })).toHaveAttribute("href", "/shorts/DRO");
  },
};

export const TopShortsDark: Story = {
  decorators: [themed("dark", 720)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
};

/** Fifty rows: the budget cleared the sparklines below the top seven, so those rows read as dashes. */
export const TopShortsFifty: Story = {
  decorators: [themed("light", 720)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
};

/** A phone-width bubble: the table scrolls sideways inside the bubble, not the page. */
export const TopShortsNarrow: Story = {
  decorators: [themed("light", 320)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
};

/**
 * The sidebar's real width, about 333px after the thread, bubble and tool padding. The
 * code, company, short position and change fit; the trend scrolls sideways, and the fade
 * on the right edge says there is more to see.
 */
export const TopShortsSidebarLight: Story = {
  decorators: [themed("light", 333)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("chat-table-more")).toBeInTheDocument();
  },
};

export const TopShortsSidebarDark: Story = {
  decorators: [themed("dark", 333)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts10))!} />,
};

/** The director trades answer at the sidebar's width: the director, shares and value fit. */
export const DirectorTradesSidebarLight: Story = {
  decorators: [themed("light", 333)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
};

export const DirectorTradesSidebarDark: Story = {
  decorators: [themed("dark", 333)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
};

/** The fifty-row answer the budget trimmed to thirty-six trades: the footer names the eight left out. */
export const DirectorTradesTrimmedLight: Story = {
  decorators: [themed("light", 333)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp50))!} code="BHP" />
  ),
};

/** The peers with the subject first and marked. Recorded 2026-10-24. */
export const PeersSidebarLight: Story = {
  decorators: [themed("light", 333)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
};

/** The tool left stocks out of the answer. Synthetic: no recorded answer carries omittedStocks. */
export const TopShortsOmitted: Story = {
  decorators: [themed("light", 720)],
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

export const PeersLight: Story = {
  decorators: [themed("light", 720)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
};

export const PeersDark: Story = {
  decorators: [themed("dark", 720)],
  render: () => <PeersTable view={parsePeers(recorded(peersBhp))!} />,
};

export const DirectorTradesLight: Story = {
  decorators: [themed("light", 720)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table", { name: "Director trades in BHP" })).toBeInTheDocument();
  },
};

export const DirectorTradesDark: Story = {
  decorators: [themed("dark", 720)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesBhp))!} code="BHP" />
  ),
};

/** The documented empty answer, {}: a sentence, not a table. */
export const DirectorTradesEmpty: Story = {
  decorators: [themed("light", 720)],
  render: () => (
    <DirectorTradesTable view={parseDirectorTrades(recorded(tradesNone))!} code="GLC" />
  ),
};

/** The table on its own, for the semantics a reader relies on. */
export const GenericTable: Story = {
  decorators: [themed("light", 480)],
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
