import {
  INVESTOR_KINDS,
  KIND_INFO,
  OUTCOME_COPY,
  REGISTER_CODE_PATTERN,
  RESERVED_SLUGS,
  WITHHOLDING_OUTCOMES,
  asAtRange,
  holderHref,
  isInstitutionSlug,
  isPooledFile,
  registerHref,
} from "../kinds";

describe("ownership kinds", () => {
  it("never lets an institution take a path the ownership section owns", () => {
    expect(RESERVED_SLUGS).toEqual(["stocks", "notices", "insights"]);
    expect(isInstitutionSlug("stocks")).toBe(false);
    expect(isInstitutionSlug("notices")).toBe(false);
    expect(isInstitutionSlug("vanguard")).toBe(true);
  });

  it("links a register by its upper-case code", () => {
    expect(registerHref("bhp")).toBe("/ownership/stocks/BHP");
    expect(registerHref("BHP")).toBe("/ownership/stocks/BHP");
  });

  it("takes one to six upper-case letters or digits as a register code", () => {
    expect(REGISTER_CODE_PATTERN.test("BHP")).toBe(true);
    expect(REGISTER_CODE_PATTERN.test("ABCDEF")).toBe(true);
    expect(REGISTER_CODE_PATTERN.test("ABCDEFG")).toBe(false);
    expect(REGISTER_CODE_PATTERN.test("bhp")).toBe(false);
    expect(REGISTER_CODE_PATTERN.test("")).toBe(false);
  });

  it("keeps a listed holder's name on its own Company tab, and an off-map holder unlinked", () => {
    expect(holderHref("", "asx:SFR")).toBe("/shorts/SFR/company");
    expect(holderHref(null, "asic:9")).toBeNull();
  });

  it("counts investors into a crowded register and leaves banks and brokers out", () => {
    expect([...INVESTOR_KINDS].sort()).toEqual(
      ["active_manager", "hedge_fund", "index_manager", "insurer", "sovereign_public", "super_fund"],
    );
    expect(INVESTOR_KINDS.has("bank_broker")).toBe(false);
  });

  it("says banks' notices are often securities lending", () => {
    expect(KIND_INFO.bank_broker.note).toBe(
      "Often securities lending: shares lent to, or held as collateral from, short sellers.",
    );
  });

  it("gives the two swatches that vanish on the dark page a dark pair", () => {
    expect(KIND_INFO.corporate.swatch).toBe("bg-[#483932] dark:bg-[#B5A48C]");
    expect(KIND_INFO.private_equity.swatch).toBe("bg-[#9E5210] dark:bg-[#C77A2A]");
  });

  it("names every outcome, and withholds only the six that are withheld", () => {
    expect(Object.keys(OUTCOME_COPY).sort()).toEqual(
      [
        "ambiguous_target",
        "fetch_error",
        "implausible",
        "inconsistent_votes",
        "no_holder",
        "no_text",
        "no_voting_power",
        "not_a_notice",
      ].sort(),
    );
    expect(WITHHOLDING_OUTCOMES).toEqual([
      "no_text",
      "no_voting_power",
      "implausible",
      "ambiguous_target",
      "no_holder",
      "inconsistent_votes",
    ]);
    expect(WITHHOLDING_OUTCOMES).not.toContain("not_a_notice");
    expect(WITHHOLDING_OUTCOMES).not.toContain("fetch_error");
  });

  it("prints the copy each withholding outcome carries", () => {
    expect(OUTCOME_COPY.no_text).toBe("no text layer (a scan)");
    expect(OUTCOME_COPY.inconsistent_votes).toBe("votes do not fit the share count");
    expect(OUTCOME_COPY.fetch_error).toBe("not yet downloaded (retried)");
  });

  it("marks only Vanguard's ETF files as pooled", () => {
    expect(isPooledFile({ sourceKind: "etf", institutionSlug: "vanguard" })).toBe(true);
    expect(isPooledFile({ sourceKind: "etf", institutionSlug: "ishares" })).toBe(false);
    expect(isPooledFile({ sourceKind: "super_phd", institutionSlug: "vanguard" })).toBe(false);
  });

  it("dates a source by one date when its files share it, and by the span when they do not", () => {
    expect(asAtRange("2026-10-14", "2026-10-14")).toBe("as at 2026-10-14");
    expect(asAtRange("2026-09-30", "2026-10-31")).toBe("as at 2026-09-30 to 2026-10-31");
    expect(asAtRange("", "2026-10-31")).toBe("as at 2026-10-31");
    expect(asAtRange("", "")).toBe("as at n/a");
  });
});
