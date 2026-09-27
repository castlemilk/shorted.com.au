import {
  STRATEGIES,
  STRATEGY_SLUGS,
  getStrategy,
} from "~/@/lib/strategies/registry";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The strategy ids shipped at launch, in display order. They are BINDING
// across the data, API, MCP and web streams (docs/plans/stock-picker.md §1):
// the slug is the URL AND the StrategyService strategy_id, so a typo here is
// a page whose every read 404s at the API.
const PLAN_IDS = [
  "zanger-breakout",
  "canslim",
  "minervini-trend-template",
  "crowded-short-breakout",
];

// Meta descriptions: long enough to say something query-specific, short
// enough that Google does not truncate the end (the "updated daily" promise).
const DESCRIPTION_MIN = 120;
const DESCRIPTION_MAX = 160;
const KEYWORDS_MIN = 3;
const KEYWORDS_MAX = 8;

const strategies = Object.values(STRATEGIES);

describe("strategy SEO registry", () => {
  it("carries exactly the plan's strategy ids, Zanger first", () => {
    expect(STRATEGY_SLUGS).toEqual(PLAN_IDS);
  });

  it("keys the record by each strategy's own slug", () => {
    for (const [key, strategy] of Object.entries(STRATEGIES)) {
      expect(strategy.slug).toBe(key);
    }
  });

  it("has unique kebab-case slugs", () => {
    const slugs = strategies.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(KEBAB_CASE);
    }
  });

  it("cross-links only to strategies that exist, never to itself, never twice", () => {
    for (const strategy of strategies) {
      expect(strategy.related.length).toBeGreaterThan(0);
      for (const related of strategy.related) {
        expect(STRATEGY_SLUGS).toContain(related);
        expect(related).not.toBe(strategy.slug);
      }
      expect(new Set(strategy.related).size).toBe(strategy.related.length);
    }
  });

  it("keeps every meta description within the snippet band", () => {
    for (const strategy of strategies) {
      expect(strategy.description.length).toBeGreaterThanOrEqual(DESCRIPTION_MIN);
      expect(strategy.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
    const descriptions = new Set(strategies.map((s) => s.description));
    expect(descriptions.size).toBe(strategies.length);
  });

  it("targets a handful of distinct, lowercase keywords", () => {
    for (const strategy of strategies) {
      expect(strategy.keywords.length).toBeGreaterThanOrEqual(KEYWORDS_MIN);
      expect(strategy.keywords.length).toBeLessThanOrEqual(KEYWORDS_MAX);
      expect(new Set(strategy.keywords).size).toBe(strategy.keywords.length);
      for (const keyword of strategy.keywords) {
        expect(keyword).toBe(keyword.toLowerCase());
      }
    }
  });

  it("populates every SEO field with unique titles and H1s", () => {
    for (const strategy of strategies) {
      expect(strategy.label.length).toBeGreaterThan(0);
      expect(strategy.title.length).toBeGreaterThan(0);
      expect(strategy.h1.length).toBeGreaterThan(0);
      expect(strategy.dek.length).toBeGreaterThan(0);
    }
    expect(new Set(strategies.map((s) => s.title)).size).toBe(strategies.length);
    expect(new Set(strategies.map((s) => s.h1)).size).toBe(strategies.length);
  });

  // The layout template appends "| Shorted"; a title carrying it would double up.
  it("omits the site suffix from titles", () => {
    for (const strategy of strategies) {
      expect(strategy.title).not.toContain("| Shorted");
    }
  });

  // House copy rule: no em or en dashes in UI text.
  it("writes no em or en dashes into visible copy", () => {
    for (const strategy of strategies) {
      for (const text of [
        strategy.label,
        strategy.title,
        strategy.h1,
        strategy.description,
        strategy.dek,
      ]) {
        expect(text).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it("resolves known slugs and rejects unknown ones, including prototype keys", () => {
    expect(getStrategy("zanger-breakout")?.slug).toBe("zanger-breakout");
    expect(getStrategy("not-a-strategy")).toBeUndefined();
    expect(getStrategy("constructor")).toBeUndefined();
    expect(getStrategy("__proto__")).toBeUndefined();
  });
});
