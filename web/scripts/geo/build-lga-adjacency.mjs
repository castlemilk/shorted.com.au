#!/usr/bin/env node
// Council adjacency, derived from the suburb topology we already ship.
//
// Two councils are neighbours when a suburb whose DOMINANT council is one
// shares a boundary arc with a suburb whose dominant council is the other.
// Same arcs as the map draws, so a neighbour on the council page is exactly a
// council whose outline touches this one on the map. The suburb topology is
// per state, so that signal never crosses a state line; the councils that meet
// ACROSS one (Albury–Wodonga, Queanbeyan-Palerang–ACT, Tweed–Gold Coast, the
// Murray) come from build-lga-cross-border.mjs, computed from the ABS council
// boundaries, and are kept apart under `cross_state` so a reader can tell them
// from same-state neighbours.
//
// Inputs (all committed): web/public/geo/suburbs/<ST>.topojson, the mesh-block
// bridge web/public/geo/insights/suburb-lga.json (join-lga-mb.py) and the
// cross-border pairs web/scripts/geo/lga-cross-border.json.
// Output: services/shorts/internal/store/shorts/lga_adjacency.json, embedded
// into the API (go:embed) — the database holds no geometry, and this changes
// only when the ASGS vintage, the bridge or the boundaries do.
//
//   node web/scripts/geo/build-lga-adjacency.mjs          # write
//   node web/scripts/geo/build-lga-adjacency.mjs --check  # exit 1 on drift
import fs from "node:fs";
import path from "node:path";
import { neighbors } from "topojson-client";

const here = import.meta.dirname;
const web = path.join(here, "../..");
export const OUTPUT = path.join(web, "../services/shorts/internal/store/shorts/lga_adjacency.json");
export const CROSS_BORDER = path.join(here, "lga-cross-border.json");
export const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

/**
 * @param {Record<string, {lga: string}>} bridge sal_code -> dominant council
 * @param {Record<string, {objects: Record<string, {geometries: {id: string|number}[]}>}>} topologies by state
 * @returns {Record<string, string[]>} council -> sorted neighbour councils
 */
export function councilAdjacency(bridge, topologies) {
  const out = new Map();
  const link = (a, b) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a).add(b);
  };
  for (const state of Object.keys(topologies).sort()) {
    const topo = topologies[state];
    const object = topo.objects[Object.keys(topo.objects)[0]];
    const geometries = object.geometries;
    const adjacent = neighbors(geometries);
    geometries.forEach((g, i) => {
      const a = bridge[String(g.id)]?.lga;
      if (!a) return;
      for (const j of adjacent[i]) {
        const b = bridge[String(geometries[j].id)]?.lga;
        if (b && b !== a) link(a, b);
      }
    });
  }
  const result = {};
  for (const code of [...out.keys()].sort()) result[code] = [...out.get(code)].sort();
  return result;
}

/**
 * @param {{a: string, b: string}[]} pairs cross-border council pairs
 * @returns {Record<string, string[]>} council -> sorted cross-border neighbours, symmetric
 */
export function crossStateAdjacency(pairs) {
  const out = new Map();
  const link = (a, b) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a).add(b);
  };
  for (const { a, b } of pairs) {
    if (a === b) continue;
    link(a, b);
    link(b, a);
  }
  const result = {};
  for (const code of [...out.keys()].sort()) result[code] = [...out.get(code)].sort();
  return result;
}

export function build() {
  const bridge = JSON.parse(fs.readFileSync(path.join(web, "public/geo/insights/suburb-lga.json"), "utf8"));
  const topologies = {};
  for (const st of STATES) {
    topologies[st] = JSON.parse(fs.readFileSync(path.join(web, `public/geo/suburbs/${st}.topojson`), "utf8"));
  }
  const crossBorder = JSON.parse(fs.readFileSync(CROSS_BORDER, "utf8"));
  return {
    source: "ABS ASGS 2021 suburbs (SAL) topology + ABS mesh-block council allocation; ABS ASGS Ed.3 LGA_2024 boundaries, CC BY 4.0",
    method: "neighbours: dominant-council suburbs sharing a boundary arc, within a state; cross_state: " + crossBorder.method,
    neighbours: councilAdjacency(bridge, topologies),
    cross_state: crossStateAdjacency(crossBorder.pairs),
  };
}

// One council per line: a boundary change reads as a one-line diff.
export function serialize(doc) {
  const rows = (map) => Object.entries(map).map(([code, list]) => `  ${JSON.stringify(code)}: ${JSON.stringify(list)}`).join(",\n");
  return [
    "{",
    `"source": ${JSON.stringify(doc.source)},`,
    `"method": ${JSON.stringify(doc.method)},`,
    `"neighbours": {`,
    rows(doc.neighbours),
    "},",
    `"cross_state": {`,
    rows(doc.cross_state),
    "}",
    "}",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const next = serialize(build());
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
    if (current !== next) {
      console.error(`${path.relative(process.cwd(), OUTPUT)} is stale: re-run build-lga-adjacency.mjs`);
      process.exit(1);
    }
    console.log("lga_adjacency.json is current");
  } else {
    fs.writeFileSync(OUTPUT, next);
    const n = Object.keys(JSON.parse(next).neighbours).length;
    console.log(`wrote ${path.relative(process.cwd(), OUTPUT)} (${n} councils, ${next.length} bytes)`);
  }
}
