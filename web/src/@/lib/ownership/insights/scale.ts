/**
 * The insights explorer's colour: a diverging rust to avocado scale for a
 * change in holdings, and the kinds' category colours for the money flow.
 *
 * A change is a polarity, so it takes two hues and a warm grey midpoint: rust
 * for a fall, avocado for a rise. Never market red or green: those mean the
 * direction of a price and nothing else (DESIGN.md, The Semantic Quarantine
 * Rule). Each arm is three steps, and each mode has its own steps, checked with
 * the dataviz validator (monotone lightness, visible gaps, the light end at 2:1
 * or more on its surface). A figure the window cannot state (no fund compared)
 * is hatched, never the midpoint: n/a is not zero.
 *
 * The classes are written out whole so Tailwind finds them in this file.
 */

/** A bin of the diverging scale: −3 (the largest falls) to +3, 0 for no change. */
export type DivergingBin = -3 | -2 | -1 | 0 | 1 | 2 | 3;

interface BinStyle {
  /** SVG fill, light and dark. */
  fill: string;
  /** A swatch background, light and dark. */
  swatch: string;
  /** Text drawn on the fill, light and dark, at 4.5:1 or more. */
  text: string;
}

export const BIN_STYLES: Readonly<Record<DivergingBin, BinStyle>> = {
  [-3]: {
    fill: "fill-[#9C4528] dark:fill-[#E08A62]",
    swatch: "bg-[#9C4528] dark:bg-[#E08A62]",
    text: "fill-[#FDFDFC] dark:fill-[#0D0D0D]",
  },
  [-2]: {
    fill: "fill-[#CC7A56] dark:fill-[#C26E48]",
    swatch: "bg-[#CC7A56] dark:bg-[#C26E48]",
    text: "fill-[#2B211C] dark:fill-[#0D0D0D]",
  },
  [-1]: {
    fill: "fill-[#DE9F82] dark:fill-[#6B3A28]",
    swatch: "bg-[#DE9F82] dark:bg-[#6B3A28]",
    text: "fill-[#2B211C] dark:fill-[#E8DEB5]",
  },
  [0]: {
    fill: "fill-[#DCD5CB] dark:fill-[#2E2924]",
    swatch: "bg-[#DCD5CB] dark:bg-[#2E2924]",
    text: "fill-[#2B211C] dark:fill-[#E8DEB5]",
  },
  [1]: {
    fill: "fill-[#9FBB84] dark:fill-[#3E5230]",
    swatch: "bg-[#9FBB84] dark:bg-[#3E5230]",
    text: "fill-[#2B211C] dark:fill-[#E8DEB5]",
  },
  [2]: {
    fill: "fill-[#7E9F5F] dark:fill-[#6C8B47]",
    swatch: "bg-[#7E9F5F] dark:bg-[#6C8B47]",
    text: "fill-[#2B211C] dark:fill-[#0D0D0D]",
  },
  [3]: {
    fill: "fill-[#58773D] dark:fill-[#9DC07A]",
    swatch: "bg-[#58773D] dark:bg-[#9DC07A]",
    text: "fill-[#FDFDFC] dark:fill-[#0D0D0D]",
  },
};

/** The hatched fill of a figure the window cannot state. */
export const NA_STYLE: BinStyle = {
  fill: "fill-[#F2F0ED] dark:fill-[#1A1714]",
  swatch: "bg-[#F2F0ED] dark:bg-[#1A1714]",
  text: "fill-[#72625A] dark:fill-[#A39A75]",
};

/** The hatch's stroke, drawn over NA_STYLE.fill. */
export const NA_HATCH_STROKE = "stroke-[#CFC6BA] dark:stroke-[#3A332C]";

export const BINS: readonly DivergingBin[] = [-3, -2, -1, 0, 1, 2, 3];

/**
 * The scale's reach: the 90th percentile of the changes' sizes, so one outlier
 * does not wash every other tile into the midpoint. Zero sizes do not count;
 * with no change at all the reach is 1, and every tile sits at the midpoint.
 */
export function divergingDomain(values: ReadonlyArray<number | null | undefined>): number {
  const sizes = values
    .filter((v): v is number => v != null && Number.isFinite(v) && v !== 0)
    .map((v) => Math.abs(v))
    .sort((a, b) => a - b);
  if (sizes.length === 0) return 1;
  const at = Math.min(sizes.length - 1, Math.floor(sizes.length * 0.9));
  return sizes[at]! > 0 ? sizes[at]! : 1;
}

/**
 * The bin a change falls in: null for a figure not held (hatched), 0 for no
 * change, else one to three steps a side, each a third of the reach, the last
 * holding everything past it.
 */
export function divergingBin(value: number | null | undefined, domain: number): DivergingBin | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value === 0 || domain <= 0) return 0;
  const step = Math.min(3, Math.max(1, Math.ceil((Math.abs(value) / domain) * 3)));
  return (value > 0 ? step : -step) as DivergingBin;
}

/** The value range each bin covers, for the legend: [low, high] in the change's units. */
export function binRange(bin: DivergingBin, domain: number): [number, number] {
  const third = domain / 3;
  if (bin === 0) return [0, 0];
  const n = Math.abs(bin);
  const lo = (n - 1) * third;
  const hi = n === 3 ? Infinity : n * third;
  return bin > 0 ? [lo, hi] : [-hi, -lo];
}

/**
 * The kinds' category colours as SVG fills, the same hexes as KIND_INFO's
 * swatches (kinds.ts). A kind is a category, never a direction.
 */
export const KIND_FILL: Readonly<Record<string, string>> = {
  super_fund: "fill-[#87A96B]",
  index_manager: "fill-[#C9A66B]",
  hedge_fund: "fill-[#D16A47]",
  active_manager: "fill-[#FFA94D]",
  bank_broker: "fill-[#72625A]",
  sovereign_public: "fill-[#9AC082]",
  insurer: "fill-[#A39A75]",
  private_equity: "fill-[#9E5210] dark:fill-[#C77A2A]",
  corporate: "fill-[#483932] dark:fill-[#B5A48C]",
  other: "fill-[#E8DEB5]",
  unclassified: "fill-[#E5E1DC] dark:fill-[#8C8378]",
};

/** The same colours as link strokes, drawn translucent. */
export const KIND_STROKE: Readonly<Record<string, string>> = {
  super_fund: "stroke-[#87A96B]",
  index_manager: "stroke-[#C9A66B]",
  hedge_fund: "stroke-[#D16A47]",
  active_manager: "stroke-[#FFA94D]",
  bank_broker: "stroke-[#72625A]",
  sovereign_public: "stroke-[#9AC082]",
  insurer: "stroke-[#A39A75]",
  private_equity: "stroke-[#9E5210] dark:stroke-[#C77A2A]",
  corporate: "stroke-[#483932] dark:stroke-[#B5A48C]",
  other: "stroke-[#E8DEB5]",
  unclassified: "stroke-[#BDB4A8] dark:stroke-[#8C8378]",
};

export function kindFill(kind: string): string {
  return KIND_FILL[kind] ?? "fill-[#A39A75]";
}

export function kindStroke(kind: string): string {
  return KIND_STROKE[kind] ?? "stroke-[#A39A75]";
}
