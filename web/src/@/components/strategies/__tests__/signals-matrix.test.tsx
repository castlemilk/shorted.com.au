import { fireEvent, render, screen, within } from "@testing-library/react";

import { SignalsMatrix } from "~/@/components/strategies/signals-matrix";
import { RuleCell, ruleState } from "~/@/components/strategies/rule-cell";
import type { SignalRule } from "~/@/lib/strategies/signals";
import { rankingInputsFor } from "~/@/lib/strategies/signals";
import type { PickRow, RuleResultRow } from "~/@/lib/strategies/types";

const RULES: SignalRule[] = [
  {
    id: "short_crowding",
    title: "Short crowding",
    core: true,
    trigger: false,
    evaluation: "",
    threshold: 5,
    unit: "pct",
    comparator: ">=",
  },
  {
    id: "breakout",
    title: "Breakout on heavy volume",
    core: true,
    trigger: true,
    evaluation: "A close above the prior 40-session high.",
    unit: "",
    comparator: "",
  },
  {
    id: "liquidity",
    title: "Liquid enough to trade",
    core: true,
    trigger: false,
    evaluation: "",
    threshold: 250_000,
    unit: "aud",
    comparator: ">=",
  },
];

function row(
  code: string,
  status: PickRow["status"],
  rules: RuleResultRow[],
): PickRow {
  return {
    rank: 1,
    code,
    name: `${code} Ltd`,
    industry: "",
    status,
    score: 50,
    rules,
    close: null,
    asOf: "2026-11-03",
    pivot: null,
    baseDepthPct: null,
    baseLengthDays: null,
    volumeRatio: null,
    revenueYoyPct: null,
    epsYoyPct: null,
    rs3mPct: null,
    shortPct: null,
    marketCap: null,
    logoUrl: "",
    daysToCover: 4.84,
  } as unknown as PickRow;
}

const WTC = row("WTC", "setup", [
  { ruleId: "short_crowding", status: "pass", detail: "", value: 10 },
  { ruleId: "breakout", status: "fail", detail: "", waiting: true },
  { ruleId: "liquidity", status: "pass", detail: "", value: 63_500_000 },
]);
const NXT = row("NXT", "watch", [
  { ruleId: "short_crowding", status: "pass", detail: "" },
  { ruleId: "breakout", status: "unknown", detail: "", reason: "no_volume" },
  { ruleId: "liquidity", status: "fail", detail: "" },
]);

describe("ruleState", () => {
  it("draws a failing trigger on a setup row as waiting, and a plain fail as fail", () => {
    expect(
      ruleState({ ruleId: "b", status: "fail", detail: "", waiting: true }),
    ).toBe("waiting");
    expect(ruleState({ ruleId: "b", status: "fail", detail: "" })).toBe("fail");
    expect(ruleState({ ruleId: "b", status: "pass", detail: "" })).toBe("pass");
    expect(ruleState({ ruleId: "b", status: "unknown", detail: "" })).toBe(
      "unknown",
    );
    expect(ruleState(undefined)).toBe("unknown");
  });
});

describe("RuleCell", () => {
  function renderCell(
    result: RuleResultRow | undefined,
    measure?: string | null,
  ) {
    return render(
      <table>
        <tbody>
          <tr>
            <RuleCell
              title="Short crowding"
              result={result}
              measure={measure}
            />
          </tr>
        </tbody>
      </table>,
    );
  }

  it("names every state in words, never a tick or a cross", () => {
    const { unmount } = renderCell({ ruleId: "x", status: "pass", detail: "" });
    expect(screen.getByText("Pass")).toBeInTheDocument();
    unmount();
    const fail = renderCell({ ruleId: "x", status: "fail", detail: "" });
    expect(screen.getByText("Fail")).toBeInTheDocument();
    fail.unmount();
    const waiting = renderCell({
      ruleId: "x",
      status: "fail",
      detail: "",
      waiting: true,
    });
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    waiting.unmount();
    renderCell({
      ruleId: "x",
      status: "unknown",
      detail: "",
      reason: "no_index",
    });
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(
      screen.getByText("No index level to compare against"),
    ).toBeInTheDocument();
  });

  it("carries the outcome and its measure in screen-reader text", () => {
    renderCell({ ruleId: "x", status: "pass", detail: "" }, "10.0% ≥ 5.0%");
    expect(
      screen.getByText("Short crowding: pass, 10.0% ≥ 5.0%"),
    ).toBeInTheDocument();
  });

  it("marks each state with a shape and no market colour", () => {
    const { container } = renderCell({
      ruleId: "x",
      status: "pass",
      detail: "",
    });
    const mark = container.querySelector("[data-rule-state='pass']");
    expect(mark?.className).toContain("bg-primary");
    expect(container.innerHTML).not.toMatch(/green|red|22c55e|ef4444/);
  });
});

describe("SignalsMatrix", () => {
  it("draws one column per core rule and the strategy's ranking inputs", () => {
    render(
      <SignalsMatrix
        rows={[WTC]}
        rules={RULES}
        rankingInputs={rankingInputsFor("crowded-short-breakout")}
        selected={null}
        onSelect={() => {}}
        caption="Crowded-short breakout: stocks by rule"
      />,
    );
    const headers = screen
      .getAllByRole("columnheader")
      .map((th) => th.textContent ?? "");
    // A core rule's head carries its CORE badge, so each title is a prefix.
    expect(headers[2]).toMatch(/^Short crowding\s*Core$/);
    expect(headers[3]).toMatch(/^Breakout on heavy volume\s*Core$/);
    expect(headers[4]).toMatch(/^Liquid enough to trade\s*Core$/);
    expect(headers.slice(5)).toEqual(["Days to cover*", "3m RS*"]);
  });

  it("prints the measure of a rule with a threshold and waiting on the trigger", () => {
    render(
      <SignalsMatrix
        rows={[WTC]}
        rules={RULES}
        rankingInputs={[]}
        selected={null}
        onSelect={() => {}}
        caption="x"
      />,
    );
    expect(
      screen.getByText("Short crowding: pass, 10.0% ≥ 5.0%"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Breakout on heavy volume: waiting"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Liquid enough to trade: pass, A$63.5m ≥ A$250k"),
    ).toBeInTheDocument();
  });

  it("selects a stock from its code button and marks it pressed", () => {
    const onSelect = jest.fn();
    render(
      <SignalsMatrix
        rows={[WTC, NXT]}
        rules={RULES}
        rankingInputs={[]}
        selected="NXT"
        onSelect={onSelect}
        caption="x"
      />,
    );
    const nxt = screen.getByRole("button", { name: "NXT" });
    expect(nxt).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "WTC" }));
    expect(onSelect).toHaveBeenCalledWith("WTC");
  });

  it("shows an unknown rule's reason in its row", () => {
    render(
      <SignalsMatrix
        rows={[NXT]}
        rules={RULES}
        rankingInputs={[]}
        selected={null}
        onSelect={() => {}}
        caption="x"
      />,
    );
    const rowEl = screen.getByRole("button", { name: "NXT" }).closest("tr")!;
    expect(
      within(rowEl).getByText("Too few traded sessions to measure volume"),
    ).toBeInTheDocument();
  });
});
