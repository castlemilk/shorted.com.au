/**
 * The strategy workspace's private paths must never be a string prefix of a
 * public strategy URL. robots.txt matches by prefix: a Disallow of "/strategies/mine"
 * would also block /strategies/minervini-trend-template, and it would do so
 * silently, with every other test green.
 *
 * The check reads the Disallow lines of the GET() body, not a copy of
 * route.ts's PRIVATE_PATHS, so a private path added there is tested as it is
 * served. The set of strategy Disallows is pinned exactly: adding one (say
 * "/strategies/c") must change this list on purpose, and then the prefix check
 * runs against every registry slug.
 */
import { GET } from "../route";
import { groupFor, parseRobotsGroups } from "../robots-groups";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";

const EXPECTED_PRIVATE_STRATEGY_PATHS = [
  "/strategies/alerts",
  "/strategies/compare",
  "/strategies/my",
];

async function robotsBody(): Promise<string> {
  return await GET().text();
}

/**
 * The Disallow lines of the `*` group and the AI group: the two groups a
 * search engine or a welcome AI crawler obeys. The AI group's closing
 * `Disallow: /` is left out here: it is the point of that group
 * (crawl-policy.test.ts), and it is a prefix of every URL by design.
 */
function disallowLines(body: string): string[] {
  const groups = parseRobotsGroups(body);
  const everyone = groupFor(groups, "*")!;
  const ai = groupFor(groups, "GPTBot")!;
  return [...everyone.disallows, ...ai.disallows.filter((d) => d !== "/")];
}

describe("robots.txt strategy private paths", () => {
  let body: string;
  let disallows: string[];

  beforeAll(async () => {
    body = await robotsBody();
    disallows = disallowLines(body);
  });

  it("disallows exactly the three private strategy paths", () => {
    const strategyDisallows = [
      ...new Set(disallows.filter((p) => p.startsWith("/strategies"))),
    ].sort();
    expect(strategyDisallows).toEqual(EXPECTED_PRIVATE_STRATEGY_PATHS);
  });

  it("each private strategy page is disallowed in both groups", () => {
    for (const path of EXPECTED_PRIVATE_STRATEGY_PATHS) {
      const occurrences = disallows.filter((p) => p === path).length;
      // The file has the User-Agent: * block and the AI-crawler block.
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });

  it("no Disallow in the file is a prefix of any public /strategies/<slug> URL", () => {
    expect(STRATEGY_SLUGS.length).toBeGreaterThan(0);
    for (const path of [...new Set(disallows)]) {
      for (const slug of STRATEGY_SLUGS) {
        const publicUrl = `/strategies/${slug}`;
        expect({ path, publicUrl, blocked: publicUrl.startsWith(path) }).toEqual(
          { path, publicUrl, blocked: false },
        );
      }
    }
  });

  it("never disallows /strategies/mine (it prefixes a real strategy slug)", () => {
    expect(disallows).not.toContain("/strategies/mine");
    expect(body).not.toMatch(/^Disallow: \/strategies\/mine$/m);
  });

  it("the public strategy paths stay allowed for AI crawlers", () => {
    expect(body).toMatch(/^Allow: \/strategies\/$/m);
    expect(body).toMatch(/^Allow: \/strategies$/m);
  });

  it("no /picks path is left in robots.txt", () => {
    expect(body).not.toMatch(/\/picks/);
  });
});
