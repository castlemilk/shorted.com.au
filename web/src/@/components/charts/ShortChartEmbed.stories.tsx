import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within, userEvent } from "storybook/test";
import { ShortChartEmbed } from "./ShortChartEmbed";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { timeSeriesDataFixture } from "~/@/mocks/fixtures/short-data";

// Interaction-only (no-visual): this is a thin fetch+period wrapper around
// StockChart, whose visuals are already covered by the Charts/StockChart baselines.
const meta = {
  title: "Charts/ShortChartEmbed",
  component: ShortChartEmbed,
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
  args: { stockCode: "PLS" },
  decorators: [
    (Story) => (
      <div style={{ width: 720, height: 440 }} className="bg-background p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShortChartEmbed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  beforeEach: () => {
    mocked(fetchStockDataClient).mockResolvedValue(
      timeSeriesDataFixture("PLS", "1y"),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
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
