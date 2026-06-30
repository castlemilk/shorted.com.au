// Reusable spatial-join harness for suburb-insight precompute scripts.
// Mirrors the ray-casting helpers in join-sed.mjs but adds a uniform-grid index
// so we can attach ~80k POIs to ~15k suburb polygons in O(points), and a
// brute-force haversine nearest for distance metrics. No external deps.
import fs from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";

// --- GeoJSON ring helpers (same math as join-sed.mjs) -----------------------
export function toPolys(geom) {
  const out = [];
  const push = (poly) => out.push({ outer: poly[0], holes: poly.slice(1) });
  if (geom.type === "Polygon") push(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach(push);
  return out;
}
export function ringsBbox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
export function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function inPolys(pt, polys) {
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
export function repPoint(polys) {
  let best = polys[0], bestArea = -1;
  for (const p of polys) { const ar = Math.abs(ringArea(p.outer)); if (ar > bestArea) { bestArea = ar; best = p; } }
  const c = ringCentroid(best.outer);
  if (inRing(c, best.outer) && !best.holes.some((h) => inRing(c, h))) return c;
  const v = best.outer[0];
  return [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2];
}

// --- Uniform-grid polygon index --------------------------------------------
const CELL = 0.05; // ~5km cells in degrees; empty cells cost nothing (Map-keyed)

// makePolygonIndex(features) where each feature = { id, geometry }.
// Returns { locate(lon,lat) → id|null, centroids() → Map<id,[lon,lat]> }.
export function makePolygonIndex(features) {
  const recs = [];
  const grid = new Map(); // "ix,iy" → [recIndex, ...]
  const key = (ix, iy) => `${ix},${iy}`;
  for (const f of features) {
    if (!f.geometry) continue;
    const polys = toPolys(f.geometry);
    if (!polys.length) continue;
    const bbox = ringsBbox(polys);
    const rec = { id: String(f.id), polys, bbox };
    const ri = recs.push(rec) - 1;
    const [x0, y0, x1, y1] = bbox;
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++)
      for (let iy = Math.floor(y0 / CELL); iy <= Math.floor(y1 / CELL); iy++) {
        const k = key(ix, iy);
        const bucket = grid.get(k);
        if (bucket) bucket.push(ri); else grid.set(k, [ri]);
      }
  }
  function locate(lon, lat) {
    const bucket = grid.get(key(Math.floor(lon / CELL), Math.floor(lat / CELL)));
    if (!bucket) return null;
    const pt = [lon, lat];
    for (const ri of bucket) {
      const r = recs[ri];
      if (pt[0] < r.bbox[0] || pt[0] > r.bbox[2] || pt[1] < r.bbox[1] || pt[1] > r.bbox[3]) continue;
      if (inPolys(pt, r.polys)) return r.id;
    }
    return null;
  }
  function centroids() {
    const m = new Map();
    for (const r of recs) m.set(r.id, repPoint(r.polys));
    return m;
  }
  return { locate, centroids };
}

// --- Suburb feature loader (TopoJSON per state, SAL_CODE21 as feature id) ----
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
export function loadSuburbFeatures(suburbsDir) {
  const out = [];
  for (const st of STATES) {
    const file = path.join(suburbsDir, `${st}.topojson`);
    if (!fs.existsSync(file)) continue;
    const topo = JSON.parse(fs.readFileSync(file, "utf8"));
    const fc = feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
    for (const f of fc.features) if (f.id && f.geometry) out.push({ id: String(f.id), geometry: f.geometry, state: st });
  }
  return out;
}

// --- Distance metrics -------------------------------------------------------
export function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// nearestPoint(lon,lat, points) where each point = { lon, lat, ... }.
// Brute force — fine offline (15k suburbs × a few-k POIs). Returns
// { point, distKm } or null.
export function nearestPoint(lon, lat, points) {
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = haversineKm(lon, lat, p.lon, p.lat);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { point: best, distKm: bestD } : null;
}
