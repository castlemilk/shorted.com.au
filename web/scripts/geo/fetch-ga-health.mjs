// Fetch Geoscience Australia "National HealthDirect Health Facilities" (CC-BY-4.0)
// — GP (layer 0), Hospital (1), Pharmacy (2) — as points, paginated. Writes
// .staging/ga-{gp,hospital,pharmacy}.json for join-amenities.mjs.
// Usage: node fetch-ga-health.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = "https://services.ga.gov.au/gis/rest/services/National_HealthDirect_Health_Facilities/MapServer";
const LAYERS = { gp: 0, hospital: 1, pharmacy: 2 };
const PAGE = 2000; // service MaxRecordCount
const OUT = path.join(import.meta.dirname, ".staging");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLayer(id) {
  const pts = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${BASE}/${id}/query?where=1%3D1&outFields=ga_class&returnGeometry=true&resultOffset=${offset}&resultRecordCount=${PAGE}&f=geojson`;
    let json = null;
    for (let attempt = 0; attempt < 3 && !json; attempt++) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "shorted-housing/1.0 (+https://shorted.com.au)" } });
        if (res.ok) json = await res.json();
        else await sleep(3000);
      } catch { await sleep(3000); }
    }
    const feats = json?.features || [];
    for (const f of feats) {
      const c = f.geometry?.coordinates;
      if (Array.isArray(c) && c.length >= 2) pts.push({ lon: c[0], lat: c[1] });
    }
    process.stdout.write(`\r  layer ${id}: ${pts.length} …`);
    if (feats.length < PAGE) break; // last page
    await sleep(500);
  }
  return pts;
}

for (const [name, id] of Object.entries(LAYERS)) {
  const dest = path.join(OUT, `ga-${name}.json`);
  if (fs.existsSync(dest) && JSON.parse(fs.readFileSync(dest, "utf8")).length > 0) {
    console.log(`${name}: already staged — skip`); continue;
  }
  const pts = await fetchLayer(id);
  fs.writeFileSync(dest, JSON.stringify(pts));
  console.log(`\n${name}: ${pts.length} points`);
}
console.log("done — GA health points in", OUT);
