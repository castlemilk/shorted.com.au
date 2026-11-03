/// <reference types="jest" />

/**
 * The desk's colour scales (spec 13.1). Every fill is a theme token mixed with the
 * paper, a figure with no value has no fill, and nothing on the desk is red or
 * green except nothing at all: the short lens takes the chart's rust.
 */

import { directionFill, lensFill, lensScale, netFill } from "../desk-scales";

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
    expect(scale).toEqual({ lens: "disclosed", mode: "sequential", lo: 0, hi: 12 });
  });

  it("gives an empty share scale a unit top, so a zero still has a fill", () => {
    expect(lensScale("hedge", [null, 0]).hi).toBe(1);
    expect(lensScale("hedge", []).hi).toBe(1);
  });

  it("diverges a flow symmetrically around zero, whichever way the figures lean", () => {
    expect(lensScale("flow", [2, -5, 1])).toEqual({ lens: "flow", mode: "diverging", lo: -5, hi: 5 });
    expect(lensScale("flow", [0, null])).toEqual({ lens: "flow", mode: "diverging", lo: -1, hi: 1 });
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
    expect(lensFill(5, scale)).toContain("50%");
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
