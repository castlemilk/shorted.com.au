// Deterministic base archetype from signals shipped by local-insights.
// harbour / river-valley / hills-ranges / farmland are NOT derivable here — they
// come from agy's archetype_hint (LLM knowledge). See the suburb-banners spec §5.
export const ARCHETYPE_BASE = [
  "coastal-beach", "urban-skyline", "inner-terraces", "parkland", "leafy-suburban", "bushland",
];
// parksCount national top-decile threshold (calibrated from data in a later task; default here).
const PARKS_TOP_DECILE = 20;

export function classifyArchetype(s) {
  const o = s ?? {};
  const coast = Number(o.distToCoastKm ?? Infinity);
  const dens = Number(o.amenityDensityScore ?? 0);
  const parks = Number(o.parksCount ?? 0);
  // Coastal identity wins at the water's edge, even for dense beach suburbs
  // (e.g. Bondi Beach, dens ~86) — only exclude genuine CBD cores (dens >= 90,
  // e.g. Sydney CBD at 100) that happen to sit near the harbour.
  if (coast < 2 && dens < 90) return "coastal-beach";
  if (dens >= 80) return "urban-skyline";
  if (dens >= 55) return "inner-terraces";
  if (parks >= PARKS_TOP_DECILE) return "parkland";
  if (dens < 25 && Number.isFinite(coast) && coast > 30) return "bushland";
  return "leafy-suburban";
}
