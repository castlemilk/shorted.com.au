import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("housing state cross-domain links", () => {
  const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

  it("links to the matching economy and the relevant housing hubs", () => {
    expect(source).toContain("href={`/economy/${stateSlug(code)}`}");
    expect(source).toContain('href="/housing"');
    expect(source).toContain("href={`/price-drops?state=${stateSlug(code)}`}");
  });

  it("does not read search params in the ISR server page", () => {
    expect(source).not.toContain("searchParams");
  });
});
