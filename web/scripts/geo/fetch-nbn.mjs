// Fetch NBN Coverage Footprints 2024 (CC-BY, DITRDCA) — Fixed Line (layer 2) +
// Fixed Wireless (layer 3) polygons, simplified, for the centroid→tech join.
// Writes .staging/nbn-fixedline.geojson + nbn-fixedwireless.geojson.
// Usage: node fetch-nbn.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = "https://spatial.infrastructure.gov.au/server/rest/services/NBN_Coverage_Footprints_2024/MapServer";
const LAYERS = { fixedline: 2, fixedwireless: 3 };
const PAGE = 250;
const OUT = path.join(import.meta.dirname, ".staging");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLayer(id) {
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${BASE}/${id}/query?where=1%3D1&outFields=&returnGeometry=true`
      + `&maxAllowableOffset=0.002&geometryPrecision=4&outSR=4326`
      + `&resultOffset=${offset}&resultRecordCount=${PAGE}&f=geojson`;
    let json = null;
    for (let a = 0; a < 3 && !json; a++) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (shorted-housing +https://shorted.com.au)" } });
        if (res.ok) json = await res.json(); else await sleep(3000);
      } catch { await sleep(3000); }
    }
    const feats = (json?.features || []).filter((f) => f.geometry);
    features.push(...feats);
    process.stdout.write(`\r  layer ${id}: ${features.length} …`);
    if ((json?.features || []).length < PAGE) break;
    await sleep(400);
  }
  return features;
}

for (const [name, id] of Object.entries(LAYERS)) {
  const dest = path.join(OUT, `nbn-${name}.geojson`);
  if (fs.existsSync(dest) && JSON.parse(fs.readFileSync(dest, "utf8")).features?.length > 0) {
    console.log(`${name}: already staged — skip`); continue;
  }
  const feats = await fetchLayer(id);
  fs.writeFileSync(dest, JSON.stringify({ type: "FeatureCollection", features: feats }));
  console.log(`\n${name}: ${feats.length} polygons`);
}
console.log("done — NBN footprints in", OUT);
