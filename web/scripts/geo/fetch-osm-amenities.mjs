// Lean OSM amenity pull for the Local Insights suburb enrichment. Fetches only
// the POI categories we surface (a few MB total) via scoped Overpass queries —
// NOT the 1GB Geofabrik PBF. Raw points land in .staging/ (gitignored, ODbL:
// we only ever publish derived per-suburb counts, never raw geometry).
//
// Robust: idempotent (skips categories already staged), falls back across
// Overpass mirrors, and splits heavy categories per-state when a whole-AU query
// times out (504). Usage: node fetch-osm-amenities.mjs  [ONLY=pub_bar,park]
import fs from "node:fs";
import path from "node:path";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const AU = "-44,112,-9,154"; // S,W,N,E
const STATE_BBOX = {
  NSW: "-37.6,140.9,-28.1,153.7", VIC: "-39.2,140.9,-33.9,150.1",
  QLD: "-29.2,137.9,-9.0,153.6", SA: "-38.1,129.0,-25.9,141.1",
  WA: "-35.2,112.9,-13.6,129.1", TAS: "-43.7,143.8,-39.4,148.5",
  NT: "-26.1,128.9,-10.9,138.1", ACT: "-35.95,148.7,-35.1,149.4",
};
const OUT = path.join(import.meta.dirname, ".staging");
fs.mkdirSync(OUT, { recursive: true });

// tag filter WITHOUT the bbox — we append it.
const CATS = {
  supermarket: `nwr["shop"="supermarket"]`,
  pub_bar: `nwr["amenity"~"^(pub|bar)$"]`,
  school: `nwr["amenity"="school"]`,
  library: `nwr["amenity"="library"]`,
  park: `nwr["leisure"="park"]`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQuery(ql) {
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: "POST", body: "data=" + encodeURIComponent(ql),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "shorted-housing/1.0 (+https://shorted.com.au)" },
      });
      if (!res.ok) { await sleep(3000); continue; }
      return await res.json();
    } catch { await sleep(3000); }
  }
  return null;
}
function extract(json, into) {
  for (const el of json.elements || []) {
    const lon = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    if (lon == null || lat == null) continue;
    const t = el.tags || {};
    into.push({ lon, lat, brand: t.brand || t["brand:wikidata"] || "", name: t.name || "" });
  }
}

const only = (process.env.ONLY || "").split(",").filter(Boolean);
for (const [cat, filter] of Object.entries(CATS)) {
  if (only.length && !only.includes(cat)) continue;
  const dest = path.join(OUT, `osm-${cat}.json`);
  if (fs.existsSync(dest) && JSON.parse(fs.readFileSync(dest, "utf8")).length > 0) {
    console.log(`${cat}: already staged (${JSON.parse(fs.readFileSync(dest, "utf8")).length}) — skip`);
    continue;
  }
  process.stdout.write(`fetching ${cat} (whole-AU) … `);
  let json = await runQuery(`[out:json][timeout:240];(${filter}(${AU}););out center tags;`);
  const pts = [];
  if (json) { extract(json, pts); console.log(`${pts.length} points`); }
  else {
    console.log("whole-AU failed; splitting per-state …");
    const seen = new Set();
    for (const [st, bbox] of Object.entries(STATE_BBOX)) {
      process.stdout.write(`  ${st} … `);
      const j = await runQuery(`[out:json][timeout:180];(${filter}(${bbox}););out center tags;`);
      const tmp = [];
      if (j) extract(j, tmp);
      let added = 0;
      for (const p of tmp) {
        const k = `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
        if (seen.has(k)) continue;
        seen.add(k); pts.push(p); added++;
      }
      console.log(`${added} new`);
      await sleep(3000);
    }
  }
  if (pts.length) fs.writeFileSync(dest, JSON.stringify(pts));
  console.log(`${cat}: ${pts.length} total`);
  await sleep(3000);
}
console.log("done — raw points in", OUT);
