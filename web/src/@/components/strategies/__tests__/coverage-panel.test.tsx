import { render, screen, within } from "@testing-library/react";

import { CoveragePanel, UNMEASURED_COPY } from "../coverage-panel";
import { mapCoverageYear, mapBacktestRun } from "~/@/lib/strategies/map-backtest";
import { fixturePublishedRun } from "~/@/lib/strategies/__tests__/backtest-fixtures";

// Minervini: the qualifying measure sees 2025 only; all-reported is served for every year.
const partialYears = [2019, 2020, 2021, 2022, 2023, 2024].map((year) =>
  mapCoverageYear({ year, measurable: false, allReportedMeasurable: true, allReportedPct: 55 + (year - 2019) }),
).concat(mapCoverageYear({ year: 2025, measurable: true, coveragePct: 88, allReportedMeasurable: true, allReportedPct: 93 }));

const partialSurvivorship = {
  measurement: "partial",
  direction: "flatters",
  statement: "Prices are missing for companies that delisted before about 2025.",
  caveat: "",
};

describe("the coverage panel's '?' for a partial run", () => {
  it("marks 2019-2024 with '?', each carrying the 1.7 copy as its title, and prints 2025's figure", () => {
    const { container } = render(
      <CoveragePanel years={partialYears} months={[]} survivorship={partialSurvivorship} dataQuality={null} dataNotes={[]} />,
    );
    // The table's marks only: the strip's bars carry the same "?" for the same years.
    const table = screen.getByRole("region", { name: "Coverage by year" });
    const marked = table.querySelectorAll('[data-unmeasured=""]');
    expect(marked).toHaveLength(6);
    for (const el of Array.from(marked)) expect(el.getAttribute("title")).toBe(UNMEASURED_COPY);
    const rows = within(screen.getByRole("region", { name: "Coverage by year" })).getAllByRole("row");
    const row2025 = rows.find((r) => r.textContent?.startsWith("2025"));
    expect(row2025?.textContent).toContain("93%");
    expect(row2025?.textContent).not.toContain("?");
  });

  it("shows the legend line only while a '?' is present", () => {
    const { container } = render(
      <CoveragePanel years={partialYears} months={[]} survivorship={partialSurvivorship} dataQuality={null} dataNotes={[]} />,
    );
    expect(container.querySelector("[data-unmeasured-legend]")?.textContent).toContain(UNMEASURED_COPY);
  });

  it("shows no '?' and no legend for a measured run (Crowded-Short)", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    const { container } = render(
      <CoveragePanel years={run.coverageByYear} months={run.coverageMonthly} survivorship={run.survivorship} dataQuality={null} dataNotes={[]} />,
    );
    expect(container.querySelector('[data-unmeasured=""]')).toBeNull();
    expect(container.querySelector("[data-unmeasured-legend]")).toBeNull();
    expect(container.textContent).not.toContain("?");
  });

  it("never names a pre-2025 year in the chip for a partial run", () => {
    const { container } = render(
      <CoveragePanel years={partialYears} months={[]} survivorship={partialSurvivorship} dataQuality={null} dataNotes={[]} />,
    );
    const chip = container.querySelector("[data-coverage-chip]")?.textContent ?? "";
    expect(chip).toContain("93% (2025)");
    expect(chip).not.toMatch(/\(2019\)|\(2024\)/);
  });
});

describe("the Minervini golden: '?' on the pre-2025 years, figures from 2025", () => {
  it("marks 2019-2024, prints 2025 and 2026, and cites no pre-2025 year in the chip", () => {
    const { fixtureMinerviniRun } = require("~/@/lib/strategies/__tests__/backtest-fixtures") as typeof import("~/@/lib/strategies/__tests__/backtest-fixtures");
    const run = mapBacktestRun(fixtureMinerviniRun());
    const { container } = render(
      <CoveragePanel years={run.coverageByYear} months={[]} survivorship={run.survivorship} dataQuality={null} dataNotes={[]} />,
    );
    const table = screen.getByRole("region", { name: "Coverage by year" });
    const rows = within(table).getAllByRole("row").slice(1);
    const byYear = Object.fromEntries(rows.map((r) => [r.querySelector("th")?.textContent ?? "", r.textContent ?? ""]));
    for (const year of ["2019", "2020", "2021", "2022", "2023", "2024"]) {
      expect(byYear[year]).toContain("?");
      const row = rows.find((r) => r.querySelector("th")?.textContent === year);
      expect(row?.querySelector('[data-unmeasured=""]')).not.toBeNull();
    }
    expect(byYear["2025"]).not.toContain("?");
    expect(byYear["2025"]).toContain("90%");
    expect(byYear["2026"]).toContain("90%");
    expect(container.querySelectorAll('[data-unmeasured=""]').length).toBeGreaterThanOrEqual(6);
    const chip = container.querySelector("[data-coverage-chip]")?.textContent ?? "";
    expect(chip).toContain("Coverage (all reported) 90% (2025) → 90% (2026)");
    expect(chip).not.toMatch(/\(2019\)|\(2020\)|\(2021\)|\(2022\)|\(2023\)|\(2024\)/);
  });
});
