/**
 * DESIGN.md's Semantic Quarantine Rule for the strategy workspace: the market
 * red and green (the mark tokens and the raw hexes) mean the direction of a
 * market number and nothing else. Rule outcomes, statuses, entries, exits and
 * delivery never use them (charts-design research, section 2.3). Returns
 * heatmap fills go through lib/strategies/returns-scale.ts, the one place that
 * may mix the mark tokens, so the components here may not name them.
 *
 * A negative figure is text in `--semantic-red-text` (the text token, which the
 * rule allows); the mark tokens and their hexes are what this guard forbids.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");

/** Files that may name the market colours, by base name. None yet in this directory. */
const EXEMPT = new Set<string>();

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /--semantic-(green|red)(?!-text)/, why: "the market mark token" },
  { pattern: /#22c55e|#ef4444|#16a34a|#dc2626/i, why: "a raw market hex" },
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
