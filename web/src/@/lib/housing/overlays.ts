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
  /**
   * Replaces `caveat` for one state whose source is a different KIND of thing —
   * ACT's only open flood layer is a modelled extent, and the generic caveat
   * ("not a flood extent") would be false there.
   */
  stateCaveats?: Record<string, string>;
  /**
   * Why a suburb in a state that HAS the layer is still null: the source's
   * instruments do not cover it. Shown instead of a share, never as 0%.
   */
  uncovered?: Record<string, string>;
};

export const ALL_STATES_WITH_WATER = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"] as const;

export const OVERLAYS: readonly OverlayDef[] = [
  {
    key: "flood_planning",
    label: "Flood planning area",
    shareLabel: "In flood planning area",
    metricKey: "flood_planning_share_pct",
    color: "#2f6fd6",
    states: ["NSW", "VIC", "SA", "TAS", "ACT"],
    source: "NSW EPI Flood (NSW Planning Portal); Vicmap Planning LSIO/FO/SBO; SA Planning and Design Code Hazards (Flooding); Tasmanian Planning Scheme Flood-prone Areas; ACT 1% AEP flood extent model",
    stateNotes: {
      NSW: "Only the councils that lodged a flood map in their planning instrument are covered; everywhere else is shown as no statutory layer, not as 0%. NSW councils have owned flood-map currency since July 2021, so the state layer may be older than a council's own study.",
      SA: "Covers the Code's Hazards (Flooding) and (Flooding – General) overlays. Land under its precautionary Evidence Required overlay has not been assessed and is shown as no statutory layer.",
      TAS: "Only councils whose Local Provisions Schedule maps flood-prone areas are covered.",
    },
    stateCaveats: {
      ACT: "The ACT has no open flood planning overlay; this is the ACT Government's modelled 1% AEP flood extent, a model of one flood event rather than a planning control. Land outside the modelled urban catchments is shown as no statutory layer.",
    },
    uncovered: {
      NSW: "No flood map lodged in the NSW planning instruments here; most councils keep theirs in a development control plan.",
      SA: "Not yet assessed: the Code applies its precautionary Evidence Required overlay here.",
      TAS: "This council's Local Provisions Schedule maps no flood-prone areas.",
      ACT: "Outside the ACT's modelled flood catchments.",
    },
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
    caveat: "Land where Landsat saw water in at least 1% of clear passes since 1987, excluding permanent water and filtered by DEA's confidence layer. Satellites miss flood peaks, so this is a floor, not a risk estimate; dense high-rise cores can still register tower shadow as water.",
  },
  {
    key: "bushfire_prone",
    label: "Bushfire prone land",
    shareLabel: "Bushfire prone land",
    metricKey: "bushfire_prone_share_pct",
    color: "#d9642b",
    states: ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT"],
    source: "NSW Bush Fire Prone Land (NSW RFS); VIC Designated Bushfire Prone Area; QLD Bushfire Prone Area (QFD); SA Planning and Design Code Hazards (Bushfire); WA Bush Fire Prone Areas (OBRM-026); Tasmanian Planning Scheme Bushfire-prone Areas; ACT Bushfire Prone Area 2026",
    stateNotes: {
      VIC: "The Building Regulations' Designated Bushfire Prone Area, the like-for-like of NSW Bush Fire Prone Land; the narrower Bushfire Management Overlay is a separate planning control.",
      QLD: "Includes the potential-impact buffer around bushfire prone vegetation. Mapping vintages differ by region (South East Queensland 2017, elsewhere 2014).",
      SA: "Covers the Code's High, Medium, General and Urban Interface bushfire overlays. Land under its precautionary Regional and Outback overlays has not been assessed and is shown as no statutory layer.",
      TAS: "Kingborough is still on an interim planning scheme and is shown as no statutory layer.",
    },
    uncovered: {
      SA: "Not yet assessed: the Code applies its precautionary Regional or Outback bushfire overlay here.",
      TAS: "Kingborough is still on an interim planning scheme, which this layer does not include.",
    },
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

/** The caveat that travels with a layer on one state's surfaces. */
export function overlayCaveat(key: OverlayKey, stateCode: string): string {
  const o = OVERLAY_BY_KEY[key];
  return `${o.stateCaveats?.[stateCode] ?? o.caveat} ${o.stateNotes?.[stateCode] ?? ""}`.trim();
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
