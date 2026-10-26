/**
 * The child-sitemap registry, its routes and the two files that advertise it
 * agree.
 *
 * SITEMAP_CHILDREN (sitemap-xml.ts) is what /sitemap.xml and robots.txt list;
 * each child is served by its own route handler, app/<child>/route.ts. The
 * ownership child (2026-10-21) took the registry from five entries to six, and
 * nothing tied the two halves together: a child registered without a route is
 * a 404 inside the sitemap index, and a route left out of the registry is a
 * sitemap no crawler is told about. No count is pinned here, so the next child
 * needs no edit to this file.
 */
import fs from "fs";
import path from "path";

import { SITEMAP_CHILDREN } from "~/@/lib/seo/sitemap-xml";
import { GET as robotsTxt } from "../robots.txt/route";
import { GET as sitemapIndex } from "../sitemap.xml/route";

const APP_DIR = path.join(process.cwd(), "src", "app");

const childRouteDirs = fs
  .readdirSync(APP_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^sitemap-.+\.xml$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

describe("sitemap children", () => {
  it("serves every registered child from its own GET route", () => {
    for (const child of SITEMAP_CHILDREN) {
      const route = path.join(APP_DIR, child, "route.ts");
      expect({ child, exists: fs.existsSync(route) }).toEqual({ child, exists: true });
      expect(fs.readFileSync(route, "utf8")).toMatch(/export (async )?function GET\b/);
    }
  });

  it("registers every child route", () => {
    expect(childRouteDirs).toEqual([...SITEMAP_CHILDREN].sort());
    expect(childRouteDirs).toContain("sitemap-ownership.xml");
  });

  it("lists every child in the /sitemap.xml index", async () => {
    const xml = await sitemapIndex().text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    expect(locs).toEqual(
      SITEMAP_CHILDREN.map((child) => `https://shorted.com.au/${child}`),
    );
  });

  it("advertises every child in robots.txt", async () => {
    const body = await robotsTxt().text();

    for (const child of SITEMAP_CHILDREN) {
      expect(body).toContain(`Sitemap: https://shorted.com.au/${child}`);
    }
  });
});
