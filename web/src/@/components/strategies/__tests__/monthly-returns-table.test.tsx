import { render, screen, within } from "@testing-library/react";

import { MonthlyReturnsTable } from "../monthly-returns-table";
import { mapBacktestRun } from "~/@/lib/strategies/map-backtest";
import { fixturePublishedRun } from "~/@/lib/strategies/__tests__/backtest-fixtures";

describe("the monthly returns table", () => {
  it("shows the newest three years, with the earlier years behind a disclosure", () => {
    const run = mapBacktestRun(
      fixturePublishedRun({
        monthly: [
          ...fixturePublishedRun().monthly!,
          { year: 2023, month: 6, state: "complete", strategyPct: 1.1, label: "" },
        ],
      }),
    );
    const { container } = render(<MonthlyReturnsTable monthly={run.monthly} strategyName="Crowded-Short Breakout" windowStart="2019-05-01" windowEnd="2026-11-06" />);
    // The newest three years are the first table; the earlier years sit in a second
    // table inside the disclosure, so a closed disclosure still names them to a crawler.
    const tables = container.querySelectorAll("table");
    expect(tables).toHaveLength(2);
    const recent = within(tables[0]!).getAllByRole("rowheader").map((th) => th.textContent);
    expect(recent).toEqual(["2024", "2025", "2026"]);
    const earlier = within(tables[1]!).getAllByRole("rowheader").map((th) => th.textContent);
    expect(earlier).toEqual(["2019", "2020", "2021", "2022", "2023"]);
    expect(screen.getByText(/Earlier years \(5\)/)).toBeInTheDocument();
  });

  it("says why a month has no figure, in its own words", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    render(<MonthlyReturnsTable monthly={run.monthly} strategyName="Crowded-Short Breakout" windowStart="2019-05-01" windowEnd="2026-11-06" />);
    expect(screen.getAllByText("Not elapsed").length).toBeGreaterThan(0);
  });

  it("marks the month to date", () => {
    const run = mapBacktestRun(fixturePublishedRun({ monthly: [{ year: 2026, month: 11, state: "to_date", strategyPct: 1.5, label: "MTD" }] }));
    render(<MonthlyReturnsTable monthly={run.monthly} strategyName="Crowded-Short Breakout" windowStart="2019-05-01" windowEnd="2026-11-06" />);
    expect(screen.getByText("Month to date")).toBeInTheDocument();
  });

  it("states that a run carries no monthly returns", () => {
    render(<MonthlyReturnsTable monthly={[]} strategyName="X" windowStart="" windowEnd="" />);
    expect(screen.getByText("No monthly returns in this run.")).toBeInTheDocument();
  });
});
