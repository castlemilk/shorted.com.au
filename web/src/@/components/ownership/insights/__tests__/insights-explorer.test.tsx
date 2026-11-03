import { join } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";

jest.mock("d3-hierarchy", () =>
  jest.requireActual(join(__dirname, "..", "..", "..", "..", "..", "..", "node_modules", "d3-hierarchy", "dist", "d3-hierarchy.js")),
);
jest.mock("../use-element-size", () => ({
  useElementSize: () => [{ current: null }, { width: 900, height: 500 }],
}));
// The lazy chunks load the real charts at once in a test, as they do after the page's first paint.
jest.mock("../insights-charts-lazy", () => ({
  MarketMapLazy: jest.requireActual("../market-map").MarketMap,
  MoneyFlowLazy: jest.requireActual("../money-flow").MoneyFlow,
  PositionHeatmapLazy: jest.requireActual("../position-heatmap").PositionHeatmap,
}));

let mockSearchParams = new URLSearchParams("");
let mockSuspend = false;
jest.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (mockSuspend) throw new Promise<never>(() => undefined);
    return mockSearchParams;
  },
}));

import { InsightsExplorer } from "../insights-explorer";
import { insightsPage } from "~/@/lib/ownership/insights/__tests__/fixtures";
import { emptyInsightsPage, type InsightsPage } from "~/@/lib/ownership/insights/types";
import type { InsightsQueryInput } from "~/@/lib/ownership/insights/query";

const MARKET_COLOURS = /\b(?:text|bg|border|fill|stroke|ring)-(?:red|green|emerald|rose)-?\d*|#(?:ef4444|22c55e|f87171|4ade80)/i;

function setup(initial: InsightsPage = insightsPage(), answer: (q: InsightsQueryInput) => InsightsPage = () => insightsPage()) {
  const loadInsights = jest.fn(async (q: InsightsQueryInput = {}) => answer(q));
  const utils = render(<InsightsExplorer initial={initial} loadInsights={loadInsights as never} />);
  return { ...utils, loadInsights };
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
  mockSuspend = false;
  window.history.replaceState(null, "", "/ownership/insights");
});

describe("InsightsExplorer", () => {
  it("draws the default view as the server fallback, every figure in a table, no request", () => {
    mockSuspend = true;
    const { loadInsights, container } = setup();
    expect(screen.getByRole("heading", { name: "Market map" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Position changes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(screen.getByText("The market map as a table: every sector")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Window start" })).toBeDisabled();
    expect(loadInsights).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toMatch(MARKET_COLOURS);
    expect(container.textContent).not.toMatch(/—|\bsold\b|\bsale\b|index ETF/i);
  });

  it("asks for nothing on the default link, and for the linked window otherwise", async () => {
    const quiet = setup();
    expect(quiet.loadInsights).not.toHaveBeenCalled();
    quiet.unmount();

    mockSearchParams = new URLSearchParams("from=2026-09-01&to=2026-10-01");
    const { loadInsights } = setup();
    await waitFor(() => expect(loadInsights).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-10-01", part: "all" }));
  });

  it("asks again for the linked window under StrictMode's second mount", async () => {
    mockSearchParams = new URLSearchParams("from=2026-09-01&to=2026-10-01");
    const answer = insightsPage();
    answer.window = { ...answer.window, from: "2026-09-01", to: "2026-10-01" };
    const loadInsights = jest.fn(async () => answer);
    render(
      <StrictMode>
        <InsightsExplorer initial={insightsPage()} loadInsights={loadInsights as never} />
      </StrictMode>,
    );
    expect(await screen.findByText(/^Window$/, { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("slider", { name: "Window start" })).toHaveAttribute("aria-valuetext", "2026-09-01"));
    expect(loadInsights.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("opens a stock's panel from the map, asks for its part and writes the link", async () => {
    const detail = insightsPage().stocks[0]!;
    const { loadInsights } = setup(insightsPage(), (q) =>
      q.part === "stock"
        ? {
            ...emptyInsightsPage({ from: "", to: "", sector: null, stock: "BHP" }, "stock"),
            ok: true,
            stockDetail: {
              code: "BHP",
              name: detail.name,
              sector: "Materials",
              disclosedPct: 11.4,
              byKind: [{ kind: "index_manager", pct: 5.1, holders: 1 }],
              holders: 2,
              latestNoticeDate: "2026-10-07",
              funds: [],
              notices: [],
            },
          }
        : insightsPage(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^BHP, BHP Group/ }));
    await waitFor(() =>
      expect(loadInsights).toHaveBeenCalledWith({ from: "2026-08-03", to: "2026-10-31", sector: null, stock: "BHP", part: "stock" }),
    );
    const panel = await screen.findByRole("region", { name: /BHP/ });
    expect(within(panel).getByRole("link", { name: "BHP's full register" })).toHaveAttribute("href", "/ownership/stocks/BHP");
    expect(within(panel).getByText(/disclosed by 2 holders, what the notices disclose, not a share of the company/)).toBeInTheDocument();
    expect(window.location.search).toBe("?stock=BHP");
  });

  it("zooms into a sector, asks for its full list, and goes back up", async () => {
    const { loadInsights } = setup();
    fireEvent.click(screen.getByTitle("Open Materials"));
    await waitFor(() =>
      expect(loadInsights).toHaveBeenCalledWith({ from: "2026-08-03", to: "2026-10-31", sector: "Materials", stock: "", part: "sector" }),
    );
    expect(window.location.search).toBe("?sector=Materials");
    expect(screen.getByText("The market map as a table: Materials")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Market map level" })).getByRole("button", { name: "All sectors" }));
    expect(window.location.search).toBe("");
  });

  it("drills a heatmap cell into its bucket", async () => {
    const { loadInsights } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Materials, 2026-09-28 to 2026-10-04/ }));
    await waitFor(() =>
      expect(loadInsights).toHaveBeenCalledWith({ from: "2026-09-28", to: "2026-10-04", sector: "Materials", stock: "", part: "sector" }),
    );
    expect(await screen.findByRole("heading", { name: /Materials, 2026-09-28 to 2026-10-04/ })).toBeInTheDocument();
  });

  it("switches the measure, writes it into the link and recaptions the views", () => {
    setup();
    fireEvent.click(screen.getByRole("radio", { name: /Disclosed stakes/ }));
    expect(window.location.search).toBe("?m=disclosed");
    expect(screen.getAllByText(/what the notices disclose, not a share of the company/).length).toBeGreaterThan(0);
  });

  it("states that one file per fund compares nothing, and still moves on notices", () => {
    const single = insightsPage();
    single.window = { ...single.window, fundsCompared: 0, startFilesFrom: "", startFilesTo: "" };
    setup(single);
    expect(screen.getByText(/No index fund has two files in this window, so every change is n\/a/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 funds compared, 4 notices in the window/)).toBeInTheDocument();
  });

  it("draws an outage as our end, never as an empty register", async () => {
    const { loadInsights } = setup(emptyInsightsPage({ from: "", to: "", sector: null, stock: "" }, "all"), () =>
      emptyInsightsPage({ from: "", to: "", sector: null, stock: "" }, "all"),
    );
    await waitFor(() => expect(loadInsights).toHaveBeenCalled());
    expect(await screen.findByText(/could not be read just now\. Nothing is missing from the register: this is our end\./)).toBeInTheDocument();
  });

  it("plays the window forward one step per answer", async () => {
    jest.useFakeTimers();
    try {
      const start = insightsPage();
      start.window = { ...start.window, from: "2026-07-01", to: "2026-09-28" };
      const { loadInsights } = setup(start, (q) => {
        const next = insightsPage();
        next.window = { ...next.window, from: String(q.from), to: String(q.to) };
        return next;
      });
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1700);
      });
      expect(loadInsights).toHaveBeenCalledWith({ from: "2026-07-08", to: "2026-10-05", part: "all" });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      const calls = loadInsights.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(loadInsights.mock.calls.length).toBe(calls);
    } finally {
      jest.useRealTimers();
    }
  });
});
