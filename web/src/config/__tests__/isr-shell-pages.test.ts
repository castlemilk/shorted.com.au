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
    ]);
  });
});
