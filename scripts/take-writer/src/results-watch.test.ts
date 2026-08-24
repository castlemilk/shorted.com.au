// Every headline in this file is a REAL one from asx_announcements, pulled
// while building the classifier. That matters: the near-misses below are the
// whole reason the module exists, and inventing plausible-looking test data
// would have missed all of them.
import { describe, expect, it } from "vitest";
import { classifyResultsFiling, rankFilings, type ResultsFiling } from "./results-watch";

describe("classifyResultsFiling — real filings", () => {
  it("catches the statutory Appendix 4D/4E filing", () => {
    // 4E is THE full-year results document, and upstream files 4,106 of these
    // under announcement_type='other'.
    expect(classifyResultsFiling("Appendix 4E & Financial Report for year ended 30 June 2026")).toBe("appendix_4de");
    expect(classifyResultsFiling("FY26 Appendix 4E and Annual Report")).toBe("appendix_4de");
    expect(classifyResultsFiling("Appendix 4E & Annual Report for Year Ending 30 June 2026")).toBe("appendix_4de");
  });

  it("prefers the statutory filing when a headline mentions both", () => {
    // "Appendix 4E and Annual Report" is the 4E, not the annual report.
    expect(classifyResultsFiling("FY26 Appendix 4E and Annual Report")).toBe("appendix_4de");
  });

  it("catches annual reports", () => {
    expect(classifyResultsFiling("Annual Report to shareholders")).toBe("annual_report");
  });

  it("catches period results releases", () => {
    expect(classifyResultsFiling("FY26 Financial Results and Dividend")).toBe("period_results");
    expect(classifyResultsFiling("FY26 Results Release")).toBe("period_results");
  });
});

describe("classifyResultsFiling — the near-misses that make this hard", () => {
  it("rejects a scheduling notice", () => {
    // Triggering research here would produce an article analysing results that
    // have not been published yet.
    expect(classifyResultsFiling("FY26 Results Date and Market Briefing")).toBeNull();
  });

  it("rejects webinar and presentation invitations", () => {
    expect(classifyResultsFiling("AMX to present FY26 Results at Coffee Microcaps Webinar")).toBeNull();
    expect(classifyResultsFiling("Advanced Braking Technology FY26 Results Webinar")).toBeNull();
  });

  it("rejects dividend administration", () => {
    // 89% of the upstream 'earnings' bucket is this.
    expect(classifyResultsFiling("Dividend/Distribution - AMA")).toBeNull();
    expect(classifyResultsFiling("Update - Dividend/Distribution - ALK")).toBeNull();
    expect(classifyResultsFiling("Confirmation of Final Dividend Payment Date")).toBeNull();
  });

  it("still accepts a results release that happens to mention the dividend", () => {
    // The exclusion must not swallow the real thing.
    expect(classifyResultsFiling("FY26 Financial Results and Dividend")).toBe("period_results");
  });

  it("rejects unrelated announcements", () => {
    for (const h of [
      "Trading Halt",
      "Change of Director's Interest Notice",
      "Quarterly Activities Report",
      "Notice of Annual General Meeting",
      "",
    ]) {
      expect(classifyResultsFiling(h)).toBeNull();
    }
  });

  it("rejects a buy-back notice that mentions the financial year", () => {
    expect(classifyResultsFiling("FY26 Dividend Declared and On-Market Share Buy-Back")).toBeNull();
  });
});

describe("rankFilings", () => {
  const f = (stockCode: string, kind: ResultsFiling["kind"]): ResultsFiling => ({
    stockCode,
    kind,
    announcementDate: "2026-08-21",
    headline: "h",
    pdfUrl: null,
  });

  it("puts the most-shorted company first", () => {
    // Reporting season queues dozens of filings a day and a research cycle is
    // not free, so the ordering decides what actually gets written.
    const ranked = rankFilings(
      [f("AAA", "appendix_4de"), f("DRO", "appendix_4de"), f("BBB", "appendix_4de")],
      new Map([["AAA", 1.2], ["DRO", 14.98], ["BBB", 0.3]]),
    );
    expect(ranked.map((x) => x.stockCode)).toEqual(["DRO", "AAA", "BBB"]);
  });

  it("weights a statutory filing above a bare annual report", () => {
    const ranked = rankFilings(
      [f("AAA", "annual_report"), f("BBB", "appendix_4de")],
      new Map([["AAA", 10], ["BBB", 8]]),
    );
    // 8 x 2 beats 10 x 1.
    expect(ranked[0]!.stockCode).toBe("BBB");
  });

  it("is deterministic when nothing is shorted", () => {
    const ranked = rankFilings([f("ZZZ", "annual_report"), f("AAA", "annual_report")], new Map());
    expect(ranked.map((x) => x.stockCode)).toEqual(["AAA", "ZZZ"]);
  });
});

describe("regressions found only by running over 632 real headlines", () => {
  // Both of these passed the hand-written tests above while being broken.
  it("accepts a results release with no definite article", () => {
    expect(classifyResultsFiling("Media Release - Result for year ended 30 June 2026")).toBe("period_results");
  });

  it("accepts a real release that also advertises a webinar", () => {
    // The webinar exclusion was swallowing a genuine filing — the same
    // over-broad-exclusion bug as the dividend rule.
    expect(classifyResultsFiling("FY26 Financial Results Release and Webinar")).toBe("period_results");
  });

  it("still rejects a webinar with no release language", () => {
    expect(classifyResultsFiling("Advanced Braking Technology FY26 Results Webinar")).toBeNull();
    expect(classifyResultsFiling("Neuren H1 2026 Financial Results Webinar on 26 August 2026")).toBeNull();
  });

  it("rejects AGM and general-meeting voting outcomes", () => {
    for (const h of ["Results of Meeting", "Results of 2025 Annual General Meeting", "Results of General Meeting - Share Issue Approvals"]) {
      expect(classifyResultsFiling(h)).toBeNull();
    }
  });
});

describe("regressions found by running the CLI against prod", () => {
  it("rejects advance notices of a results briefing", () => {
    // Reached the ranked output before the notice rule was broadened beyond
    // agm/meeting.
    expect(classifyResultsFiling("Notice of FY26 Results Market Briefing")).toBeNull();
  });

  it("rejects presentation registration logistics", () => {
    expect(classifyResultsFiling("PolyNovo FY26 Results Presentation - Registration Details")).toBeNull();
  });

  it("still accepts the filings that ranked alongside them", () => {
    expect(classifyResultsFiling("2026 GYG Full Year Report and Appendix 4E")).toBe("appendix_4de");
    expect(classifyResultsFiling("Telix HY26 Results Announcement")).toBe("period_results");
    expect(classifyResultsFiling("Media Release - Full Year Results to 30 June 2026")).toBe("period_results");
  });
});
