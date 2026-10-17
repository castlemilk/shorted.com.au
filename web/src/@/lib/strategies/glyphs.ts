// The five strategy glyphs, as SVG path data on a 24-unit grid.
//
// Serialisable on purpose (strings only, no functions, no React): the kit
// component (components/picks/strategy-glyph.tsx) draws them, tests read them,
// and the satori OG cards can reuse them. Every glyph is stroke-only
// (currentColor, 1.5 units, round joins) and draws the strategy's MECHANISM,
// not a generic chart: at 20px each must still be told from the others by
// silhouette, which is why Zanger is the only zigzag, CAN SLIM the only
// staircase, Minervini the only pure fan of diagonals, the crowded short the
// only vertical axis and the compounder the only arc.
//
// Keyed by strategy id (registry.ts); an id with no entry draws nothing.

export const STRATEGY_GLYPHS: Record<string, readonly string[]> = {
  // The pivot (the top of the base, the level that must be cleared and the
  // exit if lost), a tight base under it, one stroke up through it, and
  // volume on the floor with the tall bar under the breakout session.
  "zanger-breakout": [
    "M3 8H18",
    "M3 13.5L6.75 10.5L10.5 13.5L14 10.5L20.5 2.5",
    "M4.5 21V18.5M9 21V18.5M13.5 21V18.5M18 21V15.5",
  ],
  // Earnings acceleration as a staircase whose risers grow (5, 6, 7 units),
  // the last one clearing the prior high: the C, the A and the N.
  canslim: ["M3 20.5H7.5V15.5H12V9.5H16.5V2.5H21", "M2.5 6H18.5"],
  // The Trend Template's own picture: the 200-day, 150-day and 50-day
  // averages stacked in order and fanning apart as they rise (Stage 2).
  "minervini-trend-template": ["M3 20.5L21 14", "M3 17L21 8", "M3 13.5L21 2.5"],
  // A mechanism, not a chart: a coil compressed under a plate (the crowd of
  // short positions under resistance) and the release straight up through it.
  "crowded-short-breakout": [
    "M7.5 21.5H16.5",
    "M12 21.5L9 19.5L15 17L9 14.5L15 12L12 10.5",
    "M5.5 8.5H18.5",
    "M12 10.5V2.5M9 5.5L12 2.5L15 5.5",
  ],
  // A bench meter reading high: the one strategy that is a measurement (ROE,
  // margins, cash conversion, leverage) rather than a price pattern.
  "quality-compounders": [
    "M4 17A8 8 0 0 1 20 17",
    "M12 9V11.5M6.3 11.3L8.1 13.1M17.7 11.3L15.9 13.1",
    "M12 17L18 13.5",
    "M10.75 17a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
    "M4 20.5H20",
  ],
};

/** The 24-unit grid every glyph is drawn on. */
export const GLYPH_VIEWBOX = "0 0 24 24";
