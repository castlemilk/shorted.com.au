/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_TOKENS, type Token } from "../design-tokens";

/**
 * The design-system page documents token VALUES. Documentation that drifts from
 * the stylesheet is worse than none, because people then design against a
 * palette the app does not ship. These tests parse globals.css and hold the two
 * together — if you change a token, this fails until the registry agrees.
 */
const CSS = readFileSync(
  join(process.cwd(), "src", "styles", "globals.css"),
  "utf8",
);

/** The `:root { … }` and `.dark { … }` blocks, as raw text. */
function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = CSS.indexOf("\n  }", start);
  expect(end).toBeGreaterThan(start);
  return CSS.slice(start, end);
}

const ROOT = block(":root");
const DARK = block(".dark");

/** Last declaration wins, matching the cascade. */
function declared(scope: string, name: string): string | null {
  const re = new RegExp(`--${name}:\\s*([^;]+);`, "g");
  let value: string | null = null;
  for (const m of scope.matchAll(re)) value = m[1]!.trim();
  return value;
}

describe("design token registry matches globals.css", () => {
  it.each(ALL_TOKENS.map((t): [string, Token] => [t.name, t]))(
    "--%s is declared in both themes with the documented value",
    (_name, token) => {
      const light = declared(ROOT, token.name);
      const dark = declared(DARK, token.name);

      expect(light).not.toBeNull();
      expect(dark).not.toBeNull();
      expect(light!.toLowerCase()).toBe(token.light.toLowerCase());
      expect(dark!.toLowerCase()).toBe(token.dark.toLowerCase());
    },
  );

  it("records the right consumption form for each token", () => {
    // An HSL triplet used as `var(--x)` renders nothing, and a hex wrapped in
    // `hsl()` renders nothing. The registry's `form` field is what tells a
    // reader which of the two they are holding, so it must be accurate.
    for (const t of ALL_TOKENS) {
      const isHex = t.light.startsWith("#");
      expect(isHex).toBe(t.form === "hex");
    }
  });

  it("keeps a text-safe partner for every colour used on small text", () => {
    const names = new Set(ALL_TOKENS.map((t) => t.name));
    for (const base of ["semantic-green", "semantic-red"]) {
      expect(names.has(`${base}-text`)).toBe(true);
    }
    expect(names.has("secondary-text")).toBe(true);
  });
});
