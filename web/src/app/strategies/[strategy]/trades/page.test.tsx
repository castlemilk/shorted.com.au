import { readFileSync } from "fs";
import { join } from "path";

import { render, screen } from "@testing-library/react";

import StrategyTradesPage, { generateMetadata } from "./page";
import { mapBacktestRun } from "~/@/lib/strategies/map-backtest";
import { fixturePublishedRun } from "~/@/lib/strategies/__tests__/backtest-fixtures";

const getBacktestRun = jest.fn();
const bailOnEmptyRender = jest.fn(async () => undefined);
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
let captured: { runId: number; exitReasons: string[] } | null = null;

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));
jest.mock("~/app/actions/strategies/getBacktestRun", () => ({
  getBacktestRun: (...args: unknown[]) => getBacktestRun(...args),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
}));
jest.mock("./trades-island", () => ({
  TradesIsland: (props: { runId: number; exitReasons: string[] }) => {
    captured = props;
    return <div data-testid="trades-island" />;
  },
}));

const params = (strategy: string) => Promise.resolve({ strategy });

describe("the Trades tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    captured = null;
    getBacktestRun.mockResolvedValue(mapBacktestRun(fixturePublishedRun()));
  });

  it("is noindex, follow, and says so in its metadata", async () => {
    const meta = await generateMetadata({ params: params("crowded-short-breakout") });
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates?.canonical).toBe(
      "https://shorted.com.au/strategies/crowded-short-breakout/trades",
    );
  });

  it("shows the public trade summary to everyone, and hands the list's island the run and its exit reasons", async () => {
    const el = await StrategyTradesPage({ params: params("crowded-short-breakout") });
    render(el);
    expect(screen.getByRole("heading", { name: "Trade summary" })).toBeInTheDocument();
    expect(screen.getByText("Closed trades")).toBeInTheDocument();
    expect(screen.getByText("Exits by reason")).toBeInTheDocument();
    expect(screen.getByTestId("trades-island")).toBeInTheDocument();
    // Derived from the golden: its run id and the exit reasons its trade summary counts.
    const golden = JSON.parse(
      readFileSync(join(__dirname, "../../../../@/lib/strategies/__tests__/golden/backtest_run_crowded_short.json"), "utf8"),
    ).run as { identity: { runId: string | number }; tradeSummary: { exitsByReason: Record<string, number> } };
    // protojson writes int64 as a string; the mapper reads it as a number.
    expect(captured).toEqual({
      runId: Number(golden.identity.runId),
      exitReasons: Object.keys(golden.tradeSummary.exitsByReason).sort(),
    });
  });

  it("names the state in place of the trades when no run is published", async () => {
    getBacktestRun.mockResolvedValue(mapBacktestRun({ state: "run_required", stateReason: "Queued." }));
    const el = await StrategyTradesPage({ params: params("crowded-short-breakout") });
    render(el);
    expect(screen.getByText("Queued.")).toBeInTheDocument();
    expect(screen.queryByTestId("trades-island")).not.toBeInTheDocument();
  });

  it("bails the render, and says the trades are unavailable, when the read fails", async () => {
    getBacktestRun.mockResolvedValue(null);
    const el = await StrategyTradesPage({ params: params("crowded-short-breakout") });
    render(el);
    expect(bailOnEmptyRender).toHaveBeenCalled();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
  });
});
