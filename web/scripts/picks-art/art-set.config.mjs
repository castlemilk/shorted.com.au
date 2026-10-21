// Stock picker editorial art: the prompt config.
//
// One full-bleed scene per strategy, drawn as a MECHANISM in the warm
// duotone screen-print language of the housing banners, so the picker and
// the housing surfaces read as one brand. Each subject is the same idea the
// strategy's engraved glyph draws (web/src/@/lib/strategies/glyphs.ts), at
// scene scale: the thing the strategy waits for, never a stock chart with
// numbers and never a person. Keyed by strategy id (lib/strategies/registry.ts);
// the bake script writes the manifest from these ids.
//
// The scene sits BEHIND the strategy page's faceplate under a scrim that
// is heaviest on the left, where the bezel, the H1 and the provenance plate
// sit, so the composition keeps its subject to the right and its upper-left
// calm. The hub shows the same scene as a small 3:2 plate, so the subject
// must survive at 120px wide: one bold shape, not a landscape of details.

export const STYLE = {
  suffix:
    "Wide flat editorial illustration in a warm duotone palette: warm amber (#FFA94D) and " +
    "muted sage-olive (#87A96B) with small clay-rust (#D16A47) accents over a soft warm-cream " +
    "ground, anchored by a deep charcoal-brown. Layered screen-print poster style with gentle " +
    "paper grain, one bold simple subject on the right two-thirds, a calm near-empty field " +
    "across the upper-left for overlaid text, soft directional golden light. Full-bleed scene, " +
    "no transparency. No text, no letters, no numbers, no tickers, no candlesticks, no people, " +
    "no faces, no logos. No photorealism, no 3D render, no harsh detail, no frame or border. " +
    "Cohesive set: uniform mood and palette across every strategy.",
  palette: ["#FFA94D", "#87A96B", "#D16A47"],
  themeStyle: "warm editorial duotone flat illustration, screen-print poster, instrument and mechanism motifs",
  globalRules: [
    "warm editorial duotone, screen-print poster with subtle paper grain",
    "amber #FFA94D + sage-olive #87A96B primary, clay-rust #D16A47 accent, warm-cream ground",
    "one bold simple subject weighted to the right two-thirds",
    "calm near-empty field across the upper-left reserved for overlaid text",
    "a mechanism or instrument, never a stock chart, never a person",
    "cohesive set, uniform mood and palette",
  ],
  negativeConstraints: [
    "text", "letters", "numbers", "words", "tickers", "candlesticks", "people", "faces",
    "logos", "watermark", "photorealism", "3D render", "harsh detail", "frame", "border",
  ],
};

/**
 * The scenes. `id` is the strategy id; `subject` is the scene; the final
 * prompt is `${subject}. ${STYLE.suffix}`. `glyph` records which engraved
 * mark the scene is the large version of.
 */
export const SCENES = [
  {
    id: "zanger-breakout",
    glyph: "pivot line, tight base, one stroke up through it, volume on the floor",
    subject:
      "a river held behind a long low weir, the water tight and level against the wall, and at one point " +
      "a single bright plume bursting up and over the lip into open air, seen from the bank at golden hour",
  },
  {
    id: "canslim",
    glyph: "a staircase whose risers grow, the last one clearing the prior high",
    subject:
      "a monumental stone staircase climbing a hillside, each flight taller than the one below, the top " +
      "flight rising clear above a distant ridge line into a bright sky",
  },
  {
    id: "minervini-trend-template",
    glyph: "three averages stacked in order and fanning apart as they rise",
    subject:
      "three long terraced ridgelines stacked one above the other, rising together toward the right and " +
      "fanning apart as they climb, morning light on their upper edges",
  },
  {
    id: "crowded-short-breakout",
    glyph: "a coil compressed under a plate and the release straight up through it",
    subject:
      "a great coiled spring compressed under a heavy iron plate in a workshop, the plate just lifting " +
      "and a burst of light escaping straight upward through the gap",
  },
  {
    id: "quality-compounders",
    glyph: "a bench meter reading high",
    subject:
      "a large brass bench meter on a workshop table, its single needle swung far to the right of the " +
      "arc, warm lamplight on the dial, a calm empty wall behind",
  },
];

export const SCENE_IDS = SCENES.map((s) => s.id);

/** What the flow is told about the surface the scenes are for. */
export const TARGET = {
  surface: "editorial hero band behind a page header",
  aspectRatio: "3:2",
  compositionRules: [
    "one bold simple subject weighted to the right two-thirds",
    "calm near-empty field across the upper-left",
    "full-bleed scene, no central clutter",
  ],
  copySafety: "leave clear headline space across the upper-left for a page title and a one-line provenance plate",
};
