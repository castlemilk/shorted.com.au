import isrPages from "../isr-pages.json";
import isrShellPages from "../isr-shell-pages.json";

// The shell subset is the pages whose empty-at-build render is a user-visible
// shell, so they need a RE-PRIME after the post-promote revalidate, not just an
// invalidate. It used to be expressed as `isrPages.slice(0, 5)` — correct only
// while nobody reordered or prepended an entry in isr-pages.json, and nothing
// pinned that. These tests make the coupling explicit instead of positional.

describe("isr-shell-pages.json", () => {
  it("is a non-empty array of /-prefixed paths", () => {
    expect(Array.isArray(isrShellPages)).toBe(true);
    expect(isrShellPages.length).toBeGreaterThan(0);
    for (const path of isrShellPages) {
      expect(typeof path).toBe("string");
      expect(path.startsWith("/")).toBe(true);
    }
  });

  // A shell page not in the full inventory would be re-primed but never
  // revalidated post-promote, so it would be re-primed from a stale shell.
  it("is a subset of the full ISR inventory", () => {
    const all = new Set(isrPages as string[]);
    const orphans = (isrShellPages as string[]).filter((p) => !all.has(p));
    expect(orphans).toEqual([]);
  });

  it("has no duplicates", () => {
    expect(new Set(isrShellPages as string[]).size).toBe(isrShellPages.length);
  });

  // Guards the specific regression this file replaces: the subset must not
  // silently change when isr-pages.json is reordered. Naming them here means a
  // reorder can never quietly re-point the warm set at different pages.
  it("names the shell pages explicitly", () => {
    expect(isrShellPages).toEqual([
      "/market",
      "/housing",
      "/economy",
      "/compare",
      "/price-drops",
      "/themes",
      "/housing/nsw/council",
      "/housing/vic/council",
      "/housing/qld/council",
      "/housing/sa/council",
      "/housing/wa/council",
      "/housing/tas/council",
      "/housing/nt/council",
      "/housing/act/council",
    ]);
  });
});

// /themes/[slug] builds as a deliberately-empty static shell (skipForBuild)
// that the post-promote sweep fills. A theme present in the registry but
// missing from isr-pages.json ships every deploy as an empty page until its
// first natural revalidation — exactly what happened on the feature's launch
// deploy (2026-08-25). The slug list lives in the registry; this pins the
// sweep inventory to it.
describe("theme pages in the ISR sweep inventory", () => {
  it("covers /themes and every registry slug", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { THEME_SLUGS } = require("~/@/lib/themes/registry") as {
      THEME_SLUGS: string[];
    };
    const all = new Set(isrPages as string[]);
    expect(all.has("/themes")).toBe(true);
    const missing = THEME_SLUGS.filter((slug) => !all.has(`/themes/${slug}`));
    expect(missing).toEqual([]);
  });
});

// Housing ranking pages deliberately skip their live state read at build time
// and depend on the post-promote sweep to fill the hourly ISR cache. Keep the
// deployment inventory coupled to the registry so adding the 41st route cannot
// repeat the themes launch regression.
describe("housing ranking pages in the ISR sweep inventory", () => {
  it("covers /housing/rankings and every registry slug", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HOUSING_RANKING_SLUGS } =
      require("~/@/lib/housing-rankings/registry") as {
        HOUSING_RANKING_SLUGS: string[];
      };
    const all = new Set(isrPages as string[]);
    expect(all.has("/housing/rankings")).toBe(true);
    const missing = HOUSING_RANKING_SLUGS.filter(
      (slug) => !all.has(`/housing/rankings/${slug}`),
    );
    expect(missing).toEqual([]);
  });
});

// Capital pages also render an intentionally uncached empty state when the
// build skips its live ABS-series reads. Couple the post-promote sweep to the
// registry so every new capital route is primed alongside the hub.
describe("capital housing pages in the ISR sweep inventory", () => {
  it("covers /housing/capitals and every registry slug", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CAPITAL_SLUGS } = require("~/@/lib/housing/capitals") as {
      CAPITAL_SLUGS: string[];
    };
    const all = new Set(isrPages as string[]);
    expect(all.has("/housing/capitals")).toBe(true);
    const missing = CAPITAL_SLUGS.filter(
      (slug) => !all.has(`/housing/capitals/${slug}`),
    );
    expect(missing).toEqual([]);
  });
});

// The council index pages build as empty shells under SKIP_STATIC_GENERATION
// (listCouncils skips at build), so an invalidate alone would hand the first
// post-deploy visitor "Council data is loading" (stale-while-revalidate serves
// the shell once). They are in BOTH sets: the post-promote sweep inventory and
// the shell re-prime. The 15-minute re-prime costs 8 regenerations that read
// the 24h KV entry, not the API. bailOnEmptyRender still keeps a runtime empty
// render out of the cache.
describe("council index pages in the ISR sweep and shell re-prime", () => {
  it("covers /housing/<state>/council for all eight states", () => {
    const all = new Set(isrPages as string[]);
    const shells = new Set(isrShellPages as string[]);
    for (const st of ["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"]) {
      expect(all.has(`/housing/${st}/council`)).toBe(true);
      expect(shells.has(`/housing/${st}/council`)).toBe(true);
    }
  });
});

// The state indexes build with an empty suburb directory (the directory read
// skips at build), the suburb, council and industry pages read live data, and
// the editorial indexes list rows published between deploys. Until 2026-09-25
// none of them were in the sweep, so every promote handed them out as
// build-time placeholders for up to their 24h TTL unless someone ran
// `task deploy:revalidate` by hand with the right path list. A path containing
// `[` revalidates the whole dynamic route (see api/revalidate/route.ts).
describe("state, suburb, industry and editorial routes in the ISR sweep inventory", () => {
  it("covers the eight state indexes and the dynamic routes", () => {
    const all = new Set(isrPages as string[]);
    for (const st of ["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"]) {
      expect(all.has(`/housing/${st}`)).toBe(true);
    }
    for (const pattern of [
      "/housing/[state]/[suburb]",
      "/housing/[state]/council/[slug]",
      "/industry-intelligence",
      "/industry/[slug]",
      "/blog",
      "/news",
      "/news/[slug]",
    ]) {
      expect(all.has(pattern)).toBe(true);
    }
  });

  it("has no duplicates in the full inventory", () => {
    expect(new Set(isrPages as string[]).size).toBe(isrPages.length);
  });
});
