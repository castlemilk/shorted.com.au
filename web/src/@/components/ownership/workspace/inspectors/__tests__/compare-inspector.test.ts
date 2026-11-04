/// <reference types="jest" />

import { compareInspectorContent, compareReading, COMPARE_ONLY_LIMIT } from "../compare-inspector";
import { compareFunds, type FundPortfolio, type PortfolioHolding } from "../../../funds/fund-model";

const MINUS = String.fromCharCode(0x2212);
const EM_DASH = String.fromCharCode(0x2014);

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

function fund(
  ticker: string,
  asAt: string,
  sectors: Array<[string, number | null]>,
  holdings: PortfolioHolding[],
): FundPortfolio {
  return {
    key: `asx:${ticker}`,
    ticker,
    name: `${ticker} fund`,
    institutionSlug: "betashares",
    institutionName: "Betashares",
    sourceKind: "etf",
    pooled: false,
    asAt,
    sourceUrl: `https://example.com/${ticker}.csv`,
    snapshotDates: [asAt],
    holdings,
    holdingsTotal: holdings.length,
    top10Pct: null,
    sectorWeights: sectors.map(([industry, weightPct]) => ({ industry, weightPct })),
  };
}

/**
 * A200: Banks 30, Materials 12; holds CBA, BHP and RIO. IOZ: Banks 28.10, Health Care 9; holds CBA and CSL. Both
 * hold CBA, so A200 alone holds BHP and RIO and IOZ alone holds CSL.
 */
function pair() {
  const a = fund(
    "A200",
    "2026-11-02",
    [
      ["Banks", 30],
      ["Materials", 12],
    ],
    [held("CBA", 30, "Banks"), held("BHP", 8), held("RIO", 3)],
  );
  const b = fund(
    "IOZ",
    "2026-10-31",
    [
      ["Banks", 28.1],
      ["Health Care", 9],
    ],
    [held("CBA", 28.1, "Banks"), held("CSL", 9, "Health Care")],
  );
  return { a, b };
}

describe("the compare inspector content (backlog C5)", () => {
  it("names both funds in the heading and dates each file in the subtitle", () => {
    const { a, b } = pair();
    const content = compareInspectorContent(a, b);
    expect(content.heading).toBe("A200 vs IOZ");
    expect(content.subtitle).toBe("A200 at 2026-11-02 · IOZ at 2026-10-31");
    expect(content.logo).toBeUndefined();
    expect(content.rows).toEqual([]);
  });

  it("prints the sector weights side by side with the difference, largest difference first, a true minus where it is one", () => {
    const { a, b } = pair();
    const content = compareInspectorContent(a, b);
    const sectors = content.sections?.[0];
    expect(sectors).toMatchObject({ title: "Sector weights, A200 / IOZ", kind: "rows" });
    if (sectors?.kind !== "rows") throw new Error("expected rows");
    expect(sectors.items).toEqual([
      { label: "Materials", value: "12.00% / 0.00% (+12.00 pp)" },
      { label: "Health Care", value: `0.00% / 9.00% (${MINUS}9.00 pp)` },
      { label: "Banks", value: "30.00% / 28.10% (+1.90 pp)" },
    ]);
  });

  it("prints n/a for a weight a file does not state, and drops the difference that needs it", () => {
    const a = fund("A200", "2026-11-02", [["Banks", null]], [held("CBA", null, "Banks")]);
    const b = fund("IOZ", "2026-10-31", [["Banks", 20]], [held("CBA", 20, "Banks")]);
    const content = compareInspectorContent(a, b);
    const sectors = content.sections?.[0];
    if (sectors?.kind !== "rows") throw new Error("expected rows");
    expect(sectors.items).toEqual([{ label: "Banks", value: "n/a / 20.00%" }]);
  });

  it("lists the holdings only one fund holds, titled with the count, and the ten largest of each", () => {
    const { a, b } = pair();
    const content = compareInspectorContent(a, b);
    const only = content.sections?.slice(1) ?? [];
    expect(only.map((section) => section.title)).toEqual(["Only in A200 (2)", "Only in IOZ (1)"]);
    const first = only[0];
    if (first?.kind !== "rows") throw new Error("expected rows");
    expect(first.items).toEqual([
      { label: "BHP", value: "8.00%" },
      { label: "RIO", value: "3.00%" },
    ]);
  });

  it("keeps the ten largest holdings of a long only-in list, and the count is the whole list", () => {
    const many = Array.from({ length: COMPARE_ONLY_LIMIT + 5 }, (_, index) => held(`X${index}`, 20 - index * 0.1));
    const a = fund("A200", "2026-11-02", [], many);
    const b = fund("IOZ", "2026-10-31", [], []);
    const content = compareInspectorContent(a, b);
    const section = content.sections?.find((item) => item.title.startsWith("Only in A200"));
    expect(section?.title).toBe(`Only in A200 (${COMPARE_ONLY_LIMIT + 5})`);
    if (section?.kind !== "rows") throw new Error("expected rows");
    expect(section.items).toHaveLength(COMPARE_ONLY_LIMIT);
    expect(section.items[0]).toEqual({ label: "X0", value: "20.00%" });
  });

  it("leaves out an only-in section with no holding in it, rather than a titled section over no rows", () => {
    const same = [held("CBA", 10, "Banks")];
    const a = fund("A200", "2026-11-02", [["Banks", 10]], same);
    const b = fund("IOZ", "2026-10-31", [["Banks", 10]], same);
    const content = compareInspectorContent(a, b);
    expect(content.sections?.map((section) => section.title)).toEqual(["Sector weights, A200 / IOZ"]);
  });

  it("opens the Changes page on the first fund, the bar's link, and links to each fund's page", () => {
    const { a, b } = pair();
    const content = compareInspectorContent(a, b);
    expect(content.primary).toEqual({ label: "Compare portfolios →", href: "/ownership/changes?fund=asx%3AA200" });
    expect(content.links).toEqual([
      { label: "A200 portfolio", href: "/ownership/funds/asx%3AA200" },
      { label: "IOZ portfolio", href: "/ownership/funds/asx%3AIOZ" },
    ]);
  });

  it("carries the footnote on whose weights these are, and never an em dash", () => {
    const { a, b } = pair();
    const content = compareInspectorContent(a, b);
    expect(content.footnote).toBe("Weights are each fund's own file; a difference is of weights, not a trade.");
    const text = JSON.stringify(content);
    expect(text).not.toContain(EM_DASH);
  });

  it("prints a file with no date as n/a, never as an empty date", () => {
    const a = fund("A200", "", [], []);
    const b = fund("IOZ", "2026-10-31", [], []);
    expect(compareInspectorContent(a, b).subtitle).toBe("A200 at n/a · IOZ at 2026-10-31");
  });
});

describe("the compare reading (C1 pattern)", () => {
  it("reads the sector the funds differ most in, which is heavier there, and then the holdings only each holds", () => {
    const { a, b } = pair();
    const reading = compareReading({ first: "A200", second: "IOZ" }, compareFunds(a, b), {
      first: true,
      second: true,
    });
    expect(reading).toBe(
      "A200 and IOZ differ most in Materials, 12.00 pp (A200 heavier); 2 holdings only A200 holds, 1 only IOZ.",
    );
  });

  it("names the second fund as the heavier one when its sector weight is the larger", () => {
    const a = fund("A200", "2026-11-02", [["Banks", 10]], [held("CBA", 10, "Banks")]);
    const b = fund("IOZ", "2026-10-31", [["Banks", 14.2]], [held("CBA", 14.2, "Banks")]);
    const reading = compareReading({ first: "A200", second: "IOZ" }, compareFunds(a, b), { first: true, second: true });
    expect(reading).toBe("A200 and IOZ differ most in Banks, 4.20 pp (IOZ heavier); 0 holdings only A200 holds, 0 only IOZ.");
  });

  it("drops the sector clause when no sector difference is stated, and keeps the holdings clause", () => {
    const a = fund("A200", "2026-11-02", [], [held("BHP", 8)]);
    const b = fund("IOZ", "2026-10-31", [], [held("CSL", 9, "Health Care")]);
    const reading = compareReading({ first: "A200", second: "IOZ" }, compareFunds(a, b), { first: true, second: true });
    expect(reading).toBe("1 holding only A200 holds, 1 only IOZ.");
  });

  it("drops the sector clause when the largest difference rounds to 0.00 pp, and keeps the holdings clause", () => {
    const a = fund("A200", "2026-11-02", [["Banks", 20.001]], [held("CBA", 20, "Banks")]);
    const b = fund("IOZ", "2026-10-31", [["Banks", 20]], [held("CBA", 20, "Banks")]);
    const reading = compareReading({ first: "A200", second: "IOZ" }, compareFunds(a, b), { first: true, second: true });
    expect(reading).toBe("0 holdings only A200 holds, 0 only IOZ.");
  });

  it("drops the holdings clause when a file lists no holdings, since an empty file is not a file with no unique holdings", () => {
    const { a, b } = pair();
    const diff = compareFunds(a, b);
    expect(compareReading({ first: "A200", second: "IOZ" }, diff, { first: false, second: true })).toBe(
      "A200 and IOZ differ most in Materials, 12.00 pp (A200 heavier).",
    );
  });

  it("has no reading at all when neither clause has a figure", () => {
    const empty = fund("A200", "2026-11-02", [], []);
    const other = fund("IOZ", "2026-10-31", [], []);
    expect(compareReading({ first: "A200", second: "IOZ" }, compareFunds(empty, other), { first: false, second: false })).toBeUndefined();
    expect(compareInspectorContent(empty, other).reading).toBeUndefined();
  });

  it("states the true minus nowhere in the reading, which names the heavier fund instead of signing the figure", () => {
    const { a, b } = pair();
    const reading = compareInspectorContent(a, b).reading ?? "";
    expect(reading).not.toContain(MINUS);
    expect(reading).toContain("(A200 heavier)");
  });
});
