import { suburbCardStats, suburbCardSubtitle } from "./suburb-card-copy";

const fmtPrice = (n: number) => `$${(n / 1e6).toFixed(2)}M`;

describe("suburbCardStats", () => {
  it("leads with price and growth when the suburb is priced", () => {
    expect(
      suburbCardStats({ latestMedianPrice: 2_000_000, yoyPct: -4.25, population: 10_000, fmtPrice }),
    ).toEqual([
      { label: "Median house", value: "$2.00M" },
      { label: "Past year", value: "-4.3%", tone: "up" },
      { label: "Population", value: "10,000" },
    ]);
  });

  it("omits the price entirely for an unpriced suburb and backfills Census figures", () => {
    const stats = suburbCardStats({
      latestMedianPrice: 0, yoyPct: 0, population: 900, medianWeeklyHhdIncome: 1_234.6, medianAge: 40, fmtPrice,
    });
    expect(stats.map((s) => s.label)).toEqual(["Population", "Household income", "Median age"]);
    expect(stats[1]?.value).toBe("$1,235/wk");
  });

  it("returns nothing rather than zeros when the profile is empty", () => {
    expect(suburbCardStats({ fmtPrice })).toEqual([]);
  });
});

describe("suburbCardSubtitle", () => {
  it("prefers a short editorial blurb", () => {
    expect(suburbCardSubtitle({ stateName: "Victoria", blurb: "Bayside village." })).toBe("Bayside village.");
  });
  it("otherwise composes state, archetype and council", () => {
    expect(suburbCardSubtitle({ stateName: "Victoria", archetype: "inner-terraces", lgaName: "Yarra" }))
      .toBe("Victoria · Inner Terraces · Yarra");
  });
});
