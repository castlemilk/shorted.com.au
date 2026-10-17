import { buildStateSuburbDirectory } from "./state-suburb-directory";
import type { SuburbLike } from "./suburb-stats";

const mk = (over: Partial<SuburbLike> & { salCode: string }): SuburbLike => ({
  salName: over.salCode,
  stateCode: "NSW",
  postcode: "",
  latestMedianPrice: 0,
  yoyPct: 0,
  medianWeeklyHhdIncome: 0,
  amenityScore: 0,
  ...over,
});

describe("buildStateSuburbDirectory", () => {
  const suburbs = [
    mk({ salCode: "dear", latestMedianPrice: 9_000_000, yoyPct: 2, population: 5_000 }),
    mk({ salCode: "cheap", latestMedianPrice: 300_000, yoyPct: -3, population: 1_000 }),
    mk({ salCode: "grower", latestMedianPrice: 800_000, yoyPct: 12.5, population: 2_000 }),
    mk({ salCode: "tiny", latestMedianPrice: 50_000, yoyPct: 40, population: 40 }), // below the floor
    mk({ salCode: "unpriced-big", latestMedianPrice: 0, population: 60_000 }),
  ];

  it("ranks by price, growth and population with the rankings floor applied", () => {
    const d = buildStateSuburbDirectory(suburbs, 2);
    expect(d.mostExpensive.map((s) => s.salCode)).toEqual(["dear", "grower"]);
    expect(d.mostAffordable.map((s) => s.salCode)).toEqual(["cheap", "grower"]);
    expect(d.fastestGrowing.map((s) => s.salCode)).toEqual(["grower", "dear"]);
    // The unpriced suburb still leads by population — that is the whole point
    // for QLD/WA/ACT/TAS/NT, where nothing carries a median.
    expect(d.largest.map((s) => s.salCode)).toEqual(["unpriced-big", "dear", "grower", "cheap"]);
  });

  it("counts every priced suburb, floor or not, in the headline figures", () => {
    const d = buildStateSuburbDirectory(suburbs);
    expect(d.pricedCount).toBe(4);
    expect(d.total).toBe(5);
    expect(d.averageOfMedians).toBeCloseTo((9_000_000 + 300_000 + 800_000 + 50_000) / 4, 6);
  });

  it("reports no average when nothing is priced", () => {
    const d = buildStateSuburbDirectory([mk({ salCode: "a", population: 10 })]);
    expect(d.averageOfMedians).toBeNull();
    expect(d.mostExpensive).toEqual([]);
  });
});
