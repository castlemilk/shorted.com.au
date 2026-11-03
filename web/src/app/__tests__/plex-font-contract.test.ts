/**
 * The IBM Plex Mono contract, read from source. Jest mocks the root layout,
 * Storybook never applies the next/font class, and the e2e specs load fonts
 * instantly from localhost, so nothing else would notice a rename on either
 * side: the stacks would fall back to the system monospace with every check green.
 *
 * Read from source: importing layout pulls fonts and providers into Jest.
 */
import { readFileSync } from "fs";
import path from "path";

const appDir = path.join(__dirname, "..");
const stylesDir = path.join(__dirname, "..", "..", "styles");
const read = (file: string) => readFileSync(file, "utf8");

const layout = read(path.join(appDir, "layout.tsx"));
const stacks = {
  "globals.css": read(path.join(stylesDir, "globals.css")),
  "critical-css.ts": read(path.join(stylesDir, "critical-css.ts")),
};

describe("IBM Plex Mono as the app face", () => {
  it("is declared by next/font as --font-plex-mono, preloaded, with no generated Arial face", () => {
    const call = /const fontMono = IBM_Plex_Mono\(\{([\s\S]*?)\}\);/.exec(layout);
    expect(call).not.toBeNull();
    const options = call![1];
    expect(options).toMatch(/subsets:\s*\["latin"\]/);
    expect(options).toMatch(/weight:\s*\["400",\s*"500",\s*"600",\s*"700"\]/);
    expect(options).toMatch(/variable:\s*"--font-plex-mono"/);
    expect(options).toMatch(/display:\s*"swap"/);
    expect(options).toMatch(/preload:\s*true/);
    expect(options).toMatch(/adjustFontFallback:\s*false/);
  });

  it("puts that variable on <html>, the element the --font-sans stacks are computed on", () => {
    expect(layout).toMatch(/<html[^>]*className=\{`\$\{fontMono\.variable\}/);
  });

  it.each(Object.entries(stacks))(
    "%s reads the variable, with the literal name as its fallback",
    (_file, source) => {
      const declarations = [...source.matchAll(/--font-sans:\s*([^;]+);/g)].map((m) =>
        m[1].trim(),
      );
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.startsWith('var(--font-plex-mono, "IBM Plex Mono"),')).toBe(true);
      }
    },
  );
});
