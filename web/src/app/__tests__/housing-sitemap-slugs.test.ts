/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suburbSlug } from "~/@/lib/housing/states";

describe("housing sitemap suburb slugs", () => {
  it("uses the shared canonical suburbSlug helper", () => {
    const source = readFileSync(join(process.cwd(), "src/app/sitemap.ts"), "utf8");

    expect(source).toMatch(/import[^;]*suburbSlug[^;]*from ["']~\/@\/lib\/housing\/states["']/s);
    expect(source).toContain("suburb: suburbSlug(s.salName, s.postcode)");
    expect(source).not.toMatch(/const slugifySuburb/);
  });

  it("does not append a bare hyphen when the sitemap record has no postcode", () => {
    expect(suburbSlug("Abbotsford (Vic.)", "")).toBe("abbotsford-vic");
    expect(suburbSlug("Abbotsford (Vic.)", "3067")).toBe("abbotsford-vic-3067");
  });
});
