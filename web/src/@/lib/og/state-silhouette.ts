import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Topology } from "topojson-specification";

import {
  buildStateSilhouetteModel,
  STATE_SILHOUETTE_FRAME,
} from "@/components/economy/state-banner-geometry";
import type { StateSlug } from "@/lib/economy/map-metrics";

/**
 * Server-side state silhouette for OG cards.
 *
 * The banner heroes on /economy/[state] compute an SVG path from the ABS
 * boundary topojson in the BROWSER (use-topojson + buildStateSilhouetteModel).
 * An opengraph-image route runs on the nodejs runtime, so the same pure
 * geometry function can run here against the same committed asset — the card
 * reuses the exact silhouette the page renders, no new artwork.
 *
 * This module lives in lib/og (server-only) rather than beside the geometry:
 * state-banner-geometry.ts is imported by "use client" components, and a
 * node:fs import there would break the client bundle.
 */

export interface StateSilhouette {
  d: string;
  width: number;
  height: number;
}

let cachedTopology: Topology | null | undefined;

function loadStatesTopology(): Topology | null {
  if (cachedTopology !== undefined) return cachedTopology;
  // process.cwd() at runtime can resolve to either the repo root or web/ —
  // same dual-path dance as the suburb OG card's banner read.
  for (const rel of [
    join("public", "geo", "states.topojson"),
    join("web", "public", "geo", "states.topojson"),
  ]) {
    try {
      cachedTopology = JSON.parse(
        readFileSync(join(process.cwd(), rel), "utf8"),
      ) as Topology;
      return cachedTopology;
    } catch {
      // try the next candidate
    }
  }
  cachedTopology = null;
  return cachedTopology;
}

/**
 * The silhouette path for a state route slug, or null when the boundary file
 * is unreadable or the slug is unknown — the caller degrades to the plain
 * card, never a 500 (a crawler must always get a valid PNG).
 */
export function getStateSilhouette(state: string): StateSilhouette | null {
  try {
    const topology = loadStatesTopology();
    if (!topology) return null;
    const model = buildStateSilhouetteModel(topology, state as StateSlug);
    if (!model) return null;
    return {
      d: model.d,
      width: STATE_SILHOUETTE_FRAME.width,
      height: STATE_SILHOUETTE_FRAME.height,
    };
  } catch {
    // stateFeatureId throws on an unknown slug; unknown slug -> plain card.
    return null;
  }
}
