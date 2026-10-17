import type { SuburbPlanning } from "~/gen/shorts/v1alpha1/housing_pb";

/**
 * Attribution for the planning layer, keyed by SuburbPlanning zoning_source /
 * heritage_source ids (plus NSW_STANDARDS_SOURCE_ID for the three NSW
 * development-standard maps, which have no source field of their own). Each
 * string is the licence obligation of the dataset it names; an id absent here
 * credits nothing rather than something wrong. NSW licences are "CC BY" with no
 * version because that is how data.nsw publishes them (license_id 'cc-by').
 * Serializable (plain strings), so server and client components share it.
 */
export const PLANNING_SOURCE_CREDITS: Record<string, { short: string; credit: string; licence: string }> = {
  nsw_epi_land_zoning: {
    short: "NSW EPI Land Zoning",
    credit: "NSW Environmental Planning Instrument — Land Zoning, NSW Department of Planning",
    licence: "CC BY",
  },
  vic_plan_zone: {
    short: "Vicmap Planning zones",
    credit: "Vicmap Planning — Planning Scheme Zones, Department of Transport and Planning Victoria",
    licence: "CC BY 4.0",
  },
  sa_pd_code_zones: {
    short: "SA Planning and Design Code zones",
    credit: "Planning and Design Code Zones, Government of South Australia (PlanSA)",
    licence: "CC BY 3.0 AU",
  },
  tas_tps_zones: {
    short: "Tasmanian Planning Scheme zones",
    credit: "Tasmanian Planning Scheme Zones, theLIST © State of Tasmania",
    licence: "CC BY 3.0 AU",
  },
  tas_kingborough_ips_2015: {
    short: "Kingborough Interim Planning Scheme zones",
    credit: "Kingborough Interim Planning Scheme 2015 Zones, theLIST © State of Tasmania",
    licence: "CC BY 3.0 AU",
  },
  act_territory_plan_zones: {
    short: "ACT Territory Plan zones",
    credit: "Territory Plan Land Use Zones, ACT Government (ACTmapi)",
    licence: "CC BY 4.0",
  },
  nsw_epi_heritage: {
    short: "NSW EPI Heritage",
    credit: "NSW Environmental Planning Instrument — Heritage, NSW Department of Planning",
    licence: "CC BY",
  },
  nsw_epi_development_standards: {
    short: "NSW EPI Height of Buildings, Floor Space Ratio and Lot Size",
    credit:
      "NSW Environmental Planning Instrument — Height of Buildings, Floor Space Ratio and Minimum Lot Size, NSW Department of Planning",
    licence: "CC BY",
  },
  vic_plan_overlay_ho: {
    short: "Vicmap Heritage Overlay",
    credit: "Vicmap Planning — Heritage Overlay, Department of Transport and Planning Victoria",
    licence: "CC BY 4.0",
  },
  sa_pd_code_heritage_overlays: {
    short: "SA Code heritage & character overlays",
    credit: "Planning and Design Code Overlays (heritage and character), Government of South Australia (PlanSA)",
    licence: "CC BY 3.0 AU",
  },
  tas_tps_local_historic_heritage_code: {
    short: "TAS Local Historic Heritage Code",
    credit: "Tasmanian Planning Scheme Code Overlay — Local Historic Heritage, theLIST © State of Tasmania",
    licence: "CC BY 3.0 AU",
  },
  act_heritage_register: {
    short: "ACT Heritage Register",
    credit: "ACT Heritage Register (registered places), ACT Government (ACTmapi)",
    licence: "CC BY 4.0",
  },
  qld_heritage_register: {
    short: "Queensland Heritage Register",
    credit: "Queensland Heritage Register boundaries, Queensland Government",
    licence: "CC BY 4.0",
  },
};

/** Split a stored source id ('a+b' when a suburb spans two schemes). */
export function planningSourceIds(raw: string | undefined): string[] {
  return (raw ?? "").split("+").map((s) => s.trim()).filter(Boolean);
}

/** Credit id for the NSW Height of Buildings / FSR / Lot Size maps. */
export const NSW_STANDARDS_SOURCE_ID = "nsw_epi_development_standards";

/**
 * What a listed-heritage count counts, per source. The lists are not alike —
 * Queensland's register holds State-listed places only, the others are local
 * planning-scheme listings — so the tile says which list it is.
 */
export const HERITAGE_ITEM_NOTES: Record<string, string> = {
  nsw_epi_heritage: "items in the LEP heritage schedule",
  sa_pd_code_heritage_overlays: "local & State places in the Code",
  tas_tps_local_historic_heritage_code: "local places in the planning scheme",
  act_heritage_register: "on the ACT Heritage Register",
  qld_heritage_register: "State-listed only (Qld Heritage Register)",
};

export type PlanningControlKey = "height" | "fsr" | "lot";

/** The three NSW standards, each with its value and the share of residential land it is mapped on. */
export function planningControls(planning: SuburbPlanning) {
  return [
    { key: "height" as const, label: "maximum building height", value: planning.nswHeightMedianM, mappedPct: planning.nswHeightMappedPct },
    { key: "fsr" as const, label: "floor space ratio", value: planning.nswFsrMedian, mappedPct: planning.nswFsrMappedPct },
    { key: "lot" as const, label: "minimum lot size", value: planning.nswMinLotMedianM2, mappedPct: planning.nswMinLotMappedPct },
  ];
}

/**
 * What the planning card shows, derived once so the card and the page's
 * sources line can never disagree about what was rendered (and so credited).
 */
export function planningView(planning: SuburbPlanning | undefined) {
  if (!planning) return undefined;
  const hasZoning = (planning.zoneShares ?? []).some((z) => z.sharePct > 0);
  const coverage = planning.zoningCoveragePct;
  // The scheme layers reach part of the suburb but too little to measure it
  // (the build stores only the coverage below 50%): the card says so.
  const partialOnly = !hasZoning && coverage !== undefined && coverage > 0;
  const hasHeritage = planning.heritageSharePct !== undefined || planning.heritageItemCount !== undefined;
  const controls = planningControls(planning);
  const hasControls = controls.some((c) => c.value !== undefined);
  // A standard whose mapped share was measured but which is too patchy to report.
  const withheldControls = controls.filter((c) => c.value === undefined && c.mappedPct !== undefined);
  return { hasZoning, partialOnly, hasHeritage, hasControls, withheldControls, controls };
}

/** The planning source ids the planning card actually rendered, de-duplicated. */
export function planningCreditIds(planning: SuburbPlanning | undefined): string[] {
  const view = planningView(planning);
  if (!planning || !view) return [];
  const ids: string[] = [];
  if (view.hasZoning || view.partialOnly) ids.push(...planningSourceIds(planning.zoningSource));
  if (view.hasHeritage) ids.push(...planningSourceIds(planning.heritageSource));
  if (view.hasControls || view.withheldControls.length) ids.push(NSW_STANDARDS_SOURCE_ID);
  return [...new Set(ids)];
}
