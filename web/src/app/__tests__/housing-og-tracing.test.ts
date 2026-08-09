/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("housing OG logo tracing", () => {
  it.each([
    "/housing/[state]/opengraph-image",
    "/housing/calculators/opengraph-image",
    "/price-drops/opengraph-image",
  ])("traces both local logo candidates into %s", (route) => {
    const config = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8");
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const routeIncludes = config.match(new RegExp(`"${escapedRoute}"\\s*:\\s*\\[([^\\]]*)\\]`))?.[1] ?? "";

    expect(routeIncludes).toContain('"./public/icon-512.png"');
    expect(routeIncludes).toContain('"./public/logo.png"');
  });
});
