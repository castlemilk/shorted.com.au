import {
  PICK_SORTS,
  isRankOrder,
  parsePickSort,
  pickSortDef,
  picksQuery,
  sortPickRows,
} from "~/@/lib/strategies/sort";
import type { PickRow } from "~/@/lib/strategies/types";

function row(rank: number, overrides: Partial<PickRow> = {}): PickRow {
  return {
    rank,
    code: `C${rank}`,
    name: "",
    industry: "",
    status: "watch",
    score: 50,
    rules: [],
    close: 1,
    asOf: "",
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
    ...overrides,
  };
}

const codes = (rows: PickRow[]) => rows.map((r) => r.code);

describe("parsePickSort", () => {
  it("accepts the API's closed set, case-insensitively, and treats score as no sort", () => {
    for (const def of PICK_SORTS) {
      expect(parsePickSort(def.key)).toBe(def.key);
    }
    expect(parsePickSort(" ROE ")).toBe("roe");
    expect(parsePickSort("score")).toBeNull();
    expect(parsePickSort("price")).toBeNull();
    expect(parsePickSort(null)).toBeNull();
  });

  // Every key the web offers must be one the API accepts (sort.go SortKeys).
  it("offers exactly the API's non-default keys", () => {
    expect(PICK_SORTS.map((d) => d.key)).toEqual([
      "revenue_yoy",
      "eps_yoy",
      "roe",
      "net_margin",
      "fcf_margin",
      "pe",
      "market_cap",
    ]);
    expect(PICK_SORTS.filter((d) => d.ascending).map((d) => d.key)).toEqual([
      "pe",
    ]);
  });
});

describe("picksQuery", () => {
  it("builds the chip query and omits defaults", () => {
    expect(picksQuery(null, null)).toBe("");
    expect(picksQuery("setup", null)).toBe("?status=setup");
    expect(picksQuery(null, "roe")).toBe("?sort=roe");
    expect(picksQuery("watch", "pe")).toBe("?status=watch&sort=pe");
  });
});

describe("sortPickRows (mirrors sort.go)", () => {
  it("sorts measured figures highest first, unknowns last in rank order, without mutating", () => {
    const rows = [
      row(1, { fundamentals: { roePct: 12 } }),
      row(2),
      row(3, { fundamentals: { roePct: 31.5 } }),
      row(4, { fundamentals: {} }),
      row(5, { fundamentals: { roePct: 12 } }),
    ];
    const before = codes(rows);
    expect(codes(sortPickRows(rows, "roe"))).toEqual([
      "C3",
      "C1",
      "C5",
      "C2",
      "C4",
    ]);
    expect(codes(rows)).toEqual(before);
  });

  it("sorts P/E lowest first", () => {
    const rows = [
      row(1, { fundamentals: { peRatio: 22 } }),
      row(2, { fundamentals: { peRatio: 8.5 } }),
      row(3),
    ];
    expect(codes(sortPickRows(rows, "pe"))).toEqual(["C2", "C1", "C3"]);
  });

  it("puts growth beyond +500% or below -95% after every measured figure, before unknowns", () => {
    const rows = [
      row(1, { revenueYoyPct: 812 }),
      row(2, { revenueYoyPct: null }),
      row(3, { revenueYoyPct: -99 }),
      row(4, { revenueYoyPct: 4 }),
      row(5, { revenueYoyPct: 500 }),
      row(6, { revenueYoyPct: -95 }),
    ];
    expect(codes(sortPickRows(rows, "revenue_yoy"))).toEqual([
      "C5",
      "C4",
      "C6",
      "C1",
      "C3",
      "C2",
    ]);
  });

  it("sorts market cap from the row's resolved figure", () => {
    const rows = [
      row(1, { marketCap: 2e9 }),
      row(2, { marketCap: 9e9 }),
      row(3),
    ];
    expect(codes(sortPickRows(rows, "market_cap"))).toEqual(["C2", "C1", "C3"]);
    expect(pickSortDef("market_cap").hasColumn).toBe(false);
    expect(pickSortDef("revenue_yoy").hasColumn).toBe(true);
  });

  it("describes the market cap it sorts by, the screener fallback included", () => {
    // The API resolves a pick's market cap as close x shares, falling back to
    // the screener's figure when no share count is held (ResolvedMarketCap):
    // the tooltip must not promise one figure and sort by another.
    const { title } = pickSortDef("market_cap");
    expect(title).toBe(
      "Latest close x shares on issue, in AUD; the screener's figure where we hold no share count",
    );
    const emDash = String.fromCharCode(0x2014);
    for (const def of PICK_SORTS) expect(def.title).not.toContain(emDash);
  });
});

describe("isRankOrder", () => {
  it("is true only for strictly increasing ranks", () => {
    expect(isRankOrder([])).toBe(true);
    expect(isRankOrder([row(1), row(2), row(9)])).toBe(true);
    expect(isRankOrder([row(2), row(1)])).toBe(false);
  });
});
