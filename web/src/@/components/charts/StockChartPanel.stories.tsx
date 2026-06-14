import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within, userEvent } from "storybook/test";
import { create } from "@bufbuild/protobuf";
import { StockChartPanel } from "./StockChartPanel";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { getHistoricalData } from "~/@/lib/stock-data-service";
import {
  timeSeriesDataFixture,
  historicalDataFixture,
} from "~/@/mocks/fixtures/short-data";
import { TimeSeriesDataSchema } from "~/gen/stocks/v1alpha1/stocks_pb";

const never = <T,>() => new Promise<T>(() => undefined);
const mockData = (code: string, period: string) => {
  mocked(fetchStockDataClient).mockResolvedValue(timeSeriesDataFixture(code, period));
  mocked(getHistoricalData).mockResolvedValue(historicalDataFixture(code, period));
};

const meta = {
  title: "Charts/StockChartPanel",
  component: StockChartPanel,
  parameters: { layout: "fullscreen" },
  args: { stockCode: "PLS" },
  decorators: [
    (Story) => (
      <div style={{ width: 920, height: 540 }} className="rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StockChartPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Combined: Story = {
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    await waitFor(() => expect(canvas.getByText(/corr/i)).toBeInTheDocument());
  },
};

export const ShortInterestView: Story = {
  args: { stockCode: "PLS", defaultView: "short" },
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
  },
};

export const PriceVolumeView: Story = {
  args: { stockCode: "PLS", defaultView: "price" },
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-chart="volume"]')).toBeTruthy(),
    );
  },
};

// Interaction-only: switching sub-tabs swaps the chart view.
export const SwitchViews: Story = {
  tags: ["no-visual"],
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    // Combined shows the correlation badge; Short Interest view hides it.
    await waitFor(() => expect(canvas.getByText(/corr/i)).toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", { name: "Short Interest" }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Short Interest" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() => expect(canvas.queryByText(/corr/i)).toBeNull());
    // Price & Volume view renders the volume path.
    await userEvent.click(canvas.getByRole("button", { name: "Price & Volume" }));
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-chart="volume"]')).toBeTruthy(),
    );
  },
};

export const Loading: Story = {
  beforeEach: () => {
    mocked(fetchStockDataClient).mockReturnValue(never());
    mocked(getHistoricalData).mockReturnValue(never());
  },
};

export const Error: Story = {
  beforeEach: () => {
    mocked(fetchStockDataClient).mockRejectedValue(new globalThis.Error("backend down"));
    mocked(getHistoricalData).mockRejectedValue(new globalThis.Error("backend down"));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByText(/unable to load chart data/i)).toBeInTheDocument(),
    );
  },
};

export const Empty: Story = {
  tags: ["no-visual"],
  beforeEach: () => {
    mocked(fetchStockDataClient).mockResolvedValue(
      create(TimeSeriesDataSchema, { productCode: "PLS", points: [] }),
    );
    mocked(getHistoricalData).mockResolvedValue([]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByText(/no chart data available/i)).toBeInTheDocument(),
    );
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  beforeEach: () => mockData("PLS", "3m"),
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 520 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
};
