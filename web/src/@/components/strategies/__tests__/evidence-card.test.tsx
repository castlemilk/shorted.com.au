import { render, screen } from "@testing-library/react";

import { EvidenceCard } from "../evidence-card";
import { mapStrategyEvidence } from "~/@/lib/strategies/map-backtest";
import { FIXTURE_RECORDED_FROM, fixtureEvidence, fixtureVersion } from "~/@/lib/strategies/__tests__/backtest-fixtures";

// Realistic: the contract's annual rows carry the coverage and its measure (percent).
const ANNUAL = [
  { year: 2019, state: "partial", months: "May-Dec", coverageMeasurable: true, coveragePct: 64, coverageMeasure: "qualifying_5pct_short" },
  { year: 2025, state: "complete", coverageMeasurable: true, coveragePct: 96, coverageMeasure: "qualifying_5pct_short" },
];

describe("the Overview's Evidence card", () => {
  it("shows the since-May-2019 headline, the freeze from the version, and the lowest year named by its measure", () => {
    render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence({ annual: ANNUAL }))} />);
    expect(screen.getByText("Backtest evidence")).toBeInTheDocument();
    expect(screen.getByText("12.4%")).toBeInTheDocument();
    expect(screen.getByText("In-sample backtest · rules frozen 2 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText(/Lowest measured coverage: 2019, 64% \(qualifying ≥ 5% short\), flatters results\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full backtest →" })).toHaveAttribute("href", "/strategies/crowded-short-breakout/backtest");
  });

  it("gives the 1.7 too-short copy with the recorded-from date", () => {
    render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence({ annual: ANNUAL }))} />);
    expect(screen.getByText(new RegExp(`Recorded since 5 Oct 2026: 25 sessions, 2 trades, too short to judge`))).toBeInTheDocument();
    expect(FIXTURE_RECORDED_FROM).toBe("2026-10-05");
  });

  it("prints the approximate chip for an approximate run", () => {
    const { container } = render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence({ state: "approximate", annual: ANNUAL }))} />);
    expect(container.querySelector("[data-approximate]")?.textContent).toContain("Approximate");
  });

  it("names a fundamentals strategy's measured label, and the sentence without a label", () => {
    const labelled = mapStrategyEvidence(fixtureEvidence({ strategyId: "zanger-breakout", state: "not_computable", fiscalLabel: "FY2024", windows: [] }));
    render(<EvidenceCard slug="zanger-breakout" evidence={labelled} />);
    expect(screen.getByText(/^Not computable before FY2024\. From FY2024 a test is possible only/)).toBeInTheDocument();
  });

  it("says a run is required in the API's own state reason, never the fundamentals words", () => {
    const evidence = mapStrategyEvidence(fixtureEvidence({ state: "run_required", stateReason: "The rules have no recipe yet.", windows: [] }));
    render(<EvidenceCard slug="crowded-short-breakout" evidence={evidence} />);
    expect(screen.getByText("The rules have no recipe yet.")).toBeInTheDocument();
    expect(screen.queryByText(/point-in-time/)).not.toBeInTheDocument();
  });

  it("says a run is in progress from its start time", () => {
    const evidence = mapStrategyEvidence(fixtureEvidence({ state: "running", runningSince: "2026-11-08T14:02:00Z", windows: [] }));
    render(<EvidenceCard slug="crowded-short-breakout" evidence={evidence} />);
    expect(screen.getByText("Running since 14:02 UTC")).toBeInTheDocument();
  });

  it("draws no card for a strategy the evidence carries no full-history window for", () => {
    const { container } = render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence({ windows: [] }))} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads the freeze from the version's live date", () => {
    expect(fixtureVersion().liveFrom).toBe("2026-10-02");
  });
});
