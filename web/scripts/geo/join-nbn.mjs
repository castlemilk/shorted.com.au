// Join ABS SAL suburbs → dominant NBN access technology. NBN footprints cover
// PREMISES areas, so a single suburb centroid often lands in a park/water gap;
// instead we sample a grid of interior points per suburb and take the majority
// technology (Fixed Line > Fixed Wireless > else Satellite). NBN Coverage
// Footprints 2024, CC-BY-4.0. Outputs web/public/geo/insights/suburb-nbn.json
//   { salCode: { tech, score } }
// Usage: node join-nbn.mjs <suburbsDir> <stagingDir> <outFile>
import fs from "node:fs";
import path from "node:path";
import { loadSuburbFeatures, makePolygonIndex, toPolys, inPolys, ringsBbox, repPoint } from "./geo-index.mjs";

const suburbsDir = process.argv[2] || "web/public/geo/suburbs";
const stagingDir = process.argv[3] || path.join(import.meta.dirname, ".staging");
const outFile = process.argv[4] || "web/public/geo/insights/suburb-nbn.json";

const load = (name) => {
  const fc = JSON.parse(fs.readFileSync(path.join(stagingDir, name), "utf8"));
  return fc.features.map((f, i) => ({ id: String(i), geometry: f.geometry }));
};

console.log("indexing NBN footprints …");
const flIdx = makePolygonIndex(load("nbn-fixedline.geojson"));
const fwIdx = makePolygonIndex(load("nbn-fixedwireless.geojson"));
const SCORE = { "Fixed Line": 90, "Fixed Wireless": 55, "Satellite": 20 };

const techAt = (lon, lat) =>
  flIdx.locate(lon, lat) ? "Fixed Line" : fwIdx.locate(lon, lat) ? "Fixed Wireless" : "Satellite";

// up to n×n interior sample points across the suburb bbox (skip points outside).
function samplePoints(geom, n = 4) {
  const polys = toPolys(geom);
  const [x0, y0, x1, y1] = ringsBbox(polys);
  const pts = [];
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= n; j++) {
      const lon = x0 + ((x1 - x0) * i) / (n + 1), lat = y0 + ((y1 - y0) * j) / (n + 1);
      if (inPolys([lon, lat], polys)) pts.push([lon, lat]);
    }
  if (!pts.length) pts.push(repPoint(polys)); // tiny suburb → representative point
  return pts;
}

console.log("sampling suburbs …");
const out = {};
const tally = { "Fixed Line": 0, "Fixed Wireless": 0, "Satellite": 0 };
for (const f of loadSuburbFeatures(suburbsDir)) {
  const votes = { "Fixed Line": 0, "Fixed Wireless": 0, "Satellite": 0 };
  for (const [lon, lat] of samplePoints(f.geometry)) votes[techAt(lon, lat)]++;
  let tech = "Satellite", best = -1;
  for (const t of ["Fixed Line", "Fixed Wireless", "Satellite"]) if (votes[t] > best) { best = votes[t]; tech = t; }
  out[f.id] = { tech, score: SCORE[tech] };
  tally[tech]++;
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`wrote ${outFile}: ${Object.keys(out).length} suburbs`);
console.log(`  Fixed Line ${tally["Fixed Line"]} | Fixed Wireless ${tally["Fixed Wireless"]} | Satellite ${tally["Satellite"]}`);
