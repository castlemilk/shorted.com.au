import { ALL_STATES } from "~/@/lib/housing/states";
import {
  HOUSING_RANKINGS,
  HOUSING_RANKING_SLUGS,
  getHousingRanking,
} from "~/@/lib/housing-rankings/registry";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const METRICS = [
  "price-asc",
  "price-desc",
  "growth-desc",
  "growth-asc",
  "affordability",
] as const;
const MIN_BLURB_WORDS = 120;
const MAX_BLURB_WORDS = 160;

const rankings = Object.values(HOUSING_RANKINGS);

describe("housing ranking registry", () => {
  // Only states with an ingested Valuer-General price feed are published —
  // every metric needs a median price, so an unpriced state could only produce
  // an empty page, and advertising those in the sitemap is a soft-404 farm.
  // Measured on the production API 2026-08-25: NSW/VIC/SA have priced suburbs,
  // QLD/WA/TAS/NT/ACT have none. Widening RANKABLE_STATES updates this list.
  const RANKABLE_STATES = ["NSW", "VIC", "SA"];

  it("publishes five metrics for each rankable state, and none for the rest", () => {
    expect(rankings).toHaveLength(RANKABLE_STATES.length * METRICS.length);

    for (const stateCode of ALL_STATES) {
      const stateRankings = rankings.filter(
        (ranking) => ranking.stateCode === stateCode,
      );
      if (!RANKABLE_STATES.includes(stateCode)) {
        expect(stateRankings).toHaveLength(0);
        continue;
      }
      expect(stateRankings).toHaveLength(5);
      expect(stateRankings.map((ranking) => ranking.metric).sort()).toEqual(
        [...METRICS].sort(),
      );
    }
  });

  it("keys entries by unique kebab-case slugs", () => {
    const slugs = rankings.map((ranking) => ranking.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(HOUSING_RANKING_SLUGS).toEqual(Object.keys(HOUSING_RANKINGS));
    for (const [key, ranking] of Object.entries(HOUSING_RANKINGS)) {
      expect(ranking.slug).toBe(key);
      expect(ranking.slug).toMatch(KEBAB_CASE);
    }
  });

  it("uses only supported states and serializable metric keys", () => {
    for (const ranking of rankings) {
      expect(ALL_STATES).toContain(ranking.stateCode);
      expect(METRICS).toContain(ranking.metric);
    }
    expect(() => JSON.stringify(HOUSING_RANKINGS)).not.toThrow();
  });

  it("cross-links only to existing rankings, without duplicates or self-links", () => {
    for (const ranking of rankings) {
      expect(ranking.related.length).toBeGreaterThan(0);
      expect(new Set(ranking.related).size).toBe(ranking.related.length);
      for (const related of ranking.related) {
        expect(HOUSING_RANKING_SLUGS).toContain(related);
        expect(related).not.toBe(ranking.slug);
      }
    }
  });

  it("has genuinely separate editorial copy between 120 and 160 words", () => {
    const blurbs = new Set<string>();

    for (const ranking of rankings) {
      const words = ranking.blurb.trim().split(/\s+/).length;
      expect({ slug: ranking.slug, words }).toEqual({
        slug: ranking.slug,
        words: expect.any(Number),
      });
      expect(words).toBeGreaterThanOrEqual(MIN_BLURB_WORDS);
      expect(words).toBeLessThanOrEqual(MAX_BLURB_WORDS);
      blurbs.add(ranking.blurb);
    }
    expect(blurbs.size).toBe(rankings.length);
  });

  it("populates every SEO field and leaves the root title template to add the suffix", () => {
    for (const ranking of rankings) {
      expect(ranking.title).not.toContain("| Shorted");
      expect(ranking.title.length).toBeGreaterThan(0);
      expect(ranking.h1.length).toBeGreaterThan(0);
      expect(ranking.description.length).toBeGreaterThan(0);
      expect(ranking.keywords.length).toBeGreaterThan(0);
      expect(ranking.dek.length).toBeGreaterThan(0);
    }
  });

  it("keeps query-targeted descriptions near search-snippet length", () => {
    for (const ranking of rankings) {
      expect(ranking.description.length).toBeGreaterThanOrEqual(130);
      expect(ranking.description.length).toBeLessThanOrEqual(170);
    }
  });

  it("resolves known slugs and rejects unknown ones", () => {
    expect(getHousingRanking("cheapest-suburbs-nsw")?.stateCode).toBe("NSW");
    expect(getHousingRanking("not-a-ranking")).toBeUndefined();
    for (const inheritedName of ["constructor", "toString", "__proto__"]) {
      expect(getHousingRanking(inheritedName)).toBeUndefined();
    }
  });
});
