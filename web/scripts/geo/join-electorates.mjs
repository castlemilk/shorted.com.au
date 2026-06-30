// Spatial-join ABS SAL suburbs → federal electoral divisions.
// For each suburb we take a representative interior point and find the division
// polygon that contains it. Divisions are far larger than suburbs, so a centroid
// assignment is robust. Output: { salCode: divisionName } + stats.
//
// Usage: node join-electorates.mjs <divisions.geojson> <suburbsGeoDir> <out.json>
import fs from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";

const [, , divisionsPath, suburbsDir, outPath] = process.argv;
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

const divisions = JSON.parse(fs.readFileSync(divisionsPath, "utf8")).features.map((f) => ({
  name: f.properties.division,
  bbox: ringsBbox(f.geometry),
  polys: toPolys(f.geometry), // array of {outer, holes}
}));

// --- geometry helpers ---
function toPolys(geom) {
  const out = [];
  const push = (poly) => out.push({ outer: poly[0], holes: poly.slice(1) });
  if (geom.type === "Polygon") push(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach(push);
  return out;
}
function ringsBbox(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const scan = (ring) => { for (const [x, y] of ring) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } };
  for (const p of toPolys(geom)) scan(p.outer);
  return [x0, y0, x1, y1];
}
// ray-casting point-in-ring
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inPolys(pt, polys) {
  for (const { outer, holes } of polys) {
    if (inRing(pt, outer) && !holes.some((h) => inRing(pt, h))) return true;
  }
  return false;
}
// representative interior point: centroid of the largest ring, nudged inside if needed
function repPoint(geom) {
  const polys = toPolys(geom);
  let best = polys[0], bestArea = -1;
  for (const p of polys) { const a = Math.abs(ringArea(p.outer)); if (a > bestArea) { bestArea = a; best = p; } }
  const c = ringCentroid(best.outer);
  if (inRing(c, best.outer) && !best.holes.some((h) => inRing(c, h))) return c;
  // fallback: first vertex slightly toward centroid
  const v = best.outer[0];
  return [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2];
}
function ringArea(ring) { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]); return a / 2; }
function ringCentroid(ring) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f; a += f;
  }
  a *= 0.5;
  return a ? [x / (6 * a), y / (6 * a)] : ring[0];
}

// --- join ---
const mapping = {};
let total = 0, matched = 0;
for (const st of STATES) {
  const topo = JSON.parse(fs.readFileSync(path.join(suburbsDir, `${st}.topojson`), "utf8"));
  const objName = Object.keys(topo.objects)[0];
  const fc = feature(topo, topo.objects[objName]);
  for (const f of fc.features) {
    const sal = String(f.id);
    if (!sal || !f.geometry) continue;
    total++;
    const pt = repPoint(f.geometry);
    let hit = null;
    for (const d of divisions) {
      const [x0, y0, x1, y1] = d.bbox;
      if (pt[0] < x0 || pt[0] > x1 || pt[1] < y0 || pt[1] > y1) continue;
      if (inPolys(pt, d.polys)) { hit = d.name; break; }
    }
    if (hit) { mapping[sal] = hit; matched++; }
  }
}
fs.writeFileSync(outPath, JSON.stringify(mapping));
console.log(`suburbs: ${total} | matched to a division: ${matched} (${(100 * matched / total).toFixed(1)}%) | unmatched: ${total - matched}`);
console.log(`distinct divisions hit: ${new Set(Object.values(mapping)).size} / ${divisions.length}`);
