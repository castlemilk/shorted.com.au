import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within, userEvent } from "storybook/test";
import { StockChartEmbed } from "./StockChartEmbed";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { getHistoricalData } from "~/@/lib/stock-data-service";
import {
  timeSeriesDataFixture,
  historicalDataFixture,
} from "~/@/mocks/fixtures/short-data";

const mockData = (code: string, period: string) => {
  mocked(fetchStockDataClient).mockResolvedValue(timeSeriesDataFixture(code, period));
  mocked(getHistoricalData).mockResolvedValue(historicalDataFixture(code, period));
};

// Interaction-only (no-visual): the chart visuals are covered by the
// Charts/StockChart baselines; these stories pin the per-view wiring and the
// fill-the-frame layout. The decorator stands in for the iframe viewport.
const meta = {
  title: "Charts/StockChartEmbed",
  component: StockChartEmbed,
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
  args: { stockCode: "PLS" },
  decorators: [
    (Story) => (
      <div style={{ width: 720, height: 480 }} className="bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StockChartEmbed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ShortInterest: Story = {
  args: { stockCode: "PLS", defaultView: "short" },
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    expect(canvas.getByText("Short Interest")).toBeInTheDocument();
    // Period switch refetches; chart keeps rendering.
    await userEvent.click(canvas.getByRole("button", { name: "3m" }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "3m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  },
};

export const SharePrice: Story = {
  args: { stockCode: "PLS", defaultView: "price" },
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-chart="volume"]')).toBeTruthy(),
    );
  },
};

export const Combined: Story = {
  args: { stockCode: "PLS", defaultView: "combined" },
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    expect(canvas.getByText("Share price ($, left)")).toBeInTheDocument();
    expect(canvas.getByText("Short interest (%, right)")).toBeInTheDocument();
  },
};
