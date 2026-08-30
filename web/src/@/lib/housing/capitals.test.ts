import { CAPITALS, CAPITAL_SLUGS, getCapital } from "./capitals";

const EXPECTED_CAPITALS = [
  ["greater-sydney", "1GSYD", "Greater Sydney", "NSW", "1RNSW"],
  ["greater-melbourne", "2GMEL", "Greater Melbourne", "VIC", "2RVIC"],
  ["greater-brisbane", "3GBRI", "Greater Brisbane", "QLD", "3RQLD"],
  ["greater-adelaide", "4GADE", "Greater Adelaide", "SA", "4RSAU"],
  ["greater-perth", "5GPER", "Greater Perth", "WA", "5RWAU"],
  ["greater-hobart", "6GHOB", "Greater Hobart", "TAS", "6RTAS"],
  ["greater-darwin", "7GDAR", "Greater Darwin", "NT", "7RNTE"],
  [
    "australian-capital-territory",
    "8ACTE",
    "Australian Capital Territory",
    "ACT",
    null,
  ],
] as const;

const wordCount = (value: string) => value.trim().split(/\s+/).length;

describe("capital housing registry", () => {
  it("pins all eight ABS capital regions and their rest-of-state counterparts", () => {
    expect(
      CAPITALS.map(({ slug, regionCode, name, stateCode, restOfStateCode }) => [
        slug,
        regionCode,
        name,
        stateCode,
        restOfStateCode,
      ]),
    ).toEqual(EXPECTED_CAPITALS);
  });

  it("owns eight unique kebab-case slugs and resolves them through the helper", () => {
    expect(CAPITALS).toHaveLength(8);
    expect(CAPITAL_SLUGS).toEqual(CAPITALS.map(({ slug }) => slug));
    expect(new Set(CAPITAL_SLUGS).size).toBe(8);

    for (const slug of CAPITAL_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(getCapital(slug)?.slug).toBe(slug);
    }
    expect(getCapital("not-a-capital")).toBeUndefined();
  });

  it("models ACT as territory-wide and no other capital without regional context", () => {
    const act = getCapital("australian-capital-territory");
    expect(act?.restOfStateCode).toBeNull();
    expect(
      CAPITALS.filter(({ stateCode }) => stateCode !== "ACT").every(
        ({ restOfStateCode }) => restOfStateCode !== null,
      ),
    ).toBe(true);
  });

  it("ships complete, serializable and genuinely distinct editorial copy", () => {
    expect(() => JSON.stringify(CAPITALS)).not.toThrow();
    expect(new Set(CAPITALS.map(({ blurb }) => blurb)).size).toBe(8);
    expect(
      new Set(CAPITALS.map(({ blurb }) => blurb.split(/[.!?]/, 1)[0])).size,
    ).toBe(8);

    for (const capital of CAPITALS) {
      expect(capital.title).not.toContain("| Shorted");
      expect(capital.description.length).toBeGreaterThanOrEqual(130);
      expect(capital.description.length).toBeLessThanOrEqual(180);
      expect(capital.keywords.length).toBeGreaterThan(2);
      expect(wordCount(capital.blurb)).toBeGreaterThanOrEqual(120);
      expect(capital.blurb).toMatch(/established[- ]house/i);
      expect(capital.blurb).toMatch(/transfer/i);
      expect(capital.blurb).toMatch(/quarter/i);
      expect(capital.blurb).toMatch(/preliminary/i);
      expect(capital.blurb).toMatch(/revis/i);
      expect(capital.blurb).toMatch(/listing/i);
      expect(capital.blurb).toMatch(/valuation/i);
    }
  });
});
