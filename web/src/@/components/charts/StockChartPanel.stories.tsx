import { useState, type ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within, userEvent } from "storybook/test";
import { create } from "@bufbuild/protobuf";
import { StockChartPanel, type StockChartPanelProps } from "./StockChartPanel";
import { StockChartPanelSkeleton } from "./stock-chart-section";
import { resetChartPrefsForTests } from "./chart-prefs";
import { readoutStripHeight } from "./chart-readout";
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
    // `bare` stories are laid out at a real page width by their own decorator.
    // The frame has a width and no height: the panel's height depends on the
    // viewport (a 360 or 420px box, one row of controls or a stack), and a
    // frame that hugs its content is right for every runner. 1000px is a panel
    // of 968, past the 960 its one row of controls needs.
    (Story, { parameters }) =>
      parameters.bare ? (
        <Story />
      ) : (
        <div style={{ width: 1000 }} className="rounded-lg border bg-background p-4">
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
  // The visual suite renders every story at 1280px, whatever its viewport
  // parameter says, and the panel arranges its controls by the viewport: a 360px
  // frame at 1280px is the desktop row squeezed into a phone's width, not the
  // phone layout. `Phone` below checks the phone layout in the vitest browser,
  // where the viewport is the story's own. Here it is a smoke test.
  tags: ["no-visual"],
  // Its own 360px frame, not inside the default one: a 1000px frame around a
  // phone-width panel makes the page scroll sideways at a phone viewport.
  parameters: { bare: true, viewport: { defaultViewport: "mobile1" } },
  beforeEach: () => mockData("PLS", "3m"),
  decorators: [
    (Story) => (
      <div style={{ width: 360 }} className="rounded-lg border bg-background p-2">
        <Story />
      </div>
    ),
  ],
};

// ── Layout, in a real browser ───────────────────────────────────────────────
// The controls change arrangement at `xl` (1280px) and the chart box its height
// at `sm` (640px): both answer to the viewport, and the vitest browser runs a
// story at the viewport it names (its `viewport` global). So these stories lay
// the panel out at real page widths (the page pads 2rem each side), with the
// skeleton the page shows while it loads stacked above it. The two take exactly
// the same room, so a panel that has loaded lands on the footprint the skeleton
// held.
const VIEWPORTS = {
  phone: { name: "Phone 390x900", styles: { width: "390px", height: "900px" }, type: "mobile" },
  tablet: { name: "Tablet 768x1024", styles: { width: "768px", height: "1024px" }, type: "tablet" },
  desktop: { name: "Desktop 1280x900", styles: { width: "1280px", height: "900px" }, type: "desktop" },
} as const;

const page = (Story: ComponentType) => (
  <div className="px-8 py-4">
    <Story />
  </div>
);

function SkeletonAndPanel(props: StockChartPanelProps) {
  return (
    <>
      <div data-testid="skeleton-frame">
        <StockChartPanelSkeleton />
      </div>
      <div data-testid="panel-frame" className="mt-8">
        <StockChartPanel {...props} />
      </div>
    </>
  );
}

const rect = (el: Element) => el.getBoundingClientRect();
const GAP = 12;

function parts(canvasElement: HTMLElement) {
  const q = (selector: string) => canvasElement.querySelector<HTMLElement>(selector)!;
  const frame = q('[data-testid="panel-frame"]');
  const panel = frame.firstElementChild as HTMLElement;
  const area = (name: string) =>
    panel.querySelector<HTMLElement>(`[class*="grid-area:${name}"]`)!;
  return {
    skeleton: q('[data-testid="skeleton-frame"]'),
    frame,
    panel,
    view: area("view"),
    toggles: area("toggles"),
    period: area("period"),
    embed: area("embed"),
    chart: area("chart"),
  };
}

const drawn = (canvasElement: HTMLElement) =>
  waitFor(() =>
    expect(canvasElement.querySelector("[data-chart-container]")).toBeTruthy(),
  );

/** The panel takes the room the skeleton above it took. */
function expectSameFootprint(canvasElement: HTMLElement) {
  const { skeleton, frame } = parts(canvasElement);
  expect(rect(frame).height).toBeCloseTo(rect(skeleton).height, 0);
}

function expectNoPageOverflow() {
  const root = document.documentElement;
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
}

/** The buttons of a control, in order. */
const buttonsOf = (el: HTMLElement) => within(el).getAllByRole("button");

// The toggles row has no height to spare, so a classic scrollbar would cut its
// buttons. The runner's own scrollbars are hidden, which is why this reads the
// computed style and not a height; it also proves the arbitrary class became
// CSS at all.
const expectScrollbarHidden = (toggles: HTMLElement) =>
  expect(getComputedStyle(toggles).getPropertyValue("scrollbar-width")).toBe("none");

// Below xl, a panel is a stack: the view control and the embed button on a 40px
// row, the chart box, then the period control across the full width, then the
// toggles on a 36px row, 12px apart. Targets are 40px.
async function expectStack(canvasElement: HTMLElement, boxHeight: number) {
  const { panel, view, toggles, period, embed, chart } = parts(canvasElement);

  expect(rect(view).height).toBeCloseTo(40, 0);
  expect(rect(embed).height).toBeCloseTo(40, 0);
  expect(rect(view).top).toBeCloseTo(rect(panel).top, 0);
  expect(rect(chart).top).toBeCloseTo(rect(view).bottom + GAP, 0);
  expect(rect(chart).height).toBeCloseTo(boxHeight, 0);
  expect(rect(period).top).toBeCloseTo(rect(chart).bottom + GAP, 0);
  expect(rect(period).height).toBeCloseTo(40, 0);
  expect(rect(period).width).toBeCloseTo(rect(panel).width, 0);
  expect(rect(toggles).top).toBeCloseTo(rect(period).bottom + GAP, 0);
  expect(rect(toggles).height).toBeCloseTo(36, 0);
  expect(rect(panel).height).toBeCloseTo(40 + GAP + boxHeight + GAP + 40 + GAP + 36, 0);

  // Thumb-sized targets, and the six periods evenly spaced inside the page.
  const embedButton = within(embed).getByRole("button");
  for (const b of [...buttonsOf(view), ...buttonsOf(period), embedButton]) {
    expect(rect(b).height).toBeGreaterThanOrEqual(39.5);
  }
  expect(rect(embedButton).width).toBeGreaterThanOrEqual(39.5);
  expect(rect(embedButton).right).toBeCloseTo(rect(panel).right, 0);
  const periods = buttonsOf(period).map(rect);
  expect(periods).toHaveLength(6);
  for (const box of periods) {
    expect(box.width).toBeCloseTo(periods[0]!.width, 0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  }

  // Nothing is cut off or sent sideways.
  expect(toggles.scrollWidth).toBeLessThanOrEqual(toggles.clientWidth);
  expectScrollbarHidden(toggles);
  expectNoPageOverflow();
  expectSameFootprint(canvasElement);
}

export const Phone: Story = {
  name: "Phone (390px)",
  tags: ["no-visual"], // the visual suite does not honour a story's viewport
  parameters: { bare: true, viewport: { options: VIEWPORTS } },
  globals: { viewport: { value: "phone", isRotated: false } },
  decorators: [page],
  beforeEach: () => mockData("PLS", "1y"),
  render: (args) => <SkeletonAndPanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(window.matchMedia("(min-width: 640px)").matches).toBe(false);
    await drawn(canvasElement);
    await expectStack(canvasElement, 360);

    // The toggles are 36px, and the chart is the box: a strip for the two
    // series of this view and the plot under it.
    for (const name of ["SMA 20", "Divergence"]) {
      expect(rect(canvas.getByRole("button", { name })).height).toBeCloseTo(36, 0);
    }
    const { chart } = parts(canvasElement);
    const container = canvasElement.querySelector<HTMLElement>("[data-chart-container]")!;
    const strip = container.querySelector<HTMLElement>("[data-chart-readout]")!;
    expect(rect(container).height).toBeCloseTo(360, 0);
    expect(rect(container).width).toBeCloseTo(rect(chart).width, 0);
    expect(rect(strip).height).toBeCloseTo(readoutStripHeight(rect(container).width, 2), 0);

    // The chart follows its box when the box changes height, as it does across
    // the `sm` breakpoint: the plot gives way, the strip does not.
    chart.style.height = "300px";
    await waitFor(() => expect(rect(container).height).toBeCloseTo(300, 0));
    expect(rect(strip).height).toBeCloseTo(readoutStripHeight(rect(container).width, 2), 0);
    chart.style.height = "";
    await waitFor(() => expect(rect(container).height).toBeCloseTo(360, 0));

    // A period can be chosen, and the button says so.
    await userEvent.click(canvas.getByRole("button", { name: /^6m$/i }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^6m$/i })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(canvas.getByRole("button", { name: /^1y$/i })).toHaveAttribute("aria-pressed", "false");

    // A view with no toggles keeps their row: the panel does not change height.
    const before = rect(parts(canvasElement).panel).height;
    await userEvent.click(canvas.getByRole("button", { name: "Short" }));
    await waitFor(() => expect(canvas.queryByRole("button", { name: "SMA 20" })).toBeNull());
    expect(rect(parts(canvasElement).panel).height).toBeCloseTo(before, 0);
    expect(rect(parts(canvasElement).toggles).height).toBeCloseTo(36, 0);
    expectSameFootprint(canvasElement);
  },
};

// Short interest opens on the short view, which has no toggle at all. The row
// the toggles would be on is still there, as it is in the skeleton.
export const PhoneShortView: Story = {
  name: "Phone, short view (empty toggles row)",
  tags: ["no-visual"],
  args: { defaultView: "short" },
  parameters: { bare: true, viewport: { options: VIEWPORTS } },
  globals: { viewport: { value: "phone", isRotated: false } },
  decorators: [page],
  beforeEach: () => mockData("PLS", "1y"),
  render: (args) => <SkeletonAndPanel {...args} />,
  play: async ({ canvasElement }) => {
    await drawn(canvasElement);
    expect(parts(canvasElement).toggles.children).toHaveLength(0);
    await expectStack(canvasElement, 360);
  },
};

// A tablet is past sm (a 420px box) and short of xl, and 704px wide: the stack
// holds, with every toggle in reach. In the one row the toggles had 37px of 291.
export const Tablet: Story = {
  name: "Tablet (768px)",
  tags: ["no-visual"],
  parameters: { bare: true, viewport: { options: VIEWPORTS } },
  globals: { viewport: { value: "tablet", isRotated: false } },
  decorators: [page],
  beforeEach: () => mockData("PLS", "1y"),
  render: (args) => <SkeletonAndPanel {...args} />,
  play: async ({ canvasElement }) => {
    expect(window.matchMedia("(min-width: 640px)").matches).toBe(true);
    expect(window.matchMedia("(min-width: 1280px)").matches).toBe(false);
    await drawn(canvasElement);
    await expectStack(canvasElement, 420);
  },
};

// From xl the controls are the one row they were: today's compact sizes, the
// toggles right-aligned before the period control, a 32px row over a 420px box.
export const Desktop: Story = {
  name: "Desktop (1280px)",
  tags: ["no-visual"],
  parameters: { bare: true, viewport: { options: VIEWPORTS } },
  globals: { viewport: { value: "desktop", isRotated: false } },
  decorators: [page],
  beforeEach: () => mockData("PLS", "1y"),
  render: (args) => <SkeletonAndPanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(window.matchMedia("(min-width: 1280px)").matches).toBe(true);
    await drawn(canvasElement);
    const { panel, view, toggles, period, embed, chart } = parts(canvasElement);

    // One row of 32px, then the gap, then the box.
    const rowBottom = rect(panel).top + 32;
    expect(rect(chart).top).toBeCloseTo(rowBottom + GAP, 0);
    expect(rect(chart).height).toBeCloseTo(420, 0);
    expect(rect(panel).height).toBeCloseTo(32 + GAP + 420, 0);
    for (const control of [view, toggles, period, embed]) {
      expect(rect(control).top).toBeGreaterThanOrEqual(rect(panel).top - 0.5);
      expect(rect(control).bottom).toBeLessThanOrEqual(rowBottom + 0.5);
    }

    // Left to right: view, toggles (against the period control), period, embed.
    const lastToggle = buttonsOf(toggles).at(-1)!;
    expect(rect(view).right).toBeLessThanOrEqual(rect(buttonsOf(toggles)[0]!).left);
    expect(rect(lastToggle).right).toBeLessThanOrEqual(rect(period).left);
    expect(rect(lastToggle).right).toBeGreaterThan(rect(period).left - 24);
    expect(rect(period).right).toBeLessThanOrEqual(rect(embed).left);
    expect(rect(embed).right).toBeCloseTo(rect(panel).right, 0);
    expect(toggles.scrollWidth).toBeLessThanOrEqual(toggles.clientWidth);
    expectScrollbarHidden(toggles);

    // Today's sizes: a 24px button in a 30px pill.
    expect(rect(canvas.getByRole("button", { name: /^1y$/i })).height).toBeCloseTo(24, 0);
    expect(rect(period).height).toBeCloseTo(30, 0);
    expectNoPageOverflow();
    expectSameFootprint(canvasElement);
  },
};

// ── Settings survive a tab switch ───────────────────────────────────────────
// The stock page mounts a panel on Overview and another on Short interest and
// none on Financials. This stands in for it: the choices the visitor made are
// carried between the mounts by chart-prefs, in a real browser.
type Tab = "overview" | "short-interest" | "financials";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview tab" },
  { id: "short-interest", label: "Short interest tab" },
  { id: "financials", label: "Financials tab" },
];

function TabbedPages({ stockCode }: StockChartPanelProps) {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div>
      <nav aria-label="Stock sections" className="mb-4 flex gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <StockChartPanel stockCode={stockCode} prefsKey={`${stockCode}:overview`} />
      )}
      {tab === "short-interest" && (
        <StockChartPanel
          stockCode={stockCode}
          prefsKey={`${stockCode}:short-interest`}
          defaultView="short"
        />
      )}
      {tab === "financials" && <p>Financials: no chart here.</p>}
    </div>
  );
}

export const RemembersSettings: Story = {
  name: "Remembers settings across tabs",
  tags: ["no-visual"], // interaction-only
  parameters: { bare: true },
  decorators: [page],
  beforeEach: () => {
    resetChartPrefsForTests();
    mockData("PLS", "1y");
    // The store outlives a mount: leave it empty for the next story.
    return () => resetChartPrefsForTests();
  },
  render: (args) => <TabbedPages {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tab = (name: string) => canvas.getByRole("button", { name });
    const period = (label: RegExp) => canvas.getByRole("button", { name: label });
    await drawn(canvasElement);

    // On Overview: 6M, the Price & Volume view and SMA 20.
    await userEvent.click(period(/^6m$/i));
    await userEvent.click(canvas.getByRole("button", { name: "Price & Volume" }));
    await userEvent.click(canvas.getByRole("button", { name: "SMA 20" }));

    // Financials has no chart to keep a setting in.
    await userEvent.click(tab("Financials tab"));
    expect(canvasElement.querySelector("[data-chart-container]")).toBeNull();
    expect(canvas.queryByRole("group", { name: "Period" })).toBeNull();

    // Back on Overview it is as the visitor left it.
    await userEvent.click(tab("Overview tab"));
    expect(period(/^6m$/i)).toHaveAttribute("aria-pressed", "true");
    expect(period(/^1y$/i)).toHaveAttribute("aria-pressed", "false");
    expect(canvas.getByRole("button", { name: "Price & Volume" })).toHaveAttribute("aria-pressed", "true");
    expect(canvas.getByRole("button", { name: "SMA 20" })).toHaveAttribute("aria-pressed", "true");

    // Short interest opens on its own view, with the stock's period.
    await userEvent.click(tab("Short interest tab"));
    expect(canvas.getByRole("button", { name: "Short Interest" })).toHaveAttribute("aria-pressed", "true");
    expect(period(/^6m$/i)).toHaveAttribute("aria-pressed", "true");

    // A period chosen there goes back with the visitor; the view does not.
    await userEvent.click(period(/^1m$/i));
    await userEvent.click(tab("Overview tab"));
    expect(period(/^1m$/i)).toHaveAttribute("aria-pressed", "true");
    expect(canvas.getByRole("button", { name: "Price & Volume" })).toHaveAttribute("aria-pressed", "true");
  },
};
