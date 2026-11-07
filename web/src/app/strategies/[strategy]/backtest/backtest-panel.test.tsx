import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BacktestPanel, disclosureLines, parseWindow, type BacktestPanelProps } from "./backtest-panel";
import { HYPOTHETICAL_COPY, RETURN_BASIS_COPY } from "~/@/lib/strategies/backtest-copy";
import { mapBacktestRun, mapSeriesPoint, type BacktestWindowView, type SeriesPointView } from "~/@/lib/strategies/map-backtest";
import { orderedWindows } from "~/@/lib/strategies/backtest-windows";
import { fixturePublishedRun } from "~/@/lib/strategies/__tests__/backtest-fixtures";

// The chart is replaced by a probe that records what the panel asked it to draw.
const chartProps: Array<{ windowLabel: string; points: number }> = [];
jest.mock("~/@/components/strategies/backtest-chart-loader", () => ({
  BacktestChart: (props: { windowLabel: string; series: unknown[] }) => {
    chartProps.push({ windowLabel: props.windowLabel, points: props.series.length });
    return <div data-testid="chart" data-window={props.windowLabel} />;
  },
}));

const loadBacktestSeries = jest.fn();
jest.mock("~/app/actions/strategies/backtestSeries", () => ({
  loadBacktestSeries: (...args: unknown[]) => loadBacktestSeries(...args),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

const run = mapBacktestRun(fixturePublishedRun());
const windows: BacktestWindowView[] = orderedWindows(run.windows);
// The window the reader picks is served its own series: a shorter one, so the chart must change.
const since2023Series: SeriesPointView[] = run.series
  .filter((p) => p.date >= "2023-01-03")
  .map((p) => mapSeriesPoint({ ...p, equity: p.equity + 1 }));

function props(over: Partial<BacktestPanelProps> = {}): BacktestPanelProps {
  return {
    strategyId: "crowded-short-breakout",
    urlWindow: "",
    served: "since_2019_05",
    servedSeries: run.series,
    windows,
    universeLabel: "ASX ordinary shares",
    universeTitle: "ASX ordinary shares",
    chips: [],
    frozenChip: "In-sample backtest · rules frozen 2 Oct 2026",
    recordedChip: "Recorded since 5 Oct 2026",
    disclosures: ["Hypothetical results from rules applied to historical data, not a record of trading."],
    liveFrom: "2026-10-02",
    recordedFrom: "2026-10-05",
    engineSegments: [],
    coverageMonthly: [],
    coverageLabel: "Qualifying ≥ 5% short",
    benchmarkName: "S&P/ASX 200 Gross Total Return (XJT)",
    referenceName: "same-data reference",
    referenceTo: "",
    paper: null,
    avgHoldSessions: 31,
    identity: null,
    main: <p>monthly tables</p>,
    sidebar: <p>assumptions</p>,
    ...over,
  };
}

describe("the Backtest panel's window", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chartProps.length = 0;
    loadBacktestSeries.mockResolvedValue({ series: since2023Series, seriesResolution: "weekly", windowId: "since_2023" });
  });

  it("clicking a window changes the summary and the chart, not only the URL", async () => {
    const replace = jest.spyOn(window.history, "replaceState");
    render(<BacktestPanel {...props()} initialWindow="since_2019_05" />);
    const summary = () => document.querySelector("[data-window-summary]")?.getAttribute("data-window-summary");
    expect(summary()).toBe("since_2019_05");
    expect(screen.getByTestId("chart").getAttribute("data-window")).toBe("Since May 2019");

    const group = screen.getByRole("group", { name: "Window" });
    await act(async () => {
      fireEvent.click(within(group).getByRole("radio", { name: "Since 2023" }));
    });

    expect(summary()).toBe("since_2023");
    expect(screen.getByRole("radio", { name: "Since 2023" })).toBeChecked();
    expect(screen.getByTestId("chart").getAttribute("data-window")).toBe("Since 2023");
    expect(chartProps.at(-1)?.points).toBe(since2023Series.length);
    expect(replace).toHaveBeenCalledWith(null, "", expect.any(URL));
    expect(String(replace.mock.calls.at(-1)?.[2])).toContain("window=since_2023");
  });

  it("asks for the new window's series from one place: one request per switch", async () => {
    render(<BacktestPanel {...props()} initialWindow="since_2019_05" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Since 2023" }));
    });
    expect(loadBacktestSeries).toHaveBeenCalledTimes(1);
    expect(loadBacktestSeries).toHaveBeenCalledWith("crowded-short-breakout", "weekly", "since_2023");
  });

  it("keeps the previous chart up with a busy overlay, and shows a retry when the series fails", async () => {
    loadBacktestSeries.mockResolvedValueOnce(null);
    render(<BacktestPanel {...props()} initialWindow="since_2019_05" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Since 2023" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    loadBacktestSeries.mockResolvedValueOnce({ series: since2023Series, seriesResolution: "weekly", windowId: "since_2023" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("chart").getAttribute("data-window")).toBe("Since 2023");
  });

  it("does not request a daily series for a window of more than 500 sessions", () => {
    render(<BacktestPanel {...props()} initialWindow="since_2019_05" />);
    fireEvent.click(screen.getByRole("button", { name: "daily" }));
    expect(loadBacktestSeries).not.toHaveBeenCalled();
    expect(screen.getByText(/Daily points are served for windows of 500 sessions or fewer/)).toBeInTheDocument();
  });

  it("prints the run's disclosures under the chart, not a fixed copy", () => {
    render(<BacktestPanel {...props({ disclosures: ["Served disclosure one.", "Served disclosure two."] })} initialWindow="since_2019_05" />);
    expect(screen.getByText("Served disclosure one.")).toBeInTheDocument();
    expect(screen.getByText("Served disclosure two.")).toBeInTheDocument();
  });

  it("prints each disclosure once when the run serves the fixed lines too (the API's own list)", () => {
    // The API serves the hypothetical and return-basis lines as its first two disclosures; the panel
    // must not print them a second time beside the list.
    const served = [HYPOTHETICAL_COPY, RETURN_BASIS_COPY, "ASIC basis: the latest complete report.", "Survivorship: flatters."];
    render(<BacktestPanel {...props({ disclosures: served })} initialWindow="since_2019_05" />);
    for (const line of served) {
      expect(screen.getAllByText(line)).toHaveLength(1);
    }
  });

  it("falls back to the two fixed lines, each once, only when the run serves no disclosures", () => {
    render(<BacktestPanel {...props({ disclosures: [] })} initialWindow="since_2019_05" />);
    expect(screen.getAllByText(HYPOTHETICAL_COPY)).toHaveLength(1);
    expect(screen.getAllByText(RETURN_BASIS_COPY)).toHaveLength(1);
  });

  it("disclosureLines de-duplicates a repeated served line and never adds the fixed copy to a served list", () => {
    expect(disclosureLines(["A line.", "A line.", "B line."])).toEqual(["A line.", "B line."]);
    expect(disclosureLines(["Served only."])).toEqual(["Served only."]);
    expect(disclosureLines([])).toEqual([HYPOTHETICAL_COPY, RETURN_BASIS_COPY]);
  });

  it("chooses the freeze chip for in-sample windows and the recorded chip for the live window", async () => {
    render(<BacktestPanel {...props()} initialWindow="since_2019_05" />);
    expect(screen.getByText("In-sample backtest · rules frozen 2 Oct 2026")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Live since freeze" }));
    });
    expect(screen.getByText("Recorded since 5 Oct 2026")).toBeInTheDocument();
    expect(screen.queryByText("In-sample backtest · rules frozen 2 Oct 2026")).not.toBeInTheDocument();
  });
});

describe("parseWindow: an unavailable ?window= falls back to the served window", () => {
  it("takes a window the run carries and refuses one it does not", () => {
    expect(parseWindow("since_2023", windows, "since_2019_05")).toBe("since_2023");
    expect(parseWindow("last_12_months", windows, "since_2019_05")).toBe("since_2019_05");
    expect(parseWindow(null, windows, "since_2019_05")).toBe("since_2019_05");
  });
});
