/**
 * The map's overlay registry — a second, toggleable visual layer drawn ABOVE
 * the "Colour by" choropleth. Closed and serializable: the state page reads
 * `?overlays=flood_planning,water_observed` straight into this vocabulary and
 * fetches `/geo/hazards/<STATE>-<key>.topojson` for each. Availability is a
 * fact about which sources exist per state, pinned by overlays.test.ts against
 * the committed assets so the control never offers a layer that would 404.
 *
 * Wording is deliberate. The satellite layer is "observed under water" — it is
 * a record of water that was SEEN (Landsat under-observes flood peaks), never a
 * risk model. The statutory layers name the planning instrument, because that
 * is what they are: development-control boundaries, not flood extents.
 */

export type OverlayKey = "flood_planning" | "water_observed" | "bushfire_prone";

export type OverlayDef = {
  key: OverlayKey;
  label: string;
  /** Legend/tooltip row label for the matching per-suburb share. */
  shareLabel: string;
  /** Server metric key whose column carries the per-suburb area share. */
  metricKey: "flood_planning_share_pct" | "water_observed_share_pct" | "bushfire_prone_share_pct";
  /** Fill colour (rendered at OVERLAY_FILL_OPACITY, stroked at full). */
  color: string;
  /** States with a committed overlay asset. */
  states: readonly string[];
  source: string;
  /** One sentence that must travel with the layer wherever it is shown. */
  caveat: string;
  /** Extra caveat for one state's source, appended only on that state's surfaces. */
  stateNotes?: Record<string, string>;
};

export const ALL_STATES_WITH_WATER = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"] as const;

export const OVERLAYS: readonly OverlayDef[] = [
  {
    key: "flood_planning",
    label: "Flood planning area",
    shareLabel: "In flood planning area",
    metricKey: "flood_planning_share_pct",
    color: "#2f6fd6",
    states: ["NSW", "VIC"],
    source: "NSW EPI Flood (NSW Planning Portal); Vicmap Planning LSIO/FO/SBO",
    stateNotes: { NSW: "NSW councils have owned flood-map currency since July 2021, so the state layer may be older than a council's own study." },
    caveat: "A statutory planning-control boundary, not a flood extent, and it can lag the latest flood study.",
  },
  {
    key: "water_observed",
    label: "Observed surface water",
    shareLabel: "Observed under water since 1987",
    metricKey: "water_observed_share_pct",
    color: "#1c9c9c",
    states: ALL_STATES_WITH_WATER,
    source: "DEA Water Observations Statistics (Geoscience Australia)",
    caveat: "Land where Landsat saw water in at least 1% of clear passes since 1987, excluding permanent water. Satellites miss flood peaks, so this is a floor, not a risk estimate.",
  },
  {
    key: "bushfire_prone",
    label: "Bushfire prone land",
    shareLabel: "Bushfire prone land",
    metricKey: "bushfire_prone_share_pct",
    color: "#d9642b",
    states: ["NSW", "VIC"],
    source: "NSW Bush Fire Prone Land (NSW RFS); Vicmap Planning BMO",
    caveat: "Designated for development control; a designation, not a prediction of fire behaviour.",
  },
];

export const OVERLAY_BY_KEY: Record<OverlayKey, OverlayDef> =
  Object.fromEntries(OVERLAYS.map((o) => [o.key, o])) as Record<OverlayKey, OverlayDef>;

export const OVERLAY_FILL_OPACITY = 0.38;

export function isOverlayKey(value: string): value is OverlayKey {
  return value in OVERLAY_BY_KEY;
}

export function overlayAvailable(key: OverlayKey, stateCode: string): boolean {
  return OVERLAY_BY_KEY[key].states.includes(stateCode);
}

export function overlayAssetUrl(stateCode: string, key: OverlayKey): string {
  return `/geo/hazards/${stateCode}-${key}.topojson`;
}

/** `?overlays=a,b` → the valid, deduplicated keys in registry order. */
export function parseOverlayParam(raw: string | null | undefined): OverlayKey[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(isOverlayKey));
  return OVERLAYS.map((o) => o.key).filter((k) => wanted.has(k));
}

export function serializeOverlayParam(keys: readonly OverlayKey[]): string {
  return OVERLAYS.map((o) => o.key).filter((k) => keys.includes(k)).join(",");
}
