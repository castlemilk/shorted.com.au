// Fetch NBN Coverage Footprints 2024 (CC-BY, DITRDCA) — Fixed Line (layer 2) +
// Fixed Wireless (layer 3) polygons, for the sample-point→tech join.
// Writes <outDir>/nbn-fixedline.geojson + nbn-fixedwireless.geojson.
// Usage: node fetch-nbn.mjs [outDir]   (default: .staging beside this script)
//
// The service publishes NO satellite layer, so none is fetched and join-nbn.mjs
// never infers one (see nbn-classify.mjs).
//
// Simplification tolerance is per layer. Fixed Line footprints (FSAM/SAM
// polygons) are often only a few hundred metres across, and the old uniform
// 0.002° (~200 m) tolerance collapsed them to slivers — e.g. 2DAL-22 in
// Sydney's CBD, 29 vertices at source, 4 once simplified. 0.0001° (~10 m)
// keeps their shape (11 MB staged). Measured 2026-09-23 it moves only 5
// suburbs, so it is fidelity, not the fix: the layer itself is patchy, which
// is why a miss must stay unknown. Fixed Wireless is a coarse tower-coverage
// grid, so the coarse tolerance costs it nothing.
import fs from "node:fs";
import path from "node:path";

const BASE = "https://spatial.infrastructure.gov.au/server/rest/services/NBN_Coverage_Footprints_2024/MapServer";
const LAYERS = {
  fixedline: { id: 2, maxAllowableOffset: 0.0001, precision: 5 },
  fixedwireless: { id: 3, maxAllowableOffset: 0.002, precision: 4 },
};
const PAGE = 250;
const UA = "Mozilla/5.0 (shorted-housing +https://shorted.com.au)";
const OUT = process.argv[2] || path.join(import.meta.dirname, ".staging");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const json = await res.json();
        if (!json.error) return json;
      }
    } catch { /* retry */ }
    await sleep(3000);
  }
  // A page that never arrived used to read as an empty last page, silently
  // truncating the layer — and every suburb past the cut became a "miss".
  throw new Error(`NBN footprint request failed after 3 attempts: ${url}`);
}

async function fetchLayer({ id, maxAllowableOffset, precision }) {
  const { count } = await getJSON(`${BASE}/${id}/query?where=1%3D1&returnCountOnly=true&f=json`);
  const features = [];
  for (let offset = 0; offset < count; offset += PAGE) {
    const url = `${BASE}/${id}/query?where=1%3D1&outFields=polygon_id&returnGeometry=true`
      + `&maxAllowableOffset=${maxAllowableOffset}&geometryPrecision=${precision}&outSR=4326`
      + `&resultOffset=${offset}&resultRecordCount=${PAGE}&f=geojson`;
    const json = await getJSON(url);
    features.push(...(json.features || []).filter((f) => f.geometry));
    process.stdout.write(`\r  layer ${id}: ${features.length}/${count} …`);
    await sleep(400);
  }
  if (features.length < count) {
    throw new Error(`layer ${id}: got ${features.length} of ${count} features with geometry`);
  }
  return features;
}

for (const [name, layer] of Object.entries(LAYERS)) {
  const dest = path.join(OUT, `nbn-${name}.geojson`);
  if (fs.existsSync(dest) && JSON.parse(fs.readFileSync(dest, "utf8")).features?.length > 0) {
    console.log(`${name}: already staged — skip`); continue;
  }
  const feats = await fetchLayer(layer);
  fs.writeFileSync(dest, JSON.stringify({ type: "FeatureCollection", features: feats }));
  console.log(`\n${name}: ${feats.length} polygons`);
}
console.log("done — NBN footprints in", OUT);
