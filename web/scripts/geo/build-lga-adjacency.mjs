#!/usr/bin/env node
// Council adjacency, derived from the suburb topology we already ship.
//
// Two councils are neighbours when a suburb whose DOMINANT council is one
// shares a boundary arc with a suburb whose dominant council is the other.
// Same arcs as the map draws, so a neighbour on the council page is exactly a
// council whose outline touches this one on the map. Within a state only: the
// suburb topology is per state, so Albury and Wodonga are not neighbours here.
//
// Inputs (both committed): web/public/geo/suburbs/<ST>.topojson and the
// mesh-block bridge web/public/geo/insights/suburb-lga.json (join-lga-mb.py).
// Output: services/shorts/internal/store/shorts/lga_adjacency.json, embedded
// into the API (go:embed) — the database holds no geometry, and this changes
// only when the ASGS vintage or the bridge does.
//
//   node web/scripts/geo/build-lga-adjacency.mjs          # write
//   node web/scripts/geo/build-lga-adjacency.mjs --check  # exit 1 on drift
import fs from "node:fs";
import path from "node:path";
import { neighbors } from "topojson-client";

const here = import.meta.dirname;
const web = path.join(here, "../..");
export const OUTPUT = path.join(web, "../services/shorts/internal/store/shorts/lga_adjacency.json");
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

export function build() {
  const bridge = JSON.parse(fs.readFileSync(path.join(web, "public/geo/insights/suburb-lga.json"), "utf8"));
  const topologies = {};
  for (const st of STATES) {
    topologies[st] = JSON.parse(fs.readFileSync(path.join(web, `public/geo/suburbs/${st}.topojson`), "utf8"));
  }
  return {
    source: "ABS ASGS 2021 suburbs (SAL) topology + ABS mesh-block council allocation, CC BY 4.0",
    method: "dominant-council suburbs sharing a boundary arc, within a state",
    neighbours: councilAdjacency(bridge, topologies),
  };
}

// One council per line: a boundary change reads as a one-line diff.
export function serialize(doc) {
  const rows = Object.entries(doc.neighbours).map(([code, list]) => `  ${JSON.stringify(code)}: ${JSON.stringify(list)}`);
  return [
    "{",
    `"source": ${JSON.stringify(doc.source)},`,
    `"method": ${JSON.stringify(doc.method)},`,
    `"neighbours": {`,
    rows.join(",\n"),
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
