/// <reference types="jest" />

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

describe("housing OG logo tracing", () => {
  const appDir = join(process.cwd(), "src/app");

  function sharedCardRoutes(dir: string = appDir): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sharedCardRoutes(path);
      if (entry.name !== "opengraph-image.tsx") return [];
      if (!readFileSync(path, "utf8").includes("getOgLogo")) return [];
      return [`/${relative(appDir, path).split(sep).slice(0, -1).join("/")}/opengraph-image`];
    });
  }

  it("traces both local logo candidates into every shared-card route", () => {
    const config = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8");
    const routeIncludes = config.match(/"\/\*\*\/opengraph-image"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const routes = sharedCardRoutes();

    expect(routes.length).toBeGreaterThan(30);
    expect(routeIncludes).toContain('"./public/icon-512.png"');
    expect(routeIncludes).toContain('"./public/logo.png"');
    expect(routes.every((route) => route.endsWith("/opengraph-image"))).toBe(true);
  });
});
