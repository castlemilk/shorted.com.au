/// <reference types="jest" />

import {
  SUBURB_INDEX_MIN_POPULATION,
  isSuburbIndexable,
  isSuburbSitemapEligible,
  suburbHasPrice,
  suburbMetaCopy,
} from "../suburb-indexability";

const base = { salCode: "SAL21234", salName: "Sampleton" };

describe("suburb indexability", () => {
  it("indexes a suburb with a real price regardless of population", () => {
    expect(isSuburbIndexable({ ...base, latestMedianPrice: 850_000, population: 12 })).toBe(true);
  });

  it("indexes a populous suburb that has no price feed", () => {
    // This is the whole point: QLD, WA, ACT, TAS and NT have zero priced
    // suburbs, but ~1,587 of their suburbs have a population over 1,000 and
    // carry real Census, amenity and representative content.
    expect(
      isSuburbIndexable({ ...base, latestMedianPrice: 0, population: SUBURB_INDEX_MIN_POPULATION }),
    ).toBe(true);
  });

  it("excludes a tiny locality with neither price nor population", () => {
    expect(isSuburbIndexable({ ...base, latestMedianPrice: 0, population: 40 })).toBe(false);
  });

  it("refuses anything it cannot identify", () => {
    expect(isSuburbIndexable({ salCode: "", salName: "Sampleton", latestMedianPrice: 900_000 })).toBe(false);
    expect(isSuburbIndexable({ salCode: "SAL1", salName: "  ", latestMedianPrice: 900_000 })).toBe(false);
  });

  it("treats missing fields as absent rather than throwing", () => {
    expect(isSuburbIndexable({ ...base })).toBe(false);
    expect(isSuburbIndexable({ ...base, population: null, latestMedianPrice: null })).toBe(false);
  });
});

describe("the sitemap set is a strict subset of the indexable set", () => {
  // A sitemap entry the page marks noindex is a conflicting signal Google
  // penalises. This is the invariant that keeps the two gates honest, so it is
  // asserted over the whole shape of the input space rather than a few cases.
  const prices = [0, 1, 850_000];
  const populations = [0, 40, SUBURB_INDEX_MIN_POPULATION - 1, SUBURB_INDEX_MIN_POPULATION, 50_000];
  const ids = [
    { salCode: "SAL1", salName: "Sampleton" },
    { salCode: "", salName: "Sampleton" },
    { salCode: "SAL1", salName: "" },
  ];

  for (const id of ids) {
    for (const latestMedianPrice of prices) {
      for (const population of populations) {
        const input = { ...id, latestMedianPrice, population };
        it(`holds for ${JSON.stringify(input)}`, () => {
          if (isSuburbSitemapEligible(input)) {
            expect(isSuburbIndexable(input)).toBe(true);
          }
        });
      }
    }
  }
});

describe("metadata tells the truth about what the page shows", () => {
  it("keeps the price wording for a priced suburb", () => {
    // Unchanged wording matters: ~3,600 already-indexed URLs keep their titles.
    const { title, description } = suburbMetaCopy({
      name: "Sampleton",
      stateName: "New South Wales",
      latestMedianPrice: 1_200_000,
    });
    expect(title).toBe("Sampleton House Prices & Demographics | $1.2M Median");
    expect(description).toMatch(/median house price \$1\.2M/);
  });

  it("stops promising a median price when there is none", () => {
    const { title, description } = suburbMetaCopy({
      name: "Sampleton",
      stateName: "Queensland",
      latestMedianPrice: 0,
    });
    expect(title).not.toMatch(/house price/i);
    expect(description).not.toMatch(/median house price/i);
    expect(title).toContain("Sampleton");
    expect(description).toContain("Queensland");
  });

  it("suburbHasPrice is the single predicate both halves agree on", () => {
    expect(suburbHasPrice({ latestMedianPrice: 1 })).toBe(true);
    expect(suburbHasPrice({ latestMedianPrice: 0 })).toBe(false);
    expect(suburbHasPrice({})).toBe(false);
  });
});

describe("suburbMetaCopy — number-led copy", () => {
  it("leads a priced suburb with the median, period and move, then the Census facts", () => {
    const { title, description } = suburbMetaCopy({
      name: "Bondi Beach",
      stateName: "New South Wales",
      latestMedianPrice: 4_250_000,
      yoyPct: 3.25,
      latestPeriodSeconds: Date.UTC(2026, 5, 30) / 1000,
      population: 12_000,
      medianAge: 36,
      medianWeeklyHhdIncome: 3_012.4,
      lgaName: "Waverley",
      federalDivision: "Wentworth",
    });
    expect(title).toBe("Bondi Beach House Prices & Demographics | $4.3M Median");
    expect(description).toBe(
      "Bondi Beach, New South Wales: median house price $4.3M (Jun 2026), +3.3% over the year. " +
        "population 12,000, median age 36, household income $3,012/wk. Waverley council, Wentworth electorate. " +
        "ABS Census demographics, price history, schools and amenities.",
    );
  });

  it("describes an unpriced suburb by its Census facts and council, never a price", () => {
    const { title, description } = suburbMetaCopy({
      name: "Noosa Heads",
      stateName: "Queensland",
      latestMedianPrice: 0,
      population: 4_400,
      medianAge: 51,
      lgaName: "Noosa",
    });
    expect(title).toBe("Noosa Heads Suburb Profile & Demographics | Noosa");
    expect(description).toBe(
      "Noosa Heads, Queensland suburb profile: population 4,400, median age 51 (ABS Census). " +
        "Noosa council. Demographics, schools, amenities and local context.",
    );
    expect(description).not.toMatch(/\$/);
  });

  it("omits every fact it does not have rather than printing zeros", () => {
    const { description } = suburbMetaCopy({ name: "Lidster", stateName: "New South Wales", latestMedianPrice: 0 });
    expect(description).toBe("Lidster, New South Wales suburb profile. Demographics, schools, amenities and local context.");
  });
});
