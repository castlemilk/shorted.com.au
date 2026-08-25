import {
  MIN_RANKING_POPULATION,
  rankSuburbs,
  type RankingSuburb,
} from "~/@/lib/housing-rankings/rank";
import type { RankingMetric } from "~/@/lib/housing-rankings/registry";

function suburb(
  salCode: string,
  overrides: Partial<RankingSuburb> = {},
): RankingSuburb {
  return {
    salCode,
    salName: `Suburb ${salCode}`,
    stateCode: "NSW",
    postcode: "2000",
    latestMedianPrice: 750_000,
    yoyPct: 5,
    population: 5_000,
    medianWeeklyHhdIncome: 2_000,
    ...overrides,
  };
}

const METRICS: RankingMetric[] = [
  "price-asc",
  "price-desc",
  "growth-desc",
  "growth-asc",
  "affordability",
];

describe("rankSuburbs", () => {
  it.each(METRICS)("excludes zero-price suburbs from %s", (metric) => {
    const rows = rankSuburbs(
      [suburb("priced"), suburb("unpriced", { latestMedianPrice: 0 })],
      metric,
    );

    expect(rows.map((row) => row.salCode)).toEqual(["priced"]);
  });

  it("excludes populations below 200 while retaining the threshold itself", () => {
    const rows = rankSuburbs(
      [
        suburb("too-small", { population: MIN_RANKING_POPULATION - 1 }),
        suburb("at-floor", { population: MIN_RANKING_POPULATION }),
      ],
      "price-asc",
    );

    expect(rows.map((row) => row.salCode)).toEqual(["at-floor"]);
  });

  it("sorts cheapest and most-expensive rankings in opposite price directions", () => {
    const source = [
      suburb("middle", { latestMedianPrice: 700_000 }),
      suburb("low", { latestMedianPrice: 450_000 }),
      suburb("high", { latestMedianPrice: 1_200_000 }),
    ];

    expect(rankSuburbs(source, "price-asc").map((row) => row.salCode)).toEqual([
      "low",
      "middle",
      "high",
    ]);
    expect(rankSuburbs(source, "price-desc").map((row) => row.salCode)).toEqual(
      ["high", "middle", "low"],
    );
  });

  it("sorts fastest-growing and fastest-falling rankings by YoY percentage", () => {
    const source = [
      suburb("flat", { yoyPct: 0 }),
      suburb("fall", { yoyPct: -8.25 }),
      suburb("rise", { yoyPct: 12.4 }),
    ];

    expect(
      rankSuburbs(source, "growth-desc").map((row) => row.salCode),
    ).toEqual(["rise", "flat", "fall"]);
    expect(rankSuburbs(source, "growth-asc").map((row) => row.salCode)).toEqual(
      ["fall", "flat", "rise"],
    );
  });

  it("requires household income and ranks affordability by price-to-annual-income", () => {
    const rows = rankSuburbs(
      [
        suburb("no-income", { medianWeeklyHhdIncome: 0 }),
        suburb("lower-price", {
          latestMedianPrice: 500_000,
          medianWeeklyHhdIncome: 800,
        }),
        suburb("better-ratio", {
          latestMedianPrice: 600_000,
          medianWeeklyHhdIncome: 1_500,
        }),
      ],
      "affordability",
    );

    expect(rows.map((row) => row.salCode)).toEqual([
      "better-ratio",
      "lower-price",
    ]);
    expect(rows[0]?.affordabilityRatio).toBeCloseTo(600_000 / (1_500 * 52));
  });

  it("does not mutate the source order", () => {
    const source = [
      suburb("high", { latestMedianPrice: 900_000 }),
      suburb("low", { latestMedianPrice: 400_000 }),
    ];

    rankSuburbs(source, "price-asc");

    expect(source.map((row) => row.salCode)).toEqual(["high", "low"]);
  });
});
