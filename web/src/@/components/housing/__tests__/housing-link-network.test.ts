/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("housing internal link network", () => {
  it("does not render the permanently empty dwellings statistic", () => {
    const profile = read("src/@/components/housing/suburb-profile.tsx");

    expect(profile).not.toContain('["Dwellings"');
    expect(profile).not.toContain("d?.dwellingCount");
  });

  it("links the Widow-Maker feature to all live housing tools", () => {
    const feature = read("src/app/features/the-widow-maker/page.tsx");

    expect(feature).toContain('href="/housing"');
    expect(feature).toContain('href="/price-drops"');
    expect(feature).toContain('href="/housing/calculators"');
  });

  it("links the housing hub back to the featured investigation", () => {
    const housing = read("src/app/housing/page.tsx");

    expect(housing).toContain('href="/features/the-widow-maker"');
  });

  it("links each economy state page to its matching housing state explorer", () => {
    const economyState = read("src/app/economy/[state]/page.tsx");

    expect(economyState).toContain("href={`/housing/${state}`}");
  });
});
