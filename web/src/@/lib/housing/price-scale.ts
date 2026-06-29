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
