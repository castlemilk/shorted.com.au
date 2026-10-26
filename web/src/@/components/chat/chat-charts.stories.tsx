import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ReactNode } from "react";
import { ChatLineChart, ChatSparkline } from "./chat-charts";
import { getRichToolResult, RichToolResultView } from "./chat-rich-tool-results";
import { TopShortsTable } from "./chat-rich-tables";
import { parseShortPositions, parseTopShorts } from "./chat-tool-data";
import { formatPercent } from "./chat-tool-format";
import bhp1y from "./__fixtures__/tool-results/query_short_positions-bhp-1y.json";
import dro6m from "./__fixtures__/tool-results/query_short_positions-dro-6m.json";
import glc3m from "./__fixtures__/tool-results/query_short_positions-glc-3m.json";
import economic from "./__fixtures__/tool-results/get_economic_series-cash-rate-cpi.json";
import unemployment from "./__fixtures__/tool-results/get_economic_series-unemployment-nsw.json";
import topShorts10 from "./__fixtures__/tool-results/get_top_shorts-10.json";
import narrowRange from "./__fixtures__/tool-results/query_short_positions-narrow-range.json";
import unitSeries from "./__fixtures__/tool-results/get_economic_series-units.json";
import topShorts50 from "./__fixtures__/tool-results/get_top_shorts-50.json";

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

/**
 * The sparkline in a table cell: a tiny line that reads its day and value on focus. The
 * tooltip names the stock by its code, and opens above the line on its trailing edge.
 */
export const Sparkline: Story = {
  decorators: [themed("light", 240)],
  render: () => {
    const dro = parseTopShorts(recorded(topShorts10))!.rows[0]!;
    return (
      <ChatSparkline
        label={`${dro.code} short interest`}
        seriesLabel={dro.code}
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
        label={`${dro.code} short interest`}
        seriesLabel={dro.code}
        points={dro.points}
        color="#D16A47"
      />
    );
  },
};

/**
 * A short-position answer at a phone bubble's width. The tooltip stays inside the chart
 * box at every reading, and the latest value is outlined so the line does not cross it.
 */
export const ShortPositionResultPhone: Story = {
  decorators: [themed("light", 300)],
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

/** The chat's frame at an exact width: a sidebar's bubble is about 333px wide. */
function frame(width: number) {
  return function FrameStory(Story: () => ReactNode) {
    return (
      <div className="bg-background p-0 text-foreground" style={{ width }}>
        <Story />
      </div>
    );
  };
}

/**
 * A short position that moved only a hundredth of a point in ten days, drawn at the
 * sidebar's width. Its axis ticks are a few thousandths apart, so they print to three
 * places: no two ticks share a label. Synthetic: no recorded answer has so narrow a range.
 */
export const ShortPositionNarrowRange: Story = {
  decorators: [frame(333)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(toolCall("query_short_positions", { stock_code: "CTX", period: "3m" }, narrowRange))!
      }
    />
  ),
  play: async ({ canvasElement }) => {
    // The chart loads on demand, so its tick labels are awaited rather than read at once.
    const labels = await waitFor(() => {
      const found = [...canvasElement.querySelectorAll(".visx-axis-left text")].map(
        (node) => node.textContent ?? "",
      );
      if (found.length < 3) throw new Error("the chart's axis has not drawn yet");
      return found;
    });
    await expect(new Set(labels).size).toBe(labels.length);
  },
};

/**
 * Economic series in the units the importers write, at the sidebar's width. Each unit
 * reads as its words in the subtitle and beside the figures, and a unit the chat does
 * not know is left out, never printed as its id. Synthetic: the recorded answers carry
 * only percentages.
 */
export const EconomicSeriesUnitsSidebar: Story = {
  decorators: [frame(333)],
  render: () => (
    <RichToolResultView
      result={
        getRichToolResult(
          toolCall(
            "get_economic_series",
            { series_keys: unitSeries.series.map((series) => series.key) },
            unitSeries,
          ),
        )!
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("US dollars per barrel · Monthly")).toBeInTheDocument();
    await expect(canvas.getByText("Dwelling units · Monthly")).toBeInTheDocument();
    await expect(canvas.queryByText(/_per_|_usd/)).toBeNull();
    await expect(canvas.queryByText(/widgets_per_frob/)).toBeNull();
  },
};

/**
 * A sparkline in the window's top-right corner. Its tooltip is drawn in a portal and held
 * inside the window, so the reading is whole where the table's own scroll region would
 * have cut it off.
 */
export const SparklineAtWindowCorner: Story = {
  decorators: [
    (Story) => (
      <div style={{ position: "fixed", top: 0, right: 0, width: 96 }} className="bg-background">
        <Story />
      </div>
    ),
  ],
  render: () => {
    const dro = parseTopShorts(recorded(topShorts10))!.rows[0]!;
    return (
      <ChatSparkline label={`${dro.code} short interest`} seriesLabel={dro.code} points={dro.points} color="#D16A47" />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const spark = canvas.getByRole("group");
    spark.focus();
    // Focus sets the reading, and the tooltip is placed after the render it causes.
    const tip = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="chat-spark-tooltip"]');
      if (!element) throw new Error("no tooltip yet");
      return element;
    });
    const box = tip.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(0);
    await expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    await expect(box.top).toBeGreaterThanOrEqual(0);
    await expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
  },
};

/**
 * A series in a long unit at the desktop sidebar's width (276px): Singapore dollars per US
 * dollar. The ticks print bare figures and the latest label its short form, so the unit is
 * named once, in the subtitle, and the plot keeps most of the width. Synthetic: no recorded
 * answer carries this unit.
 */
const sgdSeries = {
  series: [
    {
      key: "fx.spot_rate.usd_sgd.sgp",
      name: "Singapore",
      unit: "sgd_per_usd",
      frequency: "monthly",
      observations: Array.from({ length: 24 }, (_, index) => ({
        period: new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 10),
        value: 1.3 + Math.sin(index / 3) * 0.03 + index * 0.002,
      })),
    },
  ],
};

export const EconomicSeriesLongUnitDesktopSidebar: Story = {
  decorators: [frame(276)],
  render: () => (
    <RichToolResultView
      result={getRichToolResult(toolCall("get_economic_series", { series_keys: ["fx.spot_rate.usd_sgd.sgp"] }, sgdSeries))!}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Singapore dollars per US dollar · Monthly")).toBeInTheDocument();
    const latest = await waitFor(() => {
      const element = canvasElement.querySelector<SVGTextElement>('[data-testid="chat-latest-label"]');
      if (!element) throw new Error("the chart has not drawn yet");
      return element;
    });
    // The label is the figure and no words, so it is not wider than the plot it sits on.
    await expect(latest.textContent ?? "").not.toMatch(/Singapore/);
    const labelBox = latest.getBoundingClientRect();
    const svg = latest.ownerSVGElement!.getBoundingClientRect();
    await expect(labelBox.left).toBeGreaterThanOrEqual(svg.left);
    // No tick label runs under the latest label.
    for (const tick of canvasElement.querySelectorAll<SVGTextElement>(".visx-axis-left text")) {
      const box = tick.getBoundingClientRect();
      const overlaps =
        box.left < labelBox.right && box.right > labelBox.left && box.top < labelBox.bottom && box.bottom > labelBox.top;
      await expect(overlaps).toBe(false);
    }
  },
};

/**
 * The DRO fixture (a real six-month answer) at the sidebar's width. Its peak is the reading
 * before the latest, and the line comes up into the latest reading from below as well. Both
 * sides of the latest reading are crossed, so the label moves into the band over the plot,
 * where no line can reach it, and the peak and the reading's digits are both visible.
 */
export const ShortPositionLatestLabelClearOfPeak: Story = {
  decorators: [frame(280)],
  render: () => (
    <RichToolResultView
      result={getRichToolResult(toolCall("query_short_positions", { stock_code: "DRO", period: "6m" }, dro6m))!}
    />
  ),
  play: async ({ canvasElement }) => {
    // The first paint lays the chart out at a fallback width. The placement is read once the
    // measured width has replaced it, which the svg's viewBox shows.
    const latest = await waitFor(() => {
      const svg = canvasElement.querySelector<SVGSVGElement>("svg[viewBox]");
      if (!svg || svg.getAttribute("viewBox")?.startsWith("0 0 480 ")) throw new Error("not measured yet");
      const element = canvasElement.querySelector<SVGTextElement>('[data-testid="chat-latest-label"]');
      if (!element) throw new Error("the chart has not drawn yet");
      return element;
    });
    await expect(latest.getAttribute("data-placement")).toBe("top");
    // The label is in the band over the plot, above the top of the line.
    await expect(Number(latest.getAttribute("y"))).toBeLessThan(0);
  },
};

/**
 * Nearly a year of monthly readings across two calendar years, so the time axis writes the
 * year where it changes. Without it the axis read "October, April, October" with no way to
 * tell which October.
 */
export const EconomicSeriesYearAxisSidebar: Story = {
  decorators: [frame(333)],
  render: () => (
    <RichToolResultView
      result={getRichToolResult(toolCall("get_economic_series", { series_keys: unemployment.series.map((s) => s.key), limit: 24 }, unemployment))!}
    />
  ),
  play: async ({ canvasElement }) => {
    const labels = await waitFor(() => {
      const found = [...canvasElement.querySelectorAll(".visx-axis-bottom text")].map((node) => node.textContent ?? "");
      if (found.length < 2) throw new Error("the time axis has not drawn yet");
      return found;
    });
    await expect(labels.some((label) => /\b20\d\d\b/.test(label))).toBe(true);
    await expect(labels.every((label) => !/^(January|February|March|April|May|June|July|August|September|October|November|December)$/.test(label))).toBe(true);
  },
};

/**
 * A focused sparkline that scrolls out of its table loses its tooltip. The tooltip would
 * otherwise float over the sheet's other content, away from the reading it describes, until
 * the next tap. The region is scrolled past the third row, where the reading was focused.
 */
export const SparklineScrolledOutOfTable: Story = {
  decorators: [frame(720)],
  render: () => <TopShortsTable view={parseTopShorts(recorded(topShorts50))!} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name: "Most shorted ASX stocks" });
    const spark = (await canvas.findAllByRole("group", { name: /short interest/ }))[2]!;
    spark.focus();
    await waitFor(() => {
      if (!document.querySelector('[data-testid="chat-spark-tooltip"]')) throw new Error("no tooltip yet");
    });
    region.scrollTop = 400;
    await waitFor(() => expect(document.querySelector('[data-testid="chat-spark-tooltip"]')).toBeNull());
  },
};
