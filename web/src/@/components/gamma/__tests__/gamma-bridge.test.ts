/// <reference types="jest" />

/**
 * The Gamma bridge (spec 14.5). Every `--gamma-*` token the vendored component
 * blocks read must be defined by gamma-bridge.css in BOTH themes, so no component
 * falls back to a browser default in dark mode. The vendored TSX must also stay
 * free of the em dash the house copy rules forbid.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

/** The declarations of one rule block, by its selector line. */
function block(css: string, selector: RegExp): string {
  const start = css.search(selector);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close < 0 ? undefined : close);
}

function defined(declarations: string): Set<string> {
  return new Set([...declarations.matchAll(/(--gamma-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

describe("gamma bridge", () => {
  const copied = read("gamma.css") + read("DataTable.css");
  const bridge = read("gamma-bridge.css");
  const light = defined(block(bridge, /:root\s*\{/));
  const dark = defined(block(bridge, /\.dark\s*\{/));
  const used = [...new Set([...copied.matchAll(/var\((--gamma-[a-z0-9-]+)/g)].map((m) => m[1]!))];

  it("reads a non-empty set of gamma tokens from the copied blocks", () => {
    expect(used.length).toBeGreaterThan(30);
  });

  it.each(used)("defines %s in the light theme", (name) => {
    expect(light.has(name)).toBe(true);
  });

  it.each(used)("defines %s in the dark theme", (name) => {
    expect(dark.has(name)).toBe(true);
  });

  // Gamma's success and danger are the direction of a change (KpiCard). A market
  // number's direction is the only red or green the site draws, so the bridge may
  // not resolve either tone to the market green or the destructive red in any theme.
  it.each([
    ["light", block(bridge, /:root\s*\{/)],
    ["dark", block(bridge, /\.dark\s*\{/)],
  ])("never resolves a status tone to a market colour in the %s theme", (_theme, decls) => {
    const tones = ["--gamma-success", "--gamma-success-soft", "--gamma-danger", "--gamma-danger-soft"];
    for (const tone of tones) {
      const value = decls.match(new RegExp(`${tone}\\s*:\\s*([^;]+);`))?.[1] ?? "";
      expect(value).not.toBe("");
      expect(value).not.toMatch(/semantic-green|destructive|green|red/);
    }
  });

  // The workspace's local changes to the vendored copy (README "Local changes", spec 14.7).
  it("draws the inspector's bottom sheet from a local block with its keyframe", () => {
    const css = read("gamma.css");
    expect(css).toMatch(/\.side-sheet\[data-side="bottom"\]\s*\{/);
    expect(css).toMatch(/@keyframes side-sheet-enter-bottom\s*\{/);
  });

  it("sets the KPI value in the UI face with tabular numerals", () => {
    const decls = block(read("gamma.css"), /\.kpi-card-value\s*\{/);
    expect(decls).toContain("var(--gamma-font-ui)");
    expect(decls).toContain("tabular-nums");
  });

  it("keeps motion/react out of the vendored DataTable", () => {
    expect(read("DataTable.tsx")).not.toMatch(/from\s+["']motion/);
  });

  it("keeps the em dash out of every vendored and bridge file", () => {
    const emDash = String.fromCharCode(0x2014);
    const files = readdirSync(DIR).filter((f) => /\.(tsx?|css|md)$/.test(f));
    const offenders = files.filter((f) => read(f).includes(emDash));
    expect(offenders).toEqual([]);
  });
});
