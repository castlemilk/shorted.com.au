/**
 * The harmonised zoning families (program decision 8) and their map palette.
 * Serializable on purpose: server components (the profile card) and client
 * components (the map, the legend) look colours up by key, never by passing a
 * function across the RSC boundary.
 *
 * The order is the Go store's `ZoneFamilies` order: the server's categorical
 * `dominant_zone_family` column is an index into it, and
 * zone-families.test.ts pins the two together.
 *
 * Colours follow planning-map convention so the map reads without a legend for
 * anyone who has seen a zoning map: residential in warm yellows/oranges,
 * centres red, industry purple, rural pale green, conservation deep green,
 * open space mid green, infrastructure grey, water blue.
 */
export const ZONE_FAMILIES = [
  "res_low",
  "res_medium_high",
  "centre_mixed",
  "industrial",
  "rural",
  "conservation",
  "open_space",
  "infrastructure",
  "water",
  "other",
] as const;

export type ZoneFamily = (typeof ZONE_FAMILIES)[number];

export const ZONE_FAMILY_LABELS: Record<ZoneFamily, string> = {
  res_low: "Low-density residential",
  res_medium_high: "General / medium / high-density residential",
  centre_mixed: "Centres & mixed use",
  industrial: "Industrial & employment",
  rural: "Rural",
  conservation: "Conservation",
  open_space: "Open space & recreation",
  infrastructure: "Infrastructure & special purpose",
  water: "Waterways",
  other: "Growth area, deferred or unzoned",
};

/** Short labels for tight spaces (stacked-bar captions, tooltips). */
export const ZONE_FAMILY_SHORT: Record<ZoneFamily, string> = {
  res_low: "Low-density res.",
  res_medium_high: "Medium/high res.",
  centre_mixed: "Centres & mixed",
  industrial: "Industrial",
  rural: "Rural",
  conservation: "Conservation",
  open_space: "Open space",
  infrastructure: "Infrastructure",
  water: "Waterways",
  other: "Growth/deferred",
};

export const ZONE_FAMILY_COLORS: Record<ZoneFamily, string> = {
  res_low: "#f2d16b",
  res_medium_high: "#e8903a",
  centre_mixed: "#d2453a",
  industrial: "#8e6bb8",
  rural: "#cfdca0",
  conservation: "#3f7f4a",
  open_space: "#7cbf6a",
  infrastructure: "#9a9a9a",
  water: "#5b9bd5",
  other: "#d9cfc1",
};

export function isZoneFamily(value: string): value is ZoneFamily {
  return (ZONE_FAMILIES as readonly string[]).includes(value);
}

/** Label → family (the server's categorical column carries labels). */
const FAMILY_BY_LABEL = new Map<string, ZoneFamily>(
  ZONE_FAMILIES.map((f) => [ZONE_FAMILY_LABELS[f], f]),
);

export function zoneFamilyColorForLabel(label: string): string {
  const family = FAMILY_BY_LABEL.get(label);
  return family ? ZONE_FAMILY_COLORS[family] : "#cccccc";
}
