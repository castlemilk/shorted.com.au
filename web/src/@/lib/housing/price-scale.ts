import { scaleSequentialSqrt } from "d3-scale";
import { interpolateOranges } from "d3-scale-chromatic";

/**
 * One sequential ramp for "median house price", used at EVERY drill level
 * (national states + state suburbs + locator) so the colour→price mapping is
 * consistent. Single-hue amber/orange — never collides with the product's
 * semantic red/green, and the ramp is clamped away from the near-white/near-black
 * extremes so the cheapest AND dearest stay legible on light and dark cards.
 * sqrt because suburb prices are long-tailed (a few very expensive outliers).
 */
export function makePriceScale(max: number) {
  return scaleSequentialSqrt((t: number) => interpolateOranges(0.18 + 0.74 * t))
    .domain([0, Math.max(1, max)]);
}

/** Compact AUD for legend ticks / labels. */
export function fmtPriceShort(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

/**
 * Upper bound for a choropleth colour ramp: a high percentile, not the maximum.
 *
 * Suburb prices are extremely long-tailed and the tail is REAL — Point Piper
 * genuinely transacts around $60M — so this is not an outlier-rejection step and
 * must not be mistaken for one. The problem is that a sequential scale anchored
 * on the raw maximum spends its whole range on the handful of suburbs at the
 * top and renders everything else the same colour.
 *
 * Measured on NSW (2,433 priced suburbs, 2026-08-28): min $60k, median $1.0M,
 * p98 $4.5M, p99 $5.5M, max $110.5M. Against the raw max the MEDIAN suburb sat
 * at 9.5% of the sqrt ramp — the map was effectively monochrome. Note that
 * removing the one implausible row only moved it to 12.9%: the fragility is in
 * the scale, not the data, and cleaning the data would not have fixed it.
 *
 * Values above the returned bound still paint — the scale clamps them to the
 * top colour — and the legend labels that tick "≥" so the ramp does not claim
 * to show a range it has stopped resolving.
 */
export function robustDomainTop(values: number[], percentile = 0.98): number {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (finite.length === 0) return 1;
  // Too few points for a percentile to mean anything — the max IS the shape.
  if (finite.length < 20) return finite[finite.length - 1]!;
  const idx = Math.min(finite.length - 1, Math.floor((finite.length - 1) * percentile));
  // Never return below the median, however degenerate the input.
  return Math.max(finite[idx]!, finite[Math.floor((finite.length - 1) / 2)]!, 1);
}
