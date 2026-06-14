import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within, userEvent } from "storybook/test";
import { create } from "@bufbuild/protobuf";
import { StockPriceShortChart } from "./StockPriceShortChart";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { getHistoricalData } from "~/@/lib/stock-data-service";
import {
  timeSeriesDataFixture,
  historicalDataFixture,
} from "~/@/mocks/fixtures/short-data";
import { TimeSeriesDataSchema } from "~/gen/stocks/v1alpha1/stocks_pb";

const never = <T,>() => new Promise<T>(() => undefined);

const mockData = (code: string, period: string) => {
  mocked(fetchStockDataClient).mockResolvedValue(
    timeSeriesDataFixture(code, period),
  );
  mocked(getHistoricalData).mockResolvedValue(historicalDataFixture(code, period));
};

const meta = {
  title: "Charts/StockPriceShortChart",
  component: StockPriceShortChart,
  parameters: { layout: "fullscreen" },
  args: { stockCode: "PLS" },
  decorators: [
    (Story) => (
      <div style={{ width: 900, height: 520 }} className="rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StockPriceShortChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Renders the combined chart (an svg appears once data resolves).
    await waitFor(() =>
      expect(canvasElement.querySelector("svg")).toBeTruthy(),
    );
    // Correlation badge is computed from merged price+short.
    await waitFor(() => expect(canvas.getByText(/corr/i)).toBeInTheDocument());
  },
};

export const PeriodSwitch: Story = {
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    // Switch period — triggers a refetch; chart still renders.
    await userEvent.click(canvas.getByRole("button", { name: "3m" }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "3m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
  },
};

export const ToggleSeries: Story = {
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    // Toggling "Short %" off removes its series; the chart keeps rendering price.
    await userEvent.click(canvas.getByRole("button", { name: /short %/i }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /short %/i })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  },
};

export const WithMovingAverage: Story = {
  beforeEach: () => mockData("PLS", "1y"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector("svg")).toBeTruthy());
    await userEvent.click(canvas.getByRole("button", { name: /sma 20/i }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /sma 20/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
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
  beforeEach: () => {
    mocked(fetchStockDataClient).mockResolvedValue(
      create(TimeSeriesDataSchema, { productCode: "PLS", points: [] }),
    );
    mocked(getHistoricalData).mockResolvedValue([]);
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement).toBeTruthy()); // no crash
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  beforeEach: () => mockData("PLS", "3m"),
  decorators: [
    (Story) => (
      <div style={{ width: 360, height: 480 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
};
