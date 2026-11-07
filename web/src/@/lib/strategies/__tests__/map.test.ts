import {
  mapPick,
  mapPickFundamentals,
  mapPicksResponse,
  mapRegime,
  isoDateOrNull,
  mapRuleResult,
  mapStrategy,
  sydneyIsoDate,
} from "~/@/lib/strategies/map";
import type {
  MarketRegime,
  Strategy,
  StrategyPick,
} from "~/gen/shorts/v1alpha1/strategies_pb";

// Plain objects shaped like the generated messages: the mapper reads fields
// only, so the protobuf runtime is not needed (and src/gen is outside jest's
// module path anyway).
function protoPick(overrides: Partial<StrategyPick> = {}): StrategyPick {
  return {
    rank: 1,
    stockCode: "BHP",
    companyName: "BHP Group",
    industry: "Materials",
    status: "triggered",
    score: 88.4,
    rules: [],
    close: 45.1,
    asOf: "2026-09-25",
    pctOff52wHigh: -2,
    volumeRatio50d: 2.1,
    baseDepthPct: 14.2,
    baseLengthDays: 38,
    pivot: 44.2,
    revenueYoyPct: 0,
    hasRevenueYoy: false,
    epsYoyPct: 0,
    hasEpsYoy: false,
    rs3mPct: 0,
    shortPct: 0,
    marketCap: 0,
    logoUrl: "",
    hasRs3mPct: false,
    hasShortPct: false,
    hasMarketCap: false,
    hasClose: true,
    ...overrides,
  } as unknown as StrategyPick;
}

describe("mapPick", () => {
  it("turns proto3's indistinguishable zeros into null", () => {
    const row = mapPick(protoPick());
    expect(row.revenueYoyPct).toBeNull();
    expect(row.epsYoyPct).toBeNull();
    expect(row.shortPct).toBeNull();
    expect(row.marketCap).toBeNull();
    expect(row.rs3mPct).toBeNull();
  });

  it("keeps a genuine zero growth figure when the has flag says it is real", () => {
    const row = mapPick(protoPick({ revenueYoyPct: 0, hasRevenueYoy: true, epsYoyPct: -12.5, hasEpsYoy: true }));
    expect(row.revenueYoyPct).toBe(0);
    expect(row.epsYoyPct).toBe(-12.5);
  });

  it("keeps a measured zero RS and short position when the has flags say they are real", () => {
    const row = mapPick(protoPick({ rs3mPct: 0, hasRs3mPct: true, shortPct: 0, hasShortPct: true }));
    expect(row.rs3mPct).toBe(0);
    expect(row.shortPct).toBe(0);
  });

  it("lets the has flags, not the value or the rules, decide availability", () => {
    // A value without its flag is not a reading, whatever it says.
    const unflagged = mapPick(
      protoPick({
        close: 12.5,
        hasClose: false,
        rs3mPct: 4.2,
        shortPct: 6.1,
        marketCap: 2e9,
        // The rs rule's own value no longer stands in for the flag.
        rules: [{ ruleId: "rs", status: "pass", detail: "Led the index", value: 4.2, hasValue: true }],
      } as unknown as Partial<StrategyPick>),
    );
    expect(unflagged.close).toBeNull();
    expect(unflagged.rs3mPct).toBeNull();
    expect(unflagged.shortPct).toBeNull();
    expect(unflagged.marketCap).toBeNull();

    // A strategy without an rs rule (crowded-short) still shows a known RS.
    const flagged = mapPick(
      protoPick({ rs3mPct: -3.4, hasRs3mPct: true, shortPct: 7.25, hasShortPct: true, marketCap: 2e9, hasMarketCap: true }),
    );
    expect(flagged.close).toBe(45.1);
    expect(flagged.rs3mPct).toBe(-3.4);
    expect(flagged.shortPct).toBe(7.25);
    expect(flagged.marketCap).toBe(2e9);
  });

  it("treats a flagged zero market cap or close as unknown: neither is a real size or price", () => {
    const row = mapPick(protoPick({ close: 0, hasClose: true, marketCap: 0, hasMarketCap: true }));
    expect(row.close).toBeNull();
    expect(row.marketCap).toBeNull();
  });

  it("drops base depth with a zero-length base and normalises unknown statuses", () => {
    const row = mapPick(
      protoPick({
        baseLengthDays: 0,
        status: "mystery",
        rules: [{ ruleId: "growth", status: "maybe", detail: "", value: 0, hasValue: false }],
      } as unknown as Partial<StrategyPick>),
    );
    expect(row.baseLengthDays).toBeNull();
    expect(row.baseDepthPct).toBeNull();
    expect(row.status).toBe("watch");
    expect(row.rules[0]!.status).toBe("unknown");
  });
});

describe("mapRegime", () => {
  it("nulls the levels of an unreadable regime", () => {
    const view = mapRegime({
      indexCode: "",
      asOf: "",
      regime: "",
      close: 0,
      sma50: 0,
      sma200: 0,
      pctOff52wHigh: 0,
      verdict: "Market regime unavailable.",
    } as unknown as MarketRegime);
    expect(view).toEqual({
      indexCode: "XJO",
      asOf: "",
      regime: "",
      close: null,
      sma50: null,
      sma200: null,
      pctOff52wHigh: null,
      verdict: "Market regime unavailable.",
    });
    expect(mapRegime(undefined)).toBeNull();
  });
});

describe("mapStrategy", () => {
  it("produces plain data and falls back to the rule count", () => {
    const def = mapStrategy({
      id: "canslim",
      name: "CAN SLIM",
      author: "William J. O'Neil",
      tagline: "t",
      descriptionParagraphs: ["a"],
      rules: [
        { id: "eps_growth", title: "C", ruleText: "r", evaluation: "e", core: true, dataSource: "stock_fundamentals" },
      ],
      metadata: {
        style: "s",
        holdingPeriod: "h",
        riskPosture: "r",
        universe: "u",
        refreshCadence: "c",
        ruleCount: 0,
      },
      caveats: [],
      sources: [],
    } as unknown as Strategy);
    expect(def.metadata?.ruleCount).toBe(1);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });
});

// The same mapper reads Connect's protojson in the browser (the sort island):
// every default-valued field is OMITTED, and a non-finite double arrives as a
// string. Nothing here may turn an absence into a zero.
describe("mapPick on protojson", () => {
  it("maps a pick whose default-valued fields are all omitted", () => {
    const row = mapPick({ stockCode: "XYZ", rank: 7, status: "setup" });
    expect(row).toEqual({
      rank: 7,
      code: "XYZ",
      name: "",
      industry: "",
      status: "setup",
      score: 0,
      rules: [],
      close: null,
      asOf: "",
      pivot: null,
      baseDepthPct: null,
      baseLengthDays: null,
      volumeRatio: null,
      revenueYoyPct: null,
      epsYoyPct: null,
      rs3mPct: null,
      shortPct: null,
      marketCap: null,
      logoUrl: "",
    });
    // No fundamentals message: no key at all (nulls omitted), not null.
    expect("fundamentals" in row).toBe(false);
  });

  // protojson omits a zero, so a measured zero arrives as its flag alone.
  it("reads a flagged but omitted double as the zero it stands for", () => {
    const row = mapPick({
      stockCode: "ZER",
      hasShortPct: true,
      hasRevenueYoy: true,
      hasRs3mPct: true,
      fundamentals: { hasRoePct: true, hasNetMarginPct: false },
    });
    expect(row.shortPct).toBe(0);
    expect(row.revenueYoyPct).toBe(0);
    expect(row.rs3mPct).toBe(0);
    expect(row.epsYoyPct).toBeNull();
    expect(row.fundamentals).toEqual({ roePct: 0 });
  });

  it("never reads a protojson NaN or Infinity string as a number", () => {
    const row = mapPick({
      stockCode: "NAN",
      close: "NaN",
      hasClose: true,
      revenueYoyPct: "Infinity",
      hasRevenueYoy: true,
      pivot: "-Infinity",
      fundamentals: { roePct: "NaN", hasRoePct: true },
    });
    expect(row.close).toBeNull();
    expect(row.revenueYoyPct).toBeNull();
    expect(row.pivot).toBeNull();
    expect(row.fundamentals).toEqual({});
  });
});

describe("mapPickFundamentals", () => {
  it("keeps only rendered fields, omits nulls and rounds ratios to the printed decimal", () => {
    const view = mapPickFundamentals({
      revenueBasisPeriodType: "ttm",
      revenuePeriodEnd: "2026-06-30",
      revenueBasisSource: "filing",
      epsBasisPeriodType: "half",
      epsPeriodEnd: "2025-12-31",
      epsBasisSource: "vendor",
      currency: "AUD",
      fetchedAt: "2026-09-27T20:00:00Z",
      netMarginPct: 12.345678,
      hasNetMarginPct: true,
      roePct: 0,
      hasRoePct: true,
      fcfMarginPct: 5,
      hasFcfMarginPct: false,
      netDebtToEbitda: -0.26,
      hasNetDebtToEbitda: true,
      peRatio: 0,
      hasPeRatio: false,
      isFinancial: false,
      netIncomePositive: true,
    });
    expect(view).toEqual({
      revenueBasis: "ttm",
      revenueEnd: "2026-06-30",
      revenueFiling: true,
      epsBasis: "half",
      epsEnd: "2025-12-31",
      // 20:00 UTC on the 27th is the 28th in Sydney.
      fetchedOn: "2026-09-28",
      netMarginPct: 12.3,
      // A measured zero ROE survives: its has flag says it is real.
      roePct: 0,
      netDebtToEbitda: -0.3,
    });
    // No vendor marker, no AUD, no flags the row does not print.
    expect(JSON.stringify(view)).not.toMatch(/vendor|AUD|isFinancial|netIncomePositive/);
  });

  it("keeps a non-AUD currency, which P/E's absence is explained by", () => {
    expect(mapPickFundamentals({ currency: "usd" })).toEqual({ currency: "USD" });
  });

  it("drops a basis it does not know and the period and source that hang off it", () => {
    expect(
      mapPickFundamentals({
        revenueBasisPeriodType: "quarter",
        revenuePeriodEnd: "2026-06-30",
        revenueBasisSource: "filing",
      }),
    ).toEqual({});
  });

  it("keeps only the not-meaningful ratios the row shows", () => {
    const view = mapPickFundamentals({
      isFinancial: true,
      notMeaningful: [
        "gross_margin_pct",
        "fcf_margin_pct",
        "net_debt",
        "net_debt_to_ebitda",
        "current_ratio",
      ],
    });
    expect(view).toEqual({ notMeaningful: ["fcf_margin_pct", "net_debt_to_ebitda"] });
  });

  it("is undefined without a fundamentals message", () => {
    expect(mapPickFundamentals(undefined)).toBeUndefined();
    expect(mapPickFundamentals(null)).toBeUndefined();
  });
});

describe("mapPicksResponse: the caller's depth", () => {
  it("reads a clamped answer and its limit from the viewer", () => {
    const mapped = mapPicksResponse({ viewer: { access: "anonymous", clamped: true, limit: 10 } });
    expect(mapped.clamped).toBe(true);
    expect(mapped.depth).toBe(10);
  });

  it("reads an unclamped answer as the whole list", () => {
    const mapped = mapPicksResponse({ viewer: { access: "premium", clamped: false, limit: 0 } });
    expect(mapped.clamped).toBe(false);
    expect(mapped.depth).toBe(0);
  });
});

describe("mapPicksResponse", () => {
  it("reads counts that protojson omitted as zero, and truncates nothing else", () => {
    expect(mapPicksResponse({})).toEqual({
      picks: [],
      totalCount: 0,
      universeCount: 0,
      fundamentalsCoverageCount: 0,
      fundamentalsRowsCount: 0,
      asOf: "",
      clamped: false,
      depth: 0,
    });
    expect(
      mapPicksResponse({
        totalCount: 57,
        universeCount: 1904,
        fundamentalsCoverageCount: 812,
        fundamentalsRowsCount: 1203,
        asOf: "2026-09-25",
      }),
    ).toMatchObject({ totalCount: 57, fundamentalsRowsCount: 1203, asOf: "2026-09-25" });
  });
});

describe("sydneyIsoDate", () => {
  it("dates an instant in Sydney, passes a bare date through and rejects junk", () => {
    expect(sydneyIsoDate("2026-09-27T13:59:00Z")).toBe("2026-09-27");
    expect(sydneyIsoDate("2026-09-27T14:01:00Z")).toBe("2026-09-28");
    expect(sydneyIsoDate("2026-09-27")).toBe("2026-09-27");
    expect(sydneyIsoDate("")).toBe("");
    expect(sydneyIsoDate("not a date")).toBe("");
    expect(sydneyIsoDate(undefined)).toBe("");
  });
});

describe("mapRuleResult", () => {
  it("keeps a measured zero value when its flag says it is real, and omits an unmeasured one", () => {
    expect(
      mapRuleResult({ ruleId: "rs", status: "pass", detail: "in line", value: 0, hasValue: true }),
    ).toEqual({ ruleId: "rs", status: "pass", detail: "in line", value: 0 });
    const unmeasured = mapRuleResult({ ruleId: "rs", status: "unknown", detail: "", value: 0, hasValue: false });
    expect(unmeasured).not.toHaveProperty("value");
  });

  it("reads a flagged but omitted value as the zero it stands for, and never a NaN string", () => {
    expect(mapRuleResult({ ruleId: "r", status: "pass", hasValue: true }).value).toBe(0);
    expect(mapRuleResult({ ruleId: "r", status: "pass", value: "NaN", hasValue: true })).not.toHaveProperty("value");
  });

  it("rounds proximity to two decimals and keeps a rule's value at the API's precision", () => {
    expect(mapRuleResult({ ruleId: "breakout", status: "fail", proximity: 0.456789, hasProximity: true }).proximity).toBe(0.46);
    expect(mapRuleResult({ ruleId: "near_high", status: "pass", value: -4.9996, hasValue: true }).value).toBe(-4.9996);
  });

  it("carries proximity only when flagged, and never for a result without one", () => {
    const graded = mapRuleResult({ ruleId: "breakout", status: "fail", proximity: 0.4, hasProximity: true });
    expect(graded.proximity).toBe(0.4);
    expect(mapRuleResult({ ruleId: "breakout", status: "fail", proximity: 0.4 })).not.toHaveProperty("proximity");
    expect(mapRuleResult({ ruleId: "breakout", status: "pass", proximity: 0, hasProximity: false })).not.toHaveProperty("proximity");
  });

  it("names why an unknown result is unknown, and marks a waiting trigger", () => {
    expect(mapRuleResult({ ruleId: "rs", status: "unknown", reason: "no_index" })).toEqual({
      ruleId: "rs",
      status: "unknown",
      detail: "",
      reason: "no_index",
    });
    const waiting = mapRuleResult({ ruleId: "breakout", status: "fail", waiting: true });
    expect(waiting.waiting).toBe(true);
    expect(mapRuleResult({ ruleId: "breakout", status: "fail" })).not.toHaveProperty("waiting");
  });
});

describe("mapStrategy rule definitions", () => {
  it("maps the trigger flag, weight, threshold, unit and comparator", () => {
    const strategy = mapStrategy({
      id: "zanger-breakout",
      rules: [
        { id: "breakout", trigger: true, weight: 0.3, unit: "", comparator: "" },
        { id: "growth", trigger: true, weight: 0.1, threshold: 15, hasThreshold: true, unit: "pct", comparator: ">=" },
        { id: "regime", weight: 0 },
      ],
    });
    expect(strategy.rules[0]).toMatchObject({ id: "breakout", trigger: true, weight: 0.3 });
    expect(strategy.rules[0]).not.toHaveProperty("threshold");
    expect(strategy.rules[1]).toMatchObject({ threshold: 15, unit: "pct", comparator: ">=" });
    expect(strategy.rules[2]).toMatchObject({ trigger: false, weight: 0 });
    expect(strategy.rules[2]).not.toHaveProperty("threshold");
  });

  it("reads a flagged zero threshold as zero and an unflagged one as absent", () => {
    const strategy = mapStrategy({
      rules: [
        { id: "rs", threshold: 0, hasThreshold: true },
        { id: "shape", threshold: 0 },
      ],
    });
    expect(strategy.rules[0].threshold).toBe(0);
    expect(strategy.rules[1]).not.toHaveProperty("threshold");
  });
});

describe("mapPick signal fields", () => {
  it("keeps a measured zero days to cover and rs_6m when their flags say so", () => {
    const row = mapPick(protoPick({ daysToCover: 0, hasDaysToCover: true, rs6mPct: 0, hasRs6mPct: true }));
    expect(row.daysToCover).toBe(0);
    expect(row.rs6mPct).toBe(0);
  });

  it("omits every figure whose flag is off, even when its value is non-zero", () => {
    const row = mapPick(protoPick({ daysToCover: 4.5, rs6mPct: 12, rs6mPercentile: 80, dollarVolume20d: 3e6 }));
    expect(row).not.toHaveProperty("daysToCover");
    expect(row).not.toHaveProperty("rs6mPct");
    expect(row).not.toHaveProperty("rs6mPercentile");
    expect(row).not.toHaveProperty("dollarVolume20d");
  });

  it("rounds the percentile and turnover down, so a figure under a cut-off never prints at it", () => {
    const row = mapPick(
      protoPick({ rs6mPercentile: 74.96, hasRs6mPercentile: true, dollarVolume20d: 249999.7, hasDollarVolume20d: true }),
    );
    expect(row.rs6mPercentile).toBe(74.9);
    expect(row.dollarVolume20d).toBe(249999);
    expect(mapPick(protoPick({ rs6mPercentile: 75, hasRs6mPercentile: true })).rs6mPercentile).toBe(75);
    expect(mapPick(protoPick({ dollarVolume20d: 250000, hasDollarVolume20d: true })).dollarVolume20d).toBe(250000);
  });

  it("says a zero percent off the high is the high only with its flag", () => {
    expect(mapPick(protoPick({ pctOff52wHigh: 0, hasPctOff52wHigh: true })).pctOff52wHigh).toBe(0);
    expect(mapPick(protoPick({ pctOff52wHigh: 0 }))).not.toHaveProperty("pctOff52wHigh");
  });

  it("maps dates as YYYY-MM-DD and omits a missing or unreadable one", () => {
    const row = mapPick(
      protoPick({
        breakoutDate: "2026-09-18",
        shortReportDate: "2026-10-27",
        shortAvailableDate: "2026-10-30",
        caSuspectDate: "not a date",
        shortStatus: " reported ",
      }),
    );
    expect(row).toMatchObject({
      breakoutDate: "2026-09-18",
      shortReportDate: "2026-10-27",
      shortAvailableDate: "2026-10-30",
      shortStatus: "reported",
    });
    expect(row).not.toHaveProperty("caSuspectDate");
  });

  it("carries none of the signal keys for a pick that sends none", () => {
    const row = mapPick(protoPick({}));
    for (const key of ["daysToCover", "rs6mPct", "rs6mPercentile", "dollarVolume20d", "pctOff52wHigh", "breakoutDate", "shortReportDate", "shortAvailableDate", "shortStatus", "caSuspectDate"]) {
      expect(row).not.toHaveProperty(key);
    }
  });
});

describe("mapPicksResponse signal fields", () => {
  it("maps the status counts, the dates, the quartile, the universe and the version", () => {
    const mapped = mapPicksResponse({
      statusCounts: { triggered: 1, setup: 2, watch: 3, unknown: 0 },
      sessionDate: "2026-09-25",
      shortReportDate: "2026-10-27",
      shortAvailableDate: "2026-10-30",
      rsQuantileThreshold: 32.5,
      hasRsQuantileThreshold: true,
      universeLabel: "ASX stocks with 60 sessions of price history",
      version: { strategyId: "zanger-breakout", label: "v0", rulesHash: "" },
    });
    expect(mapped.statusCounts).toEqual({ triggered: 1, setup: 2, watch: 3, unknown: 0 });
    expect(mapped).toMatchObject({
      sessionDate: "2026-09-25",
      shortReportDate: "2026-10-27",
      shortAvailableDate: "2026-10-30",
      rsQuantileThreshold: 32.5,
      universeLabel: "ASX stocks with 60 sessions of price history",
      version: { label: "v0", strategyId: "zanger-breakout", rulesHash: "" },
    });
  });

  it("gives none of the signals for an API that predates them, never zeros", () => {
    const mapped = mapPicksResponse({});
    expect(mapped).not.toHaveProperty("statusCounts");
    expect(mapped).not.toHaveProperty("rsQuantileThreshold");
    expect(mapped).not.toHaveProperty("version");
    expect(mapped).not.toHaveProperty("stale");
  });

  it("drops a quartile without its flag, and claims staleness only when the API does", () => {
    expect(mapPicksResponse({ rsQuantileThreshold: 32.5 })).not.toHaveProperty("rsQuantileThreshold");
    expect(mapPicksResponse({ stale: true }).stale).toBe(true);
    expect(mapPicksResponse({ stale: false })).not.toHaveProperty("stale");
  });

  it("drops a version that names neither a label nor a hash", () => {
    expect(mapPicksResponse({ version: { strategyId: "x" } })).not.toHaveProperty("version");
  });
});

describe("isoDateOrNull", () => {
  it("passes a date through and returns null for anything else", () => {
    expect(isoDateOrNull("2026-10-27")).toBe("2026-10-27");
    expect(isoDateOrNull("2026-10-27T00:00:00Z")).toBe("2026-10-27");
    expect(isoDateOrNull("")).toBeNull();
    expect(isoDateOrNull(undefined)).toBeNull();
    expect(isoDateOrNull("soon")).toBeNull();
  });
});

describe("unknown picks", () => {
  it("keep the unknown status, so the Unknown filter and pill see them", () => {
    const row = mapPick(protoPick({ status: "unknown" } as unknown as Partial<StrategyPick>));
    expect(row.status).toBe("unknown");
  });
});
