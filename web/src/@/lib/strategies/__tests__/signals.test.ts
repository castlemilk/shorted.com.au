import {
  RANKING_INPUTS,
  SIGNALS_PUBLIC_ROWS,
  chipFilters,
  countLine,
  coreRules,
  filterCount,
  matchesFilter,
  parseSelection,
  rankingInputsFor,
} from "~/@/lib/strategies/signals";
import type { PickRow, StatusCountsView } from "~/@/lib/strategies/types";

const COUNTS: StatusCountsView = {
  triggered: 5,
  setup: 66,
  watch: 0,
  unknown: 0,
};

describe("the Signals tab's rules", () => {
  it("shows the top ten anonymously", () => {
    expect(SIGNALS_PUBLIC_ROWS).toBe(10);
  });

  it("keeps the core rules in order and drops the scoring-only ones", () => {
    const rules = [
      { id: "a", core: true },
      { id: "b", core: false },
      { id: "c", core: true },
    ];
    expect(coreRules(rules).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("gives each strategy its own ranking inputs, and none to the rest", () => {
    expect(
      rankingInputsFor("crowded-short-breakout").map((i) => i.label),
    ).toEqual(["Days to cover*", "3m RS*"]);
    expect(rankingInputsFor("canslim").map((i) => i.id)).toEqual([
      "rs_6m_percentile",
    ]);
    expect(rankingInputsFor("zanger-breakout")).toEqual([]);
    expect(Object.keys(RANKING_INPUTS)).toContain("minervini-trend-template");
  });

  it("reads the ranking inputs in their own units, n/a when absent", () => {
    const row = {
      daysToCover: 4.84,
      rs3mPct: 6.2,
      rs6mPercentile: 81.26,
    } as PickRow;
    const crowded = rankingInputsFor("crowded-short-breakout");
    expect(crowded.map((i) => i.read(row))).toEqual(["4.8", "+6.2pp"]);
    const missing = {
      daysToCover: undefined,
      rs3mPct: null,
    } as unknown as PickRow;
    expect(crowded.map((i) => i.read(missing))).toEqual(["n/a", "n/a"]);
    expect(rankingInputsFor("canslim")[0]!.read(row)).toBe("81");
  });
});

describe("filter chips and the count line", () => {
  it("offers Unknown only once the API counts an unknown signal", () => {
    expect(chipFilters(COUNTS)).toEqual(["all", "triggered", "setup", "watch"]);
    expect(chipFilters({ ...COUNTS, unknown: 2 })).toContain("unknown");
    expect(chipFilters(null)).toEqual(["all", "triggered", "setup", "watch"]);
  });

  it("reads each chip's count from the status counts, not the rows", () => {
    expect(filterCount("all", COUNTS, 71)).toBe(71);
    expect(filterCount("setup", COUNTS, 71)).toBe(66);
    expect(filterCount("setup", null, 71)).toBeNull();
    expect(filterCount("all", null, 71)).toBeNull();
  });

  it("says how many are shown and splits the whole list by status", () => {
    expect(countLine(COUNTS, 10, 71)).toBe(
      "Showing 10 of 71 signals: 5 triggered · 66 setup",
    );
  });

  it("prints the whole list when every signal is shown", () => {
    expect(countLine(COUNTS, 71, 71)).toBe(
      "71 signals: 5 triggered · 66 setup",
    );
    expect(
      countLine({ triggered: 0, setup: 1, watch: 0, unknown: 0 }, 1, 1),
    ).toBe("1 signal: 1 setup");
  });

  it("is empty without status counts rather than inventing a split", () => {
    expect(countLine(null, 10, 71)).toBe("");
  });

  it("filters rows by status, and 'all' takes every row", () => {
    expect(matchesFilter({ status: "setup" } as PickRow, "setup")).toBe(true);
    expect(matchesFilter({ status: "setup" } as PickRow, "triggered")).toBe(
      false,
    );
    expect(matchesFilter({ status: "watch" } as PickRow, "all")).toBe(true);
  });
});

describe("parseSelection", () => {
  it.each([
    ["stock:wtc", "WTC"],
    ["stock:BHP", "BHP"],
    ["strategy:canslim", null],
    ["stock:", null],
    ["stock:TOO-LONG-CODE", null],
    [null, null],
  ])("reads %j as %j", (raw, expected) => {
    expect(parseSelection(raw)).toBe(expected);
  });
});
