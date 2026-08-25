import {
  THEMES,
  THEME_SLUGS,
  getTheme,
  themesForIndustry,
  themesForTicker,
} from "~/@/lib/themes/registry";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TICKER = /^[A-Z0-9]{2,4}$/;
const MIN_TICKERS = 5;
const MIN_BLURB_WORDS = 100;

const themes = Object.values(THEMES);

describe("theme registry", () => {
  it("keys the record by each theme's own slug", () => {
    for (const [key, theme] of Object.entries(THEMES)) {
      expect(theme.slug).toBe(key);
    }
  });

  it("has unique kebab-case slugs", () => {
    const slugs = themes.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(KEBAB_CASE);
    }
  });

  it("cross-links only to themes that exist, never to itself", () => {
    for (const theme of themes) {
      for (const related of theme.relatedThemes) {
        expect(THEME_SLUGS).toContain(related);
        expect(related).not.toBe(theme.slug);
      }
      expect(new Set(theme.relatedThemes).size).toBe(theme.relatedThemes.length);
    }
  });

  // Tickers go straight into ScreenerFilters.product_codes; the API uppercases
  // defensively, but a lowercase or duplicated code here is a curation error.
  it("carries uppercase, unique tickers", () => {
    for (const theme of themes) {
      for (const ticker of theme.tickers) {
        expect(ticker).toMatch(TICKER);
      }
      expect(new Set(theme.tickers).size).toBe(theme.tickers.length);
    }
  });

  it("has at least five verified tickers per theme", () => {
    for (const theme of themes) {
      expect(theme.tickers.length).toBeGreaterThanOrEqual(MIN_TICKERS);
    }
  });

  it("has unique editorial copy of at least 100 words per theme", () => {
    const blurbs = new Set<string>();
    for (const theme of themes) {
      const words = theme.blurb.trim().split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(MIN_BLURB_WORDS);
      blurbs.add(theme.blurb);
    }
    expect(blurbs.size).toBe(themes.length);
  });

  it("populates every SEO field", () => {
    for (const theme of themes) {
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.title.length).toBeGreaterThan(0);
      expect(theme.h1.length).toBeGreaterThan(0);
      expect(theme.description.length).toBeGreaterThan(0);
      expect(theme.dek.length).toBeGreaterThan(0);
      expect(theme.keywords.length).toBeGreaterThan(0);
      expect(theme.relatedIndustries.length).toBeGreaterThan(0);
    }
  });

  // The layout template appends "| Shorted" — a title carrying it would double up.
  it("omits the site suffix from titles", () => {
    for (const theme of themes) {
      expect(theme.title).not.toContain("| Shorted");
    }
  });

  it("resolves known slugs and rejects unknown ones", () => {
    expect(getTheme("lithium")?.slug).toBe("lithium");
    expect(getTheme("not-a-theme")).toBeUndefined();
  });
});

describe("themesForTicker", () => {
  it("returns every theme containing the code, in registry order", () => {
    // PLS is deliberately in two baskets (registry curation rule 3).
    expect(themesForTicker("PLS").map((t) => t.slug)).toEqual([
      "lithium",
      "battery-metals",
    ]);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(themesForTicker(" pls ").map((t) => t.slug)).toEqual(
      themesForTicker("PLS").map((t) => t.slug),
    );
  });

  it("returns an empty array for a code in no basket", () => {
    expect(themesForTicker("ZZZZ")).toEqual([]);
    expect(themesForTicker("")).toEqual([]);
  });

  // The chips render theme.name straight from these objects.
  it("returns full definitions, not slugs", () => {
    const [first] = themesForTicker("CBA");
    expect(first?.slug).toBe("banks");
    expect(first?.name).toBe("Banks");
  });

  // The reverse index is shared module state — a caller must not be able to
  // corrupt it for every later render in the process.
  it("cannot be mutated through the returned array", () => {
    themesForTicker("PLS").pop();
    expect(themesForTicker("PLS")).toHaveLength(2);
  });

  it("agrees with the forward mapping for every ticker", () => {
    for (const theme of themes) {
      for (const ticker of theme.tickers) {
        expect(themesForTicker(ticker).map((t) => t.slug)).toContain(
          theme.slug,
        );
      }
    }
  });
});

describe("themesForIndustry", () => {
  it("matches an exact GICS industry string", () => {
    expect(themesForIndustry("Banks").map((t) => t.slug)).toEqual(["banks"]);
  });

  it("matches case-insensitively", () => {
    expect(themesForIndustry("banks").map((t) => t.slug)).toEqual(["banks"]);
  });

  it("returns every theme claiming a shared industry", () => {
    const slugs = themesForIndustry("Materials").map((t) => t.slug);
    expect(slugs).toContain("lithium");
    expect(slugs).toContain("gold");
  });

  it("returns an empty array for an unclaimed or blank industry", () => {
    expect(themesForIndustry("Utilities")).toEqual([]);
    expect(themesForIndustry("")).toEqual([]);
  });
});
