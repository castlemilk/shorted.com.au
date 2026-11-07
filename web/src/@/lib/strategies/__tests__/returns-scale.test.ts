import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COVERAGE_HATCH_BELOW,
  GREEN_FILL_MAX,
  RED_FILL_MAX,
  RETURNS_INK,
  RETURNS_PLAIN_INK,
  binFill,
  coverageFraction,
  coverageHatched,
  returnBin,
  returnsLegend,
  type ReturnsScale,
} from "../returns-scale";
import { coverageKnown, printedReturn } from "../returns-scale";

// The contrast check reads the real tokens, so a palette change that breaks
// the ink fails here, not in a screenshot.
const CSS = readFileSync(
  join(__dirname, "..", "..", "..", "..", "styles", "globals.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The `--name: value` declarations of the first block that opens with `selector`. */
function tokens(selector: RegExp): Record<string, string> {
  const start = CSS.search(selector);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const open = CSS.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = CSS.slice(open + 1, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out[m[1]!] = m[2]!.trim();
  return out;
}

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
};

/** An HSL triplet "h s% l%" as sRGB, the way `hsl(var(--x))` resolves. */
function hslTripletToRgb(triplet: string): RGB {
  const [h, s, l] = triplet.split(/\s+/).map((p) => parseFloat(p));
  const S = s! / 100;
  const L = l! / 100;
  const k = (n: number) => (n + h! / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) =>
    L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => x * 255) as RGB;
}

function resolveColour(value: string, theme: Record<string, string>): RGB {
  const hsl = value.match(/^hsl\(var\((--[\w-]+)\)\)$/);
  if (hsl) return hslTripletToRgb(theme[hsl[1]!]!);
  if (value.startsWith("#")) return hexToRgb(value);
  if (value.startsWith("var("))
    return resolveColour(theme[value.slice(4, -1)]!, theme);
  throw new Error(`unhandled colour ${value}`);
}

/** color-mix(in srgb, A p%, B), which mixes gamma-encoded sRGB components. */
function mix(a: RGB, pct: number, b: RGB): RGB {
  const p = pct / 100;
  return [0, 1, 2].map((i) => a[i]! * p + b[i]! * (1 - p)) as RGB;
}

function luminance(c: RGB): number {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const THEMES = {
  light: tokens(/(^|\n)\s*:root\s*\{/),
  dark: tokens(/(^|\n)\s*\.dark\s*\{/),
} as const;

/** The fill a bin paints, resolved to sRGB in a theme: the colour-mix of its signal over the paper. */
function fillRgb(
  bin: NonNullable<ReturnType<typeof returnBin>>,
  theme: Record<string, string>,
): RGB | null {
  if (bin.strength === null) return null;
  const signal = resolveColour(
    bin.sign > 0 ? "var(--semantic-green)" : "var(--semantic-red)",
    theme,
  );
  const paper = resolveColour("hsl(var(--returns-paper))", theme);
  return mix(signal, bin.strength, paper);
}

const SAMPLES: Record<ReturnsScale, number[]> = {
  annual: [-25, -10, -3, -0.5, 0, 0.4, 0.5, 4, 10, 37],
  monthly: [-7, -5, -2, -0.5, 0.2, 0.5, 3, 5, 9],
};

describe("returnBin", () => {
  it.each([
    ["annual", -10, "strong-down"],
    ["annual", -9.9, "down"],
    ["annual", -0.5, "down"],
    ["annual", -0.4, "flat"],
    ["annual", 0.49, "flat"],
    ["annual", 0.5, "up"],
    ["annual", 9.99, "up"],
    ["annual", 10, "strong-up"],
    ["monthly", -5, "strong-down"],
    ["monthly", 4.99, "up"],
    ["monthly", 5, "strong-up"],
  ] as const)("bins %s %d as %s", (scale, value, key) => {
    expect(returnBin(value, scale)?.key).toBe(key);
  });

  it("places no bin for a value that is not a number", () => {
    expect(returnBin(Number.NaN, "annual")).toBeNull();
    expect(returnBin(Number.POSITIVE_INFINITY, "monthly")).toBeNull();
  });

  it("caps the red at 60% and the green at 80%", () => {
    expect(returnBin(-50, "annual")?.strength).toBe(RED_FILL_MAX);
    expect(returnBin(50, "annual")?.strength).toBe(GREEN_FILL_MAX);
    expect(RED_FILL_MAX).toBe(60);
    expect(GREEN_FILL_MAX).toBe(80);
  });

  it("gives the about-zero bin no fill", () => {
    const bin = returnBin(0.1, "annual")!;
    expect(bin.strength).toBeNull();
    expect(binFill(bin)).toBeNull();
  });
});

describe("binFill", () => {
  it("mixes the semantic signal over the paper token, never a fixed hex", () => {
    expect(binFill(returnBin(12, "annual")!)).toBe(
      "color-mix(in srgb, var(--semantic-green) 80%, hsl(var(--returns-paper)))",
    );
    expect(binFill(returnBin(-12, "annual")!)).toBe(
      "color-mix(in srgb, var(--semantic-red) 60%, hsl(var(--returns-paper)))",
    );
  });
});

describe("ink contrast on every bin", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`keeps the ink at 4.5:1 or better on every fill in the ${theme} theme`, () => {
      const t = THEMES[theme];
      const ink = resolveColour(RETURNS_INK, t);
      for (const scale of ["annual", "monthly"] as const) {
        for (const value of SAMPLES[scale]) {
          const bin = returnBin(value, scale)!;
          const fill = fillRgb(bin, t);
          if (!fill) continue;
          expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps the plain text readable on the card in the ${theme} theme, for an unfilled cell`, () => {
      const t = THEMES[theme];
      const card = resolveColour("hsl(var(--card))", t);
      expect(
        contrast(resolveColour(RETURNS_PLAIN_INK, t), card),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps the muted state text readable on a hatched cell in the ${theme} theme`, () => {
      // .hatch-empty: the muted token at 60% over the card, with the hatch over it.
      const t = THEMES[theme];
      const card = resolveColour("hsl(var(--card))", t);
      const muted = resolveColour("hsl(var(--muted))", t);
      const cell = mix(muted, 60, card);
      expect(
        contrast(resolveColour("hsl(var(--muted-foreground))", t), cell),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("never uses the paper or the background as text", () => {
    expect(RETURNS_INK).toBe("hsl(var(--returns-ink))");
    expect(RETURNS_INK).not.toMatch(/paper|background/);
    expect(RETURNS_PLAIN_INK).not.toMatch(/paper|background/);
  });
});

describe("returnsLegend", () => {
  it("names the five annual bins in the mockup's terms", () => {
    expect(returnsLegend("annual")).toEqual([
      "≤ −10%",
      "−10 to −0.5%",
      "about 0",
      "0.5 to 10%",
      "≥ 10%",
    ]);
  });

  it("names the five monthly bins", () => {
    expect(returnsLegend("monthly")).toEqual([
      "≤ −5%",
      "−5 to −0.5%",
      "about 0",
      "0.5 to 5%",
      "≥ 5%",
    ]);
  });
});

describe("coverage", () => {
  it("clamps a bar's fraction to [0, 1] and draws nothing for an unknown figure", () => {
    expect(coverageFraction(0.64)).toBe(0.64);
    expect(coverageFraction(1.4)).toBe(1);
    expect(coverageFraction(-0.2)).toBe(0);
    expect(coverageFraction(null)).toBe(0);
    expect(coverageFraction(Number.NaN)).toBe(0);
  });

  it("hatches a figure under 80% and never an unknown one", () => {
    expect(COVERAGE_HATCH_BELOW).toBe(0.8);
    expect(coverageHatched(0.64)).toBe(true);
    expect(coverageHatched(0.8)).toBe(false);
    expect(coverageHatched(null)).toBe(false);
  });
});

describe("printedReturn", () => {
  it.each([
    [9.96, 10, "annual"],
    [-9.96, -10, "annual"],
    [4.97, 5, "monthly"],
    [-0.46, -0.5, "annual"],
    [0.46, 0.5, "annual"],
  ] as const)("rounds %d to the %d the cell prints", (value, printed) => {
    expect(printedReturn(value)).toBe(printed);
  });

  it("bins the printed figure, so the fill agrees with its text at each bin edge", () => {
    expect(returnBin(printedReturn(9.96), "annual")?.key).toBe("strong-up");
    expect(returnBin(printedReturn(-0.46), "annual")?.key).toBe("down");
    expect(returnBin(printedReturn(4.97), "monthly")?.key).toBe("strong-up");
  });

  it("passes a value that is not a number through, to be given no bin", () => {
    expect(printedReturn(Number.NaN)).toBeNaN();
    expect(returnBin(printedReturn(Number.NaN), "annual")).toBeNull();
  });
});

describe("coverageKnown", () => {
  it("is true only for a finite number", () => {
    expect(coverageKnown(0.64)).toBe(true);
    expect(coverageKnown(0)).toBe(true);
    expect(coverageKnown(null)).toBe(false);
    expect(coverageKnown(undefined)).toBe(false);
    expect(coverageKnown(Number.NaN)).toBe(false);
    expect(coverageKnown(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("the coverage hatch over a filled cell", () => {
  it("is stripes only: a transparent base, so the fill shows through", () => {
    // Comments are stripped by the CSS reader above, so this checks the declaration.
    expect(CSS).toMatch(
      /\.hatch-on-fill\s*\{\s*background-color:\s*transparent;/,
    );
    expect(CSS).not.toMatch(/\.hatch-on-fill[^}]*hsl\(var\(--muted\)/);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`keeps the ink at 4.5:1 or better on its stripes over every fill in the ${theme} theme`, () => {
      // The stripe is the returns paper at 60% over the fill, the same composite
      // the browser paints where a stripe crosses the cell.
      const t = THEMES[theme];
      const ink = resolveColour(RETURNS_INK, t);
      const paper = resolveColour("hsl(var(--returns-paper))", t);
      for (const scale of ["annual", "monthly"] as const) {
        for (const value of SAMPLES[scale]) {
          const fill = fillRgb(returnBin(value, scale)!, t);
          if (!fill) continue;
          expect(contrast(ink, mix(paper, 60, fill))).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
    });
  }
});
