/// <reference types="jest" />

/**
 * The desk's colour scales (spec 13.1). Every fill is a theme token mixed with the
 * paper, a figure with no value has no fill, and nothing on the desk is red or
 * green except nothing at all: the short lens takes the chart's rust.
 */

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

  it("gives the short lens its own mode, drawn in the chart's short colour", () => {
    expect(lensScale("short", [3]).mode).toBe("short");
    const fill = lensFill(3, lensScale("short", [3]));
    expect(fill).toContain("#D16A47");
    noSignalColour(fill);
  });
});

describe("lens fills", () => {
  it("has no fill for a missing figure, so the caller hatches the cell", () => {
    const scale = lensScale("disclosed", [10]);
    expect(lensFill(null, scale)).toBeNull();
    expect(lensFill(Number.NaN, scale)).toBeNull();
  });

  it("paints the largest figure in the primary and a zero in the paper", () => {
    const scale = lensScale("disclosed", [10]);
    expect(lensFill(10, scale)).toBe("color-mix(in srgb, hsl(var(--primary)) 100%, hsl(var(--background)))");
    expect(lensFill(0, scale)).toBe("hsl(var(--background))");
  });

  it("grows a sequential fill with its figure, never past the scale", () => {
    const scale = lensScale("institutional", [10]);
    // Ten is the top: the bins are two wide, so five falls in the third (60%) and forty in the top (100%).
    expect(lensFill(5, scale)).toContain("60%");
    expect(lensFill(40, scale)).toContain("100%");
  });

  it("runs a flow from ink through paper to amber, never red or green", () => {
    const scale = lensScale("flow", [-4, 4]);
    const falling = lensFill(-4, scale);
    const rising = lensFill(4, scale);
    expect(falling).toContain("hsl(var(--foreground))");
    expect(rising).toContain("hsl(var(--primary))");
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
});

describe("direction and week fills", () => {
  it("draws an increase in the amber and a decrease in the ink", () => {
    expect(directionFill("up")).toContain("hsl(var(--primary))");
    expect(directionFill("down")).toContain("hsl(var(--foreground))");
    noSignalColour(directionFill("up"));
    noSignalColour(directionFill("down"));
  });

  it("scales a week's net change to the largest week, diverging around zero", () => {
    expect(netFill(null, 4)).toBeNull();
    expect(netFill(0, 4)).toBe("hsl(var(--background))");
    expect(netFill(-4, 4)).toContain("hsl(var(--foreground))");
    expect(netFill(2, 4)).toContain("50%");
    noSignalColour(netFill(-2, 4));
  });
});

describe("the scale's cap", () => {
  it("tops a long list at the 98th percentile and says so, and keeps a short list's largest figure", () => {
    const { lensScale } = require("../desk-scales") as typeof import("../desk-scales");
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

  it("draws a rise and a fall of one size at one strength, the centre bin as the paper", () => {
    const scale = lensScale("flow", [-4, 4]);
    expect(binFill(binOf(-3, scale)!, scale)).toContain("50%");
    expect(binFill(binOf(3, scale)!, scale)).toContain("50%");
    expect(binFill(binOf(-4, scale)!, scale)).toContain("100%");
    expect(binFill(binOf(4, scale)!, scale)).toContain("100%");
    expect(binFill(binOf(0.5, scale)!, scale)).toBe("hsl(var(--background))");
    expect(binFill(binOf(-0.5, scale)!, scale)).toBe("hsl(var(--background))");
  });

  it("uses the deepest bin for every figure above a capped top", () => {
    const many = Array.from({ length: 99 }, (_, i) => i + 1).concat([242]);
    const capped = lensScale("disclosed", many);
    expect(binOf(242, capped)).toBe(BIN_COUNT - 1);
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

  it("takes the paper ink on the two deepest steps and the ink elsewhere", () => {
    const scale = netScale(4);
    expect(labelOnBin(binOf(-4, scale), scale)).toBe("hsl(var(--background))");
    expect(labelOnBin(binOf(4, scale), scale)).toBe("hsl(var(--background))");
    expect(labelOnBin(binOf(0.5, scale), scale)).toBe("hsl(var(--foreground))");
    expect(labelOnBin(null, scale)).toBe("hsl(var(--foreground))");
  });

  it("gives the net-change scale the same five symmetric bins as the flow lens", () => {
    expect(netFill(-4, 4)).toBe(lensFill(-4, lensScale("flow", [-4, 4])));
    expect(netFill(4, 4)).toBe(lensFill(4, lensScale("flow", [-4, 4])));
  });
});
