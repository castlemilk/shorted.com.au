import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("housing state cross-domain links", () => {
  const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

  it("links to the matching economy and the relevant housing hubs", () => {
    expect(source).toContain("href={`/economy/${stateSlug(code)}`}");
    expect(source).toContain('href="/housing"');
    expect(source).toContain("href={`/price-drops?state=${stateSlug(code)}`}");
    expect(source).toContain("href={`/housing/${stateSlug(code)}/council`}");
  });

  it("does not read search params in the ISR server page", () => {
    expect(source).not.toContain("searchParams");
  });
});

describe("housing state page crawlability", () => {
  const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

  it("server-renders a suburb directory so suburb pages are not sitemap-only orphans", () => {
    // The explorer is an ssr:false island; without this section the state
    // page's HTML linked to no suburb at all (Search Console URL inspection,
    // 2026-09: suburb pages referred only by the sitemap).
    expect(source).toContain("<StateSuburbDirectorySection");
    expect(source).toContain("getStateSuburbIndex(code)");
    // A failed index must not be baked into the 24h ISR entry.
    expect(source).toContain("bailOnEmptyRender()");
  });
});
