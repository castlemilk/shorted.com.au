/// <reference types="jest" />
import {
  SHORTS_CHANGE_LIMITS,
  broadShortsRevalidation,
  narrowShortsRevalidation,
  parseShortsChange,
} from "../shorts-change";

describe("parseShortsChange", () => {
  it("is none when the body carries no change set", () => {
    expect(parseShortsChange(null)).toEqual({ kind: "none" });
    expect(parseShortsChange("text")).toEqual({ kind: "none" });
    expect(parseShortsChange({ other: true })).toEqual({ kind: "none" });
  });

  it("reads a change set, normalised, deduplicated and sorted", () => {
    expect(
      parseShortsChange({
        shorts: { codes: ["cba", " BHP ", "CBA"], dates: ["2026-11-03", "2026-10-28", "2026-11-03"] },
      }),
    ).toEqual({
      kind: "narrow",
      change: { codes: ["BHP", "CBA"], dates: ["2026-10-28", "2026-11-03"] },
    });
  });

  it.each([
    ["shorts is not an object", { shorts: "BHP" }],
    ["codes and dates must be arrays", { shorts: { codes: "BHP", dates: ["2026-11-03"] } }],
    ["a stock code is unreadable", { shorts: { codes: ["BHP", "B H P"], dates: ["2026-11-03"] } }],
    ["a stock code is unreadable", { shorts: { codes: [42], dates: ["2026-11-03"] } }],
    ["a date is not YYYY-MM-DD", { shorts: { codes: ["BHP"], dates: ["2026-02-30"] } }],
    ["the change set names no stock or no date", { shorts: { codes: [], dates: ["2026-11-03"] } }],
    ["the change set names no stock or no date", { shorts: { codes: ["BHP"], dates: [] } }],
  ])("is broad when it cannot trust the set in full: %s", (reason, body) => {
    expect(parseShortsChange(body)).toEqual({ kind: "broad", reason });
  });

  it("is broad past either ceiling", () => {
    const codes = Array.from({ length: SHORTS_CHANGE_LIMITS.codes + 1 }, (_, i) => `C${i}`);
    expect(parseShortsChange({ shorts: { codes, dates: ["2026-11-03"] } })).toEqual({
      kind: "broad",
      reason: `more than ${SHORTS_CHANGE_LIMITS.codes} stocks`,
    });
    const dates = Array.from({ length: SHORTS_CHANGE_LIMITS.dates + 1 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    );
    expect(parseShortsChange({ shorts: { codes: ["BHP"], dates } })).toEqual({
      kind: "broad",
      reason: `more than ${SHORTS_CHANGE_LIMITS.dates} dates`,
    });
  });
});

describe("narrowShortsRevalidation", () => {
  const plan = narrowShortsRevalidation({
    codes: ["BHP", "CBA"],
    dates: ["2026-10-28", "2026-11-03"],
  });

  it("expires each written stock by its own tag", () => {
    expect(plan.stockTags).toEqual(["stock:BHP", "stock:CBA"]);
  });

  it("never expires every stock, every market date or every report", () => {
    expect(plan.tags).not.toContain("shorts-data");
    expect(plan.patterns).toEqual([]);
    expect(plan.paths.some((p) => p.includes("["))).toBe(false);
  });

  it("refreshes the newest-snapshot reads and the market index", () => {
    expect(plan.tags).toEqual(expect.arrayContaining(["shorts-latest", "market-index"]));
    expect(plan.paths).toContain("/market");
  });

  it("refreshes each written date's market page and the reports that cover it", () => {
    expect(plan.tags).toEqual(
      expect.arrayContaining([
        "market-date:2026-10-28",
        "market-date:2026-11-03",
        "report-2026-W44",
        "report-2026-W45",
        "report-2026-10",
        "report-2026-11",
        "report-2026",
      ]),
    );
    expect(plan.paths).toEqual(
      expect.arrayContaining([
        "/market/2026-10-28",
        "/market/2026-11-03",
        "/reports/weekly/10-most-shorted-asx-stocks-week-44-2026",
        "/reports/weekly/10-most-shorted-asx-stocks-week-45-2026",
        "/reports/monthly/2026-10",
        "/reports/monthly/2026-11",
        "/reports/yearly/2026",
      ]),
    );
  });

  it("does not expire the report archive: a corrected date is not a new report", () => {
    expect(plan.tags).not.toContain("reports-index");
  });
});

describe("broadShortsRevalidation", () => {
  it("is the revalidation every shorts event used to get", () => {
    expect(broadShortsRevalidation()).toEqual({
      tags: ["shorts-data", "market-index"],
      stockTags: [],
      paths: ["/market"],
      patterns: [
        "/market/[date]",
        "/reports/weekly/[slug]",
        "/reports/monthly/[slug]",
        "/reports/yearly/[slug]",
      ],
    });
  });
});
