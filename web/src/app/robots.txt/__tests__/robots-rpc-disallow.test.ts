/**
 * robots.txt must keep Connect-RPC endpoints out of the crawl, and must keep
 * everything else in it.
 *
 * Why this exists: measured on 2026-08-23, **56.7% of Googlebot's crawl budget
 * on shorted.com.au** (1,124 of 1,983 hits/24h) was being spent on
 * `/shorts.v1alpha1.*Service` paths — protobuf-JSON that can never be indexed.
 * Real content pages got ~19% against an 8,748-URL sitemap. Those paths sit at
 * the ROOT because next.config.mjs rewrites them straight to the API, so the
 * long-standing `Disallow: /api/` never covered them.
 *
 * The two failure directions are asymmetric, so both are pinned below:
 *   - losing an RPC Disallow quietly burns the crawl budget again;
 *   - adding a Disallow for `/_next/` or a content path would stop Google
 *     rendering or indexing the site, which is far worse.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "../route";
import { groupFor, isAllowed, parseRobotsGroups } from "../robots-groups";

async function robotsBody(): Promise<string> {
  const res = GET();
  return await res.text();
}

describe("robots.txt", () => {
  let body: string;

  beforeAll(async () => {
    body = await robotsBody();
  });

  it("disallows every Connect-RPC namespace", async () => {
    for (const ns of [
      "/shorts.v1alpha1.",
      "/marketdata.v1.",
      "/chat.v1.",
      "/register.v1.",
    ]) {
      expect(body).toContain(`Disallow: ${ns}`);
    }
  });

  it("applies the RPC disallow to the AI-crawler group as well", () => {
    // The file has two blocks (User-Agent: * and the AI crawler list). Both
    // must carry it, or the AI crawlers keep burning origin requests on JSON.
    const occurrences = body.split("Disallow: /shorts.v1alpha1.").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("still disallows the private surfaces", () => {
    for (const p of ["/admin/", "/api/", "/portfolio/", "/dashboards/"]) {
      expect(body).toContain(`Disallow: ${p}`);
    }
  });

  it("NEVER disallows /_next/ — that would break Google's rendering", () => {
    // The classic own-goal: Google needs the JS and CSS to render the page.
    expect(body).not.toContain("Disallow: /_next");
  });

  it("never disallows an indexable content surface for search engines", () => {
    // The `*` group is the one Googlebot obeys. The AI group ends with
    // `Disallow: /` on purpose (crawl-policy.test.ts), so this reads the group,
    // not the file.
    const everyone = groupFor(parseRobotsGroups(body), "*")!;
    expect(everyone.disallows).not.toContain("/");
    for (const p of ["/shorts/", "/housing", "/reports", "/compare", "/economy", "/top"]) {
      expect(everyone.disallows).not.toContain(p);
    }
    for (const path of ["/shorts/BHP", "/housing/nsw/bondi", "/reports/2026-W40", "/compare", "/economy/vic", "/top"]) {
      expect({ path, allowed: isAllowed(everyone, path) }).toEqual({ path, allowed: true });
    }
  });

  it("does not accidentally disallow /shorts/ when disallowing the RPC prefix", () => {
    // `/shorts.v1alpha1.` and `/shorts/` share a prefix up to "/shorts", so a
    // sloppy rule like `Disallow: /shorts` would take out every stock page —
    // the single most valuable surface on the site. The trailing dot is what
    // keeps them apart.
    const rpcRules = body
      .split("\n")
      .filter((l) => l.startsWith("Disallow: /shorts"));
    expect(rpcRules.length).toBeGreaterThan(0);
    for (const rule of rpcRules) {
      expect(rule).toBe("Disallow: /shorts.v1alpha1.");
    }
  });

  it("still advertises the sitemap index and its children", () => {
    expect(body).toContain("Sitemap: https://shorted.com.au/sitemap.xml");
    expect(body).toContain("sitemap-shorts.xml");
  });

  it("keeps the Content-Signal directive", () => {
    expect(body).toContain("Content-Signal:");
  });

  // A chart shared to X or Slack is a /chart/<code> link, and Twitterbot and
  // Slackbot honour robots.txt: disallowed, the link posts with no preview.
  // The page keeps itself out of the index with a noindex meta instead.
  // /embed/ stays disallowed: it is the iframe, not the thing people share.
  it("lets unfurlers fetch chart share links and their cards", () => {
    // Twitterbot and Slackbot obey the `*` group.
    const everyone = groupFor(parseRobotsGroups(body), "*")!;
    for (const path of ["/chart/WBT", "/chart/WBT/image", "/chart/WBT?view=short&period=3m"]) {
      expect({ path, allowed: isAllowed(everyone, path) }).toEqual({ path, allowed: true });
    }
    expect(everyone.disallows).toContain("/embed/");
  });

  // The share page's noindex also goes out as a header (next.config.mjs), so a
  // crawler that never renders the page still reads it. Only the one rule
  // covers /chart: the card at /chart/<code>/image is an unfurler's image and
  // carries no robots header.
  it("sends noindex, follow as a header on the chart share page only", () => {
    const config = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8");
    const rule =
      config.match(/source:\s*"\/chart\/:code",\s*headers:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(rule).toContain('key: "X-Robots-Tag"');
    expect(rule).toContain('value: "noindex, follow"');
    expect(config.match(/source:\s*"\/chart[^"]*"/g)).toEqual([
      'source: "/chart/:code"',
    ]);
  });
});
