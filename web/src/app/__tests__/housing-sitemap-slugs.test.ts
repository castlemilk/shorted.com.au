/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("housing sitemap suburb slugs", () => {
  it("uses the shared canonical suburbSlug helper", () => {
    const source = readFileSync(join(process.cwd(), "src/app/sitemap.ts"), "utf8");

    expect(source).toMatch(/import[^;]*suburbSlug[^;]*from ["']~\/@\/lib\/housing\/states["']/s);
    expect(source).toContain("suburb: suburbSlug(s.salName, s.postcode)");
    expect(source).not.toMatch(/const slugifySuburb/);
  });
});
