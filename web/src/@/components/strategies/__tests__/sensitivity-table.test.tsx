import { render, screen, within } from "@testing-library/react";

import { SensitivityTable } from "../sensitivity-table";
import { mapBacktestRun, mapSensitivity } from "@/lib/strategies/map-backtest";
import { fixtureMinerviniRun } from "@/lib/strategies/__tests__/backtest-fixtures";

const recipe = mapBacktestRun(fixtureMinerviniRun()).recipe;

function rowOf(label: string): HTMLElement {
  const row = screen.getByRole("rowheader", { name: label }).closest("tr");
  if (!row) throw new Error(`no row ${label}`);
  return row as HTMLElement;
}

describe("SensitivityTable", () => {
  it("reads a wiped-out run's Reading as 'Wiped out' in words, and keeps its served CAGR", () => {
    render(
      <SensitivityTable
        rows={[mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -100.01 })]}
        baseBeatsXjt={true}
        recipe={recipe}
      />,
    );
    const tr = rowOf("Costs doubled");
    const cells = tr.querySelectorAll("td");
    // The CAGR cell shows the served figure (n/a while the engine serves none).
    expect(cells[0]?.textContent).toBe("n/a");
    const reading = within(tr).getByText("Wiped out");
    expect(reading).toBeInTheDocument();
    // The reading is a word, not a red or green figure.
    expect(reading.className).not.toMatch(/red|green/);
  });

  it("keeps a sensitivity that is not wiped out on its own reading", () => {
    render(
      <SensitivityTable
        rows={[mapSensitivity({ id: "entry_plus_1", label: "Entry one session later", applies: true, cagrPct: 1.67, hasCagr: true, excessVsBenchmarkPct: -7, hasExcess: true, maxDrawdownPct: -66.65 })]}
        baseBeatsXjt={false}
        recipe={recipe}
      />,
    );
    expect(within(rowOf("Entry one session later")).getByText("Does not beat XJT")).toBeInTheDocument();
    expect(screen.queryByText("Wiped out")).toBe(null);
  });

  it("states the costs from the run's recipe tiers, not a fixed range", () => {
    render(
      <SensitivityTable
        rows={[mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -33 })]}
        baseBeatsXjt={null}
        recipe={recipe}
      />,
    );
    expect(screen.getByText(/5-75 bps spread by liquidity/)).toBeInTheDocument();
  });
});
