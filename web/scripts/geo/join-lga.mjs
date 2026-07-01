// Join ABS SAL suburbs → LGA_2024 councils by point-in-polygon (SAL centroid in
// the LGA generalized boundary), and emit the LGA dimension facts. Outputs:
//   web/public/geo/insights/suburb-lga.json  { salCode: lgaCode }
//   web/public/geo/insights/lga-facts.json   { lgaCode: { name, state, areaSqkm } }
// Usage: node join-lga.mjs <suburbsDir> <stagingDir> <outDir>
import fs from "node:fs";
import path from "node:path";
import { loadSuburbFeatures, makePolygonIndex } from "./geo-index.mjs";

const suburbsDir = process.argv[2] || "web/public/geo/suburbs";
const stagingDir = process.argv[3] || path.join(import.meta.dirname, ".staging");
const outDir = process.argv[4] || "web/public/geo/insights";

const lgaFC = JSON.parse(fs.readFileSync(path.join(stagingDir, "abs-lga.geojson"), "utf8"));
// Give each LGA feature an `id` = lga_code so makePolygonIndex.locate returns it.
const lgaFeatures = lgaFC.features.map((f) => ({ id: f.properties.lga_code_2024, geometry: f.geometry }));
const facts = {};
for (const f of lgaFC.features) {
  const p = f.properties;
  facts[p.lga_code_2024] = {
    name: p.lga_name_2024,
    state: p.state_name_2021,
    areaSqkm: p.area_albers_sqkm != null ? Math.round(p.area_albers_sqkm * 10) / 10 : null,
  };
}

console.log(`indexing ${lgaFeatures.length} LGAs + ${"suburbs"} …`);
const lgaIdx = makePolygonIndex(lgaFeatures);
const subs = loadSuburbFeatures(suburbsDir);
const subIdx = makePolygonIndex(subs);
const centroids = subIdx.centroids();

const bridge = {};
let matched = 0;
for (const [sal, [lon, lat]] of centroids) {
  const lga = lgaIdx.locate(lon, lat);
  if (lga) { bridge[sal] = lga; matched++; }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "suburb-lga.json"), JSON.stringify(bridge));
fs.writeFileSync(path.join(outDir, "lga-facts.json"), JSON.stringify(facts));
console.log(`suburbs matched to an LGA: ${matched}/${centroids.size} (${(100 * matched / centroids.size).toFixed(1)}%)`);
console.log(`distinct LGAs hit: ${new Set(Object.values(bridge)).size} / ${Object.keys(facts).length}`);
