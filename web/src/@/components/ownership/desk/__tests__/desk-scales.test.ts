/// <reference types="jest" />

/**
 * The desk's colour scales (spec 13.1). Every fill is a theme token (a stop of the
 * ramp, globals.css), a figure with no value has no fill, and nothing on the desk is
 * red or green. The short lens has its own rust stops (`--desk-short-*`), so no
 * fill is a mix made at run time.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { BIN_COUNT, binFill, binOf, countScale, directionFill, labelOnBin, lensFill, lensScale, netFill, netScale, niceStep } from "../desk-scales";

const SIGNAL_COLOURS = [
  "#EF4444",
  "#22C55E",
  "#F87171",
  "#4ADE80",
  "--destructive",
  "--success",
  "red",
  "green",
];

/** A ramp fill is a theme token and nothing else: no literal colour, no mix. */
const RAMP_TOKEN = /^hsl\(var\(--desk-[a-z0-9-]+\)\)$/;
/** The short lens's stops: the theme's rust family, and no other fill. */
const SHORT_TOKEN = /^hsl\(var\(--desk-short-[0-4]\)\)$/;

function noSignalColour(fill: string | null): void {
  expect(fill).not.toBeNull();
  for (const colour of SIGNAL_COLOURS) {
    expect(fill!.toLowerCase()).not.toContain(colour.toLowerCase());
  }
}

describe("lens scales", () => {
  it("starts a share at zero and runs to the largest figure", () => {
    const scale = lensScale("disclosed", [4, 12, null, 9]);
    // Five round bins of 2.5 reach the largest figure: the top is 12.5, never a continuous 12.
    expect(scale).toEqual({ lens: "disclosed", mode: "sequential", lo: 0, hi: 12.5, step: 2.5, capped: false });
  });

  it("gives an empty share scale a unit top, so a zero still has a fill", () => {
    expect(lensScale("hedge", [null, 0]).hi).toBe(1);
    expect(lensScale("hedge", []).hi).toBe(1);
  });

  it("diverges a flow symmetrically around zero, whichever way the figures lean", () => {
    expect(lensScale("flow", [2, -5, 1])).toEqual({ lens: "flow", mode: "diverging", lo: -5, hi: 5, step: 2.5, capped: false });
    expect(lensScale("flow", [0, null])).toEqual({ lens: "flow", mode: "diverging", lo: -2, hi: 2, step: 1 });
  });

  it("gives the short lens its own mode, drawn from its own rust stops", () => {
    expect(lensScale("short", [3]).mode).toBe("short");
    const fill = lensFill(3, lensScale("short", [3]));
    expect(fill).toBe("hsl(var(--desk-short-3))");
    noSignalColour(fill);
  });
});

describe("lens fills", () => {
  it("has no fill for a missing figure, so the caller hatches the cell", () => {
    const scale = lensScale("disclosed", [10]);
    expect(lensFill(null, scale)).toBeNull();
    expect(lensFill(Number.NaN, scale)).toBeNull();
  });

  it("paints the largest figure in the top stop and a zero in the paper", () => {
    const scale = lensScale("disclosed", [10]);
    expect(lensFill(10, scale)).toBe("hsl(var(--desk-bin-4))");
    expect(lensFill(0, scale)).toBe("hsl(var(--background))");
  });

  it("grows a sequential fill with its figure, one stop per bin, never past the scale", () => {
    const scale = lensScale("institutional", [10]);
    // Ten is the top: the bins are two wide, so five falls in the third stop and forty in the top.
    expect(lensFill(5, scale)).toBe("hsl(var(--desk-bin-2))");
    expect(lensFill(40, scale)).toBe("hsl(var(--desk-bin-4))");
  });

  it("runs a flow from ink through paper to amber, never red or green", () => {
    const scale = lensScale("flow", [-4, 4]);
    const falling = lensFill(-4, scale);
    const rising = lensFill(4, scale);
    expect(falling).toBe("hsl(var(--desk-fall-2))");
    expect(rising).toBe("hsl(var(--desk-rise-2))");
    expect(lensFill(0, scale)).toBe("hsl(var(--background))");
    noSignalColour(falling);
    noSignalColour(rising);
  });

  it("never uses a signal colour on any lens", () => {
    const values = [-3, -1, 0, 1, 3, null];
    for (const lens of ["disclosed", "institutional", "hedge", "index", "short", "flow"] as const) {
      const scale = lensScale(lens, values);
      for (const value of values) {
        const fill = lensFill(value, scale);
        if (fill !== null) noSignalColour(fill);
      }
    }
  });

  it("paints every sequential and diverging bin from a theme token, never a literal colour", () => {
    const sequential = lensScale("disclosed", [10]);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      expect(binFill(bin, sequential)).toMatch(RAMP_TOKEN);
    }
    const diverging = lensScale("flow", [-4, 4]);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      // The diverging centre is the paper itself: the zero both sides of the flow share.
      if (bin === 2) expect(binFill(bin, diverging)).toBe("hsl(var(--background))");
      else expect(binFill(bin, diverging)).toMatch(RAMP_TOKEN);
    }
    const short = lensScale("short", [10]);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      expect(binFill(bin, short)).toMatch(SHORT_TOKEN);
    }
  });
});

describe("the ink of each bin (labelOnBin)", () => {
  it("takes the sequential stop's own ink token, the foreground on the pale stops and the paper on the deepest", () => {
    const scale = lensScale("disclosed", [10]);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      expect(labelOnBin(bin, scale)).toBe(`hsl(var(--desk-bin-ink-${bin}))`);
    }
    expect(labelOnBin(null, scale)).toBe("hsl(var(--foreground))");
  });

  it("takes the diverging stop's own ink token, the paper on the two deepest falls and rises", () => {
    const scale = lensScale("flow", [-4, 4]);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      expect(labelOnBin(bin, scale)).toBe(`hsl(var(--desk-div-ink-${bin}))`);
    }
    expect(labelOnBin(binOf(-4, scale), scale)).toBe("hsl(var(--desk-div-ink-0))");
    expect(labelOnBin(binOf(0.5, scale), scale)).toBe("hsl(var(--desk-div-ink-2))");
    expect(labelOnBin(binOf(4, scale), scale)).toBe("hsl(var(--desk-div-ink-4))");
  });

  it("gives the short lens its own ink token for each of its stops", () => {
    const scale = lensScale("short", [10]);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      expect(labelOnBin(bin, scale)).toBe(`hsl(var(--desk-short-ink-${bin}))`);
    }
    expect(labelOnBin(null, scale)).toBe("hsl(var(--foreground))");
  });
});

describe("direction and week fills", () => {
  it("draws an increase in the deepest amber stop and a decrease in the ink", () => {
    expect(directionFill("up")).toBe("hsl(var(--desk-rise-2))");
    expect(directionFill("down")).toBe("hsl(var(--desk-fall-2))");
    noSignalColour(directionFill("up"));
    noSignalColour(directionFill("down"));
  });

  it("scales a week's net change to the largest week, diverging around zero", () => {
    expect(netFill(null, 4)).toBeNull();
    expect(netFill(0, 4)).toBe("hsl(var(--background))");
    expect(netFill(-4, 4)).toBe("hsl(var(--desk-fall-2))");
    expect(netFill(2, 4)).toBe("hsl(var(--desk-rise-1))");
    noSignalColour(netFill(-2, 4));
  });
});

describe("the scale's cap", () => {
  it("tops a long list at the 98th percentile and says so, and keeps a short list's largest figure", () => {
    const many = Array.from({ length: 99 }, (_, i) => i + 1).concat([242]);
    const capped = lensScale("disclosed", many);
    expect(capped.capped).toBe(true);
    expect(capped.hi).toBeLessThan(242);
    expect(capped.hi).toBeGreaterThanOrEqual(97);
    const few = lensScale("disclosed", [1, 2, 242]);
    expect(few.capped).toBe(false);
    expect(few.hi).toBeGreaterThanOrEqual(242);
    const flow = lensScale("flow", many.map((v) => (v % 2 ? v : -v)));
    expect(flow.capped).toBe(true);
    expect(flow.lo).toBe(-flow.hi);
  });
});

describe("five quantised bins (spec 14.9)", () => {
  it("rounds the bin width to 1, 2, 2.5, 5 or 10 times a power of ten", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(2.4)).toBe(2.5);
    expect(niceStep(3.1)).toBe(5);
    expect(niceStep(48.4)).toBe(50);
    expect(niceStep(0)).toBe(1);
  });

  it("draws every lens in exactly five bins, the top of the scale on the fifth", () => {
    for (const lens of ["disclosed", "institutional", "hedge", "index", "short"] as const) {
      const scale = lensScale(lens, [1, 4, 9, 13]);
      expect(scale.hi).toBeCloseTo(scale.step * BIN_COUNT, 10);
      // The scale's top sits in the fifth bin, its foot in the first.
      expect(binOf(scale.hi - 0.001, scale)).toBe(BIN_COUNT - 1);
      expect(binOf(0, scale)).toBe(0);
      const bins = [1, 4, 9, 13].map((value) => binOf(value, scale));
      expect(new Set(bins).size).toBeGreaterThan(1);
    }
  });

  it("puts a figure in the bin its round threshold names, and never outside the five", () => {
    const scale = lensScale("disclosed", [10]);
    expect(scale.step).toBe(2);
    expect(binOf(1.9, scale)).toBe(0);
    expect(binOf(2, scale)).toBe(1);
    expect(binOf(9.9, scale)).toBe(4);
    expect(binOf(500, scale)).toBe(4);
    expect(binOf(null, scale)).toBeNull();
  });

  it("gives the diverging scale five bins symmetric about zero: a fall and a rise of one size in mirrored bins", () => {
    // Step 2: below -4 and -4 to -2 (falls), -2 to 2 (the paper), 2 to 4 and 4 and above (rises).
    const scale = lensScale("flow", [-4, 4]);
    expect(binOf(-5, scale)).toBe(0);
    expect(binOf(-4, scale)).toBe(0);
    expect(binOf(-3, scale)).toBe(1);
    expect(binOf(-1, scale)).toBe(2);
    expect(binOf(1, scale)).toBe(2);
    expect(binOf(3, scale)).toBe(3);
    expect(binOf(4, scale)).toBe(4);
    expect(binOf(0, scale)).toBe(2);
    const mirror = (bin: number | null) => (bin === 0 ? 4 : bin === 1 ? 3 : bin === 3 ? 1 : bin === 4 ? 0 : bin);
    for (const size of [0.5, 1, 1.5, 2, 3, 4, 5]) {
      expect(binOf(size, scale)).toBe(mirror(binOf(-size, scale)));
    }
  });

  it("draws a rise and a fall of one size on the same step, the centre bin as the paper", () => {
    const scale = lensScale("flow", [-4, 4]);
    expect(binFill(binOf(-3, scale)!, scale)).toBe("hsl(var(--desk-fall-1))");
    expect(binFill(binOf(3, scale)!, scale)).toBe("hsl(var(--desk-rise-1))");
    expect(binFill(binOf(-4, scale)!, scale)).toBe("hsl(var(--desk-fall-2))");
    expect(binFill(binOf(4, scale)!, scale)).toBe("hsl(var(--desk-rise-2))");
    expect(binFill(binOf(0.5, scale)!, scale)).toBe("hsl(var(--background))");
    expect(binFill(binOf(-0.5, scale)!, scale)).toBe("hsl(var(--background))");
  });

  it("uses the deepest bin for every figure above a capped top", () => {
    const many = Array.from({ length: 99 }, (_, i) => i + 1).concat([242]);
    const capped = lensScale("disclosed", many);
    expect(binOf(242, capped)).toBe(BIN_COUNT - 1);
  });

  it("fills the short lens from its five rust stops in order, never a mix into the paper", () => {
    const scale = lensScale("short", [10]);
    expect(binFill(0, scale)).toBe("hsl(var(--desk-short-0))");
    expect(binFill(2, scale)).toBe("hsl(var(--desk-short-2))");
    expect(binFill(4, scale)).toBe("hsl(var(--desk-short-4))");
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      expect(binFill(bin, scale)).not.toContain("color-mix");
    }
  });

  it("keeps the module pure: no mix, and no import from the chart theme", () => {
    const source = readFileSync(path.join(__dirname, "../desk-scales.ts"), "utf8");
    expect(source).not.toContain("color-mix");
    expect(source).not.toMatch(/from\s+["'][^"']*chart-theme["']/);
  });
});

describe("the heatmap's count scale and label ink (spec 14.9)", () => {
  it("draws a count in five whole-notice bins, the top bin at the most notices in one week", () => {
    const scale = countScale(12);
    expect(scale).toEqual({ lens: "disclosed", mode: "sequential", lo: 0, hi: 15, step: 3 });
    expect(binOf(1, scale)).toBe(0);
    expect(binOf(3, scale)).toBe(1);
    expect(binOf(12, scale)).toBe(4);
    expect(Number.isInteger(scale.step)).toBe(true);
  });

  it("keeps a one-notice scale whole, even when the most in a week is one", () => {
    expect(countScale(1).step).toBe(1);
    expect(countScale(0).step).toBe(1);
  });

  it("takes each stop's ink for the label on it, the foreground for an empty cell", () => {
    const scale = netScale(4);
    expect(labelOnBin(binOf(-4, scale), scale)).toBe("hsl(var(--desk-div-ink-0))");
    expect(labelOnBin(binOf(4, scale), scale)).toBe("hsl(var(--desk-div-ink-4))");
    expect(labelOnBin(binOf(0.5, scale), scale)).toBe("hsl(var(--desk-div-ink-2))");
    expect(labelOnBin(null, scale)).toBe("hsl(var(--foreground))");
  });

  it("gives the net-change scale the same five symmetric bins as the flow lens", () => {
    expect(netFill(-4, 4)).toBe(lensFill(-4, lensScale("flow", [-4, 4])));
    expect(netFill(4, 4)).toBe(lensFill(4, lensScale("flow", [-4, 4])));
  });

  it("fills a count cell from the ramp's stops, the same tokens as every other sequential lens", () => {
    const scale = countScale(12);
    expect(lensFill(12, scale)).toBe("hsl(var(--desk-bin-4))");
    expect(lensFill(0, scale)).toBe("hsl(var(--background))");
    expect(lensFill(3, scale)).toBe("hsl(var(--desk-bin-1))");
  });
});
