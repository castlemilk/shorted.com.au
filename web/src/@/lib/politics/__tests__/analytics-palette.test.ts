/**
 * The heatmap ramp, pinned.
 *
 * A sequential ramp has exactly two properties that matter, and both are
 * checkable rather than a matter of taste:
 *
 *   1. LIGHTNESS IS MONOTONIC. That is what makes it readable end-to-end and
 *      what distinguishes a sequential ramp from a rainbow. (Adjacent-pair CVD
 *      separation is a CATEGORICAL check and deliberately does not apply — a
 *      sequential ramp is meant to be confusable step-to-step.)
 *   2. THE LEGEND AGREES WITH THE CELLS. A legend computed independently of the
 *      fill function is a legend that eventually lies about a chart describing
 *      named politicians.
 */

import {
  AMBER_STEPS,
  ZERO_FILL,
  fillFor,
  inkOn,
  legendBands,
  stepFor,
} from "../analytics-palette";

/** WCAG relative luminance — the monotonicity measure. */
function luminance(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("register analytics ramp", () => {
  it("is strictly monotonic from light to dark", () => {
    const ls = AMBER_STEPS.map(luminance);
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i]!).toBeLessThan(ls[i - 1]!);
    }
  });

  it("is one hue, not a rainbow", () => {
    // Every step must be warmer in red than blue — a hue excursion would show up
    // as a step where blue overtakes red.
    for (const step of AMBER_STEPS) {
      const r = parseInt(step.slice(1, 3), 16);
      const b = parseInt(step.slice(5, 7), 16);
      expect(r).toBeGreaterThan(b);
    }
  });

  it("gives ZERO no ink at all", () => {
    // "No member of this party declared anything in this industry" must not look
    // like a faint presence.
    expect(fillFor(0, 50)).toBe(ZERO_FILL);
    expect(stepFor(0, 50)).toBe(-1);
    expect(fillFor(1, 50)).not.toBe(ZERO_FILL);
  });

  it("keeps every cell label legible on its own fill", () => {
    // The pale steps fall below 3:1 against the surface, which obligates relief.
    // The relief is the printed value, so the value must pass on every step.
    AMBER_STEPS.forEach((fill, step) => {
      expect(contrast(fill, inkOn(step))).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("uses the whole ramp on a long-tailed distribution", () => {
    // The real shape: one industry at 54, most in single digits. A LINEAR scale
    // renders nearly everything as step 0 and hides the variation the chart
    // exists to show; sqrt is why this passes.
    const max = 54;
    const steps = new Set([1, 2, 3, 5, 8, 13, 21, 34, 54].map((v) => stepFor(v, max)));
    expect(steps.size).toBeGreaterThanOrEqual(4);
    expect(stepFor(max, max)).toBe(AMBER_STEPS.length - 1);
  });

  it("legend bands agree with the fills they claim to describe", () => {
    const max = 54;
    const bands = legendBands(max);
    expect(bands).toHaveLength(AMBER_STEPS.length);
    for (let value = 1; value <= max; value++) {
      const step = stepFor(value, max);
      expect(bands[step]!.fill).toBe(fillFor(value, max));
    }
  });

  it("survives a degenerate maximum without throwing", () => {
    expect(legendBands(0)).toEqual([]);
    expect(fillFor(1, 0)).toBe(ZERO_FILL);
    expect(fillFor(1, 1)).toBe(AMBER_STEPS[AMBER_STEPS.length - 1]);
  });
});
