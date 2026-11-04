/// <reference types="jest" />

import {
  FUND_COMPARE_MAX,
  SECTOR_TINTS,
  changesCsv,
  cleanFundKey,
  cleanIsoDate,
  compareCaption,
  compareOptionLabel,
  defaultCompareFund,
  defaultPair,
  filterChanges,
  formatDeltaPp,
  fundCodeOf,
  fundLabel,
  heatMix,
  holdingsTreemap,
  orderFundsForCompare,
  otherWeightOf,
  parseFundKeys,
  patchHref,
  serializeFundKeys,
  sectorColumns,
  sectorSummary,
  sectorTint,
  sectorWeightOf,
  statusLabel,
  toggleFundKey,
  type CompareRow,
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

  it("reads a fund's own weight in a column, and n/a where the file states none", () => {
    expect(sectorWeightOf(funds[0]!, "Banks")).toBe(30);
    expect(sectorWeightOf(funds[0]!, "Utilities")).toBeNull();
    expect(sectorWeightOf(funds[0]!, "Energy")).toBeNull();
  });

  it("folds every sector outside the columns into Other, and is n/a when none is stated", () => {
    expect(otherWeightOf(funds[1]!, ["Banks"])).toBe(5);
    expect(otherWeightOf(fund({ key: "X", sectorWeights: [{ industry: "Banks", weightPct: 1 }] }), ["Banks"])).toBeNull();
  });

  it("tints a heat cell on one scale, and leaves a cell with no weight or a zero plain", () => {
    expect(heatMix(null)).toBeNull();
    expect(heatMix(0)).toBeNull();
    expect(heatMix(40)).toContain("60%");
    expect(heatMix(80)).toContain("60%");
    expect(heatMix(10)).toContain("15%");
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
    expect(parseFundKeys("asx:A200,asx:IOZ,asx:A200,bad key,asx:VAS,asx:STW,asx:HVST")).toEqual(["asx:A200", "asx:IOZ", "asx:VAS"]);
    expect(parseFundKeys(null)).toEqual([]);
  });

  it("reads back a list of keys whose super option names hold a comma or a percent sign", () => {
    const keys = ["aware/High Growth, Balanced", "asx:A200", "vanguard/Index 100% Fund"];
    const written = serializeFundKeys(keys);
    expect(written).toBe("aware/High Growth%2C Balanced,asx:A200,vanguard/Index 100%25 Fund");
    expect(parseFundKeys(written)).toEqual(keys);
    expect(parseFundKeys("asx:A200,asx:IOZ")).toEqual(["asx:A200", "asx:IOZ"]);
    expect(FUND_COMPARE_MAX).toBe(3);
  });

  it("ticks and clears a fund, and never takes a fourth", () => {
    expect(toggleFundKey(["A200"], "IOZ")).toEqual(["A200", "IOZ"]);
    expect(toggleFundKey(["A200", "IOZ"], "A200")).toEqual(["IOZ"]);
    expect(toggleFundKey(["A", "B", "C"], "D")).toEqual(["A", "B", "C"]);
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
