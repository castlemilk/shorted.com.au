/// <reference types="jest" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "..");

describe("retired housing suburb explorer cleanup", () => {
  it("keeps the redirect but removes the unreachable route and component cluster", () => {
    const retiredPaths = [
      "web/src/app/housing/suburbs/page.tsx",
      "web/src/@/components/housing/suburb-explorer.tsx",
      "web/src/@/components/housing/suburb-explorer-loader.tsx",
      "web/src/@/components/housing/suburb-map.tsx",
      "web/src/@/components/housing/data/suburb-centroids.json",
    ];

    for (const path of retiredPaths) {
      expect(existsSync(join(ROOT, path))).toBe(false);
    }

    const nextConfig = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8");
    expect(nextConfig).toContain('{ source: "/housing/suburbs", destination: "/housing", permanent: true }');
  });

  it("does not hardcode the set of Valuer-General coverage states", () => {
    const files = [
      "web/src/@/components/housing/state-suburb-explorer.tsx",
      "web/src/@/components/housing/state-suburb-map.tsx",
      "web/src/@/components/housing/suburb-profile.tsx",
    ];

    for (const path of files) {
      const source = readFileSync(join(ROOT, path), "utf8");
      expect(source).not.toMatch(/SA (?:&|&amp;) VIC/);
    }
  });

  it("removes the dead sitemap helper", () => {
    const sitemapHelper = readFileSync(join(ROOT, "web/src/app/actions/getHousingSitemap.ts"), "utf8");

    expect(sitemapHelper).not.toContain("getHousingSuburbUrls");
  });
});
