/**
 * The root layout must not declare a canonical (or any `alternates`).
 *
 * Next merges metadata per segment, so a canonical in app/layout.tsx is
 * inherited by every page that does not declare its own, and each such page
 * tells Google it is a duplicate of the homepage. An OpenSEO crawl on
 * 2026-10-15 found /pricing and /terms canonicalised to "/", and the same held
 * for /docs/api and its children, /developer, /alerts and others. The
 * homepage names its own canonical in app/page.tsx.
 *
 * Read from source: importing the layout pulls fonts and providers into Jest.
 */
import { readFileSync } from "fs";
import path from "path";

const appDir = path.join(__dirname, "..");
const read = (file: string) => readFileSync(path.join(appDir, file), "utf8");

describe("canonical URLs", () => {
  it("are not declared in the root layout", () => {
    const layout = read("layout.tsx");
    expect(layout).not.toMatch(/\balternates\s*:/);
    expect(layout).not.toMatch(/\bcanonical\s*:/);
  });

  it("are declared by the homepage itself", () => {
    expect(read("page.tsx")).toMatch(/canonical:\s*siteConfig\.url/);
  });

  it.each([
    ["pricing/page.tsx", "/pricing"],
    ["terms/page.tsx", "/terms"],
  ])("%s names itself", (file, route) => {
    expect(read(file)).toContain(`canonical: \`\${siteConfig.url}${route}\``);
  });
});
