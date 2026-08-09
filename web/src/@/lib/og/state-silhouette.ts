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
  // same dual-path dance as the suburb OG card's banner read. INLINE LITERAL
  // paths on each call, NOT a loop over a path array: Vercel's file tracer
  // only bundles what it can statically resolve, and the loop variant shipped
  // to prod with no topojson in the lambda — every state card silently fell
  // back to the plain layout (measured on /housing/opengraph-image, same
  // failure). The suburb card's literal reads have traced correctly since it
  // shipped; mirror them exactly.
  try {
    cachedTopology = JSON.parse(
      readFileSync(
        join(process.cwd(), "public", "geo", "states.topojson"),
        "utf8",
      ),
    ) as Topology;
    return cachedTopology;
  } catch {
    // try the repo-root variant
  }
  try {
    cachedTopology = JSON.parse(
      readFileSync(
        join(process.cwd(), "web", "public", "geo", "states.topojson"),
        "utf8",
      ),
    ) as Topology;
    return cachedTopology;
  } catch {
    // fall through to null
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
