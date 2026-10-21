// Where a strategy's editorial art is served from. Pure and serialisable
// (strings in, strings out), safe on both sides of the RSC boundary.
//
// The art is generated through the brandbrain flow-orchestrator MCP (or the
// OpenAI fallback) and baked by web/scripts/picks-art/bake.mjs, which also
// writes the manifest this reads (./art.generated.ts). A strategy with no
// entry has no art, and every surface renders exactly as it did before art
// existed: the glyph, the bezel, the standard share card.

import { STRATEGY_ART } from "./art.generated";

/** The directory under /public the bake script writes to. */
export const PICKS_ART_PATH = "/picks-art";

export interface StrategyArtUrls {
  /** The light-room band (AVIF, ~3:1). */
  light: string;
  /** The dark-room band: the same scene through the dark gradient map. */
  dark: string;
  /** The share-card scene, 1200x630 JPEG, dark-toned (satori decodes JPEG). */
  og: string;
  /** Content hash of the baked set; the URLs carry it as a cache key. */
  hash: string;
}

/** The art URLs for a strategy, or null when none is baked. */
export function strategyArt(slug: string): StrategyArtUrls | null {
  const entry = Object.prototype.hasOwnProperty.call(STRATEGY_ART, slug)
    ? STRATEGY_ART[slug]
    : undefined;
  if (!entry?.hash) return null;
  const v = `?v=${encodeURIComponent(entry.hash)}`;
  return {
    light: `${PICKS_ART_PATH}/${slug}.light.avif${v}`,
    dark: `${PICKS_ART_PATH}/${slug}.dark.avif${v}`,
    og: `${PICKS_ART_PATH}/og/${slug}.jpg${v}`,
    hash: entry.hash,
  };
}

/** The strategies with baked art, in manifest order. */
export function strategiesWithArt(): string[] {
  return Object.keys(STRATEGY_ART).filter((slug) => strategyArt(slug) !== null);
}
