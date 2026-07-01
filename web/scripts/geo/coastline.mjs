// Derive the Australian coastline from the committed ABS state-boundary TopoJSON
// (web/public/geo/states.topojson, CC-BY 4.0) — no external dataset needed.
//
// A TopoJSON arc that borders two state polygons is an INTERNAL state border
// (referenced twice); an arc that borders land and ocean is COASTLINE
// (referenced once). We keep the used-once arcs, decode them from the quantized
// delta encoding, densify long segments, and expose a nearest-coast helper.
// Islands (Tasmania, Kangaroo Island, …) are their own rings and are included.
import fs from "node:fs";
import { haversineKm } from "./geo-index.mjs";

// loadCoastlinePoints(statesPath) → [{ lon, lat }] sampling the AU coastline at
// roughly `stepKm` spacing (segments longer than that are linearly densified so
// a suburb opposite the middle of a simplified segment still measures correctly).
export function loadCoastlinePoints(statesPath, stepKm = 2) {
  const topo = JSON.parse(fs.readFileSync(statesPath, "utf8"));
  const { scale, translate } = topo.transform;
  const objName = Object.keys(topo.objects)[0];
  const geoms = topo.objects[objName].geometries;

  // Count how many polygon rings reference each arc (by absolute index).
  const use = new Map();
  const bump = (i) => { const k = i < 0 ? ~i : i; use.set(k, (use.get(k) || 0) + 1); };
  for (const g of geoms) {
    if (g.type === "Polygon") g.arcs.forEach((r) => r.forEach(bump));
    else if (g.type === "MultiPolygon") g.arcs.forEach((p) => p.forEach((r) => r.forEach(bump)));
  }

  // Decode a quantized arc (cumulative integer deltas) into absolute lon/lat.
  const decode = (arc) => {
    let x = 0, y = 0;
    const pts = [];
    for (const [dx, dy] of arc) {
      x += dx; y += dy;
      pts.push([translate[0] + scale[0] * x, translate[1] + scale[1] * y]);
    }
    return pts;
  };

  const points = [];
  for (const [idx, count] of use) {
    if (count !== 1) continue; // internal border → not coast
    const pts = decode(topo.arcs[idx]);
    for (let i = 0; i < pts.length; i++) {
      const [lon, lat] = pts[i];
      points.push({ lon, lat });
      if (i + 1 < pts.length) {
        const [lon2, lat2] = pts[i + 1];
        const segKm = haversineKm(lon, lat, lon2, lat2);
        const n = Math.floor(segKm / stepKm);
        for (let k = 1; k < n; k++) {
          const f = k / n;
          points.push({ lon: lon + (lon2 - lon) * f, lat: lat + (lat2 - lat) * f });
        }
      }
    }
  }
  return points;
}

// makeCoastDistanceFn(points) → (lon,lat) → km to nearest coast. Uses an
// equirectangular (cos-lat scaled) squared distance to pick the nearest point
// cheaply, then one haversine for the exact km. Fast enough brute-force for an
// offline precompute (~40k coast points × ~15k suburbs).
export function makeCoastDistanceFn(points) {
  const lons = Float64Array.from(points, (p) => p.lon);
  const lats = Float64Array.from(points, (p) => p.lat);
  const n = points.length;
  return (lon, lat) => {
    const cos = Math.cos((lat * Math.PI) / 180);
    let bestD2 = Infinity, bi = -1;
    for (let i = 0; i < n; i++) {
      const dx = (lons[i] - lon) * cos;
      const dy = lats[i] - lat;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bi = i; }
    }
    return bi < 0 ? null : haversineKm(lon, lat, lons[bi], lats[bi]);
  };
}
