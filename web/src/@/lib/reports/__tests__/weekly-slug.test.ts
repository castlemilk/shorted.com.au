import {
  weekDbSlugToPathSlug,
  weeklyReportPath,
  resolveWeeklySlugParam,
} from "../weekly-slug";

describe("weekly-slug", () => {
  it("maps DB slugs to canonical unpadded path slugs", () => {
    expect(weekDbSlugToPathSlug("2026-W29")).toBe(
      "10-most-shorted-asx-stocks-week-29-2026",
    );
    expect(weekDbSlugToPathSlug("2026-W05")).toBe(
      "10-most-shorted-asx-stocks-week-5-2026",
    );
    expect(weekDbSlugToPathSlug("garbage")).toBeNull();
  });

  it("builds report paths (falls back to raw slug for malformed input)", () => {
    expect(weeklyReportPath("2026-W29")).toBe(
      "/reports/weekly/10-most-shorted-asx-stocks-week-29-2026",
    );
    expect(weeklyReportPath("nope")).toBe("/reports/weekly/nope");
  });

  it("resolves canonical path slugs as canonical", () => {
    expect(
      resolveWeeklySlugParam("10-most-shorted-asx-stocks-week-29-2026"),
    ).toEqual({ dbSlug: "2026-W29", canonical: true });
  });

  it("treats zero-padded week variants as NON-canonical (must 301)", () => {
    expect(
      resolveWeeklySlugParam("10-most-shorted-asx-stocks-week-05-2026"),
    ).toEqual({ dbSlug: "2026-W05", canonical: false });
  });

  it("treats the ISO form as non-canonical and rejects garbage", () => {
    expect(resolveWeeklySlugParam("2026-W29")).toEqual({
      dbSlug: "2026-W29",
      canonical: false,
    });
    expect(resolveWeeklySlugParam("not-a-slug")).toBeNull();
    expect(
      resolveWeeklySlugParam("10-most-shorted-asx-stocks-week-99-2026"),
    ).toBeNull();
  });
});
