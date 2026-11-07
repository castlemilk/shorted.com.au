import { render, screen, within } from "@testing-library/react";

import StrategyBacktestPage, { generateMetadata, revalidate } from "./page";
import { mapBacktestRun, type BacktestRunInput } from "~/@/lib/strategies/map-backtest";
import { fixturePublishedRun } from "~/@/lib/strategies/__tests__/backtest-fixtures";

const getBacktestRun = jest.fn();
const bailOnEmptyRender = jest.fn(async () => undefined);
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
let searchParams = new URLSearchParams("");

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
  useSearchParams: () => searchParams,
}));
jest.mock("~/app/actions/strategies/getBacktestRun", () => ({
  getBacktestRun: (...args: unknown[]) => getBacktestRun(...args),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
// The universe is the registry's own StrategyMetadata.universe, read with the catalogue.
const getStrategies = jest.fn(async () => ({
  strategies: [{ id: "crowded-short-breakout", metadata: { universe: "ASX ordinary shares" } }],
  regime: null,
}));
jest.mock("~/app/actions/getStrategies", () => ({
  getStrategies: () => getStrategies(),
}));
jest.mock("~/app/actions/strategies/backtestSeries", () => ({
  loadBacktestSeries: jest.fn(async () => null),
}));
// The chart measures its width; under test the width is fixed so the SVG draws.
jest.mock("@/components/charts/parent-size", () => ({
  ParentSize: ({ children }: { children: (s: { width: number; height: number }) => React.ReactNode }) =>
    children({ width: 720, height: 0 }),
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
}));
// The panel's props are the client's payload: captured here, so the test asserts what the
// client receives (not the fixture's shape). The panel itself is the real one.
jest.mock("./backtest-panel", () => {
  const actual = jest.requireActual("./backtest-panel");
  return { ...actual, BacktestPanel: jest.fn(actual.BacktestPanel) };
});
// The chart is client-only in production (a lazy chunk); in jest it is the real
// chart, drawn synchronously, so its markup is under test.
jest.mock("~/@/components/strategies/backtest-chart-loader", () => ({
  BacktestChart: jest.requireActual("~/@/components/strategies/backtest-chart").BacktestChart,
}));

const params = (strategy: string) => Promise.resolve({ strategy });

/** A run as the API serves it, through the mapper the action uses. */
function runOf(input: Partial<BacktestRunInput>) {
  return mapBacktestRun({ ...fixturePublishedRun(), ...input });
}

async function renderPage(slug = "crowded-short-breakout") {
  const el = await StrategyBacktestPage({ params: params(slug) });
  return render(el);
}

describe("the Backtest tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams("");
    getBacktestRun.mockResolvedValue(runOf({}));
  });

  it("is an ISR page, with the 60-second bail on a failed read", () => {
    expect(revalidate).toBe(3600);
  });

  it("renders a published run from its fixture: the chart, the tables, the assumptions and the callouts", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { name: "Growth of A$100,000" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Monthly returns" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Coverage and survivorship" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sensitivity runs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Execution assumptions" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Execution recipe chosen by Shorted to test the screen; the author's own entries and exits differ.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Editing rules creates a new variant and requires a new backtest.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inspect trades" })).toHaveAttribute(
      "href",
      "/strategies/crowded-short-breakout/trades",
    );
    expect(screen.getByRole("link", { name: "Full recipe & data coverage →" })).toHaveAttribute("href", "#coverage");
  });

  it("opens on the since-May-2019 window and names the others as the four windows of 5.8", async () => {
    await renderPage();
    const group = screen.getByRole("group", { name: "Window" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "Since May 2019",
      "Since 2023",
      "Last 12 months",
      "Live since freeze",
    ]);
    expect(within(group).getByRole("radio", { name: "Since May 2019" })).toBeChecked();
  });

  it("draws the recorded span and the frozen date on the chart", async () => {
    const { container } = await renderPage();
    expect(container.querySelector("[data-recorded-band]")).not.toBeNull();
    expect(container.querySelector("[data-frozen-marker]")).not.toBeNull();
    expect(screen.getByText("Rules frozen 2 Oct 2026", { selector: "text" })).toBeInTheDocument();
  });

  it("shows the window the reader asked for in the URL, and its own summary", async () => {
    searchParams = new URLSearchParams("window=live");
    const { container } = await renderPage();
    const summary = container.querySelector('[data-window-summary="live"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain("Live since freeze");
  });

  it("prints the run identity as one line that opens the full identity", async () => {
    const { container } = await renderPage();
    const identity = container.querySelector("[data-run-identity]");
    expect(identity?.textContent).toContain("Run 8 Nov 2026");
    expect(identity?.textContent).toContain("prices to 6 Nov");
  });

  it("prints the strategy's universe beside the window controls, from the registry", async () => {
    await renderPage();
    expect(screen.getByText("ASX ordinary shares")).toBeInTheDocument();
  });

  it("prints the data-quality counts the run serves, as fields", async () => {
    await renderPage();
    expect(screen.getAllByText("Delisting exits").length).toBeGreaterThan(0);
    expect(screen.getByText("Ex-dates credited in cash")).toBeInTheDocument();
  });

  it("starts the recorded band at the track's own first session, not the freeze", async () => {
    const { container } = await renderPage();
    expect(container.querySelector("[data-recorded-band]")?.textContent).toContain("Recorded since 5 Oct 2026");
  });

  it("prints the honesty chips: in-sample with the freeze date, the coverage and the costs", async () => {
    await renderPage();
    expect(screen.getByText("In-sample backtest · rules frozen 2 Oct 2026")).toBeInTheDocument();
    expect(screen.getAllByText(/Coverage \(qualifying ≥ 5% short\) 64% \(2019\) → 96% \(2025\)/).length).toBeGreaterThan(0);
    expect(screen.getByText("Hypothetical · after costs")).toBeInTheDocument();
  });

  it("chips a sensitivity that flips the sign as fragile, in words", async () => {
    await renderPage();
    expect(screen.getAllByText("Fragile to publication timing").length).toBeGreaterThan(0);
  });

  it("prints the survivorship statement the run carries, never a copy of its own", async () => {
    await renderPage();
    expect(screen.getByText(/these results flatter the strategy, most in the earlier years/)).toBeInTheDocument();
  });

  it("names the approximate run's chip when the run is approximate", async () => {
    getBacktestRun.mockResolvedValue(runOf({ state: "approximate" }));
    await renderPage();
    expect(screen.getByText(/Approximate: fundamentals assumed known 2 months after period end/)).toBeInTheDocument();
  });

  it("keeps the payload within the design's 500 series points", async () => {
    await renderPage();
    const run = await getBacktestRun.mock.results[0]?.value;
    expect(run.series.length).toBeLessThanOrEqual(500);
  });

  describe("the states other than a published run", () => {
    it("run_required: prints the API's own reason, never the fundamentals sentence, and is noindex", async () => {
      getBacktestRun.mockResolvedValue(
        mapBacktestRun({
          state: "run_required",
          stateReason: "This version has no recipe yet, so no run can be published.",
          liveVersion: { strategyId: "crowded-short-breakout", label: "v1", rulesHash: "3f9a1c2e" + "b".repeat(56) },
        }),
      );
      await renderPage();
      expect(screen.getByText("This version has no recipe yet, so no run can be published.")).toBeInTheDocument();
      expect(screen.queryByText(/point-in-time/)).not.toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Window" })).not.toBeInTheDocument();
      const meta = await generateMetadata({ params: params("crowded-short-breakout") });
      expect(meta.robots).toEqual({ index: false, follow: true });
    });

    it("run_required without a reason: the queued copy, with the rules' short hash", async () => {
      getBacktestRun.mockResolvedValue(
        mapBacktestRun({
          state: "run_required",
          liveVersion: { strategyId: "crowded-short-breakout", label: "v1", rulesHash: "3f9a1c2e" + "b".repeat(56) },
        }),
      );
      await renderPage();
      expect(
        screen.getByText(
          "No completed backtest for rules v1 (3f9a1c2e) yet. It is queued; results usually appear within the hour.",
        ),
      ).toBeInTheDocument();
    });

    it("not_computable with a measured label: the headline names it, and the body explains why", async () => {
      getBacktestRun.mockResolvedValue(
        mapBacktestRun({ state: "not_computable", fiscalLabel: "FY2024", computableFrom: "2026-09-30" }),
      );
      await renderPage("zanger-breakout");
      expect(
        screen.getByText(
          "Not computable before FY2024. From FY2024 a test is possible only by assuming when results were known and using restated figures; it is not published.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/This strategy's core rules need company fundamentals/)).toBeInTheDocument();
      const meta = await generateMetadata({ params: params("zanger-breakout") });
      expect(meta.robots).toEqual({ index: false, follow: true });
    });

    it("not_computable without a label: the measured share, and no invented year", async () => {
      getBacktestRun.mockResolvedValue(
        mapBacktestRun({ state: "not_computable", computableSharePct: 31.4, hasComputableShare: true }),
      );
      await renderPage("canslim");
      expect(
        screen.getByText("Not computable: needs point-in-time fundamentals (fundamentals for 31% of the universe)."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Not computable before/)).not.toBeInTheDocument();
    });

    it("running: says so from the start time", async () => {
      getBacktestRun.mockResolvedValue(mapBacktestRun({ state: "running", runningSince: "2026-11-08T14:02:00Z" }));
      await renderPage();
      expect(screen.getByText("Running since 14:02 UTC")).toBeInTheDocument();
    });
  });

  it("is indexable for a published run with 60 sessions or more, and sets no robots key", async () => {
    const meta = await generateMetadata({ params: params("crowded-short-breakout") });
    expect(meta).not.toHaveProperty("robots");
    expect(meta.title).toBe("Backtest: Crowded-Short Breakout");
  });

  it("is noindex, follow for a published run with fewer than 60 sessions", async () => {
    const short = fixturePublishedRun();
    short.windows = short.windows?.map((w) => (w.window === "since_2019_05" ? { ...w, sessions: 59 } : w));
    getBacktestRun.mockResolvedValue(mapBacktestRun(short));
    const meta = await generateMetadata({ params: params("crowded-short-breakout") });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it("bails the render, and says the tab is unavailable, when the read fails", async () => {
    getBacktestRun.mockResolvedValue(null);
    await renderPage();
    expect(bailOnEmptyRender).toHaveBeenCalled();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
  });

  it("404s a strategy the registry does not hold, without reading the API", async () => {
    await expect(StrategyBacktestPage({ params: params("not-a-strategy") })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getBacktestRun).not.toHaveBeenCalled();
  });
});

describe("the Backtest page's client payload", () => {
  it("passes at most 500 series points and a small serialisable payload, the tables staying on the server", async () => {
    getBacktestRun.mockResolvedValue(runOf({}));
    await renderPage();
    const { BacktestPanel } = await import("./backtest-panel");
    const panelProps = (BacktestPanel as unknown as jest.Mock).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(panelProps).toBeDefined();
    const servedSeries = panelProps.servedSeries as unknown[];
    expect(servedSeries.length).toBeLessThanOrEqual(500);
    // The tables (monthly, annual, recipe, data quality) are not in the client's props; the
    // serialisable part, without the server-rendered slots, stays under the budget.
    const { main: _main, sidebar: _sidebar, identity: _identity, ...serialisable } = panelProps;
    expect(JSON.stringify(serialisable).length).toBeLessThan(120_000);
    expect(panelProps).not.toHaveProperty("run");
  });
});
