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
import { GET } from "../route";

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

  it("never disallows an indexable content surface", () => {
    for (const p of [
      "Disallow: /shorts/",
      "Disallow: /housing",
      "Disallow: /reports",
      "Disallow: /compare",
      "Disallow: /economy",
      "Disallow: /top",
      "Disallow: /\n",
    ]) {
      expect(body).not.toContain(p);
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
});
