/// <reference types="jest" />
import {
  STOCK_CODE_PATTERN,
  asOfClauseFor,
  cleanCompanyName,
  formatAsOfDate,
} from "../stock-page-shared";

describe("STOCK_CODE_PATTERN", () => {
  it.each(["BHP", "A2M", "Z", "ABCD", "4DX"])("accepts %s", (code) => {
    expect(STOCK_CODE_PATTERN.test(code)).toBe(true);
  });

  it.each(["", "ABCDE", "BH-P", "BHP ", " BHP", "../X", "B.P"])("rejects %j", (code) => {
    expect(STOCK_CODE_PATTERN.test(code)).toBe(false);
  });
});

describe("cleanCompanyName", () => {
  it("title-cases the raw ASIC product string and drops its security descriptor", () => {
    expect(cleanCompanyName("BHP GROUP LIMITED ORDINARY", "BHP")).toBe("BHP Group");
  });
});

describe("formatAsOfDate", () => {
  it("formats an ASIC report date as en-AU day, short month and year", () => {
    expect(formatAsOfDate(new Date("2026-10-02T00:00:00Z"))).toBe("2 Oct 2026");
  });

  it("reads the Sydney calendar day, so a UTC-hosted render cannot show the previous day", () => {
    // 15:00 UTC on 1 Oct is 01:00 on 2 Oct in Sydney (AEST, UTC+10).
    expect(formatAsOfDate(new Date("2026-10-01T15:00:00Z"))).toBe("2 Oct 2026");
  });
});

describe("asOfClauseFor", () => {
  it("states the report date when there is one", () => {
    expect(asOfClauseFor(new Date("2026-10-02T00:00:00Z"))).toBe("as of 2 Oct 2026");
  });

  it("never invents a date: no report date reads as the latest report", () => {
    expect(asOfClauseFor(null)).toBe("in the latest ASIC report");
  });
});
