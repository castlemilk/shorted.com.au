import { readFileSync } from "fs";
import { join } from "path";
import {
  GROWTH_NOT_MEANINGFUL_ABOVE,
  GROWTH_NOT_MEANINGFUL_BELOW,
  INTEREST_COVER_CAP,
  MINUS,
  MULTIPLE_SUFFIX,
  NET_CASH_LABEL,
  NET_DEBT_LABEL,
  NOT_AVAILABLE,
  NOT_MEANINGFUL,
  NOT_MEANINGFUL_RATIOS,
  NOT_MEANINGFUL_TITLE,
  basisDescription,
  basisLabel,
  distinctSourceLabels,
  formatAmount,
  formatAsOf,
  formatDate,
  formatGrowthPct,
  formatInterestCover,
  formatMultiple,
  formatNetDebt,
  formatPct,
  formatPerShare,
  formatProseAmount,
  formatRatio,
  formatShares,
  isAud,
  isGrowthMeaningful,
  isNotMeaningful,
  periodColumnLabel,
  ratioOrNotMeaningful,
  sourceLabel,
  sourceListLabel,
  valuationNotAvailable,
} from "../format";

// Built from code points so no literal dash sits in the source.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

describe("vocabulary constants", () => {
  it("pins the shared n/a and n/m vocabulary", () => {
    expect(NOT_AVAILABLE).toBe("n/a");
    expect(NOT_MEANINGFUL).toBe("n/m");
    expect(NOT_MEANINGFUL_TITLE).toBe(
      "Not meaningful for banks, insurers and other financials",
    );
    expect(MINUS).toBe("−");
    expect(MULTIPLE_SUFFIX).toBe("×");
    expect(GROWTH_NOT_MEANINGFUL_ABOVE).toBe(500);
    expect(GROWTH_NOT_MEANINGFUL_BELOW).toBe(-95);
    expect(INTEREST_COVER_CAP).toBe(100);
  });

  it("lists exactly the contract §2.7 not-meaningful set", () => {
    expect([...NOT_MEANINGFUL_RATIOS].sort()).toEqual(
      [
        "gross_margin_pct",
        "operating_margin_pct",
        "fcf_margin_pct",
        "fcf_conversion",
        "net_debt",
        "net_debt_to_ebitda",
        "net_debt_to_equity",
        "current_ratio",
        "interest_cover",
      ].sort(),
    );
    expect(Object.isFrozen(NOT_MEANINGFUL_RATIOS)).toBe(true);
  });
});

describe("formatAmount", () => {
  it("prefixes $ only for AUD", () => {
    expect(formatAmount(4_290_000_000, "AUD")).toBe("$4.29B");
    expect(formatAmount(4_290_000_000, "aud")).toBe("$4.29B");
    expect(formatAmount(4_290_000_000, "USD")).toBe("4.29B");
    expect(formatAmount(4_290_000_000, "")).toBe("4.29B");
    expect(formatAmount(4_290_000_000, null)).toBe("4.29B");
    expect(formatAmount(4_290_000_000, undefined)).toBe("4.29B");
  });

  it("prefixes the ISO code for non-AUD amounts in a mixed-currency card", () => {
    expect(formatAmount(4_290_000_000, "USD", { mixed: true })).toBe(
      "USD 4.29B",
    );
    expect(formatAmount(4_290_000_000, "nzd", { mixed: true })).toBe(
      "NZD 4.29B",
    );
    expect(formatAmount(4_290_000_000, "AUD", { mixed: true })).toBe("$4.29B");
    // An unknown currency in a mixed card stays bare rather than guessed.
    expect(formatAmount(4_290_000_000, "", { mixed: true })).toBe("4.29B");
  });

  it("keeps the stock page's original compact precision", () => {
    // Same figures as fundamentals-block.test.tsx's formatCompactAmount cases.
    expect(formatAmount(1_234_000_000_000, "USD")).toBe("1.23T");
    expect(formatAmount(55_658_000_000, "USD")).toBe("55.66B");
    expect(formatAmount(-412_340_000, "USD")).toBe(`${MINUS}412.3M`);
    expect(formatAmount(85_200, "USD")).toBe("85.2K");
    expect(formatAmount(512, "USD")).toBe("512");
    expect(formatAmount(0, "USD")).toBe("0");
    expect(formatAmount(0, "AUD")).toBe("$0");
  });

  it("puts the minus before the currency mark", () => {
    expect(formatAmount(-412_340_000, "AUD")).toBe(`${MINUS}$412.3M`);
    expect(formatAmount(-4_290_000_000, "USD", { mixed: true })).toBe(
      `USD ${MINUS}4.29B`,
    );
  });

  it("rolls a value that rounds to 1000 of its unit into the next unit", () => {
    expect(formatAmount(999_960, "AUD")).toBe("$1.0M");
    expect(formatAmount(999.6, "AUD")).toBe("$1.0K");
    expect(formatAmount(999_996_000_000, "AUD")).toBe("$1.00T");
    expect(formatAmount(999_940, "AUD")).toBe("$999.9K");
  });

  it("never writes a signed zero", () => {
    expect(formatAmount(-0.4, "AUD")).toBe("$0");
    expect(formatAmount(-0.4, "USD")).toBe("0");
  });

  it("renders n/a for anything not held", () => {
    expect(formatAmount(null, "AUD")).toBe(NOT_AVAILABLE);
    expect(formatAmount(undefined, "AUD")).toBe(NOT_AVAILABLE);
    expect(formatAmount(Number.NaN, "AUD")).toBe(NOT_AVAILABLE);
    expect(formatAmount(Number.POSITIVE_INFINITY, "AUD")).toBe(NOT_AVAILABLE);
    expect(formatAmount(Number.NEGATIVE_INFINITY, "USD")).toBe(NOT_AVAILABLE);
  });
});

describe("formatProseAmount", () => {
  it("marks every currency so prose is never misread as AUD", () => {
    expect(formatProseAmount(58_800_000_000, "USD")).toBe("US$58.8B");
    expect(formatProseAmount(1_200_000_000, "NZD")).toBe("NZ$1.2B");
    expect(formatProseAmount(3_100_000_000, "AUD")).toBe("A$3.1B");
    expect(formatProseAmount(2_000_000_000, "GBP")).toBe("£2.0B");
    expect(formatProseAmount(1_200_000_000, "ZAR")).toBe("ZAR 1.2B");
  });

  it("uses one decimal above a thousand and none below", () => {
    expect(formatProseAmount(412_340_000, "AUD")).toBe("A$412.3M");
    expect(formatProseAmount(1_234_000_000_000, "USD")).toBe("US$1.2T");
    expect(formatProseAmount(512, "AUD")).toBe("A$512");
  });

  it("handles negatives, unknown currency and n/a", () => {
    expect(formatProseAmount(-1_200_000_000, "USD")).toBe(`${MINUS}US$1.2B`);
    expect(formatProseAmount(1_200_000_000, "")).toBe("1.2B");
    expect(formatProseAmount(null, "USD")).toBe(NOT_AVAILABLE);
    expect(formatProseAmount(Number.NaN, "USD")).toBe(NOT_AVAILABLE);
  });
});

describe("formatPerShare", () => {
  it("writes dollars with the currency rule of formatAmount", () => {
    expect(formatPerShare(0.94, "AUD")).toBe("$0.94");
    expect(formatPerShare(2.74, "USD")).toBe("2.74");
    expect(formatPerShare(2.74, "USD", { mixed: true })).toBe("USD 2.74");
    expect(formatPerShare(2.74, "AUD", { mixed: true })).toBe("$2.74");
  });

  it("keeps the stock page's original precision, a third digit under ten cents", () => {
    expect(formatPerShare(1.7734, "USD")).toBe("1.77");
    expect(formatPerShare(-0.0451, "USD")).toBe(`${MINUS}0.045`);
    expect(formatPerShare(-0.0451, "AUD")).toBe(`${MINUS}$0.045`);
    expect(formatPerShare(0, "USD")).toBe("0.00");
    expect(formatPerShare(-0.0001, "AUD")).toBe("$0.000");
    expect(formatPerShare(1234.5, "AUD")).toBe("$1,234.50");
  });

  it("renders n/a for anything not held", () => {
    expect(formatPerShare(null, "AUD")).toBe(NOT_AVAILABLE);
    expect(formatPerShare(undefined, "USD", { mixed: true })).toBe(
      NOT_AVAILABLE,
    );
    expect(formatPerShare(Number.NaN, "AUD")).toBe(NOT_AVAILABLE);
  });
});

describe("formatShares", () => {
  it("is compact with no currency mark", () => {
    expect(formatShares(5_074_000_000)).toBe("5.07B");
    expect(formatShares(812_400)).toBe("812.4K");
    expect(formatShares(null)).toBe(NOT_AVAILABLE);
  });
});

describe("formatNetDebt", () => {
  it("labels positive net debt and turns a negative into net cash", () => {
    expect(formatNetDebt(2_100_000_000, "AUD")).toEqual({
      label: NET_DEBT_LABEL,
      text: "$2.10B",
    });
    // FMG FY24 (contract §2.9): 5,400 - 815 - 4,903 = -318 (millions, USD).
    expect(formatNetDebt(-318_000_000, "USD")).toEqual({
      label: NET_CASH_LABEL,
      text: "318.0M",
    });
    expect(formatNetDebt(-318_000_000, "USD", { mixed: true })).toEqual({
      label: NET_CASH_LABEL,
      text: "USD 318.0M",
    });
    expect(formatNetDebt(null, "AUD")).toEqual({
      label: NET_DEBT_LABEL,
      text: NOT_AVAILABLE,
    });
    expect(NET_DEBT_LABEL).toBe("Net debt (excl. leases)");
    expect(NET_CASH_LABEL).toBe("Net cash (excl. leases)");
  });
});

describe("formatPct", () => {
  it("is unsigned by default with a true minus on negatives", () => {
    expect(formatPct(12.44)).toBe("12.4%");
    expect(formatPct(-3)).toBe(`${MINUS}3.0%`);
    expect(formatPct(12.444, { digits: 2 })).toBe("12.44%");
    expect(formatPct(12.4, { digits: 0 })).toBe("12%");
  });

  it("matches the picker's formatSigned when signed", () => {
    expect(formatPct(41.2, { signed: true })).toBe("+41.2%");
    expect(formatPct(-3, { signed: true })).toBe(`${MINUS}3.0%`);
    expect(formatPct(0, { signed: true })).toBe("0.0%");
    expect(formatPct(-0.04, { signed: true })).toBe("0.0%");
    expect(formatPct(0.04, { signed: true })).toBe("0.0%");
  });

  it("groups thousands", () => {
    expect(formatPct(12345.6, { signed: true })).toBe("+12,345.6%");
  });

  it("renders n/a for anything not held", () => {
    expect(formatPct(null)).toBe(NOT_AVAILABLE);
    expect(formatPct(undefined, { signed: true })).toBe(NOT_AVAILABLE);
    expect(formatPct(Number.NaN)).toBe(NOT_AVAILABLE);
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe(NOT_AVAILABLE);
  });
});

describe("formatGrowthPct and isGrowthMeaningful", () => {
  it("renders in-range growth signed, like the picker cells", () => {
    expect(formatGrowthPct(41.2)).toEqual({ text: "+41.2%" });
    expect(formatGrowthPct(-17.04)).toEqual({ text: `${MINUS}17.0%` });
    expect(formatGrowthPct(0)).toEqual({ text: "0.0%" });
    expect(formatGrowthPct(12.345, { digits: 2 })).toEqual({ text: "+12.35%" });
  });

  it("keeps the boundaries themselves meaningful", () => {
    expect(formatGrowthPct(500)).toEqual({ text: "+500.0%" });
    expect(formatGrowthPct(-95)).toEqual({ text: `${MINUS}95.0%` });
    expect(isGrowthMeaningful(500)).toBe(true);
    expect(isGrowthMeaningful(-95)).toBe(true);
  });

  it("renders n/m with the raw figure in the title outside +500% / -95%", () => {
    expect(formatGrowthPct(812.4)).toEqual({
      text: NOT_MEANINGFUL,
      title: `+812.4% year on year, not meaningful above +500% or below ${MINUS}95%`,
    });
    expect(formatGrowthPct(-98.7)).toEqual({
      text: NOT_MEANINGFUL,
      title: `${MINUS}98.7% year on year, not meaningful above +500% or below ${MINUS}95%`,
    });
    expect(formatGrowthPct(24_310.56)).toEqual({
      text: NOT_MEANINGFUL,
      title: `+24,310.6% year on year, not meaningful above +500% or below ${MINUS}95%`,
    });
    expect(isGrowthMeaningful(500.01)).toBe(false);
    expect(isGrowthMeaningful(-95.01)).toBe(false);
  });

  it("drops the raw figure from the title when asked", () => {
    expect(formatGrowthPct(812.4, { rawTitle: false })).toEqual({
      text: NOT_MEANINGFUL,
      title: `Growth not meaningful above +500% or below ${MINUS}95%`,
    });
  });

  it("renders n/a (no title) for anything not held", () => {
    expect(formatGrowthPct(null)).toEqual({ text: NOT_AVAILABLE });
    expect(formatGrowthPct(undefined)).toEqual({ text: NOT_AVAILABLE });
    expect(formatGrowthPct(Number.NaN)).toEqual({ text: NOT_AVAILABLE });
    expect(formatGrowthPct(Number.POSITIVE_INFINITY)).toEqual({
      text: NOT_AVAILABLE,
    });
    expect(isGrowthMeaningful(null)).toBe(false);
    expect(isGrowthMeaningful(undefined)).toBe(false);
    expect(isGrowthMeaningful(Number.NaN)).toBe(false);
  });
});

describe("ratios and multiples", () => {
  it("formats ratios with the multiplication sign", () => {
    expect(formatRatio(1.84)).toBe(`1.8${MULTIPLE_SUFFIX}`);
    expect(formatRatio(1.846, 2)).toBe(`1.85${MULTIPLE_SUFFIX}`);
    expect(formatRatio(0)).toBe(`0.0${MULTIPLE_SUFFIX}`);
    expect(formatRatio(-0.42)).toBe(`${MINUS}0.4${MULTIPLE_SUFFIX}`);
    expect(formatRatio(-0.01)).toBe(`0.0${MULTIPLE_SUFFIX}`);
    expect(formatRatio(null)).toBe(NOT_AVAILABLE);
    expect(formatRatio(Number.NaN, 2)).toBe(NOT_AVAILABLE);
  });

  it("formats P/E, P/B and leverage multiples to one decimal", () => {
    expect(formatMultiple(12.44)).toBe(`12.4${MULTIPLE_SUFFIX}`);
    expect(formatMultiple(2_345.67)).toBe(`2,345.7${MULTIPLE_SUFFIX}`);
    // Net cash gives a negative net debt / EBITDA.
    expect(formatMultiple(-0.4)).toBe(`${MINUS}0.4${MULTIPLE_SUFFIX}`);
    expect(formatMultiple(undefined)).toBe(NOT_AVAILABLE);
  });

  it("caps interest cover at >100x", () => {
    expect(formatInterestCover(8.24)).toBe(`8.2${MULTIPLE_SUFFIX}`);
    expect(formatInterestCover(100)).toBe(`100.0${MULTIPLE_SUFFIX}`);
    expect(formatInterestCover(100.01)).toBe(`>100${MULTIPLE_SUFFIX}`);
    expect(formatInterestCover(98_765)).toBe(`>100${MULTIPLE_SUFFIX}`);
    expect(formatInterestCover(-3.2)).toBe(`${MINUS}3.2${MULTIPLE_SUFFIX}`);
    expect(formatInterestCover(null)).toBe(NOT_AVAILABLE);
    expect(formatInterestCover(Number.POSITIVE_INFINITY)).toBe(NOT_AVAILABLE);
  });
});

describe("ratioOrNotMeaningful and isNotMeaningful", () => {
  const withheld = ["current_ratio", "net_debt_to_ebitda"] as const;

  it("renders n/m with the financials title for a withheld ratio", () => {
    expect(
      ratioOrNotMeaningful("current_ratio", null, withheld, formatRatio),
    ).toEqual({ text: NOT_MEANINGFUL, title: NOT_MEANINGFUL_TITLE });
    // Withheld wins even if a value somehow arrives with it.
    expect(
      ratioOrNotMeaningful("net_debt_to_ebitda", 1.2, withheld, formatMultiple),
    ).toEqual({ text: NOT_MEANINGFUL, title: NOT_MEANINGFUL_TITLE });
  });

  it("formats a ratio that is not withheld", () => {
    expect(
      ratioOrNotMeaningful("roe_pct", 18.24, withheld, (v) => formatPct(v)),
    ).toBe("18.2%");
    expect(
      ratioOrNotMeaningful(
        "interest_cover",
        250,
        withheld,
        formatInterestCover,
      ),
    ).toBe(`>100${MULTIPLE_SUFFIX}`);
    expect(ratioOrNotMeaningful("roa_pct", null, withheld, formatPct)).toBe(
      NOT_AVAILABLE,
    );
  });

  it("withholds nothing when the API sent no list (an older API)", () => {
    expect(
      ratioOrNotMeaningful("current_ratio", 1.8, undefined, formatRatio),
    ).toBe(`1.8${MULTIPLE_SUFFIX}`);
    expect(ratioOrNotMeaningful("current_ratio", 1.8, [], formatRatio)).toBe(
      `1.8${MULTIPLE_SUFFIX}`,
    );
  });

  it("passes a structured formatter's result through", () => {
    expect(
      ratioOrNotMeaningful("revenue_yoy_pct", 812.4, withheld, (v) =>
        formatGrowthPct(v),
      ),
    ).toEqual(formatGrowthPct(812.4));
  });

  it("matches camelCase names against the snake_case wire list", () => {
    expect(isNotMeaningful("currentRatio", withheld)).toBe(true);
    expect(isNotMeaningful("netDebtToEbitda", withheld)).toBe(true);
    expect(isNotMeaningful("current_ratio", ["currentRatio"])).toBe(true);
    expect(isNotMeaningful("roePct", withheld)).toBe(false);
    expect(isNotMeaningful("current_ratio", undefined)).toBe(false);
  });

  it("covers every name in NOT_MEANINGFUL_RATIOS", () => {
    for (const name of NOT_MEANINGFUL_RATIOS) {
      expect(
        ratioOrNotMeaningful(name, 1, NOT_MEANINGFUL_RATIOS, formatRatio),
      ).toEqual({ text: NOT_MEANINGFUL, title: NOT_MEANINGFUL_TITLE });
    }
  });
});

describe("valuationNotAvailable", () => {
  it("names the reporting currency for a non-AUD reporter", () => {
    expect(valuationNotAvailable("USD", "non-aud")).toBe(
      "n/a (reports in USD)",
    );
    expect(valuationNotAvailable("nzd", "non-aud")).toBe(
      "n/a (reports in NZD)",
    );
    expect(valuationNotAvailable("", "non-aud")).toBe(
      "n/a (not reported in AUD)",
    );
    // No note but a non-AUD currency still explains itself.
    expect(valuationNotAvailable("USD", "")).toBe("n/a (reports in USD)");
  });

  it("gives short copy for the other valuation notes", () => {
    expect(valuationNotAvailable("AUD", "listed-unit")).toBe(
      "n/a (listed unit is not one ordinary share)",
    );
    expect(valuationNotAvailable("AUD", "no-shares")).toBe(
      "n/a (no share count we can vouch for)",
    );
    expect(valuationNotAvailable("AUD", "no-price")).toBe(
      "n/a (no recent price)",
    );
  });

  it("falls back to plain n/a for AUD with no or an unknown note", () => {
    expect(valuationNotAvailable("AUD", "")).toBe(NOT_AVAILABLE);
    expect(valuationNotAvailable("AUD", null)).toBe(NOT_AVAILABLE);
    expect(valuationNotAvailable(null, undefined)).toBe(NOT_AVAILABLE);
    expect(valuationNotAvailable("AUD", "something-new")).toBe(NOT_AVAILABLE);
  });
});

describe("basisLabel and basisDescription", () => {
  it("maps every basis to TTM, FY or HY", () => {
    expect(basisLabel("ttm")).toBe("TTM");
    expect(basisLabel("annual")).toBe("FY");
    expect(basisLabel("half")).toBe("HY");
    expect(basisLabel(" TTM ")).toBe("TTM");
    expect(basisLabel("quarter")).toBe("");
    expect(basisLabel("")).toBe("");
    expect(basisLabel(null)).toBe("");
    expect(basisLabel(undefined)).toBe("");
  });

  it("describes a basis with its period end for titles", () => {
    expect(basisDescription("ttm", "2026-06-30")).toBe(
      "12 months to 30 Jun 2026",
    );
    expect(basisDescription("annual", "2026-06-30")).toBe(
      "Year to 30 Jun 2026",
    );
    expect(basisDescription("half", "2025-12-31")).toBe(
      "Half year to 31 Dec 2025",
    );
    expect(basisDescription("quarter", "2025-09-30")).toBe(
      "Balance sheet at 30 Sep 2025",
    );
  });

  it("describes the basis alone without a usable date, and nothing for an unknown basis", () => {
    expect(basisDescription("ttm", "")).toBe("Trailing 12 months");
    expect(basisDescription("annual", null)).toBe("Financial year");
    expect(basisDescription("half", "not-a-date")).toBe("Half year");
    expect(basisDescription("quarter", undefined)).toBe("Balance sheet");
    expect(basisDescription("", "2026-06-30")).toBe("");
    expect(basisDescription(undefined, "2026-06-30")).toBe("");
  });
});

describe("periodColumnLabel", () => {
  it("uses the API's fiscal year when present", () => {
    expect(periodColumnLabel("annual", "2026-06-30", 2026)).toBe("FY26");
    expect(periodColumnLabel("half", "2025-12-31", 2026)).toBe("HY26");
    // A December balance date: the year to Dec 2025 is FY25.
    expect(periodColumnLabel("annual", "2025-12-31", 2025)).toBe("FY25");
  });

  it("derives the year when the fiscal year is unknown (0 on the wire)", () => {
    expect(periodColumnLabel("annual", "2026-06-30", 0)).toBe("FY26");
    expect(periodColumnLabel("annual", "2025-12-31")).toBe("FY25");
    expect(periodColumnLabel("annual", "2025-12-31", null)).toBe("FY25");
    // A 52/53-week year ending in the first days of July is the June year.
    expect(periodColumnLabel("annual", "2023-07-02")).toBe("FY23");
    // ASX halves are first halves: Dec 2025 opens FY26 (June balance date),
    // Jun 2026 opens FY26 (December balance date).
    expect(periodColumnLabel("half", "2025-12-31")).toBe("HY26");
    expect(periodColumnLabel("half", "2026-06-30")).toBe("HY26");
  });

  it("labels TTM and quarter snapshots by month", () => {
    expect(periodColumnLabel("ttm", "2026-06-30")).toBe("TTM Jun 26");
    expect(periodColumnLabel("ttm", "2026-01-02")).toBe("TTM Dec 25");
    expect(periodColumnLabel("quarter", "2025-09-30")).toBe("Sep 25");
    expect(periodColumnLabel("TTM", "2026-06-30", 2026)).toBe("TTM Jun 26");
  });

  it("falls back to the raw period end, then n/a", () => {
    expect(periodColumnLabel("annual", "garbage")).toBe("garbage");
    expect(periodColumnLabel("ttm", "")).toBe(NOT_AVAILABLE);
    expect(periodColumnLabel("half", null)).toBe(NOT_AVAILABLE);
    expect(periodColumnLabel(undefined, undefined)).toBe(NOT_AVAILABLE);
  });
});

describe("formatDate and formatAsOf", () => {
  it("formats an ISO date with a fixed three-letter month", () => {
    expect(formatDate("2026-06-30")).toBe("30 Jun 2026");
    expect(formatDate("2025-09-01")).toBe("1 Sep 2025");
    expect(formatDate("2026-06-30T23:59:59Z")).toBe("30 Jun 2026");
  });

  it("returns empty for a missing or invalid date so callers omit the clause", () => {
    expect(formatDate("")).toBe("");
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("30/06/2026")).toBe("");
    expect(formatDate("2026-02-31")).toBe("");
  });

  it("formats an RFC 3339 timestamp as the Sydney date", () => {
    expect(formatAsOf("2026-09-28T02:10:00Z")).toBe("28 Sep 2026");
    // 20:00 UTC on the 27th is already the 28th in Sydney.
    expect(formatAsOf("2026-09-27T20:00:00Z")).toBe("28 Sep 2026");
    expect(formatAsOf("2026-09-28T10:00:00+10:00")).toBe("28 Sep 2026");
    expect(formatAsOf("2026-09-28")).toBe("28 Sep 2026");
  });

  it("returns empty for a missing or invalid timestamp", () => {
    expect(formatAsOf("")).toBe("");
    expect(formatAsOf("   ")).toBe("");
    expect(formatAsOf(null)).toBe("");
    expect(formatAsOf(undefined)).toBe("");
    expect(formatAsOf("yesterday")).toBe("");
  });
});

describe("sourceLabel", () => {
  it("labels every source and field_sources value the API emits", () => {
    expect(sourceLabel("yahoo-timeseries")).toBe("Yahoo Finance");
    expect(sourceLabel("markit-key-statistics")).toBe("ASX (Markit)");
    expect(sourceLabel("asx-filing-extraction")).toBe(
      "Company filing (extracted)",
    );
    expect(sourceLabel("derived:fcf-minus-capex")).toBe(
      "Derived: free cash flow minus capex",
    );
    expect(sourceLabel("derived:ttm-at-fye")).toBe(
      "Derived: trailing 12 months at year end",
    );
  });

  it("passes an unknown id through rather than hiding it", () => {
    expect(sourceLabel("some-new-source")).toBe("some-new-source");
    expect(sourceLabel("")).toBe("");
  });
});

describe("sourceListLabel and distinctSourceLabels", () => {
  it("names each distinct source once, in first appearance order", () => {
    expect(
      sourceListLabel([
        "asx-filing-extraction",
        "yahoo-timeseries",
        "asx-filing-extraction",
      ]),
    ).toBe("Company filing (extracted) and Yahoo Finance");
    expect(
      sourceListLabel([
        "yahoo-timeseries",
        "markit-key-statistics",
        "asx-filing-extraction",
      ]),
    ).toBe("Yahoo Finance, ASX (Markit) and Company filing (extracted)");
    expect(sourceListLabel(["yahoo-timeseries", "yahoo-timeseries"])).toBe(
      "Yahoo Finance",
    );
  });

  it("skips empty ids and reads empty for none", () => {
    expect(sourceListLabel(["", "yahoo-timeseries", " "])).toBe(
      "Yahoo Finance",
    );
    expect(sourceListLabel([])).toBe("");
    expect(distinctSourceLabels(["", " "])).toEqual([]);
    expect(
      distinctSourceLabels(["markit-key-statistics", "markit-key-statistics"]),
    ).toEqual(["ASX (Markit)"]);
  });
});

describe("isAud", () => {
  it("is case-insensitive and false for anything else", () => {
    expect(isAud("AUD")).toBe(true);
    expect(isAud(" aud ")).toBe(true);
    expect(isAud("USD")).toBe(false);
    expect(isAud("")).toBe(false);
    expect(isAud(null)).toBe(false);
  });
});

describe("module hygiene", () => {
  const source = readFileSync(join(__dirname, "..", "format.ts"), "utf8");

  it("imports nothing, so it is safe on both sides of the RSC boundary", () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    // Re-exports ("export ... from") would pull a dependency in too.
    expect(source).not.toMatch(/^\s*export\s[^\n]*\sfrom\s+["']/m);
    expect(source).not.toMatch(/\bimport\(/);
    expect(source).not.toMatch(/"use client"/);
  });

  it("writes no em or en dash in any output string", () => {
    const outputs: string[] = [
      NOT_MEANINGFUL_TITLE,
      NET_DEBT_LABEL,
      NET_CASH_LABEL,
      formatAmount(-4_290_000_000, "USD", { mixed: true }),
      formatProseAmount(-58_800_000_000, "USD"),
      formatPerShare(-0.045, "AUD"),
      formatPct(-3, { signed: true }),
      formatRatio(-0.4),
      formatInterestCover(250),
      valuationNotAvailable("USD", "non-aud"),
      valuationNotAvailable("AUD", "listed-unit"),
      valuationNotAvailable("AUD", "no-shares"),
      valuationNotAvailable("AUD", "no-price"),
      valuationNotAvailable("", "non-aud"),
      basisDescription("ttm", "2026-06-30"),
      basisDescription("annual", "2026-06-30"),
      basisDescription("half", "2025-12-31"),
      basisDescription("quarter", "2025-09-30"),
      periodColumnLabel("ttm", "2026-06-30"),
      formatDate("2026-06-30"),
      formatAsOf("2026-09-28T02:10:00Z"),
      sourceLabel("derived:fcf-minus-capex"),
      sourceLabel("derived:ttm-at-fye"),
      sourceListLabel([
        "yahoo-timeseries",
        "markit-key-statistics",
        "asx-filing-extraction",
      ]),
    ];
    const growth = [
      formatGrowthPct(812.4),
      formatGrowthPct(-99, { rawTitle: false }),
    ];
    for (const g of growth) outputs.push(g.text, g.title ?? "");
    for (const text of outputs) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
    expect(source).not.toContain(EM_DASH);
  });
});
