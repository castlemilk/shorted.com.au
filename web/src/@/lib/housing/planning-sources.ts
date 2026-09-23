/**
 * Attribution for the planning layer, keyed by SuburbPlanning zoning_source /
 * heritage_source ids. Each string is the licence obligation of the dataset it
 * names; an id absent here credits nothing rather than something wrong.
 * Serializable (plain strings), so server and client components share it.
 */
export const PLANNING_SOURCE_CREDITS: Record<string, { short: string; credit: string; licence: string }> = {
  nsw_epi_land_zoning: {
    short: "NSW EPI Land Zoning",
    credit: "NSW Environmental Planning Instrument — Land Zoning, NSW Department of Planning",
    licence: "CC BY 4.0",
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
    licence: "CC BY 4.0",
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
