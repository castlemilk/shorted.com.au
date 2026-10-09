/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type { StrategyDef } from "~/@/lib/strategies/types";
import type {
  StockStrategyFitRow,
  StrategyFitStatus,
} from "~/app/actions/getStockStrategyFit";
import { defaultStrategyId } from "../strategy-levels";
import { StrategyFitPanel, sortFitsByStrength } from "../strategy-fit-panel";

function row(
  strategyId: string,
  status: StrategyFitStatus,
  score: number | null,
  extra: Partial<StockStrategyFitRow> = {},
): StockStrategyFitRow {
  return {
    strategyId,
    strategyName: strategyId.toUpperCase(),
    status,
    score,
    rank: status === "none" ? null : 3,
    totalCount: 40,
    rules: [],
    ruleColumns: [],
    ...extra,
  };
}

const ids = (fits: StockStrategyFitRow[]) => fits.map((f) => f.strategyId);

describe("sortFitsByStrength", () => {
  it("puts triggered before setup before watch before none, whatever the scores", () => {
    const fits = [
      row("none-a", "none", null),
      row("watch-a", "watch", 99),
      row("trig-a", "triggered", 10),
      row("setup-a", "setup", 50),
    ];
    expect(ids(sortFitsByStrength(fits))).toEqual([
      "trig-a",
      "setup-a",
      "watch-a",
      "none-a",
    ]);
  });

  it("orders by score, highest first, within a status", () => {
    const fits = [
      row("low", "watch", 20),
      row("high", "watch", 80),
      row("mid", "watch", 50),
    ];
    expect(ids(sortFitsByStrength(fits))).toEqual(["high", "mid", "low"]);
  });

  it("ranks a measured score of 0 above no score at all", () => {
    const fits = [row("unscored", "watch", null), row("zero", "watch", 0)];
    expect(ids(sortFitsByStrength(fits))).toEqual(["zero", "unscored"]);
  });

  it("keeps the given order for an equal status and score", () => {
    const fits = [
      row("first", "setup", 50),
      row("second", "setup", 50),
      row("third", "setup", 50),
      row("a", "none", null),
      row("b", "none", null),
    ];
    expect(ids(sortFitsByStrength(fits))).toEqual([
      "first",
      "second",
      "third",
      "a",
      "b",
    ]);
  });

  it("returns a new array and leaves its input as it was", () => {
    const fits = [row("watch-a", "watch", 1), row("trig-a", "triggered", 1)];
    const before = [...fits];
    const sorted = sortFitsByStrength(fits);
    expect(sorted).not.toBe(fits);
    expect(fits).toEqual(before);
  });

  it("returns no fits for no fits", () => {
    expect(sortFitsByStrength([])).toEqual([]);
  });

  it("leads with the strategy the chart opens on, for any order of the same fits", () => {
    const fits = [
      row("a", "watch", 90),
      row("b", "setup", 40),
      row("c", "setup", 70),
      row("d", "none", null),
      row("e", "triggered", 30),
      row("f", "triggered", 30),
    ];
    const orders = [
      [0, 1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1, 0],
      [3, 0, 5, 1, 4, 2],
    ];
    for (const order of orders) {
      const given = order.map((i) => fits[i]!);
      expect(sortFitsByStrength(given)[0]!.strategyId).toBe(
        defaultStrategyId(given),
      );
    }
  });
});

const definition: StrategyDef = {
  id: "canslim",
  name: "CAN SLIM",
  author: "William O'Neil",
  tagline: "Growth with leadership",
  descriptionParagraphs: [
    "O'Neil's method buys leaders in confirmed uptrends.",
  ],
  rules: [
    {
      id: "market",
      title: "Market direction",
      ruleText: "Only buy in a confirmed uptrend.",
      evaluation: "XJO above its 50 and 200-day averages.",
      core: true,
      dataSource: "index_prices",
    },
    {
      id: "volume",
      title: "Volume surge",
      ruleText: "Breakouts need heavy volume.",
      evaluation: "Volume at least 1.5x the 50-day average.",
      core: false,
      dataSource: "stock_prices",
    },
  ],
  metadata: null,
  caveats: [],
  sources: [],
};

const canslim = row("canslim", "setup", 61.6, {
  strategyName: "CAN SLIM",
  rank: 7,
  totalCount: 120,
  rules: [
    { ruleId: "market", status: "pass", detail: "XJO uptrend" },
    {
      ruleId: "volume",
      status: "fail",
      detail: "Volume 0.8x the 50-day average",
    },
    { ruleId: "growth", status: "unknown", detail: "No fundamentals held" },
  ],
  ruleColumns: [
    { id: "market", title: "Market direction" },
    { id: "volume", title: "Volume surge" },
    { id: "growth", title: "Earnings growth" },
  ],
});

/** The body rows of the panel's table as arrays of cell text. */
function bodyRows(panel: HTMLElement): string[][] {
  return within(panel)
    .getAllByRole("row")
    .slice(1)
    .map((tr) =>
      Array.from(tr.querySelectorAll("th, td")).map((c) => c.textContent ?? ""),
    );
}

describe("StrategyFitPanel", () => {
  it("is a region named by the strategy, whose name links to its picks page", () => {
    render(<StrategyFitPanel fit={canslim} definition={definition} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    expect(
      within(panel).getByRole("link", { name: "CAN SLIM" }),
    ).toHaveAttribute("href", "/picks/canslim");
    expect(
      within(panel).getByRole("heading", { level: 2, name: "CAN SLIM" }),
    ).toBeInTheDocument();
  });

  it("reads the status, the rounded score and the rank in the header", () => {
    render(<StrategyFitPanel fit={canslim} definition={definition} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    expect(within(panel).getByText("Setup")).toBeInTheDocument();
    expect(within(panel).getByText("62")).toBeInTheDocument();
    expect(within(panel).getByText("rank 7 of 120")).toBeInTheDocument();
  });

  it("says Not a candidate, with no score or rank, for a stock the strategy does not pick", () => {
    const none = row("canslim", "none", null, {
      strategyName: "CAN SLIM",
      totalCount: 120,
      rules: [{ ruleId: "market", status: "fail", detail: "XJO downtrend" }],
      ruleColumns: [{ id: "market", title: "Market direction" }],
    });
    render(<StrategyFitPanel fit={none} definition={definition} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    expect(within(panel).getByText("Not a candidate")).toBeInTheDocument();
    expect(within(panel).queryByText(/Score/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/rank/)).not.toBeInTheDocument();
    // The rules it failed are still shown: that is the reading.
    expect(within(panel).getByText("XJO downtrend")).toBeInTheDocument();
  });

  it("lists every rule in the fit's order with the rule, how it is tested, the result and the evidence", () => {
    render(<StrategyFitPanel fit={canslim} definition={definition} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    expect(
      within(panel)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Rule", "The rule", "How we test it", "Result", "Evidence"]);
    expect(bodyRows(panel)).toEqual([
      [
        "Market direction core",
        "Only buy in a confirmed uptrend.",
        "XJO above its 50 and 200-day averages.",
        "Pass",
        "XJO uptrend",
      ],
      [
        "Volume surge",
        "Breakouts need heavy volume.",
        "Volume at least 1.5x the 50-day average.",
        "Fail",
        "Volume 0.8x the 50-day average",
      ],
      // No definition for this rule: its words are blank, never invented.
      ["Earnings growth", "", "", "Unknown", "No fundamentals held"],
    ]);
  });

  it("names each result in words and marks it with the dot for that result", () => {
    const { container } = render(
      <StrategyFitPanel fit={canslim} definition={definition} />,
    );
    expect(
      Array.from(container.querySelectorAll("[data-rule-status]")).map((dot) =>
        dot.getAttribute("data-rule-status"),
      ),
    ).toEqual(["pass", "fail", "unknown"]);
    // The dots are decorative; the word is what a screen reader gets.
    expect(
      container.querySelectorAll('[data-rule-status][aria-hidden="true"]'),
    ).toHaveLength(3);
  });

  it("flags a core rule and no other", () => {
    render(<StrategyFitPanel fit={canslim} definition={definition} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    expect(within(panel).getAllByText("core")).toHaveLength(1);
    const market = within(panel).getByRole("rowheader", {
      name: /Market direction/,
    });
    expect(within(market).getByText("core")).toBeInTheDocument();
  });

  it("titles a rule from the fit's column, then the definition, then its id", () => {
    const fit = row("canslim", "watch", 10, {
      strategyName: "CAN SLIM",
      rules: [
        { ruleId: "market", status: "pass", detail: "" },
        { ruleId: "volume", status: "pass", detail: "" },
        { ruleId: "mystery_rule", status: "pass", detail: "" },
      ],
      // Only "market" has a column; "volume" falls to the definition's title.
      ruleColumns: [{ id: "market", title: "Direction of the market" }],
    });
    render(<StrategyFitPanel fit={fit} definition={definition} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    expect(bodyRows(panel).map((cells) => cells[0])).toEqual([
      "Direction of the market core",
      "Volume surge",
      "mystery_rule",
    ]);
  });

  it("leaves the author's two columns out, header and cells together, when there is no definition", () => {
    render(<StrategyFitPanel fit={canslim} definition={null} />);
    const panel = screen.getByRole("region", { name: "CAN SLIM" });
    // No blank "The rule" or "How we test it" cells under their headers: the
    // table is the rule's name, the result and the evidence, every row three
    // cells wide to match the three headers.
    expect(
      within(panel)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Rule", "Result", "Evidence"]);
    expect(bodyRows(panel)).toEqual([
      ["Market direction", "Pass", "XJO uptrend"],
      ["Volume surge", "Fail", "Volume 0.8x the 50-day average"],
      ["Earnings growth", "Unknown", "No fundamentals held"],
    ]);
    expect(within(panel).queryByText("core")).not.toBeInTheDocument();
  });

  it("does not repeat the strategy's description: the name links to the page that owns it", () => {
    render(<StrategyFitPanel fit={canslim} definition={definition} />);
    expect(
      screen.queryByText(/buys leaders in confirmed uptrends/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/William O'Neil/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Growth with leadership/),
    ).not.toBeInTheDocument();
  });
});
