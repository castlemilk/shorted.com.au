import { geoMercator, geoPath } from "d3-geo";
import type { Feature, Geometry } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

import { STATE_TO_STE_CODE, slugToState } from "@/lib/housing/states";
import type { StateSlug } from "@/lib/economy/map-metrics";

export type FitExtent = [[number, number], [number, number]];

export const STATE_SILHOUETTE_FRAME = {
  width: 360,
  height: 260,
  paddingX: 52,
  paddingY: 38,
} as const;

const TOPO_OBJECT = "STE_2021_AUST_GDA2020";

/** Build a symmetric inset rectangle for d3 projection.fitExtent(). */
export function centeredFitExtent(
  width: number,
  height: number,
  paddingX: number,
  paddingY: number,
): FitExtent {
  return [
    [paddingX, paddingY],
    [width - paddingX, height - paddingY],
  ];
}

/** Resolve the economy route slug through the shared ABS state registry. */
export function stateFeatureId(state: StateSlug): string {
  const stateCode = slugToState(state);
  const featureId = stateCode ? STATE_TO_STE_CODE[stateCode] : undefined;

  if (!featureId) {
    throw new Error(`No ABS STE feature id for state slug: ${state}`);
  }

  return featureId;
}

export type StateSilhouetteModel = {
  d: string;
  featureId: string;
};

/** Project one state—not the national collection—into the banner frame. */
export function buildStateSilhouetteModel(
  topology: Topology,
  state: StateSlug,
): StateSilhouetteModel | null {
  const topologyObject = topology.objects[TOPO_OBJECT] as
    | GeometryCollection
    | undefined;
  if (!topologyObject) return null;

  const collection = feature(topology, topologyObject) as unknown as {
    features: Feature<Geometry>[];
  };
  const featureId = stateFeatureId(state);
  const target = collection.features.find(
    (candidate) => String(candidate.id) === featureId,
  );
  if (!target) return null;

  const { width, height, paddingX, paddingY } = STATE_SILHOUETTE_FRAME;
  const projection = geoMercator().fitExtent(
    centeredFitExtent(width, height, paddingX, paddingY),
    target,
  );
  const d = geoPath(projection)(target) ?? "";

  return d ? { d, featureId } : null;
}
