/**
 * Server-side loader for suburb geometry: reads the committed ABS SAL boundary
 * TopoJSON off disk ONCE per state per process and hands decoded features to
 * the pure builders in `suburb-geometry.ts`.
 *
 * Node runtime only (node:fs). Import it from server components, server
 * actions and opengraph-image routes — never from a "use client" module.
 *
 * Vercel's file tracer cannot see these reads (the path is computed), so
 * `next.config.mjs` lists `public/geo/suburbs/*.topojson` and
 * `public/geo/states.topojson` under `outputFileTracingIncludes` for every
 * route that imports this module. Without that, prod silently renders every
 * suburb without a map and every OG card without a silhouette (measured on
 * the state OG cards, 2026-08-09 — see state-silhouette.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

import { STATE_TO_STE_CODE } from "@/lib/housing/states";
import {
  buildStateLocatorModel,
  buildSuburbLocatorModel,
  findSuburbFeature,
  type StateLocatorModel,
  type SuburbFeature,
  type SuburbGeometryModel,
} from "@/lib/housing/suburb-geometry";

const STATES_OBJECT = "STE_2021_AUST_GDA2020";

/** Everything a suburb page and its OG card need, computed in one pass. */
export interface SuburbPageGeometry extends SuburbGeometryModel {
  stateLocator: StateLocatorModel | null;
}

const suburbCache = new Map<string, readonly SuburbFeature[] | null>();
let statesCache: readonly SuburbFeature[] | null | undefined;

function readJson(rel: string[]): Topology | null {
  // process.cwd() at runtime can resolve to either the repo root or web/.
  for (const base of [process.cwd(), join(process.cwd(), "web")]) {
    try {
      return JSON.parse(readFileSync(join(base, ...rel), "utf8")) as Topology;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function decode(topology: Topology | null, objectName?: string): readonly SuburbFeature[] | null {
  if (!topology) return null;
  const name = objectName ?? Object.keys(topology.objects)[0];
  if (!name) return null;
  const obj = topology.objects[name] as GeometryCollection | undefined;
  if (!obj) return null;
  const fc = feature(topology, obj) as unknown as { features: SuburbFeature[] };
  return fc.features ?? null;
}

/** Decoded SAL features for one state, or null when the asset is unreadable. */
export function loadSuburbFeatures(stateCode: string): readonly SuburbFeature[] | null {
  const key = stateCode.toUpperCase();
  if (suburbCache.has(key)) return suburbCache.get(key) ?? null;
  const features = decode(readJson(["public", "geo", "suburbs", `${key}.topojson`]));
  suburbCache.set(key, features);
  return features;
}

/** The state boundary feature from the national STE topojson. */
export function loadStateFeature(stateCode: string): SuburbFeature | null {
  if (statesCache === undefined) {
    statesCache = decode(readJson(["public", "geo", "states.topojson"]), STATES_OBJECT);
  }
  const id = STATE_TO_STE_CODE[stateCode.toUpperCase()];
  if (!statesCache || !id) return null;
  return statesCache.find((f) => String(f.id) === id) ?? null;
}

const MEMO_MAX = 512;
const memo = new Map<string, SuburbPageGeometry | null>();

/**
 * Geometry for one suburb, or null. Never throws: a missing asset, an unknown
 * SAL code or a malformed polygon all degrade to "no map", because a crawler
 * or share fetch must never get a 500 for want of a thumbnail.
 *
 * Memoised per process (bounded, insertion-order eviction) so generateMetadata,
 * the page body and the opengraph-image route share one projection per suburb.
 * Deliberately NOT React's `cache()`: that export only exists in the RSC build
 * of react, and this module is also imported by route handlers and scripts.
 */
export function getSuburbGeometry(stateCode: string, salCode: string): SuburbPageGeometry | null {
  const key = `${stateCode.toUpperCase()}:${salCode}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let result: SuburbPageGeometry | null = null;
  try {
    const features = loadSuburbFeatures(stateCode);
    if (features) {
      const model = buildSuburbLocatorModel(features, salCode);
      if (model) {
        let stateLocator: StateLocatorModel | null = null;
        const stateFeature = loadStateFeature(stateCode);
        const suburbFeature = findSuburbFeature(features, salCode);
        if (stateFeature && suburbFeature) {
          stateLocator = buildStateLocatorModel(stateFeature, suburbFeature);
        }
        result = { ...model, stateLocator };
      }
    }
  } catch (err) {
    console.error(`[suburb-geometry] failed for ${stateCode}/${salCode}:`, err);
    result = null;
  }
  if (memo.size >= MEMO_MAX) {
    // Map iterates in insertion order, so the first key is the oldest entry.
    for (const oldest of memo.keys()) {
      memo.delete(oldest);
      break;
    }
  }
  memo.set(key, result);
  return result;
}
