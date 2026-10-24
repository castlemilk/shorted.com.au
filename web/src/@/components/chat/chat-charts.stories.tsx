import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ReactNode } from "react";
import { ChatLineChart, ChatSparkline } from "./chat-charts";
import { getRichToolResult, RichToolResultView } from "./chat-rich-tool-results";
import { parseShortPositions, parseTopShorts } from "./chat-tool-data";
import { formatPercent } from "./chat-tool-format";
import bhp1y from "./__fixtures__/tool-results/query_short_positions-bhp-1y.json";
import dro6m from "./__fixtures__/tool-results/query_short_positions-dro-6m.json";
import glc3m from "./__fixtures__/tool-results/query_short_positions-glc-3m.json";
import economic from "./__fixtures__/tool-results/get_economic_series-cash-rate-cpi.json";
import unemployment from "./__fixtures__/tool-results/get_economic_series-unemployment-nsw.json";
import topShorts10 from "./__fixtures__/tool-results/get_top_shorts-10.json";

// The fixtures are the recorded results, re-serialised: the components see the
// same JSON text the chat receives.
const recorded = (value: unknown) => JSON.stringify(value);

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

/** A tool call as the chat holds it, drawn by the same dispatcher the message uses. */
function toolCall(toolName: string, args: Record<string, unknown>, result: unknown) {
  return {
    toolName,
    arguments: JSON.stringify(args),
    result: recorded(result),
  };
}

const bhpPoints = parseShortPositions(recorded(bhp1y), JSON.stringify({ stock_code: "BHP" }))!.points;

const meta = {
  title: "Chat/Charts",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The interactive chart on its own, with a year of BHP readings (40 of 254 shown). */
export const ShortPositionLight: Story = {
  decorators: [themed("light", 640)],
  render: () => (
    <ChatLineChart
      label="BHP short interest"
      points={bhpPoints}
      color="#D16A47"
      kind="area"
      formatValue={formatPercent}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chart = canvas.getByRole("group", { name: /BHP short interest/ });
    chart.focus();
    await userEvent.keyboard("{ArrowLeft}");
    const readout = canvasElement.querySelector('[aria-live="polite"]');
    await expect(readout?.textContent ?? "").toMatch(/%$/);
  },
};

export const ShortPositionDark: Story = {
  decorators: [themed("dark", 640)],
  render: () => (
    <ChatLineChart
      label="BHP short interest"
      points={bhpPoints}
      color="#D16A47"
      kind="area"
      formatValue={formatPercent}
    />
  ),
};

/** A short-position answer as the chat draws it: the header, the chart and its caption. */
export const ShortPositionResultLight: Story = {
  decorators: [themed("light", 640)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(
          toolCall("query_short_positions", { stock_code: "DRO", period: "6m" }, dro6m),
        )!
      }
    />
  ),
};

export const ShortPositionResultDark: Story = {
  decorators: [themed("dark", 640)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(
          toolCall("query_short_positions", { stock_code: "DRO", period: "6m" }, dro6m),
        )!
      }
    />
  ),
};

/** Four readings across three months: sparse, and no downsampling note. */
export const ShortPositionSparse: Story = {
  decorators: [themed("light", 640)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(
          toolCall("query_short_positions", { stock_code: "GLC", period: "3m" }, glc3m),
        )!
      }
    />
  ),
};

/** Two economic series, each its own chart. */
export const EconomicSeriesLight: Story = {
  decorators: [themed("light", 640)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(
          toolCall("get_economic_series", { series_keys: ["rates.cash_rate_target.aus"] }, economic),
        )!
      }
    />
  ),
};

export const EconomicSeriesDark: Story = {
  decorators: [themed("dark", 640)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(
          toolCall("get_economic_series", { series_keys: ["labour.unemployment_rate.total.nsw.seasadj"] }, unemployment),
        )!
      }
    />
  ),
};

/** The sparkline in a table cell: a tiny line that reads its day and value on focus. */
export const Sparkline: Story = {
  decorators: [themed("light", 240)],
  render: () => {
    const dro = parseTopShorts(recorded(topShorts10))!.rows[0]!;
    return (
      <ChatSparkline
        label={`${dro.code} short interest, last three months`}
        points={dro.points}
        color="#D16A47"
      />
    );
  },
};

export const SparklineDark: Story = {
  decorators: [themed("dark", 240)],
  render: () => {
    const dro = parseTopShorts(recorded(topShorts10))!.rows[0]!;
    return (
      <ChatSparkline
        label={`${dro.code} short interest, last three months`}
        points={dro.points}
        color="#D16A47"
      />
    );
  },
};
