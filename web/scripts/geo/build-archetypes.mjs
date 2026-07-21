// Build the committed suburb -> archetype map by running the deterministic
// classifier over every suburb's amenity signals. Loaded later by the collector
// (-mode banners). No npm deps (node:fs only).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyArchetype } from "./classify-archetype.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INS = join(HERE, "..", "..", "public", "geo", "insights");
const amen = JSON.parse(readFileSync(join(INS, "suburb-amenities.json"), "utf8")); // { salCode: {...} }

// Informational: the classifier hardcodes PARKS_TOP_DECILE=20; log the actual p90
// so we can sanity-check that constant against the data.
const parksVals = Object.values(amen).map((a) => Number(a.parksCount ?? 0)).sort((x, y) => x - y);
const p90 = parksVals[Math.floor(parksVals.length * 0.9)] ?? 0;

const out = {};
for (const [sal, a] of Object.entries(amen)) {
  out[sal] = classifyArchetype({
    distToCoastKm: a.distToCoastKm,
    amenityDensityScore: a.amenityDensityScore,
    parksCount: a.parksCount,
  });
}
writeFileSync(join(INS, "suburb-archetypes.json"), JSON.stringify(out));
const counts = {};
for (const v of Object.values(out)) counts[v] = (counts[v] || 0) + 1;
console.error(`archetypes for ${Object.keys(out).length} suburbs (parks p90=${p90}, classifier constant=20):`, counts);
