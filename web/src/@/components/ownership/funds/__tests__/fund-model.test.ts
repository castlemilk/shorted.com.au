/// <reference types="jest" />

import {
  FUND_COMPARE_MAX,
  SECTOR_TINTS,
  changesCsv,
  cleanFundKey,
  cleanIsoDate,
  compareCaption,
  compareChangesHref,
  compareFunds,
  compareOptionLabel,
  defaultCompareFund,
  defaultPair,
  filterChanges,
  formatDeltaPp,
  fundCodeOf,
  fundLabel,
  holdingsTreemap,
  orderFundsForCompare,
  orderFundsForSort,
  otherWeightOf,
  parseFundKeys,
  patchHref,
  serializeFundKeys,
  sectorChangeDetail,
  sectorColumns,
  sectorSummary,
  sectorTint,
  sectorWeightOf,
  statusLabel,
  toggleFundKey,
  type CompareRow,
  type FundPortfolio,
  type FundRow,
  type PortfolioHolding,
} from "../fund-model";

const MINUS = String.fromCharCode(0x2212);

function fund(overrides: Partial<FundRow> & { key: string }): FundRow {
  return {
    ticker: overrides.key,
    name: `${overrides.key} fund`,
    institutionSlug: "vanguard",
    institutionName: "Vanguard",
    sourceKind: "etf",
    pooled: false,
    asAt: "2026-10-31",
    sourceUrl: "",
    holdings: 200,
    top10Pct: 40,
    sectorWeights: [],
    largest: [],
    aumAud: null,
    ...overrides,
  };
}

function holding(code: string, weightPct: number | null, industry = "Materials"): PortfolioHolding {
  return {
    code,
    name: `${code} Ltd`,
    industry,
    weightPct,
    units: null,
    valueAud: null,
    sharesOnIssue: null,
    estCompanyPct: null,
    sharesOnIssueAsAt: "",
  };
}

function change(overrides: Partial<CompareRow> & { code: string }): CompareRow {
  return {
    name: `${overrides.code} Ltd`,
    industry: "Banks",
    weightFrom: 10,
    weightTo: 10,
    deltaPp: 0,
    valueFrom: null,
    valueTo: null,
    status: "continuing",
    ...overrides,
  };
}

describe("fund sectors", () => {
  const funds = [
    fund({
      key: "A200",
      sectorWeights: [
        { industry: "Banks", weightPct: 30 },
        { industry: "Materials", weightPct: 10 },
        { industry: "Utilities", weightPct: null },
      ],
    }),
    fund({
      key: "IOZ",
      sectorWeights: [
        { industry: "Banks", weightPct: 25 },
        { industry: "Insurance", weightPct: 5 },
      ],
    }),
  ];

  it("takes the largest sectors by summed weight, and a name for a tie", () => {
    expect(sectorColumns(funds, 2)).toEqual(["Banks", "Materials"]);
    expect(sectorColumns(funds, 6)).toEqual(["Banks", "Materials", "Insurance"]);
  });

  it("reads a fund's own weight in a column, n/a where the file names the sector with no weight", () => {
    expect(sectorWeightOf(funds[0]!, "Banks")).toBe(30);
    expect(sectorWeightOf(funds[0]!, "Utilities")).toBeNull();
  });

  it("reads a sector its complete file does not name as a true 0, and n/a for a file with no holdings", () => {
    expect(sectorWeightOf(funds[0]!, "Energy")).toBe(0);
    expect(sectorWeightOf({ ...funds[0]!, holdings: 0 }, "Energy")).toBeNull();
    expect(sectorWeightOf({ ...funds[0]!, holdings: 0 }, "Banks")).toBe(30);
  });

  it("folds every sector outside the columns into Other; a complete file with nothing outside reads 0, and n/a when it has no holdings", () => {
    expect(otherWeightOf(funds[1]!, ["Banks"])).toBe(5);
    expect(otherWeightOf(fund({ key: "X", sectorWeights: [{ industry: "Banks", weightPct: 1 }] }), ["Banks"])).toBe(0);
    expect(otherWeightOf(fund({ key: "X", holdings: 0, sectorWeights: [{ industry: "Banks", weightPct: 1 }] }), ["Banks"])).toBeNull();
  });

  it("is n/a for Other when a sector outside the columns states no weight", () => {
    const unstated = fund({ key: "Y", sectorWeights: [{ industry: "Banks", weightPct: 1 }, { industry: "Energy", weightPct: null }] });
    expect(otherWeightOf(unstated, ["Banks"])).toBeNull();
  });

  it("gives the six sector tints in order, cycling, never a kind colour or red or green", () => {
    expect(SECTOR_TINTS).toHaveLength(6);
    expect(sectorTint(0)).toBe(SECTOR_TINTS[0]);
    expect(sectorTint(6)).toBe(SECTOR_TINTS[0]);
    for (const tint of SECTOR_TINTS) {
      expect(tint).not.toMatch(/red|green|#ef4444|#22c55e/i);
    }
  });

  it("names a sector with its weight, or with its name alone when none is stated", () => {
    expect(sectorSummary("Materials", 32.4)).toBe("Materials (32%)");
    expect(sectorSummary("Materials", null)).toBe("Materials");
  });
});

describe("fund selection", () => {
  it("reads only valid, unique keys, at most the compare limit", () => {
    expect(parseFundKeys("asx:A200,asx:IOZ,asx:A200,bad key,asx:VAS,asx:STW,asx:HVST")).toEqual(["asx:A200", "asx:IOZ"]);
    expect(parseFundKeys("asx:A200,bad key,asx:IOZ")).toEqual(["asx:A200", "asx:IOZ"]);
    expect(parseFundKeys(null)).toEqual([]);
  });

  it("reads back a list of keys whose super option names hold a comma or a percent sign", () => {
    // Two keys, the most a comparison holds (FUND_COMPARE_MAX): a comma and a percent sign both survive the list.
    const keys = ["aware/High Growth, Balanced", "vanguard/Index 100% Fund"];
    const written = serializeFundKeys(keys);
    expect(written).toBe("aware/High Growth%2C Balanced,vanguard/Index 100%25 Fund");
    expect(parseFundKeys(written)).toEqual(keys);
    expect(parseFundKeys("asx:A200,asx:IOZ")).toEqual(["asx:A200", "asx:IOZ"]);
    expect(FUND_COMPARE_MAX).toBe(2);
  });

  it("ticks and clears a fund, keeping the tick order", () => {
    expect(toggleFundKey(["A200"], "IOZ")).toEqual(["A200", "IOZ"]);
    expect(toggleFundKey(["A200", "IOZ"], "A200")).toEqual(["IOZ"]);
    expect(toggleFundKey([], "A200")).toEqual(["A200"]);
  });

  it("replaces the oldest ticked fund with a third tick, so the comparison is always the two ticked last (backlog C5)", () => {
    expect(toggleFundKey(["A200", "IOZ"], "STW")).toEqual(["IOZ", "STW"]);
    expect(toggleFundKey(["IOZ", "STW"], "VAS")).toEqual(["STW", "VAS"]);
    expect(toggleFundKey(["A", "B", "C"], "D")).toEqual(["C", "D"]);
    expect(toggleFundKey(["A", "B"], "C", 3)).toEqual(["A", "B", "C"]);
  });

  it("links a comparison to the Changes page on its first fund, the way the bar always has", () => {
    expect(compareChangesHref("asx:A200")).toBe("/ownership/changes?fund=asx%3AA200");
    expect(compareChangesHref("aware/High Growth, Balanced")).toBe(
      "/ownership/changes?fund=aware%2FHigh%20Growth%2C%20Balanced",
    );
  });

  it("cleans a key and a date, and refuses a shape that is not one", () => {
    expect(cleanFundKey(" asx:A200 ")).toBe("asx:A200");
    expect(cleanFundKey("A200")).toBe("");
    expect(cleanFundKey("A/200")).toBe("");
    expect(cleanFundKey("vanguard/Vanguard Australian Shares Index Fund")).toBe("vanguard/Vanguard Australian Shares Index Fund");
    expect(cleanIsoDate("2026-10-31")).toBe("2026-10-31");
    expect(cleanIsoDate("31/10/2026")).toBe("");
    expect(defaultPair(["2026-09-30", "2026-10-31", "2026-06-30"])).toEqual({ from: "2026-09-30", to: "2026-10-31" });
    expect(defaultPair(["2026-10-31"])).toEqual({ from: "", to: "" });
  });

  it("writes a link that keeps every other parameter and clears a default to the bare path", () => {
    const params = new URLSearchParams("type=super&view=holdings");
    expect(patchHref("/ownership/funds", params, { sel: "fund:A200" })).toBe(
      "/ownership/funds?type=super&view=holdings&sel=fund%3AA200",
    );
    expect(patchHref("/ownership/funds", new URLSearchParams("sel=fund:A200"), { sel: null })).toBe("/ownership/funds");
  });
});

describe("the portfolio treemap", () => {
  it("gives every stated, positive holding an area, and leaves the rest to the list", () => {
    const holdings = [holding("BHP", 8), holding("CBA", 6, "Banks"), holding("NOW", null), holding("ZERO", 0)];
    const layout = holdingsTreemap(holdings, 1000, 560);
    expect(layout.cells.map((cell) => cell.code).sort()).toEqual(["BHP", "CBA"]);
    const total = layout.cells.reduce((sum, cell) => sum + (cell.x1 - cell.x0) * (cell.y1 - cell.y0), 0);
    expect(total).toBeCloseTo(1000 * 560, 3);
  });

  it("groups by sector and zooms to one when a focus names it", () => {
    const holdings = [holding("BHP", 8), holding("CBA", 6, "Banks")];
    const sectors = holdingsTreemap(holdings, 1000, 560).sectors.map((sector) => sector.sector);
    expect(sectors).toEqual(expect.arrayContaining(["Materials", "Banks"]));
    const zoomed = holdingsTreemap(holdings, 1000, 560, "Banks");
    expect(zoomed.zoomed).toBe(true);
    expect(zoomed.cells.map((cell) => cell.code)).toEqual(["CBA"]);
  });
});

describe("the change table", () => {
  const rows = [
    change({ code: "CBA", deltaPp: 0.1, weightFrom: 10.1, weightTo: 10.2 }),
    change({ code: "BHP", deltaPp: -0.31, status: "continuing" }),
    change({ code: "NEW", deltaPp: null, weightFrom: null, weightTo: 1.2, status: "new" }),
    change({ code: "OLD", deltaPp: null, weightFrom: 2, weightTo: null, status: "dropped" }),
  ];

  it("prints a change with a true minus, and n/a where the stock is in one file only", () => {
    expect(formatDeltaPp(0.1)).toBe("+0.10 pp");
    expect(formatDeltaPp(-0.31)).toBe(`${MINUS}0.31 pp`);
    expect(formatDeltaPp(0.001)).toBe("0.00 pp");
    expect(formatDeltaPp(null)).toBe("n/a");
  });

  it("names each status in the words of the table", () => {
    expect(statusLabel("continuing")).toBe("Continuing");
    expect(statusLabel("new")).toBe("Newly reported");
    expect(statusLabel("dropped")).toBe("No longer reported");
    expect(statusLabel("weird")).toBe("n/a");
  });

  it("filters to rises, falls and coverage changes, and never counts a stock on one date as a change", () => {
    expect(filterChanges(rows, "increases").map((row) => row.code)).toEqual(["CBA"]);
    expect(filterChanges(rows, "decreases").map((row) => row.code)).toEqual(["BHP"]);
    expect(filterChanges(rows, "coverage").map((row) => row.code)).toEqual(["NEW", "OLD"]);
    expect(filterChanges(rows, "all")).toHaveLength(4);
  });

  it("builds the CSV from the rows, with a header, CRLF ends, and an unstated figure left empty", () => {
    const csv = changesCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Code,Company,Earlier weight (%),Later weight (%),Change (pp),Status");
    expect(lines[1]).toBe('"CBA","CBA Ltd",10.10,10.20,0.10,"Continuing"');
    expect(lines[3]).toBe('"NEW","NEW Ltd",,1.20,,"Newly reported"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("neutralises a formula in a name, so a spreadsheet reads it as text", () => {
    const csv = changesCsv([change({ code: "X", name: '=HYPERLINK("x")' })]);
    expect(csv.split("\r\n")[1]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("a fund's label (spec 14.8)", () => {
  it("is its ticker, else its name, for a super option with an empty ticker", () => {
    expect(fundLabel({ ticker: "IOZ", name: "iShares Core S&P/ASX 200 ETF" })).toBe("IOZ");
    expect(fundLabel({ ticker: "", name: "Hostplus Balanced" })).toBe("Hostplus Balanced");
    expect(fundLabel({ ticker: "  ", name: "Aware Super High Growth" })).toBe("Aware Super High Growth");
  });

  it("never prints a raw fund key for a super option", () => {
    expect(fundCodeOf("asx:A200")).toBe("A200");
    expect(fundCodeOf("aware/High Growth")).toBe("High Growth");
  });
});

describe("the comparison's fund order and default (spec 14.3, B4)", () => {
  const VAS = { key: "asx:VAS", ticker: "VAS", name: "Vanguard", sourceKind: "etf", snapshotCount: 1 };
  const IOZ = { key: "asx:IOZ", ticker: "IOZ", name: "iShares", sourceKind: "etf", snapshotCount: 3 };
  const A200 = { key: "asx:A200", ticker: "A200", name: "Betashares", sourceKind: "etf", snapshotCount: 2 };
  const HVST = { key: "hostplus/Balanced", ticker: "", name: "Balanced", sourceKind: "super_phd", snapshotCount: 4 };

  it("lists every fund with two file dates first, then the rest, each in the API's order", () => {
    expect(orderFundsForCompare([VAS, IOZ, A200]).map((fund) => fund.key)).toEqual(["asx:IOZ", "asx:A200", "asx:VAS"]);
    expect(orderFundsForCompare([VAS, HVST, A200]).map((fund) => fund.key)).toEqual([
      "hostplus/Balanced",
      "asx:A200",
      "asx:VAS",
    ]);
  });

  it("keeps a fund with one file in the list, never drops it", () => {
    expect(orderFundsForCompare([VAS])).toEqual([VAS]);
    expect(orderFundsForCompare([])).toEqual([]);
  });

  it("reads a fund that states no count as having none, so it sorts after the comparable funds", () => {
    const unknown = { key: "asx:NEW", ticker: "NEW", name: "New", sourceKind: "etf" };
    expect(orderFundsForCompare([unknown, A200]).map((fund) => fund.key)).toEqual(["asx:A200", "asx:NEW"]);
  });

  it("defaults to the first index fund with two file dates", () => {
    expect(defaultCompareFund([VAS, IOZ, A200])).toBe(IOZ);
  });

  it("passes over a super fund option with two files for an index fund with two", () => {
    expect(defaultCompareFund([HVST, VAS, A200])).toBe(A200);
  });

  it("falls back to the first fund of any kind with two files when no index fund has two", () => {
    expect(defaultCompareFund([VAS, HVST])).toBe(HVST);
  });

  it("falls back to the first fund when none has two files, and to undefined for an empty registry", () => {
    expect(defaultCompareFund([VAS, { ...A200, snapshotCount: 1 }])).toBe(VAS);
    expect(defaultCompareFund([])).toBeUndefined();
  });
});

describe("a fund's option label (spec 14.3, B4)", () => {
  it("is the ticker, a middle dot and the name", () => {
    expect(compareOptionLabel({ ticker: "IOZ", name: "iShares", snapshotCount: 3 })).toBe("IOZ · iShares");
  });

  it("is the name alone when the fund has no ticker", () => {
    expect(compareOptionLabel({ ticker: " ", name: "Balanced", snapshotCount: 2 })).toBe("Balanced");
  });

  it("carries the suffix when the fund has exactly one file date, and never hides it", () => {
    expect(compareOptionLabel({ ticker: "VAS", name: "Vanguard", snapshotCount: 1 })).toBe("VAS · Vanguard (one file)");
  });

  it("carries no suffix for a count of 0, which is a count the API did not state, not a fund with no file", () => {
    expect(compareOptionLabel({ ticker: "VAS", name: "Vanguard", snapshotCount: 0 })).toBe("VAS · Vanguard");
  });

  it("carries no suffix when the fund states no count, so an unknown count is never read as one file", () => {
    expect(compareOptionLabel({ ticker: "VAS", name: "Vanguard" })).toBe("VAS · Vanguard");
  });
});

describe("the comparison's caption (spec 14.3, B4)", () => {
  const CAPTION_TAIL = "Reported snapshot change, not a trade record.";
  const row = (deltaPp: number | null, status = "continuing"): CompareRow => ({
    code: "X",
    name: "X",
    industry: "",
    weightFrom: 1,
    weightTo: 1,
    deltaPp,
    valueFrom: null,
    valueTo: null,
    status,
  });

  it("names the ticker, the two dates and the count of changed holdings", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row(0.5)),
      row(null, "new"),
      row(null, "dropped"),
      row(0),
    ];
    expect(compareCaption("VAS", "2026-10-15", "2026-11-02", rows)).toBe(
      `VAS, 2026-10-15 against 2026-11-02: 12 holdings changed. ${CAPTION_TAIL}`,
    );
  });

  it("counts a continuing holding whose change rounds to 0.01 pp or more, and not one under half of that", () => {
    expect(compareCaption("VAS", "a", "b", [row(0.005)])).toContain("1 holding changed");
    expect(compareCaption("VAS", "a", "b", [row(0.0049)])).toContain("no holding changed");
    expect(compareCaption("VAS", "a", "b", [row(-0.01)])).toContain("1 holding changed");
  });

  it("reads a count of one in the singular and a count of none as no holding changed", () => {
    expect(compareCaption("VAS", "a", "b", [row(null, "new")])).toBe(`VAS, a against b: 1 holding changed. ${CAPTION_TAIL}`);
    expect(compareCaption("VAS", "a", "b", [row(0)])).toBe(`VAS, a against b: no holding changed. ${CAPTION_TAIL}`);
    expect(compareCaption("VAS", "a", "b", [])).toBe(`VAS, a against b: no holding changed. ${CAPTION_TAIL}`);
  });

  it("is the bare note when no comparison is on screen", () => {
    expect(compareCaption("VAS", "", "", [])).toBe(CAPTION_TAIL);
    expect(compareCaption("VAS", "2026-10-15", "", [row(1)])).toBe(CAPTION_TAIL);
  });

  it("is the bare note for one file on both sides, which is no comparison", () => {
    expect(compareCaption("VAS", "a", "a", [])).toBe(CAPTION_TAIL);
  });

  it("carries no em dash, whatever the comparison", () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(compareCaption("VAS", "2026-10-15", "2026-11-02", [row(1)])).not.toContain(EM_DASH);
    expect(compareCaption("VAS", "", "", [])).not.toContain(EM_DASH);
  });
});

describe("the fund sort (backlog C3b)", () => {
  const moved = (key: string, pp: number | null) =>
    fund({ key, largestSectorChangePp: pp, largestSectorChangeSector: "Banks" });
  const keysOf = (rows: FundRow[]) => rows.map((row) => row.key);

  it("keeps the API's order under Largest", () => {
    const rows = [moved("A", 1), moved("B", null), moved("C", -5)];
    expect(keysOf(orderFundsForSort(rows, "largest"))).toEqual(["A", "B", "C"]);
  });

  it("orders by the size of the change under Changed, a fall as much as a rise", () => {
    const rows = [moved("A", 1), moved("B", -4), moved("C", 2.5)];
    expect(keysOf(orderFundsForSort(rows, "changed"))).toEqual(["B", "C", "A"]);
  });

  it("puts the funds that state no change last, in the API's order, and does not reorder the input", () => {
    const rows = [moved("A", null), moved("B", 0.2), moved("C", null), moved("D", -3)];
    expect(keysOf(orderFundsForSort(rows, "changed"))).toEqual(["D", "B", "A", "C"]);
    expect(keysOf(rows)).toEqual(["A", "B", "C", "D"]);
  });

  it("treats a fund without the field as one that states no change", () => {
    expect(keysOf(orderFundsForSort([fund({ key: "A" }), moved("B", 1)], "changed"))).toEqual(["B", "A"]);
  });
});

describe("the sector change's detail (backlog C3b)", () => {
  it("names the sector's short name and the change, with a true minus", () => {
    expect(sectorChangeDetail({ largestSectorChangePp: 10.2, largestSectorChangeSector: "Banks" })).toBe("Banks +10.20 pp");
    expect(sectorChangeDetail({ largestSectorChangePp: -2.5, largestSectorChangeSector: "Banks" })).toBe(`Banks ${MINUS}2.50 pp`);
  });

  it("is empty when the fund states no change, never a dash or a zero", () => {
    expect(sectorChangeDetail({ largestSectorChangePp: null, largestSectorChangeSector: "" })).toBe("");
    expect(sectorChangeDetail({})).toBe("");
  });
});

describe("comparing two fund files (backlog C5)", () => {
  function held(code: string, weightPct: number | null, industry = "Materials"): PortfolioHolding {
    return {
      code,
      name: `${code} Ltd`,
      industry,
      weightPct,
      units: null,
      valueAud: null,
      sharesOnIssue: null,
      estCompanyPct: null,
      sharesOnIssueAsAt: "",
    };
  }

  /** The two fields the diff reads, so a test states only what it compares. */
  function file(
    sectors: Array<[string, number | null]>,
    holdings: PortfolioHolding[],
  ): Pick<FundPortfolio, "sectorWeights" | "holdings"> {
    return {
      sectorWeights: sectors.map(([industry, weightPct]) => ({ industry, weightPct })),
      holdings,
    };
  }

  it("joins the sectors over the union of both files, with a true zero for a sector a complete file does not name", () => {
    const first = file([["Banks", 30], ["Materials", 12]], [held("CBA", 30, "Banks")]);
    const second = file([["Banks", 28], ["Health Care", 9]], [held("CSL", 9, "Health Care")]);
    const diff = compareFunds(first, second);
    const byName = Object.fromEntries(diff.sectors.map((row) => [row.industry, row]));
    expect(Object.keys(byName).sort()).toEqual(["Banks", "Health Care", "Materials"]);
    expect(byName.Materials).toEqual({ industry: "Materials", firstPct: 12, secondPct: 0, deltaPp: 12 });
    expect(byName["Health Care"]).toEqual({ industry: "Health Care", firstPct: 0, secondPct: 9, deltaPp: -9 });
  });

  it("signs the difference first less second, and orders the sectors by the size of the difference", () => {
    const first = file([["Banks", 30], ["Materials", 12], ["Energy", 5]], [held("CBA", 30, "Banks")]);
    const second = file([["Banks", 25.8], ["Materials", 17.2], ["Energy", 5]], [held("BHP", 30, "Materials")]);
    const diff = compareFunds(first, second);
    // Materials differs by 5.2 points and Banks by 4.2: the larger size leads, whatever its sign.
    expect(diff.sectors.map((row) => row.industry)).toEqual(["Materials", "Banks", "Energy"]);
    expect(diff.sectors[0]?.deltaPp).toBeCloseTo(-5.2, 10);
    expect(diff.sectors[1]?.deltaPp).toBeCloseTo(4.2, 10);
    expect(diff.sectors[2]?.deltaPp).toBe(0);
    expect(diff.largest?.industry).toBe("Materials");
  });

  it("states no difference from a figure one file does not state, and puts that sector last", () => {
    const first = file([["Banks", null], ["Materials", 10]], [held("CBA", null, "Banks")]);
    const second = file([["Banks", 20], ["Materials", 10]], [held("CBA", 20, "Banks")]);
    const diff = compareFunds(first, second);
    const banks = diff.sectors.find((row) => row.industry === "Banks");
    expect(banks).toEqual({ industry: "Banks", firstPct: null, secondPct: 20, deltaPp: null });
    expect(diff.sectors[diff.sectors.length - 1]?.industry).toBe("Banks");
    expect(diff.largest?.industry).toBe("Materials");
  });

  it("reads an absent sector as unknown when the file lists no holdings, never as a zero", () => {
    const empty = file([], []);
    const named = file([["Banks", 40]], [held("CBA", 40, "Banks")]);
    const diff = compareFunds(empty, named);
    expect(diff.sectors).toEqual([{ industry: "Banks", firstPct: null, secondPct: 40, deltaPp: null }]);
    expect(diff.largest).toBeNull();
  });

  it("lists the holdings only one fund holds, by code, the heaviest first and a holding with no weight last", () => {
    const first = file([], [held("BHP", 8), held("RIO", 3), held("ZZZ", null), held("CBA", 10, "Banks")]);
    const second = file([], [held("CBA", 9, "Banks"), held("CSL", 4, "Health Care"), held("WES", 6, "Industrials")]);
    const diff = compareFunds(first, second);
    expect(diff.onlyFirst.map((row) => row.code)).toEqual(["BHP", "RIO", "ZZZ"]);
    expect(diff.onlySecond.map((row) => row.code)).toEqual(["WES", "CSL"]);
    expect(diff.onlyFirst[0]).toEqual({ code: "BHP", name: "BHP Ltd", industry: "Materials", weightPct: 8 });
  });

  it("returns no difference and no only-in holding for two empty files, and an empty comparison of a file with itself", () => {
    expect(compareFunds(file([], []), file([], []))).toEqual({ sectors: [], largest: null, onlyFirst: [], onlySecond: [] });
    const same = file([["Banks", 20]], [held("CBA", 20, "Banks")]);
    const self = compareFunds(same, same);
    expect(self.sectors).toEqual([{ industry: "Banks", firstPct: 20, secondPct: 20, deltaPp: 0 }]);
    expect(self.onlyFirst).toEqual([]);
    expect(self.onlySecond).toEqual([]);
  });
});
