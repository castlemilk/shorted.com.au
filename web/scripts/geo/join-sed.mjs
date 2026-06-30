// Spatial-join ABS SAL suburbs → ABS State Electoral Divisions (SED 2025).
// Output: { salCode: { state, district } } for matched suburbs.
// Usage: node join-sed.mjs <sed.geojson> <suburbsGeoDir> <out.json>
import fs from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";

const [, , sedPath, suburbsDir, outPath] = process.argv;
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

const districts = JSON.parse(fs.readFileSync(sedPath, "utf8")).features
  .filter((f) => f.geometry)
  .map((f) => ({ name: f.properties.division, state: f.properties.state, bbox: ringsBbox(f.geometry), polys: toPolys(f.geometry) }));

function toPolys(geom) {
  const out = [];
  const push = (poly) => out.push({ outer: poly[0], holes: poly.slice(1) });
  if (geom.type === "Polygon") push(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach(push);
  return out;
}
function ringsBbox(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of toPolys(geom)) for (const [x, y] of p.outer) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inPolys(pt, polys) {
  for (const { outer, holes } of polys) if (inRing(pt, outer) && !holes.some((h) => inRing(pt, h))) return true;
  return false;
}
function ringArea(ring) { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]); return a / 2; }
function ringCentroid(ring) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f; a += f;
  }
  a *= 0.5; return a ? [x / (6 * a), y / (6 * a)] : ring[0];
}
function repPoint(geom) {
  const polys = toPolys(geom);
  let best = polys[0], bestArea = -1;
  for (const p of polys) { const ar = Math.abs(ringArea(p.outer)); if (ar > bestArea) { bestArea = ar; best = p; } }
  const c = ringCentroid(best.outer);
  if (inRing(c, best.outer) && !best.holes.some((h) => inRing(c, h))) return c;
  const v = best.outer[0];
  return [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2];
}

const mapping = {};
let total = 0, matched = 0;
for (const st of STATES) {
  const topo = JSON.parse(fs.readFileSync(path.join(suburbsDir, `${st}.topojson`), "utf8"));
  const fc = feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
  for (const f of fc.features) {
    const sal = String(f.id);
    if (!sal || !f.geometry) continue;
    total++;
    const pt = repPoint(f.geometry);
    for (const d of districts) {
      const [x0, y0, x1, y1] = d.bbox;
      if (pt[0] < x0 || pt[0] > x1 || pt[1] < y0 || pt[1] > y1) continue;
      if (inPolys(pt, d.polys)) {
        // ABS names VIC/TAS lower-house seats as "District (Region)" — strip the
        // qualifier to the bare House district (Bass (Launceston) → Bass).
        mapping[sal] = { state: d.state, district: d.name.replace(/\s*\([^)]*\)\s*$/, "").trim() };
        matched++; break;
      }
    }
  }
}
fs.writeFileSync(outPath, JSON.stringify(mapping));
console.log(`suburbs: ${total} | matched to a state district: ${matched} (${(100 * matched / total).toFixed(1)}%)`);
console.log(`distinct districts hit: ${new Set(Object.values(mapping).map((m) => m.district)).size}`);
