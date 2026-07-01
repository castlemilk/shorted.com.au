// Fetch ABS ASGS Ed.3 LGA_2024 generalized boundaries (CC-BY-4.0) as GeoJSON
// for the suburb→LGA point-in-polygon join. Writes .staging/abs-lga.geojson.
// Usage: node fetch-abs-lga.mjs
import fs from "node:fs";
import path from "node:path";

// Layer 1 = LGA_GEN (generalized geometry — smaller, fine for centroid PiP).
const BASE = "https://geo.abs.gov.au/arcgis/rest/services/ASGS2024/LGA/MapServer/1/query";
const PAGE = 500;
const OUT = path.join(import.meta.dirname, ".staging");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const features = [];
for (let offset = 0; ; offset += PAGE) {
  const url = `${BASE}?where=1%3D1&outFields=lga_code_2024,lga_name_2024,state_name_2021,area_albers_sqkm`
    + `&returnGeometry=true&maxAllowableOffset=0.001&geometryPrecision=5&outSR=4326`
    + `&resultOffset=${offset}&resultRecordCount=${PAGE}&f=geojson`;
  let json = null;
  for (let a = 0; a < 3 && !json; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "shorted-housing/1.0 (+https://shorted.com.au)" } });
      if (res.ok) json = await res.json(); else await sleep(3000);
    } catch { await sleep(3000); }
  }
  const feats = json?.features || [];
  features.push(...feats);
  process.stdout.write(`\r  ${features.length} LGAs …`);
  if (feats.length < PAGE) break;
  await sleep(400);
}
fs.writeFileSync(path.join(OUT, "abs-lga.geojson"), JSON.stringify({ type: "FeatureCollection", features }));
console.log(`\nwrote ${features.length} LGA features to .staging/abs-lga.geojson`);
