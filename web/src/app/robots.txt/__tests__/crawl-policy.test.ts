/**
 * The crawl policy robots.txt states, group by group.
 *
 * Measured in Cloudflare zone analytics over the 7 days to 2026-11-07: AI
 * crawlers were 107k requests and AI search 77k, Baidu 109k on its own, and
 * the AI group's `Allow: /` was a prefix of every path, so the forty allows
 * under it changed nothing. The group now ends with `Disallow: /`, the
 * homepage is `/$`, the group carries a Crawl-delay, the parameterised views
 * are disallowed for everyone, and the steered crawlers get one page.
 */
import { GET } from "../route";
import { DATA_LICENCE_PATH, STEERED_CRAWLERS } from "~/@/lib/seo/crawl-policy";
import { groupFor, isAllowed, parseRobotsGroups, type RobotsGroup } from "../robots-groups";

describe("robots.txt crawl policy", () => {
  let groups: RobotsGroup[];
  let everyone: RobotsGroup;
  let ai: RobotsGroup;
  let steered: RobotsGroup;

  beforeAll(async () => {
    groups = parseRobotsGroups(await GET().text());
    everyone = groupFor(groups, "*")!;
    ai = groupFor(groups, "GPTBot")!;
    steered = groupFor(groups, "Baiduspider")!;
  });

  it("has one group for everyone, one for the AI crawlers and one for the steered crawlers", () => {
    expect(groups).toHaveLength(3);
    expect(everyone.agents).toEqual(["*"]);
    expect(ai.agents).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "CCBot"]));
    expect(steered.agents).toEqual(STEERED_CRAWLERS);
  });

  it("closes the AI group with Disallow: / and allows the homepage as /$ only", () => {
    expect(ai.disallows[ai.disallows.length - 1]).toBe("/");
    expect(ai.allows).toContain("/$");
    expect(ai.allows).not.toContain("/");
    // The `*` group keeps the bare allow: search engines read everything.
    expect(everyone.allows).toContain("/");
    expect(everyone.disallows).not.toContain("/");
  });

  it("lets the AI group read the content sections and nothing else", () => {
    for (const path of [
      "/",
      "/shorts/BHP",
      "/shorts/BHP/financials",
      "/top",
      "/housing/nsw/bondi",
      "/ownership/stocks/BHP",
      "/strategies/canslim",
      "/blog/some-post",
      "/docs/api",
      "/llms.txt",
    ]) {
      expect({ path, allowed: isAllowed(ai, path) }).toEqual({ path, allowed: true });
    }
    for (const path of [
      "/chart/BHP",
      "/chart/BHP/image",
      "/compare",
      "/signin",
      "/embed/chart",
      "/_next/image?url=x",
      "/shorts.v1alpha1.StockService/GetStock",
      "/strategies/my",
    ]) {
      expect({ path, allowed: isAllowed(ai, path) }).toEqual({ path, allowed: false });
    }
  });

  it("asks the AI group for a crawl delay", () => {
    expect(ai.crawlDelay).toBe(5);
    expect(everyone.crawlDelay).toBeUndefined();
  });

  it("disallows the parameterised views for everyone", () => {
    for (const query of ["sel", "status", "sort", "window"]) {
      for (const group of [everyone, ai]) {
        expect(group.disallows).toContain(`/*?${query}=`);
      }
      expect(isAllowed(everyone, `/ownership/map?${query}=x`)).toBe(false);
    }
    // The chart share links carry period and view and must stay fetchable.
    expect(isAllowed(everyone, "/chart/WBT?view=short&period=3m")).toBe(true);
    expect(isAllowed(everyone, "/strategies/canslim")).toBe(true);
  });

  it("gives a steered crawler the data-licence page and nothing else", () => {
    expect(steered.allows).toEqual([DATA_LICENCE_PATH]);
    expect(steered.disallows).toEqual(["/"]);
    expect(isAllowed(steered, DATA_LICENCE_PATH)).toBe(true);
    expect(isAllowed(steered, "/")).toBe(false);
    expect(isAllowed(steered, "/housing/nsw")).toBe(false);
    // The group is reached by its own token, not the AI list.
    for (const agent of STEERED_CRAWLERS) {
      expect(groupFor(groups, agent)).toBe(steered);
    }
  });

  it("points at the data-licence page from the header comment", async () => {
    const body = await GET().text();
    expect(body).toContain(`https://shorted.com.au${DATA_LICENCE_PATH}`);
  });
});
