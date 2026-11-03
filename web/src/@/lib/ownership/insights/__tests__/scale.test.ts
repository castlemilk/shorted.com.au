import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BINS, BIN_STYLES, KIND_FILL, binRange, divergingBin, divergingDomain } from "../scale";

describe("the diverging scale", () => {
  it("reaches the 90th percentile of the changes' sizes, so one outlier does not wash out the rest", () => {
    const values = [1, -2, 3, 4, -5, 6, 7, 8, 9, 100];
    expect(divergingDomain(values)).toBe(100);
    expect(divergingDomain([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1000])).toBe(11);
    expect(divergingDomain([null, undefined, 0, Number.NaN])).toBe(1);
    expect(divergingDomain([])).toBe(1);
  });

  it("bins a change into thirds of the reach a side, holds the far end open and keeps n/a apart from zero", () => {
    expect(divergingBin(null, 9)).toBeNull();
    expect(divergingBin(undefined, 9)).toBeNull();
    expect(divergingBin(0, 9)).toBe(0);
    expect(divergingBin(1, 9)).toBe(1);
    expect(divergingBin(3, 9)).toBe(1);
    expect(divergingBin(3.01, 9)).toBe(2);
    expect(divergingBin(6.5, 9)).toBe(3);
    expect(divergingBin(900, 9)).toBe(3);
    expect(divergingBin(-0.1, 9)).toBe(-1);
    expect(divergingBin(-7, 9)).toBe(-3);
  });

  it("states each bin's range for the legend", () => {
    expect(binRange(0, 9)).toEqual([0, 0]);
    expect(binRange(1, 9)).toEqual([0, 3]);
    expect(binRange(2, 9)).toEqual([3, 6]);
    expect(binRange(3, 9)).toEqual([6, Infinity]);
    expect(binRange(-3, 9)).toEqual([-Infinity, -6]);
  });

  it("has a light and a dark step for every bin, and never a market red or green", () => {
    for (const bin of BINS) {
      const style = BIN_STYLES[bin];
      expect(style.fill).toMatch(/^fill-\[#[0-9A-F]{6}\] dark:fill-\[#[0-9A-F]{6}\]$/);
      expect(style.swatch).toMatch(/dark:bg-/);
    }
    const source = readFileSync(join(__dirname, "..", "scale.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:text|bg|border|fill|stroke|ring)-(?:red|green|emerald|rose)-?\d*|#(?:ef4444|22c55e|f87171|4ade80)/i);
    expect(Object.values(KIND_FILL).join(" ")).not.toMatch(/red|green/);
  });

  it("runs rust for a fall and avocado for a rise, darker as the change grows in light mode", () => {
    const light = (bin: (typeof BINS)[number]) => /fill-\[#([0-9A-F]{6})\]/.exec(BIN_STYLES[bin].fill)![1]!;
    const lum = (hex: string) => {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    expect(lum(light(-1))).toBeGreaterThan(lum(light(-2)));
    expect(lum(light(-2))).toBeGreaterThan(lum(light(-3)));
    expect(lum(light(1))).toBeGreaterThan(lum(light(2)));
    expect(lum(light(2))).toBeGreaterThan(lum(light(3)));
    const [r, , b] = [0, 2, 4].map((i) => parseInt(light(-3).slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(b!);
  });
});
