import { industryLabel, isPlaceholderIndustrySlug } from "./industry-placeholder";
import { createSlug } from "./industry-slug";

describe("industryLabel", () => {
  it.each([
    ["Materials", "Materials"],
    ["  Banks\n", "Banks"],
    ["Real Estate Investment Trusts (REITs)", "Real Estate Investment Trusts (REITs)"],
  ])("gives a real industry %p back, trimmed", (raw, label) => {
    expect(industryLabel(raw)).toBe(label);
  });

  // What the ASX writes for a security it has not classified ("Not Applic" for an
  // ETF or a trust, "Class Pend" while it is pending), and "Other", the bucket
  // the industry pages put all of them in.
  it.each([
    "Not Applic",
    "Not Applicable",
    "Class Pend",
    "Other",
    "NOT APPLIC",
    "not applicable",
    "class pend",
    "OTHER",
    "  Not Applic  ",
    "Class Pend\n",
  ])("gives nothing for the placeholder %p", (raw) => {
    expect(industryLabel(raw)).toBe("");
  });

  it.each([undefined, null, "", "   "])("gives nothing for no industry at all (%p)", (raw) => {
    expect(industryLabel(raw)).toBe("");
  });

  it("keeps a real industry whose name only starts like a placeholder", () => {
    expect(industryLabel("Not Applic Holdings")).toBe("Not Applic Holdings");
    expect(industryLabel("Other Financials")).toBe("Other Financials");
  });
});

describe("isPlaceholderIndustrySlug", () => {
  it.each(["not-applic", "not-applicable", "class-pend", "other", "", null, undefined])(
    "is true for the placeholder slug %p",
    (slug) => {
      expect(isPlaceholderIndustrySlug(slug)).toBe(true);
    },
  );

  it.each(["materials", "banks", "other-financials", "not-applic-holdings"])(
    "is false for the real industry slug %p",
    (slug) => {
      expect(isPlaceholderIndustrySlug(slug)).toBe(false);
    },
  );

  it("agrees with industryLabel on every placeholder's slug", () => {
    for (const name of ["Not Applic", "Not Applicable", "Class Pend", "Other"]) {
      expect(industryLabel(name)).toBe("");
      expect(isPlaceholderIndustrySlug(createSlug(name))).toBe(true);
    }
  });
});
