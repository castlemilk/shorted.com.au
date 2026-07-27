import { formatCompanyName } from "../company-name";

describe("formatCompanyName", () => {
  it("uppercases a word matching the stock code (backend-mangled name)", () => {
    // The live /shorts/BHP bug: backend returns "Bhp Group".
    expect(formatCompanyName("Bhp Group", "BHP")).toBe("BHP Group");
    expect(formatCompanyName("Csl", "CSL")).toBe("CSL");
    expect(formatCompanyName("Anz Banking Group", "ANZ")).toBe(
      "ANZ Banking Group",
    );
  });

  it("title-cases a shouted source and strips entity suffixes", () => {
    expect(formatCompanyName("BHP GROUP LIMITED", "BHP")).toBe("BHP Group");
    expect(formatCompanyName("COMMONWEALTH BANK OF AUSTRALIA", "CBA")).toBe(
      "Commonwealth Bank of Australia",
    );
  });

  it("keeps short all-caps acronyms uppercase in a shouted source", () => {
    expect(formatCompanyName("NIB HOLDINGS LIMITED", "NHF")).toBe(
      "NIB Holdings",
    );
    expect(formatCompanyName("AGL ENERGY LIMITED", "AGL")).toBe("AGL Energy");
  });

  it("leaves an already well-cased name untouched", () => {
    expect(formatCompanyName("Woolworths Group", "WOW")).toBe(
      "Woolworths Group",
    );
    expect(formatCompanyName("Macquarie Group Limited", "MQG")).toBe(
      "Macquarie Group",
    );
  });

  it("preserves separators, numbers and multi-word structure", () => {
    // Pronounceable code words are NOT shouted — "Rio Tinto" stays as-is.
    expect(formatCompanyName("Rio Tinto Ltd", "RIO")).toBe("Rio Tinto");
    expect(formatCompanyName("Wesfarmers", "WES")).toBe("Wesfarmers");
    expect(formatCompanyName("360 CAPITAL GROUP LIMITED", "TGP")).toBe(
      "360 Capital Group",
    );
  });

  it("strips ASIC security descriptors and handles digit-leading names", () => {
    // Names read off the shorts table carry the raw ASIC PRODUCT field.
    expect(formatCompanyName("4DMEDICAL LIMITED ORDINARY", "4DX")).toBe(
      "4Dmedical",
    );
    expect(formatCompanyName("SANTOS LIMITED ORDINARY", "STO")).toBe("Santos");
    expect(formatCompanyName("BLOCK INC CDI 1:1", "SQ2")).toBe("Block");
    // A trailing full stop must not block the anchored suffix match.
    expect(formatCompanyName("AGL Energy Limited.", "AGL")).toBe("AGL Energy");
  });

  it("falls back to the stock code for empty input", () => {
    expect(formatCompanyName("", "BHP")).toBe("BHP");
    expect(formatCompanyName(undefined, "BHP")).toBe("BHP");
    expect(formatCompanyName(null)).toBe("");
  });

  it("never strips a suffix that is the whole name", () => {
    expect(formatCompanyName("LIMITED", "LTD")).toBe("Limited");
  });
});
