#!/usr/bin/env node
// Cross-border council adjacency, computed geometrically from the ABS council
// boundaries.
//
// build-lga-adjacency.mjs derives neighbours from the suburb topology, which is
// per state, so a council never meets one across a state or territory line:
// Albury–Wodonga, Queanbeyan-Palerang/Yass Valley–ACT, Tweed–Gold Coast and the
// Murray River councils were all missing. This script finds exactly those
// pairs: two councils in DIFFERENT states whose boundaries touch or come within
// TOLERANCE_M metres.
//
// Input (not committed, ~5.5 MB): web/scripts/geo/.staging/abs-lga.geojson,
// ABS ASGS Ed.3 LGA_2024 generalized boundaries (CC BY 4.0), fetched by
// `node web/scripts/geo/fetch-abs-lga.mjs`. The generalization keeps shared
// borders coincident: of the 76 pairs found at 50 m, 72 are at 0.0 m and the
// rest under 3 m, and 200 m finds the same 76 (1 km adds three corner
// near-misses such as Federation–Wodonga, which do not touch).
// Output (committed, small): web/scripts/geo/lga-cross-border.json, one pair
// per line with its distance. build-lga-adjacency.mjs merges it into
// lga_adjacency.json under `cross_state`, so the API artifact stays
// reproducible from committed inputs.
//
//   node web/scripts/geo/build-lga-cross-border.mjs           # write
//   node web/scripts/geo/build-lga-cross-border.mjs --check   # exit 1 on drift
import fs from "node:fs";
import path from "node:path";
import Flatbush from "flatbush";

const here = import.meta.dirname;
export const INPUT = path.join(here, ".staging/abs-lga.geojson");
export const OUTPUT = path.join(here, "lga-cross-border.json");
export const TOLERANCE_M = 50;

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;

// ABS LGA code prefix -> state. Codes are 5 digits, first digit the state.
const STATE_BY_DIGIT = { 1: "NSW", 2: "VIC", 3: "QLD", 4: "SA", 5: "WA", 6: "TAS", 7: "NT", 8: "ACT", 9: "OT" };

/** Pseudo areas have no ground to border anything: "No usual address" (x9499),
 * "Migratory - Offshore - Shipping" (x9799) and "Outside Australia" (ZZZZZ). */
export function isPseudoLga(code) {
  return !/^\d{5}$/.test(code) || /^\d9[47]99$/.test(code);
}

export function stateOfLga(code) {
  return STATE_BY_DIGIT[code[0]];
}

function rings(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polys.flat();
}

// Point-to-segment distance in a plane.
function pointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function orient(ax, ay, bx, by, cx, cy) {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/** Distance in metres between two lon/lat segments, 0 when they cross. Uses a
 * local equirectangular frame at the first segment's latitude: exact enough at
 * tens of metres, which is all the tolerance asks. */
export function segmentDistanceM(s, t) {
  const k = Math.cos((s[1] * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  const x = (lon) => (lon - s[0]) * k;
  const y = (lat) => (lat - s[1]) * M_PER_DEG_LAT;
  const [ax, ay, bx, by] = [x(s[0]), y(s[1]), x(s[2]), y(s[3])];
  const [cx, cy, dx, dy] = [x(t[0]), y(t[1]), x(t[2]), y(t[3])];
  if (
    orient(ax, ay, bx, by, cx, cy) !== orient(ax, ay, bx, by, dx, dy) &&
    orient(cx, cy, dx, dy, ax, ay) !== orient(cx, cy, dx, dy, bx, by)
  ) {
    return 0;
  }
  return Math.min(
    pointSegment(cx, cy, ax, ay, bx, by),
    pointSegment(dx, dy, ax, ay, bx, by),
    pointSegment(ax, ay, cx, cy, dx, dy),
    pointSegment(bx, by, cx, cy, dx, dy),
  );
}

/**
 * @param {{features: {properties: {lga_code_2024: string, lga_name_2024: string}, geometry: object|null}[]}} fc
 * @param {number} toleranceM
 * @returns {{a: string, b: string, a_name: string, b_name: string, distance_m: number}[]} sorted pairs, a < b
 */
export function crossBorderPairs(fc, toleranceM = TOLERANCE_M) {
  const segs = [];
  const names = {};
  for (const f of fc.features) {
    const code = String(f.properties.lga_code_2024);
    if (isPseudoLga(code) || !stateOfLga(code)) continue;
    names[code] = f.properties.lga_name_2024;
    const state = stateOfLga(code);
    for (const ring of rings(f.geometry)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        segs.push({ code, state, s: [ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]] });
      }
    }
  }
  if (!segs.length) return [];
  const index = new Flatbush(segs.length);
  for (const { s } of segs) index.add(Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3]));
  index.finish();

  const best = new Map();
  const dLat = toleranceM / M_PER_DEG_LAT;
  for (const seg of segs) {
    const { s } = seg;
    const dLon = toleranceM / (M_PER_DEG_LON_EQ * Math.cos((s[1] * Math.PI) / 180));
    const hits = index.search(
      Math.min(s[0], s[2]) - dLon, Math.min(s[1], s[3]) - dLat,
      Math.max(s[0], s[2]) + dLon, Math.max(s[1], s[3]) + dLat,
    );
    for (const j of hits) {
      const other = segs[j];
      if (other.state === seg.state) continue;
      const d = segmentDistanceM(s, other.s);
      if (d > toleranceM) continue;
      const [a, b] = seg.code < other.code ? [seg.code, other.code] : [other.code, seg.code];
      const key = `${a}|${b}`;
      if (!best.has(key) || d < best.get(key)) best.set(key, d);
    }
  }
  return [...best.keys()].sort().map((key) => {
    const [a, b] = key.split("|");
    return { a, b, a_name: names[a], b_name: names[b], distance_m: Math.round(best.get(key) * 10) / 10 };
  });
}

export function buildDoc(fc) {
  return {
    source: "ABS ASGS Edition 3 LGA_2024 generalized boundaries (geo.abs.gov.au ASGS2024/LGA MapServer layer 1), CC BY 4.0",
    method: `councils in different states whose boundaries touch or come within ${TOLERANCE_M} m; pseudo areas excluded`,
    tolerance_m: TOLERANCE_M,
    pairs: crossBorderPairs(fc, TOLERANCE_M),
  };
}

// One pair per line: a boundary change reads as a one-line diff.
export function serialize(doc) {
  return [
    "{",
    `"source": ${JSON.stringify(doc.source)},`,
    `"method": ${JSON.stringify(doc.method)},`,
    `"tolerance_m": ${doc.tolerance_m},`,
    `"pairs": [`,
    doc.pairs.map((p) => `  ${JSON.stringify(p)}`).join(",\n"),
    "]",
    "}",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!fs.existsSync(INPUT)) {
    console.error(`${path.relative(process.cwd(), INPUT)} is missing: run node web/scripts/geo/fetch-abs-lga.mjs first`);
    process.exit(2);
  }
  const next = serialize(buildDoc(JSON.parse(fs.readFileSync(INPUT, "utf8"))));
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
    if (current !== next) {
      console.error(`${path.relative(process.cwd(), OUTPUT)} is stale: re-run build-lga-cross-border.mjs`);
      process.exit(1);
    }
    console.log("lga-cross-border.json is current");
  } else {
    fs.writeFileSync(OUTPUT, next);
    console.log(`wrote ${path.relative(process.cwd(), OUTPUT)} (${JSON.parse(next).pairs.length} pairs)`);
  }
}
