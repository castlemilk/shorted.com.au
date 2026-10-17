// Join ABS SAL suburbs → dominant NBN access technology. NBN footprints cover
// PREMISES areas, so a single suburb centroid often lands in a park/water gap;
// instead we sample a grid of interior points per suburb and take the majority
// technology among covered points, requiring at least 50% sample coverage.
// Coarse tiers need stronger evidence (see nbn-classify.mjs). NBN Coverage
// Footprints 2024, CC-BY-4.0. Outputs web/public/geo/insights/suburb-nbn.json
//   { salCode: { tech, score } }   (tech/score null = insufficient evidence)
//
// A point outside every footprint is UNKNOWN, never Satellite — see
// nbn-classify.mjs for why the old fallback labelled Bondi 'Satellite'. The
// service publishes no satellite layer, so 'Satellite' appears only when a
// satellite footprint has been staged as nbn-satellite.geojson.
// Usage: node join-nbn.mjs <suburbsDir> <stagingDir> <outFile>
import fs from "node:fs";
import path from "node:path";
import { loadSuburbFeatures, makePolygonIndex, toPolys, inPolys, ringsBbox, repPoint } from "./geo-index.mjs";
import { TECHS, UNKNOWN, classifySuburb, techAtPoint } from "./nbn-classify.mjs";

const suburbsDir = process.argv[2] || "web/public/geo/suburbs";
const stagingDir = process.argv[3] || path.join(import.meta.dirname, ".staging");
const outFile = process.argv[4] || "web/public/geo/insights/suburb-nbn.json";

const load = (name) => {
  const fc = JSON.parse(fs.readFileSync(path.join(stagingDir, name), "utf8"));
  return fc.features.map((f, i) => ({ id: String(i), geometry: f.geometry }));
};
const loadOptional = (name) => (fs.existsSync(path.join(stagingDir, name)) ? makePolygonIndex(load(name)) : null);

console.log("indexing NBN footprints …");
const indexes = {
  fixedLine: makePolygonIndex(load("nbn-fixedline.geojson")),
  fixedWireless: makePolygonIndex(load("nbn-fixedwireless.geojson")),
  satellite: loadOptional("nbn-satellite.geojson"),
};
if (!indexes.satellite) console.log("  no satellite footprint staged — no suburb will be classed Satellite");

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
const tally = { "Fixed Line": 0, "Fixed Wireless": 0, "Satellite": 0, [UNKNOWN]: 0 };
for (const f of loadSuburbFeatures(suburbsDir)) {
  const votes = Object.fromEntries([...TECHS, UNKNOWN].map((t) => [t, 0]));
  for (const [lon, lat] of samplePoints(f.geometry)) votes[techAtPoint(lon, lat, indexes)]++;
  const { tech, score } = classifySuburb(votes);
  out[f.id] = { tech, score };
  tally[tech ?? UNKNOWN]++;
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`wrote ${outFile}: ${Object.keys(out).length} suburbs`);
console.log(`  Fixed Line ${tally["Fixed Line"]} | Fixed Wireless ${tally["Fixed Wireless"]} | Satellite ${tally["Satellite"]} | unknown ${tally[UNKNOWN]}`);
