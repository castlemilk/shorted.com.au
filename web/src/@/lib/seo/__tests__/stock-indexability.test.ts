import {
  isStockIndexable,
  isStockSitemapEligible,
  STOCK_INDEX_MIN_SHORT_PCT,
  VALID_STOCK_CODE,
} from "../stock-indexability";

describe("isStockIndexable", () => {
  it("indexes enriched companies regardless of short % (rescues BXB/DOW/CNB/HCL)", () => {
    // Real companies with industry metadata — should index even at ~0% short.
    expect(isStockIndexable({ code: "BXB", name: "BRAMBLES LIMITED", industry: "Industrials", percentShorted: 0.496 })).toBe(true);
    expect(isStockIndexable({ code: "DOW", name: "DOWNER EDI LIMITED", industry: "Industrials", percentShorted: 0.399 })).toBe(true);
    expect(isStockIndexable({ code: "CNB", name: "CARNABY RESOURCE", industry: "Materials", percentShorted: 0.012 })).toBe(true);
    expect(isStockIndexable({ code: "HCL", name: "HIGHCOM LIMITED", industry: "Industrials", percentShorted: 0 })).toBe(true);
  });

  it("indexes meaningfully-shorted stocks even without an industry classification", () => {
    expect(isStockIndexable({ code: "ABC", name: "SOME CO", industry: "", percentShorted: 0.6 })).toBe(true);
    expect(isStockIndexable({ code: "ABC", name: "SOME CO", percentShorted: STOCK_INDEX_MIN_SHORT_PCT })).toBe(true);
  });

  it("noindexes thin stubs: no industry AND short % below the floor (JREG/WEMG)", () => {
    expect(isStockIndexable({ code: "JREG", name: "JADE GAS HOLDINGS", industry: "", percentShorted: 0.083 })).toBe(false);
    expect(isStockIndexable({ code: "WEMG", name: "WEB TRAVEL GROUP", industry: null, percentShorted: 0.004 })).toBe(false);
  });

  it("requires a company name", () => {
    expect(isStockIndexable({ code: "BHP", name: "", industry: "Materials", percentShorted: 1.4 })).toBe(false);
    expect(isStockIndexable({ code: "BHP", name: "   ", industry: "Materials", percentShorted: 1.4 })).toBe(false);
    expect(isStockIndexable({ code: "BHP", name: undefined, industry: "Materials", percentShorted: 1.4 })).toBe(false);
  });

  it("rejects codes the /shorts/[code] route cannot serve (>4 chars / non-alnum)", () => {
    expect(isStockIndexable({ code: "GSBW30", name: "GOVT BOND", industry: "Government", percentShorted: 5 })).toBe(false);
    expect(isStockIndexable({ code: "bhp", name: "BHP", industry: "Materials", percentShorted: 1.4 })).toBe(false);
    expect(isStockIndexable({ code: "", name: "X", industry: "Y", percentShorted: 1 })).toBe(false);
  });

  it("treats null/undefined short % as 0", () => {
    expect(isStockIndexable({ code: "ABC", name: "CO", percentShorted: null })).toBe(false);
    expect(isStockIndexable({ code: "ABC", name: "CO" })).toBe(false);
    // ...but still indexes if it has industry
    expect(isStockIndexable({ code: "ABC", name: "CO", industry: "Energy" })).toBe(true);
  });
});

describe("isStockSitemapEligible", () => {
  it("lists named stocks at or above the floor", () => {
    expect(isStockSitemapEligible({ code: "BXB", name: "BRAMBLES", percentShorted: 0.496 })).toBe(true);
    expect(isStockSitemapEligible({ code: "ABC", name: "CO", percentShorted: STOCK_INDEX_MIN_SHORT_PCT })).toBe(true);
  });

  it("excludes stocks below the floor (they remain page-indexable via industry, just not in the sitemap)", () => {
    expect(isStockSitemapEligible({ code: "CNB", name: "CARNABY", percentShorted: 0.012 })).toBe(false);
    expect(isStockSitemapEligible({ code: "HCL", name: "HIGHCOM", percentShorted: 0 })).toBe(false);
  });

  it("requires a name and a valid code", () => {
    expect(isStockSitemapEligible({ code: "ABC", name: "", percentShorted: 5 })).toBe(false);
    expect(isStockSitemapEligible({ code: "GSBW30", name: "BOND", percentShorted: 5 })).toBe(false);
  });
});

describe("sitemap eligibility is a strict subset of indexability (no conflicting signals)", () => {
  // Property: anything the sitemap lists must also be indexed by the page.
  const codes = ["BHP", "AB1", "Z9"];
  const names = ["", "Some Company"];
  const industries = ["", "Energy"];
  const pcts = [0, 0.05, STOCK_INDEX_MIN_SHORT_PCT, 0.25, 0.5, 2];

  for (const code of codes) {
    for (const name of names) {
      for (const industry of industries) {
        for (const percentShorted of pcts) {
          it(`code=${code} name="${name}" industry="${industry}" pct=${percentShorted}`, () => {
            const sitemap = isStockSitemapEligible({ code, name, percentShorted });
            const indexable = isStockIndexable({ code, name, industry, percentShorted });
            if (sitemap) expect(indexable).toBe(true);
          });
        }
      }
    }
  }
});

describe("VALID_STOCK_CODE", () => {
  it("matches 1-4 uppercase alphanumeric codes only", () => {
    expect(VALID_STOCK_CODE.test("BHP")).toBe(true);
    expect(VALID_STOCK_CODE.test("4DX")).toBe(true);
    expect(VALID_STOCK_CODE.test("GSBW30")).toBe(false);
    expect(VALID_STOCK_CODE.test("bhp")).toBe(false);
  });
});
