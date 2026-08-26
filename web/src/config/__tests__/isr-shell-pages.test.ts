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
