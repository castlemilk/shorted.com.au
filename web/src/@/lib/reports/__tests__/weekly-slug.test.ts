import {
  isoWeekDbSlug,
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

  it("names the ISO-8601 week a date falls in, as Go's time.ISOWeek does", () => {
    expect(isoWeekDbSlug("2026-11-03")).toBe("2026-W45");
    // A Thursday on 1 January opens week 1 of its own year.
    expect(isoWeekDbSlug("2026-01-01")).toBe("2026-W01");
    // A Friday on 1 January belongs to the previous year's last week.
    expect(isoWeekDbSlug("2027-01-01")).toBe("2026-W53");
    // A Monday on 30 December can open the next year's week 1.
    expect(isoWeekDbSlug("2024-12-30")).toBe("2025-W01");
    expect(isoWeekDbSlug("2026-12-31")).toBe("2026-W53");
  });

  it("refuses anything that is not a real calendar date", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "20261103", "2026-11-3", "", "2026-11-03T00:00:00Z"]) {
      expect(isoWeekDbSlug(bad)).toBeNull();
    }
  });
});
