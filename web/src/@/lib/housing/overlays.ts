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
 *
 * Planning layers (zoning, heritage) share this registry: zoning is the one
 * CATEGORICAL overlay (one dissolved feature per zoning family, filled per
 * class), heritage is binary. Both live under /geo/planning/.
 */

import { ZONE_FAMILIES, ZONE_FAMILY_COLORS, ZONE_FAMILY_LABELS } from "./zone-families";

export type OverlayKey = "flood_planning" | "water_observed" | "bushfire_prone" | "zoning" | "heritage";

/** One class of a categorical overlay (a feature's `classProperty` value). */
export type OverlayClass = { value: string; label: string; color: string };

export type OverlayDef = {
  key: OverlayKey;
  label: string;
  /** Legend/tooltip row label for the matching per-suburb share. */
  shareLabel: string;
  /** Server metric key whose column carries the per-suburb area share. */
  metricKey:
    | "flood_planning_share_pct" | "water_observed_share_pct" | "bushfire_prone_share_pct"
    | "heritage_share_pct" | "dominant_zone_family";
  /** Fill colour (rendered at OVERLAY_FILL_OPACITY, stroked at full). For a
   * categorical layer it is the swatch shown in the picker; features are
   * filled per class. */
  color: string;
  /** Binary (the default): one colour for every feature. Categorical: each
   * feature is filled by the class named in `properties[classProperty]`. */
  kind?: "binary" | "categorical";
  classes?: readonly OverlayClass[];
  classProperty?: string;
  /** Directory under /geo the per-state assets live in (default "hazards"). */
  assetDir?: "hazards" | "planning";
  /** States with a committed overlay asset. */
  states: readonly string[];
  source: string;
  /** One sentence that must travel with the layer wherever it is shown. */
  caveat: string;
  /** Extra caveat for one state's source, appended only on that state's surfaces. */
  stateNotes?: Record<string, string>;
  /** Why a state has no asset, when the generic "no open layer yet" misleads. */
  unavailableNotes?: Record<string, string>;
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
  /**
   * States whose shares are read through a per-suburb coverage mask. A suburb
   * at least half covered publishes its mapped land over the WHOLE suburb, so
   * the share is a floor there and the card says so.
   */
  masked?: readonly string[];
};

export const ALL_STATES_WITH_WATER = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"] as const;

/** States with an open statewide zoning source (WA is licence-blocked, QLD has
 * no statewide scheme, NT has no open layer). */
export const PLANNING_ZONING_STATES = ["NSW", "VIC", "SA", "TAS", "ACT"] as const;
/** States with an open heritage AREA layer (QLD's register is places only). */
export const PLANNING_HERITAGE_STATES = ["NSW", "VIC", "SA", "TAS", "ACT"] as const;

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
      SA: "Covers the Code's Hazards (Flooding) and (Flooding – General) overlays. Land under its precautionary Evidence Required overlay has not been assessed; a suburb mostly under it is shown as no statutory layer.",
      TAS: "Only councils whose Local Provisions Schedule maps flood-prone areas are covered.",
    },
    stateCaveats: {
      ACT: "The ACT has no open flood planning overlay; this is the ACT Government's modelled 1% AEP flood extent, a model of one flood event rather than a planning control. Land outside the modelled urban catchments is shown as no statutory layer.",
    },
    uncovered: {
      NSW: "No flood map lodged in the NSW planning instruments for most of this suburb; most councils keep theirs in a development control plan.",
      SA: "Not yet assessed: the Code applies its precautionary Evidence Required overlay to most of this suburb.",
      TAS: "Most of this suburb lies in a council whose planning scheme maps no flood-prone areas, or that is still on an interim scheme (Kingborough).",
      ACT: "Outside the ACT's modelled flood catchments.",
    },
    masked: ["NSW", "SA", "TAS", "ACT"],
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
      SA: "Not yet assessed: the Code applies its precautionary Regional or Outback bushfire overlay to most of this suburb.",
      TAS: "Kingborough is still on an interim planning scheme, which this layer does not include.",
    },
    masked: ["SA", "TAS"],
    caveat: "Designated for development control; a designation, not a prediction of fire behaviour.",
  },
  {
    key: "zoning",
    label: "Planning zones",
    shareLabel: "Mostly zoned",
    metricKey: "dominant_zone_family",
    color: ZONE_FAMILY_COLORS.res_low,
    kind: "categorical",
    classProperty: "family",
    classes: ZONE_FAMILIES.map((f) => ({ value: f, label: ZONE_FAMILY_LABELS[f], color: ZONE_FAMILY_COLORS[f] })),
    assetDir: "planning",
    states: PLANNING_ZONING_STATES,
    source: "State planning schemes: NSW EPI Land Zoning; Vicmap Planning zones; SA Planning and Design Code; Tasmanian Planning Scheme; ACT Territory Plan",
    caveat: "Statutory zones grouped into ten families across states, simplified for the state map — check the council's planning scheme for any one lot.",
    stateNotes: {
      TAS: "Kingborough is still on its 2015 interim scheme; its zones are mapped to the same families.",
      VIC: "Urban Growth, Comprehensive Development and Priority Development zones take their uses from a later plan, so they are drawn as growth/other.",
    },
    unavailableNotes: {
      QLD: "Queensland has no statewide zoning — each of its 77 councils publishes its own scheme.",
      WA: "WA's zoning layers are licensed for internal use only, so they cannot be shown.",
      NT: "The NT Planning Scheme has no open zoning layer.",
    },
  },
  {
    key: "heritage",
    label: "Heritage areas",
    shareLabel: "In a heritage area",
    metricKey: "heritage_share_pct",
    color: "#8c5a3c",
    assetDir: "planning",
    states: PLANNING_HERITAGE_STATES,
    source: "NSW EPI Heritage conservation areas; Vicmap Heritage Overlay; SA Code Historic/Character Areas; TAS Local Historic Heritage Code precincts; ACT Heritage Register",
    caveat: "Heritage conservation areas, Heritage Overlays and historic or character areas — places where demolition and alterations need heritage consent. Individually listed items are counted on the suburb page, not drawn.",
    unavailableNotes: {
      QLD: "The Queensland Heritage Register lists places, not areas — see the item count on each suburb page.",
      WA: "WA's heritage layers are licensed for internal use only, so they cannot be shown.",
      NT: "No open NT heritage area layer.",
    },
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

/**
 * The layers whose data is on the map right now and so must be credited under
 * it: every active overlay this state has, plus the layer behind the "Colour
 * by" metric (a zoning or heritage share is derived from the same CC BY
 * source as the overlay). Registry order, no duplicates. The static sources
 * line under the map names OSM/ABS/ACARA and none of these.
 */
export function creditedOverlays(
  stateCode: string,
  active: readonly OverlayKey[],
  metricKey?: string,
): OverlayDef[] {
  const fromMetric = (o: OverlayDef) =>
    metricKey !== undefined &&
    (o.metricKey === metricKey || (o.key === "zoning" && /^zone_[a-z_]+_share_pct$/.test(metricKey)));
  return OVERLAYS.filter(
    (o) => overlayAvailable(o.key, stateCode) && (active.includes(o.key) || fromMetric(o)),
  );
}

/** The caveat that travels with a layer on one state's surfaces. */
export function overlayCaveat(key: OverlayKey, stateCode: string): string {
  const o = OVERLAY_BY_KEY[key];
  return `${o.stateCaveats?.[stateCode] ?? o.caveat} ${o.stateNotes?.[stateCode] ?? ""}`.trim();
}

export function overlayAssetUrl(stateCode: string, key: OverlayKey): string {
  return `/geo/${OVERLAY_BY_KEY[key].assetDir ?? "hazards"}/${stateCode}-${key}.topojson`;
}

/** The class a categorical overlay feature belongs to, or undefined. */
export function overlayClassFor(key: OverlayKey, value: unknown): OverlayClass | undefined {
  const def = OVERLAY_BY_KEY[key];
  if (def.kind !== "categorical" || typeof value !== "string") return undefined;
  return def.classes?.find((c) => c.value === value);
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
