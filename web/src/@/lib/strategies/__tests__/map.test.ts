import { mapPick, mapRegime, mapStrategy } from "~/@/lib/strategies/map";
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
