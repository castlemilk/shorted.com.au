import { readFileSync } from "fs";
import { join } from "path";

import { render, screen } from "@testing-library/react";

import { EvidenceCard } from "../evidence-card";
import { frozenLabel, recordedSinceLabel } from "~/@/lib/strategies/backtest-copy";
import { mapStrategyEvidence } from "~/@/lib/strategies/map-backtest";
import { fixtureEvidence, fixtureVersion } from "~/@/lib/strategies/__tests__/backtest-fixtures";

// Every expectation below is read from the committed evidence golden, so a regenerated golden
// needs no hand edit here.
const GOLDEN_DIR = join(__dirname, "../../../lib/strategies/__tests__/golden");
const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, "strategy_evidence_all.json"), "utf8")) as {
  strategies: Array<{
    strategyId: string;
    paper: { recordedFrom: string; sessions: number; closedTrades: number };
    annual: Array<{ year: number; coverageMeasurable?: boolean; coveragePct?: number; coverageMeasure?: string }>;
    version: { liveFrom?: string };
  }>;
};
const crowded = golden.strategies.find((s) => s.strategyId === "crowded-short-breakout")!;
const lowestQualifying = crowded.annual
  .filter((a) => a.coverageMeasurable === true && a.coverageMeasure === "qualifying_5pct_short")
  .reduce((lowest, a) => (lowest === null || (a.coveragePct ?? 0) < (lowest.coveragePct ?? 0) ? a : lowest), null as (typeof crowded.annual)[number] | null)!;

describe("the Overview's Evidence card", () => {
  it("shows the since-May-2019 headline, the freeze from the version, and the lowest year named by its measure", () => {
    render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence())} />);
    expect(screen.getByText("Backtest evidence")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^In-sample backtest · ${frozenLabel(crowded.version.liveFrom!).replace(/^Rules/, "rules")}$`))).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`Lowest measured coverage: ${lowestQualifying.year}, ${lowestQualifying.coveragePct}% \\(qualifying ≥ 5% short\\), flatters results\\.`)),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full backtest →" })).toHaveAttribute("href", "/strategies/crowded-short-breakout/backtest");
  });

  it("gives the 1.7 too-short copy with the recorded-from date and the golden's counts", () => {
    render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence())} />);
    const recorded = recordedSinceLabel(crowded.paper.recordedFrom);
    expect(screen.getByText(new RegExp(`${recorded}: ${crowded.paper.sessions} sessions, ${crowded.paper.closedTrades} trades, too short to judge`))).toBeInTheDocument();
  });

  it("prints the approximate chip for an approximate run", () => {
    const { container } = render(<EvidenceCard slug="crowded-short-breakout" evidence={mapStrategyEvidence(fixtureEvidence({ state: "approximate" }))} />);
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
    expect(fixtureVersion().liveFrom).toBe(crowded.version.liveFrom);
  });
});

describe("the Overview card's lowest year for a partial run", () => {
  it("never cites a pre-2025 year: the lowest is the lowest from 2025 on", () => {
    const annual = [
      { year: 2019, state: "partial", coverageMeasurable: true, coveragePct: 40, coverageMeasure: "all_reported" },
      { year: 2024, state: "complete", coverageMeasurable: true, coveragePct: 45, coverageMeasure: "all_reported" },
      { year: 2025, state: "complete", coverageMeasurable: true, coveragePct: 88, coverageMeasure: "qualifying_5pct_short" },
    ];
    // Under 80% is named; 88% from 2025 is not, so no lowest-year line is drawn.
    const { container } = render(<EvidenceCard slug="minervini-trend-template" evidence={mapStrategyEvidence(fixtureEvidence({ annual, windows: fixtureEvidence().windows }))} />);
    expect(container.querySelector("[data-lowest-coverage]")).toBeNull();
  });
});
