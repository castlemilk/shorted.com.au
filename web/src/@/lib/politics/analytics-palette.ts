/**
 * The sequential ramp for register analytics.
 *
 * WHY DISCRETE STEPS AND NOT d3. `@/lib/housing/highlight-metrics` already
 * exports `amberScale()`, but importing it pulls d3-scale + d3-scale-chromatic
 * (~20kB) into the route — the same reason `party-palette.ts` was split out of
 * it. A heatmap reads better bucketed anyway: six named steps let a reader map a
 * cell back to the legend, which a continuous gradient does not.
 *
 * These six values ARE the house ramp, sampled from it rather than invented:
 * `interpolateOranges(0.18 + 0.74t)` at t = 0, .2, .4, .6, .8, 1 — the exact
 * expression `amberScale` uses. So the heatmap and the housing choropleth are
 * the same amber.
 *
 * VALIDATED, not eyeballed:
 *   - strictly monotonic light -> dark (relative luminance .758 → .089), which is
 *     the correct check for a SEQUENTIAL ramp (adjacent-pair CVD separation is a
 *     categorical check and does not apply — a sequential ramp is *meant* to be
 *     confusable step-to-step and readable end-to-end)
 *   - the lightest steps fall below 3:1 against the surface, which obligates
 *     relief rather than being dismissable: every cell carries its VALUE as text
 *     and a table view exists. That is why `inkOn()` exists below.
 *
 * One hue, light to dark. Never a rainbow, never a diverging pair — the measure
 * is a count with a natural zero, not a polarity.
 */

/** Six steps, lightest (fewest) to darkest (most). */
export const AMBER_STEPS = [
  "#fedcba",
  "#fdbb80",
  "#fc9346",
  "#ef6a17",
  "#ce4603",
  "#983103",
] as const;

/**
 * The zero cell is NOT step 0 — it is the surface with a hairline.
 *
 * "No member of this party declared an interest in this industry" is a different
 * statement from "one did", and giving zero the palest amber makes absence look
 * like a small presence. Absence gets no ink.
 */
export const ZERO_FILL = "transparent";

/**
 * Bucket a count onto the ramp.
 *
 * SQRT, not linear: the distribution is long-tailed (Banks 54 people, most cells
 * in single digits), and a linear scale renders almost everything as step 0 with
 * one dark outlier — which hides the actual variation the chart exists to show.
 * Sqrt is the same compression `amberScale(…, sqrt = true)` offers.
 */
export function stepFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return -1;
  const t = Math.sqrt(value) / Math.sqrt(max);
  const idx = Math.ceil(t * AMBER_STEPS.length) - 1;
  return Math.min(Math.max(idx, 0), AMBER_STEPS.length - 1);
}

export function fillFor(value: number, max: number): string {
  const step = stepFor(value, max);
  // stepFor already clamps into range; the ?? is for noUncheckedIndexedAccess,
  // not for a case that can happen.
  return step < 0 ? ZERO_FILL : (AMBER_STEPS[step] ?? AMBER_STEPS[0]);
}

/**
 * Ink for a label sitting ON a ramp step.
 *
 * The top two steps are dark enough that dark ink fails; the rest are light
 * enough that light ink fails. Measured: #983103 vs white = 7.57:1, #fedcba vs
 * #1c1917 = 13.46:1 — both clear WCAG AA for normal text with room to spare.
 */
export function inkOn(step: number): string {
  return step >= 4 ? "#ffffff" : "#1c1917";
}

/**
 * Legend bands as "N–M" labels for the six steps.
 *
 * Derived from the same sqrt mapping so the legend cannot disagree with the
 * cells — a legend computed independently of the fill function is a legend that
 * eventually lies.
 */
export function legendBands(max: number): { fill: string; label: string }[] {
  if (max <= 0) return [];
  const edges: number[] = [];
  for (let i = 1; i <= AMBER_STEPS.length; i++) {
    edges.push(Math.round(Math.pow((i / AMBER_STEPS.length) * Math.sqrt(max), 2)));
  }
  let low = 1;
  return AMBER_STEPS.map((fill, i) => {
    const high = edges[i] ?? low;
    const label = high <= low ? `${low}` : `${low}–${high}`;
    low = high + 1;
    return { fill, label };
  });
}
