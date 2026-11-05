/**
 * DESIGN.md's Semantic Quarantine Rule for the strategy workspace: the market
 * red and green (the mark tokens and the raw hexes) mean the direction of a
 * market number and nothing else. Rule outcomes, statuses, entries, exits and
 * delivery never use them. Returns heatmap fills go through
 * lib/strategies/returns-scale.ts, the one place that may mix the mark tokens,
 * so the components here may not name them.
 *
 * A negative figure is text in `--semantic-red-text` (the text token, which the
 * rule allows). The mark tokens, their raw hexes, and Tailwind's default red and
 * green utilities (text-red-600, bg-green-500: #ef4444 and #22c55e) are what
 * this guard forbids.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { LEVEL_COLORS } from "~/@/components/strategy/strategy-levels";

const COMPONENT_DIR = join(__dirname, "..");

/** Files that may name the market colours, by base name. None yet in this directory. */
const EXEMPT = new Set<string>();

/**
 * Tailwind's default red and green (and the emerald and rose families), as a
 * utility class: text-red-600, bg-green-500, ring-emerald-400. The config extends
 * the palette, so these classes still exist and would paint market colours.
 */
const TAILWIND_MARKET =
  /\b(?:text|bg|border|fill|stroke|ring|outline|from|via|to)-(?:red|green|emerald|rose)-\d{2,3}\b/;

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /--semantic-(green|red)(?!-text)/, why: "the market mark token" },
  { pattern: /#22c55e|#ef4444|#16a34a|#dc2626/i, why: "a raw market hex" },
  { pattern: TAILWIND_MARKET, why: "a Tailwind market colour utility" },
];

function kitFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory())
      return entry === "__tests__" ? [] : kitFiles(path);
    if (
      !/\.tsx?$/.test(entry) ||
      entry.endsWith(".test.ts") ||
      entry.endsWith(".test.tsx")
    )
      return [];
    return EXEMPT.has(entry) ? [] : [path];
  });
}

describe("strategy components keep the market colours to direction", () => {
  const files = kitFiles(COMPONENT_DIR);

  it("has components to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.slice(COMPONENT_DIR.length + 1)} names no market mark colour`, () => {
      const source = readFileSync(file, "utf8");
      for (const { pattern, why } of BANNED) {
        const hit = source.match(pattern);
        expect(hit ? `${why}: ${hit[0]}` : null).toBeNull();
      }
    });
  }
});

describe("the levels chart's line colours (shared with the Strategy tab)", () => {
  it.each(Object.entries(LEVEL_COLORS))("%s is not a market colour", (_name, color) => {
    expect(color).not.toMatch(/#22c55e|#ef4444|#16a34a|#dc2626|semantic-(green|red)(?!-text)/i);
  });
});

describe("the Tailwind market utilities", () => {
  it.each([
    "text-red-600",
    "bg-green-500",
    "ring-emerald-400",
    "from-rose-300",
  ])("bans %s", (cls) => {
    expect(cls.match(TAILWIND_MARKET)).not.toBeNull();
  });

  it.each([
    "text-red-foreground",
    "text-muted-foreground",
    "bg-card",
    "text-semantic-red-text",
  ])("allows %s", (cls) => {
    expect(cls.match(TAILWIND_MARKET)).toBeNull();
  });
});
