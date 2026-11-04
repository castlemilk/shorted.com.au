import {
  INVESTOR_KINDS,
  KIND_INFO,
  KIND_ORDER,
  OUTCOME_COPY,
  REGISTER_CODE_PATTERN,
  RESERVED_SLUGS,
  WITHHOLDING_OUTCOMES,
  asAtRange,
  fundHref,
  formatHeadlinePct,
  formatVotingPower,
  holderHref,
  isInstitutionSlug,
  isPooledFile,
  kindShortLabel,
  FOLDED_SECTOR_LABEL,
  registerHref,
  shortSector,
} from "../kinds";
import { formatSum } from "~/@/components/ownership/ownership-parts";

describe("formatHeadlinePct (spec A4)", () => {
  it("prints a headline at two decimals, where the notice states four", () => {
    expect(formatHeadlinePct(19.4336)).toBe("19.43%");
    expect(formatHeadlinePct(13.131)).toBe("13.13%");
  });

  it("pads a whole figure to two decimals", () => {
    expect(formatHeadlinePct(5)).toBe("5.00%");
  });

  it("prints a measured zero as 0.00%, never as a missing figure", () => {
    expect(formatHeadlinePct(0)).toBe("0.00%");
  });

  it("prints n/a for a figure the page does not hold: null, undefined, NaN and infinity", () => {
    expect(formatHeadlinePct(null)).toBe("n/a");
    expect(formatHeadlinePct(undefined)).toBe("n/a");
    expect(formatHeadlinePct(Number.NaN)).toBe("n/a");
    expect(formatHeadlinePct(Number.POSITIVE_INFINITY)).toBe("n/a");
  });

  it("takes a true minus for a negative figure, as the rest of the copy does", () => {
    expect(formatHeadlinePct(-2.5)).toBe("−2.50%");
  });

  it("keeps the notice's own precision in formatVotingPower, which the headline does not use", () => {
    expect(formatVotingPower(19.4336)).toBe("19.4336%");
    expect(formatHeadlinePct(19.4336)).not.toBe(formatVotingPower(19.4336));
  });

  it("prints what formatSum prints, the pair the kinds.ts comment names", () => {
    for (const v of [19.4336, 13.131, 5, 0, -2.5, null, undefined, Number.NaN]) {
      expect(formatHeadlinePct(v)).toBe(formatSum(v));
    }
  });
});

describe("shortSector (spec 14.9)", () => {
  it("maps every GICS industry group the API names to a short label", () => {
    const names = [
      "Materials", "Energy", "Software & Services", "Financial Services",
      "Health Care Equipment & Services", "Pharmaceuticals, Biotechnology & Life Sciences",
      "Capital Goods", "Commercial & Professional Services", "Media & Entertainment",
      "Food, Beverage & Tobacco", "Consumer Discretionary Distribution & Retail", "Consumer Services",
      "Equity Real Estate Investment Trusts (REITs)", "Technology Hardware & Equipment", "Transportation",
      "Real Estate Management & Development", "Utilities", "Telecommunication Services",
      "Consumer Durables & Apparel", "Banks", "Household & Personal Products", "Insurance",
      "Automobiles & Components", "Consumer Staples Distribution & Retail",
      "Semiconductors & Semiconductor Equipment",
    ];
    // Every name is known: none falls through to the API's own (long) name.
    expect(names.every((name) => shortSector(name).length < name.length || name.length <= 24)).toBe(true);
    for (const name of names) {
      const short = shortSector(name);
      expect(short).not.toBe("");
      expect(short.length).toBeLessThanOrEqual(24);
    }
    expect(shortSector("Equity Real Estate Investment Trusts (REITs)")).toBe("REITs");
    expect(shortSector("Pharmaceuticals, Biotechnology & Life Sciences")).toBe("Pharma & biotech");
    expect(shortSector("Consumer Discretionary Distribution & Retail")).toBe("Discretionary retail");
    expect(shortSector("Consumer Staples Distribution & Retail")).toBe("Staples retail");
    expect(shortSector("Telecommunication Services")).toBe("Telecoms");
  });

  it("reads a placeholder or empty industry as Other, and keeps an unknown name as the API states it", () => {
    expect(shortSector("")).toBe("Other");
    expect(shortSector(null)).toBe("Other");
    expect(shortSector("Not Applic")).toBe("Other");
    expect(shortSector("Quantum Widgets")).toBe("Quantum Widgets");
  });

  it("names the fold's bucket for every sector past the six largest", () => {
    expect(FOLDED_SECTOR_LABEL).toBe("Other sectors");
  });
});

describe("kindShortLabel (spec B6)", () => {
  it("names each kind by its short label, the names a sankey's gutter is sized from", () => {
    expect(kindShortLabel("super_fund")).toBe("Super");
    expect(kindShortLabel("index_manager")).toBe("Index");
    expect(kindShortLabel("active_manager")).toBe("Active");
    expect(kindShortLabel("hedge_fund")).toBe("Hedge");
    expect(kindShortLabel("bank_broker")).toBe("Bank/broker");
    expect(kindShortLabel("sovereign_public")).toBe("Sovereign");
    expect(kindShortLabel("insurer")).toBe("Insurer");
    expect(kindShortLabel("private_equity")).toBe("PE");
    expect(kindShortLabel("corporate")).toBe("Listed co");
    expect(kindShortLabel("other")).toBe("Other");
    expect(kindShortLabel("unclassified")).toBe("Unclassified");
  });

  it("reads an unknown kind as Unclassified, and an inherited name as Unclassified too", () => {
    expect(kindShortLabel("")).toBe("Unclassified");
    expect(kindShortLabel("made_up_kind")).toBe("Unclassified");
    expect(kindShortLabel("constructor")).toBe("Unclassified");
    expect(kindShortLabel("toString")).toBe("Unclassified");
  });

  it("keeps every short name at twelve characters or fewer, unique, and free of an ellipsis", () => {
    const shorts = Object.keys(KIND_INFO).map((kind) => kindShortLabel(kind));
    for (const short of shorts) {
      expect(short.length).toBeGreaterThan(0);
      expect(short.length).toBeLessThanOrEqual(12);
      expect(short).not.toContain("…");
    }
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it("names every kind with its own short label, never the full one", () => {
    for (const [kind, info] of Object.entries(KIND_INFO)) {
      expect(kindShortLabel(kind)).toBe(info.short);
      expect(info.short.length).toBeLessThanOrEqual(info.label.length);
    }
  });
});

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
    expect(KIND_INFO.corporate.swatch).toBe("bg-[#483932] dark:bg-[#A49994]");
    expect(KIND_INFO.private_equity.swatch).toBe("bg-[#7E5C44] dark:bg-[#A98260]");
  });

  it("gives every kind a light and a dark swatch, so no kind keeps the light hex on the dark page", () => {
    for (const info of Object.values(KIND_INFO)) {
      expect(info.swatch).toMatch(/^bg-\[#[0-9A-F]{6}\] dark:bg-\[#[0-9A-F]{6}\]$/);
    }
  });

  it("keeps each kind's SVG fill pair equal to its swatch, so a chart's mark and a box agree", () => {
    for (const info of Object.values(KIND_INFO)) {
      expect(info.fill).toBe(info.swatch.replace(/bg-/g, "fill-"));
    }
  });

  it("keeps KIND_ORDER and KIND_INFO on the same kinds, so no kind is left out of the order, the table or the colour check", () => {
    expect([...KIND_ORDER].sort()).toEqual(Object.keys(KIND_INFO).sort());
  });

  it("never gives the active manager the amber selection's own hex, which was its old swatch", () => {
    expect(KIND_INFO.active_manager.swatch).not.toMatch(/FFA94D/i);
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

describe("fundHref (spec 14.7)", () => {
  it("encodes the API's fund key as one path segment", () => {
    expect(fundHref("asx:A200")).toBe("/ownership/funds/asx%3AA200");
    expect(fundHref("abn:12345678901")).toBe("/ownership/funds/abn%3A12345678901");
    expect(fundHref("aware/High Growth")).toBe("/ownership/funds/aware%2FHigh%20Growth");
  });
});
