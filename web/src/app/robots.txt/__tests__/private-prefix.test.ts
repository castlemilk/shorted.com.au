/**
 * The strategy workspace's private paths must never be a string prefix of a
 * public strategy URL. robots.txt matches by prefix: a Disallow of "/strategies/mine"
 * would also block /strategies/minervini-trend-template, and it would do so
 * silently, with every other test green.
 *
 * Pinned here against the registry itself rather than a copied list, so a new
 * strategy slug that happens to start with a private segment fails this test.
 */
import { GET } from "../route";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";

const PRIVATE_STRATEGY_PATHS = [
  "/strategies/my",
  "/strategies/alerts",
  "/strategies/compare",
];

async function robotsBody(): Promise<string> {
  return await GET().text();
}

function disallowLines(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("Disallow: "))
    .map((line) => line.slice("Disallow: ".length).trim());
}

describe("robots.txt strategy private paths", () => {
  let body: string;

  beforeAll(async () => {
    body = await robotsBody();
  });

  it("disallows each private strategy page in both groups", () => {
    for (const path of PRIVATE_STRATEGY_PATHS) {
      const occurrences = disallowLines(body).filter((p) => p === path).length;
      // The file has the User-Agent: * block and the AI-crawler block.
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });

  it("never disallows /strategies/mine (it prefixes a real strategy slug)", () => {
    expect(disallowLines(body)).not.toContain("/strategies/mine");
    expect(body).not.toMatch(/^Disallow: \/strategies\/mine$/m);
  });

  it("no private strategy path is a prefix of any public /strategies/<slug> URL", () => {
    for (const path of PRIVATE_STRATEGY_PATHS) {
      for (const slug of STRATEGY_SLUGS) {
        const publicUrl = `/strategies/${slug}`;
        expect(publicUrl.startsWith(path)).toBe(false);
      }
    }
  });

  it("the public strategy paths stay allowed for AI crawlers", () => {
    expect(body).toMatch(/^Allow: \/strategies\/$/m);
    expect(body).toMatch(/^Allow: \/strategies$/m);
  });

  it("no /picks path is left in robots.txt", () => {
    expect(body).not.toMatch(/\/picks/);
  });
});
