import { render, screen } from "@testing-library/react";

import { EvidenceCard } from "../evidence-card";
import { mapBacktestRun, mapStrategyEvidence } from "~/@/lib/strategies/map-backtest";
import { fixtureEvidence, fixturePublishedRun } from "~/@/lib/strategies/__tests__/backtest-fixtures";

const run = mapBacktestRun(fixturePublishedRun());

describe("the Overview's Evidence card", () => {
  it("shows the since-May-2019 headline, the in-sample split and the link to the full backtest", () => {
    render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence())} run={run} />);
    expect(screen.getByText("Backtest evidence")).toBeInTheDocument();
    expect(screen.getByText("12.4%")).toBeInTheDocument();
    expect(screen.getByText("In-sample backtest · rules frozen 2 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText(/Lowest measured coverage: 2019, 64%/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full backtest →" })).toHaveAttribute(
      "href",
      "/strategies/crowded-short-breakout/backtest",
    );
  });

  it("names the measured fiscal label for a fundamentals strategy that cannot be tested yet", () => {
    const evidence = mapStrategyEvidence(
      fixtureEvidence({ strategyId: "zanger-breakout", state: "not_computable", fiscalLabel: "FY2024", windows: [] }),
    );
    render(<EvidenceCard slug="zanger-breakout" evidence={evidence} run={null} />);
    expect(
      screen.getByText(/^Not computable before FY2024\. From FY2024 a test is possible only/),
    ).toBeInTheDocument();
    expect(screen.getByText(/This strategy's core rules need company fundamentals/)).toBeInTheDocument();
  });

  it("uses the fundamentals-free sentence when no label was measured", () => {
    const evidence = mapStrategyEvidence(
      fixtureEvidence({ strategyId: "canslim", state: "not_computable", fiscalLabel: "", computableSharePct: 31.4, hasComputableShare: true, windows: [] }),
    );
    render(<EvidenceCard slug="canslim" evidence={evidence} run={null} />);
    expect(screen.getByText("Not computable: needs point-in-time fundamentals (fundamentals for 31% of the universe).")).toBeInTheDocument();
  });

  it("says a run is required in the API's own reason, never in the fundamentals words", () => {
    const evidence = mapStrategyEvidence(fixtureEvidence({ state: "run_required", windows: [] }));
    const pending = mapBacktestRun({ state: "run_required", stateReason: "The rules have no recipe yet." });
    render(<EvidenceCard slug="crowded-short-breakout" evidence={evidence} run={pending} />);
    expect(screen.getByText("The rules have no recipe yet.")).toBeInTheDocument();
    expect(screen.queryByText(/point-in-time/)).not.toBeInTheDocument();
  });

  it("says a run is in progress from its start time", () => {
    const evidence = mapStrategyEvidence(fixtureEvidence({ state: "running", windows: [] }));
    const running = mapBacktestRun({ state: "running", runningSince: "2026-11-08T14:02:00Z" });
    render(<EvidenceCard slug="crowded-short-breakout" evidence={evidence} run={running} />);
    expect(screen.getByText("Running since 14:02 UTC")).toBeInTheDocument();
  });

  it("draws no card for a strategy the evidence does not carry a window for", () => {
    const { container } = render(
      <EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence({ windows: [] }))} run={run} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
