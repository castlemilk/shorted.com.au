// Join staged OSM amenity points → ABS SAL suburbs via the geo-index harness,
// producing the committed derived metrics file web/public/geo/insights/
// suburb-amenities.json ({ salCode: {counts/distances/indices} }). Derived
// counts only — a Produced Work under ODbL (attribution, no share-alike); raw
// OSM geometry is never written here.
// Usage: node join-amenities.mjs <suburbsDir> <stagingDir> <outFile>
import fs from "node:fs";
import path from "node:path";
import { loadSuburbFeatures, makePolygonIndex, nearestPoint } from "./geo-index.mjs";

const suburbsDir = process.argv[2] || "web/public/geo/suburbs";
const stagingDir = process.argv[3] || path.join(import.meta.dirname, ".staging");
const outFile = process.argv[4] || "web/public/geo/insights/suburb-amenities.json";

const readPts = (cat) => {
  const f = path.join(stagingDir, `osm-${cat}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
};

// Coles Q1108172, Woolworths Q3249145, ALDI Q41171364/Q125054, IGA Q1825080.
function brandKey(p) {
  const s = `${p.brand} ${p.name}`.toLowerCase();
  if (/woolworths|q3249145/.test(s)) return "woolworths";
  if (/coles|q1108172/.test(s)) return "coles";
  if (/\baldi\b|q41171364|q125054/.test(s)) return "aldi";
  if (/\biga\b|q1825080/.test(s)) return "iga";
  return null;
}

console.log("building suburb index …");
const feats = loadSuburbFeatures(suburbsDir);
const idx = makePolygonIndex(feats);
const centroids = idx.centroids();

// Initialise every suburb to 0 (a real "no amenity here", not no-data).
const rows = new Map();
for (const sal of centroids.keys()) {
  rows.set(sal, {
    schoolsTotal: 0, supermarketsTotal: 0, colesCount: 0, woolworthsCount: 0,
    aldiCount: 0, igaCount: 0, pubsBars: 0, parksCount: 0, librariesCount: 0,
  });
}

const tally = (cat, field, brandAware = false) => {
  let hit = 0;
  for (const p of readPts(cat)) {
    const sal = idx.locate(p.lon, p.lat);
    if (!sal) continue;
    const r = rows.get(sal);
    if (!r) continue;
    r[field]++;
    hit++;
    if (brandAware) {
      const b = brandKey(p);
      if (b) r[`${b}Count`]++;
    }
  }
  console.log(`  ${cat}: ${hit} joined to a suburb`);
};

console.log("joining points → suburbs …");
tally("school", "schoolsTotal");
tally("supermarket", "supermarketsTotal", true);
tally("pub_bar", "pubsBars");
tally("park", "parksCount");
tally("library", "librariesCount");

// nearest supermarket (km) from each suburb centroid, across ALL supermarkets.
const supers = readPts("supermarket");
if (supers.length) {
  console.log(`nearest-supermarket over ${supers.length} points …`);
  for (const [sal, [lon, lat]] of centroids) {
    const n = nearestPoint(lon, lat, supers);
    if (n) rows.get(sal).nearestSupermarketKm = Math.round(n.distKm * 10) / 10;
  }
}

// amenity-density score 0..100: weighted raw, scaled by the 95th percentile so
// a handful of CBD outliers don't flatten the rest, then capped.
const raw = (r) => r.schoolsTotal * 2 + r.supermarketsTotal * 5 + r.pubsBars * 3 + r.librariesCount * 4 + r.parksCount;
const raws = [...rows.values()].map(raw).filter((v) => v > 0).sort((a, b) => a - b);
const p95 = raws.length ? raws[Math.floor(raws.length * 0.95)] : 1;
for (const r of rows.values()) {
  r.amenityDensityScore = Math.round(Math.min(100, (raw(r) / Math.max(1, p95)) * 100) * 10) / 10;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(Object.fromEntries(rows)));
const withAny = [...rows.values()].filter((r) => raw(r) > 0).length;
console.log(`wrote ${outFile}: ${rows.size} suburbs (${withAny} with ≥1 amenity, p95 raw=${p95})`);
