// Fetch per-state CC-BY school-location data (with sector) for the suburb
// school-sector split. Only jurisdictions that publish a COMPLETE, geocoded,
// commercial-use-OK (CC-BY) all-sector list are ingested — currently VIC + QLD
// (full Government/Catholic/Independent split). NSW/SA are government-only, WA/ACT
// don't split non-government, TAS's licence is unconfirmed and NT lacks coords, so
// they're excluded (the suburb sector card is scoped to covered states, like the
// price tracker's SA/VIC scope). Raw points → .staging/ (gitignored); the join
// publishes only per-suburb derived counts.
//
// Sources (both CC-BY-4.0):
//   VIC — School Locations 2025, Dept of Education (data.vic / education.vic.gov.au)
//   QLD — State and non-state school details, Dept of Education (data.qld.gov.au)
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(import.meta.dirname, ".staging");
fs.mkdirSync(OUT, { recursive: true });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const VIC_URL = "https://www.education.vic.gov.au/Documents/about/research/datavic/dv402-SchoolLocations2025.csv";
const QLD_URL = "https://www.data.qld.gov.au/datastore/dump/5b39065c-df32-415c-994c-5ff12f8de997";

// Minimal RFC-4180-ish parser: handles quoted fields with embedded commas/quotes.
function parseCSV(text) {
  const rows = [];
  let field = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// "Prep Year"/"Early Childhood"/"Kindergarten" → 0; "Year N" → N.
function yearNum(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("prep") || t.includes("early") || t.includes("kinder") || t.includes("foundation")) return 0;
  const m = t.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const out = [];

// --- VIC: Education_Sector (Government/Catholic/Independent), School_Type, X/Y ---
{
  const rows = parseCSV((await get(VIC_URL)).replace(/^﻿/, ""));
  const h = rows[0].map((x) => x.trim());
  const iSec = h.indexOf("Education_Sector"), iType = h.indexOf("School_Type"), iX = h.indexOf("X"), iY = h.indexOf("Y");
  let n = 0;
  for (const r of rows.slice(1)) {
    if (r.length < h.length) continue;
    const lon = parseFloat(r[iX]), lat = parseFloat(r[iY]);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const secRaw = (r[iSec] || "").trim();
    const sector = secRaw === "Government" ? "gov" : secRaw === "Catholic" ? "catholic" : secRaw === "Independent" ? "independent" : null;
    if (!sector) continue;
    const t = (r[iType] || "").trim().toLowerCase();
    const offersPrimary = t === "primary" || t.startsWith("pri");
    const offersSecondary = t === "secondary" || t.includes("sec");
    out.push({ lon, lat, sector, p: offersPrimary ? 1 : 0, s: offersSecondary ? 1 : 0 });
    n++;
  }
  console.log(`VIC: ${n} schools`);
}

// --- QLD: Sector (State/Non-State) + Non-State Sector, year levels, Lat/Long ---
{
  const rows = parseCSV(await get(QLD_URL));
  const h = rows[0].map((x) => x.trim());
  const iSec = h.indexOf("Sector"), iNS = h.indexOf("Non-State Sector");
  const iLo = h.indexOf("Official Low Year Level"), iHi = h.indexOf("Official High Year Level");
  const iLat = h.indexOf("Latitude"), iLon = h.indexOf("Longitude");
  let n = 0;
  for (const r of rows.slice(1)) {
    if (r.length < h.length) continue;
    const lon = parseFloat(r[iLon]), lat = parseFloat(r[iLat]);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    let sector;
    if ((r[iSec] || "").trim() === "State") sector = "gov";
    else sector = (r[iNS] || "").trim() === "Catholic" ? "catholic" : "independent"; // Non-State → catholic/independent
    const lo = yearNum(r[iLo]), hi = yearNum(r[iHi]);
    const offersPrimary = lo != null && lo <= 6;
    const offersSecondary = hi != null && hi >= 7;
    out.push({ lon, lat, sector, p: offersPrimary ? 1 : 0, s: offersSecondary ? 1 : 0 });
    n++;
  }
  console.log(`QLD: ${n} schools`);
}

const dest = path.join(OUT, "schools-sector.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${dest}: ${out.length} schools (VIC+QLD, gov/catholic/independent)`);
