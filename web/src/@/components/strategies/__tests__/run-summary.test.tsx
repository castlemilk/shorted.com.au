import { render, screen } from "@testing-library/react";

import { RunSummary } from "../run-summary";
import { mapPaperTrack, mapWindowMetrics } from "~/@/lib/strategies/map-backtest";
import { fixtureWindows } from "~/@/lib/strategies/__tests__/backtest-fixtures";

const full = mapWindowMetrics(fixtureWindows()[0]!);

describe("the run summary of a window", () => {
  it("prints CAGR for a window of a year or more", () => {
    render(<RunSummary window={full} paper={null} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(screen.getByText("Net CAGR")).toBeInTheDocument();
    expect(screen.getByText("12.4%")).toBeInTheDocument();
  });

  it("prints total return, marked not annualised, under 365 days", () => {
    const short = mapWindowMetrics({ ...fixtureWindows()[2]!, calendarDays: 364, cagrPct: 14, hasCagr: true });
    render(<RunSummary window={short} paper={null} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(screen.getByText("Total return")).toBeInTheDocument();
    expect(screen.getByText("not annualised")).toBeInTheDocument();
    expect(screen.queryByText("Net CAGR")).not.toBeInTheDocument();
  });

  it("prints the Sharpe with its standard error at 126 returns, and n/m under it", () => {
    render(<RunSummary window={full} paper={null} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(screen.getByText("0.82 (± 0.36)")).toBeInTheDocument();
  });

  it("prints n/m for Sharpe under 126 returns", () => {
    const few = mapWindowMetrics({ ...fixtureWindows()[3]!, sessions: 126, hasSharpe: true, sharpe: 0.4, sharpeSe: 0.2 });
    render(<RunSummary window={few} paper={null} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(screen.getByText("n/m")).toBeInTheDocument();
  });

  it("says the out-of-sample record is too short to judge before 63 sessions", () => {
    const paper = mapPaperTrack({ since: "2026-10-02", sessions: 25, closedTrades: 2, tooShort: true });
    const { container } = render(<RunSummary window={full} paper={paper} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(container.querySelector('[data-oos="too-short"]')?.textContent).toContain("too short to judge");
  });

  it("prints the recorded out-of-sample figure once it can be judged", () => {
    const paper = mapPaperTrack({ since: "2026-10-02", sessions: 70, closedTrades: 12, returnPct: 3.2, hasReturn: true, tooShort: false });
    const { container } = render(<RunSummary window={full} paper={paper} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(container.querySelector('[data-oos="recorded"]')?.textContent).toContain("Out-of-sample (recorded)");
  });

  it("paints a negative max drawdown in the text token, and prints n/a, never 0, for an absent figure", () => {
    render(<RunSummary window={full} paper={null} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    const dd = screen.getByText("−18.6%");
    expect(dd.className).toContain("semantic-red-text");
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(0);
  });

  it("states that there is no figure when the page has no window", () => {
    render(<RunSummary window={null} paper={null} tradeSummary={null} benchmarkName="XJT" referenceName="ref" />);
    expect(screen.getByText("No figures for this window in the run.")).toBeInTheDocument();
  });
});
