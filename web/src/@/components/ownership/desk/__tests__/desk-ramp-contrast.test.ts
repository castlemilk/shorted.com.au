/// <reference types="jest" />

/**
 * The desk's five-stop ramp, checked against the tokens the theme sets (spec 13.1,
 * backlog A2). The test reads web/src/styles/globals.css itself, so a change to a
 * stop is judged here and not in a copy: the :root block is light, the .dark block
 * is dark, and a token a block leaves out falls back to :root's value.
 *
 * The rules: every ink clears WCAG AA (4.5:1) over its fill at the 11px figures;
 * adjacent bins differ by at least 7 CIE L*; the first bin differs from the paper by
 * at least 7 L*; the bins rise in lightness in dark and fall in light; the light and
 * dark falls and rises each differ from the paper by at least 7 L*. The short
 * lens's five stops (`--desk-short-*`) are checked by the same rules.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const STYLES = path.join(__dirname, "../../../../../styles/globals.css");

type Theme = "light" | "dark";
type Tokens = Record<string, string>;

/** The declarations of a top-level rule whose selector is `selector`, comments removed. */
function declarationsOf(css: string, selector: string): Tokens {
  const start = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`).exec(css);
  if (start === null) throw new Error(`no ${selector} block in globals.css`);
  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
    i += 1;
  }
  const body = css.slice(from, i - 1);
  const tokens: Tokens = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

const css = readFileSync(STYLES, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ROOT = declarationsOf(css, ":root");
const DARK = declarationsOf(css, ".dark");

/** A token's raw value in a theme, with one level of var() resolved (and the :root value as the fallback). */
function raw(theme: Theme, name: string): string {
  const own = theme === "dark" ? DARK : ROOT;
  const value = own[name] ?? ROOT[name];
  if (value === undefined) throw new Error(`token ${name} is not set in :root`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref !== null) return raw(theme, ref[1]!);
  return value;
}

/** An HSL triplet "H S% L%" as sRGB components in [0, 1]. */
function hslToRgb(triplet: string): [number, number, number] {
  const m = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(triplet);
  if (m === null) throw new Error(`not an HSL triplet: ${triplet}`);
  const h = Number(m[1]) % 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m0 = l - c / 2;
  return [r1 + m0, g1 + m0, b1 + m0];
}

/** WCAG relative luminance of an sRGB colour. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** CIE L* of an sRGB colour (the lightness the eye reads, 0 to 100). */
function lightness(rgb: [number, number, number]): number {
  const y = luminance(rgb);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** WCAG contrast ratio between two sRGB colours. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Stop {
  name: string;
  fill: string;
  ink: string;
}

/**
 * The stops of a theme: the five bins, the short lens's five rust stops, the diverging
 * falls and rises, and the centre (the paper on the paper).
 */
function stopsOf(theme: Theme): { bins: Stop[]; short: Stop[]; diverging: Stop[]; paper: [number, number, number] } {
  const token = (name: string) => raw(theme, name);
  const bins = [0, 1, 2, 3, 4].map((bin) => ({
    name: `bin ${bin}`,
    fill: token(`--desk-bin-${bin}`),
    ink: token(`--desk-bin-ink-${bin}`),
  }));
  const short = [0, 1, 2, 3, 4].map((bin) => ({
    name: `short ${bin}`,
    fill: token(`--desk-short-${bin}`),
    ink: token(`--desk-short-ink-${bin}`),
  }));
  const diverging: Stop[] = [
    { name: "fall 2 (deepest)", fill: token("--desk-fall-2"), ink: token("--desk-div-ink-0") },
    { name: "fall 1", fill: token("--desk-fall-1"), ink: token("--desk-div-ink-1") },
    { name: "centre (paper)", fill: token("--background"), ink: token("--desk-div-ink-2") },
    { name: "rise 1", fill: token("--desk-rise-1"), ink: token("--desk-div-ink-3") },
    { name: "rise 2 (deepest)", fill: token("--desk-rise-2"), ink: token("--desk-div-ink-4") },
  ];
  return { bins, short, diverging, paper: hslToRgb(token("--background")) };
}

const THEMES: readonly Theme[] = ["light", "dark"];

describe.each(THEMES)("the desk ramp in the %s theme", (theme) => {
  const { bins, short, diverging, paper } = stopsOf(theme);
  const L = (triplet: string) => lightness(hslToRgb(triplet));

  // The table the test prints: one row per stop, with its ink, the ratio over it and its lightness.
  const rows = [...bins, ...short, ...diverging].map((stop) => {
    const fill = hslToRgb(stop.fill);
    const ink = hslToRgb(stop.ink);
    return {
      stop: stop.name,
      fill: stop.fill,
      ink: stop.ink,
      "ink ratio": Number(contrast(ink, fill).toFixed(2)),
      "fill L*": Number(lightness(fill).toFixed(1)),
      "passes AA": contrast(ink, fill) >= 4.5 ? "yes" : "no",
    };
  });
  console.table(rows);

  it("sets every stop, its ink and the paper as tokens the theme defines", () => {
    for (const stop of [...bins, ...short, ...diverging]) {
      hslToRgb(stop.fill);
      hslToRgb(stop.ink);
    }
    hslToRgb(raw(theme, "--foreground"));
    hslToRgb(raw(theme, "--background"));
  });

  it("holds every bin's ink at WCAG AA (4.5:1) over the bin's fill", () => {
    for (const stop of bins) {
      expect(contrast(hslToRgb(stop.ink), hslToRgb(stop.fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tells adjacent bins apart by at least 7 L*", () => {
    for (let bin = 1; bin < bins.length; bin += 1) {
      const gap = Math.abs(L(bins[bin]!.fill) - L(bins[bin - 1]!.fill));
      expect(gap).toBeGreaterThanOrEqual(7);
    }
  });

  it("tells the first bin apart from the paper by at least 7 L*", () => {
    expect(Math.abs(L(bins[0]!.fill) - lightness(paper))).toBeGreaterThanOrEqual(7);
  });

  it("steps the bins monotonically in lightness: rising in dark, falling in light", () => {
    const lightnesses = bins.map((stop) => L(stop.fill));
    for (let bin = 1; bin < lightnesses.length; bin += 1) {
      if (theme === "dark") expect(lightnesses[bin]!).toBeGreaterThan(lightnesses[bin - 1]!);
      else expect(lightnesses[bin]!).toBeLessThan(lightnesses[bin - 1]!);
    }
  });

  it("holds every short-lens stop's ink at WCAG AA over the stop's fill", () => {
    for (const stop of short) {
      expect(contrast(hslToRgb(stop.ink), hslToRgb(stop.fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tells adjacent short-lens stops apart by at least 7 L*", () => {
    for (let stop = 1; stop < short.length; stop += 1) {
      const gap = Math.abs(L(short[stop]!.fill) - L(short[stop - 1]!.fill));
      expect(gap).toBeGreaterThanOrEqual(7);
    }
  });

  it("tells the first short-lens stop apart from the paper by at least 7 L*", () => {
    expect(Math.abs(L(short[0]!.fill) - lightness(paper))).toBeGreaterThanOrEqual(7);
  });

  it("steps the short-lens stops monotonically in lightness: rising in dark, falling in light", () => {
    const lightnesses = short.map((stop) => L(stop.fill));
    for (let stop = 1; stop < lightnesses.length; stop += 1) {
      if (theme === "dark") expect(lightnesses[stop]!).toBeGreaterThan(lightnesses[stop - 1]!);
      else expect(lightnesses[stop]!).toBeLessThan(lightnesses[stop - 1]!);
    }
  });

  it("holds every diverging stop's ink at WCAG AA, the falls, the rises and the paper centre", () => {
    for (const stop of diverging) {
      expect(contrast(hslToRgb(stop.ink), hslToRgb(stop.fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tells the light fall and the light rise apart from the paper by at least 7 L*", () => {
    const fall1 = diverging[1]!;
    const rise1 = diverging[3]!;
    expect(Math.abs(L(fall1.fill) - lightness(paper))).toBeGreaterThanOrEqual(7);
    expect(Math.abs(L(rise1.fill) - lightness(paper))).toBeGreaterThanOrEqual(7);
  });
});
