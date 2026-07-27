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
    expect(formatCompanyName("THE A2 MILK COMPANY ORDINARY", "A2M")).toBe(
      "The A2 Milk Company",
    );
    // A trailing full stop must not block the anchored suffix match.
    expect(formatCompanyName("AGL Energy Limited.", "AGL")).toBe("AGL Energy");
  });

  it("cuts instrument metadata at the first security-type token", () => {
    // The ASIC PRODUCT field is `<company> <security type> [qualifiers…]`.
    expect(formatCompanyName("FIDUCIAN GROUP LTD ORDINARY FULLY PAID", "FID")).toBe(
      "Fiducian Group",
    );
    expect(formatCompanyName("LENDLEASE GROUP FPO/UNITS STAPLED", "LLC")).toBe(
      "Lendlease Group",
    );
    expect(formatCompanyName("FLETCHER BUILDING ORD FOR. EXEMPT NZX", "FBU")).toBe(
      "Fletcher Building",
    );
    expect(formatCompanyName("GRAINCORP LIMITED A CLASS ORDINARY", "GNC")).toBe(
      "Graincorp",
    );
    // Space-less venue form — \b would fail between the "I" and the "1".
    expect(formatCompanyName("NEWMONT CORPORATION CDI1:1FOREXEMPT NYSE", "NEM")).toBe(
      "Newmont",
    );
    expect(formatCompanyName("OMNI BRIDGEWAY LTD ORD US PROHIBITED", "OBL")).toBe(
      "Omni Bridgeway",
    );
  });

  it("lowercases a possessive s after an apostrophe", () => {
    expect(
      formatCompanyName("DOMINO'S PIZZA ENTERPRISES LIMITED", "DMP"),
    ).toBe("Domino's Pizza Enterprises");
    // The shape already stored in company-metadata by the old backend
    // title-caser is repaired too, even though it is mixed-case.
    expect(formatCompanyName("Domino'S Pizza Enterprises", "DMP")).toBe(
      "Domino's Pizza Enterprises",
    );
    // A multi-letter token after an apostrophe keeps normal title casing.
    expect(formatCompanyName("O'REILLY GROUP LTD", "ORG")).toBe(
      "O'Reilly Group",
    );
  });

  it("re-cases an all-lowercase name and drops a trailing parenthetical", () => {
    // company-metadata rows written by the old backend title-caser, which
    // capitalised character 0 rather than the first letter.
    expect(formatCompanyName("4dmedical", "4DX")).toBe("4Dmedical");
    expect(formatCompanyName("29metals", "29M")).toBe("29Metals");
    // A trailing parenthetical blocks the anchored entity-suffix match.
    expect(formatCompanyName("Environmental Group Limited (The)", "EGL")).toBe(
      "Environmental Group",
    );
    // A genuinely mixed-case name still carries intentional casing.
    expect(formatCompanyName("Woolworths Group", "WOW")).toBe(
      "Woolworths Group",
    );
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
