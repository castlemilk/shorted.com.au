import { render, screen } from "@testing-library/react";

import { STATE_SLUGS, type StateSlug } from "@/lib/economy/map-metrics";
import { StateCharts } from "../state-charts";

jest.mock("../economy-charts", () => ({
  EconomySeriesChart: ({
    seriesKey,
    ariaLabel,
    format,
  }: {
    seriesKey: string;
    ariaLabel: string;
    format: string;
  }) => (
    <div role="img" aria-label={ariaLabel} data-series-key={seriesKey} data-format={format} />
  ),
}));

jest.mock("../state-companies", () => ({ StateCompanies: () => <div>Companies</div> }));
jest.mock("../top-exports", () => ({ TopExports: () => <div>Top exports</div> }));
jest.mock("../state-correlations", () => ({ StateCorrelations: () => <div>Correlations</div> }));

const seriesKeyFor = (label: string) =>
  screen.getByRole("img", { name: label }).getAttribute("data-series-key");

describe("StateCharts", () => {
  it("surfaces retail, dwelling approvals, population level, and the finance breakdown", () => {
    render(<StateCharts state="nsw" />);

    expect(seriesKeyFor("New South Wales retail turnover")).toBe(
      "retail.turnover.total.nsw.seasadj",
    );
    expect(seriesKeyFor("New South Wales dwelling approvals")).toBe(
      "approvals.dwelling_units.total.nsw",
    );
    expect(seriesKeyFor("New South Wales estimated resident population")).toBe(
      "population.erp.total.nsw",
    );
    expect(seriesKeyFor("New South Wales government taxation revenue")).toBe(
      "govfin.revenue.taxation.nsw",
    );
    expect(seriesKeyFor("New South Wales government grants revenue")).toBe(
      "govfin.revenue.grants.nsw",
    );
    expect(seriesKeyFor("New South Wales government employee expenses")).toBe(
      "govfin.expenses.employees.nsw",
    );
    expect(seriesKeyFor("New South Wales government interest expenses")).toBe(
      "govfin.expenses.interest.nsw",
    );
  });

  it("renders three safe official finance links for every state", () => {
    const expectedBudgetHosts: Record<StateSlug, string> = {
      nsw: "budget.nsw.gov.au",
      vic: "budget.vic.gov.au",
      qld: "budget.qld.gov.au",
      sa: "statebudget.sa.gov.au",
      wa: "ourstatebudget.wa.gov.au",
      tas: "budget.tas.gov.au",
      nt: "budget.nt.gov.au",
      act: "act.gov.au",
    };

    for (const state of STATE_SLUGS) {
      const { unmount } = render(<StateCharts state={state} />);
      const section = screen.getByRole("heading", { name: "Sources & further reading" }).parentElement!;
      const links = Array.from(section.querySelectorAll("a"));
      expect(links).toHaveLength(3);
      expect(new URL(links[0]!.href).hostname).toContain(expectedBudgetHosts[state]);
      for (const link of links) {
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
      }
      unmount();
    }
  });
});
