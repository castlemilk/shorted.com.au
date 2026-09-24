import { scaleLinear, scaleSequential, scaleSequentialSqrt, scaleDiverging, scaleSqrt } from "d3-scale";
import { interpolateBlues, interpolateOranges, interpolateRdBu, interpolateYlOrRd } from "d3-scale-chromatic";
import { fmtPriceShort } from "./price-scale";
import { ZONE_FAMILY_COLORS, ZONE_FAMILY_SHORT, zoneFamilyColorForLabel, type ZoneFamily } from "./zone-families";
import type { HousingIconName } from "@/components/housing/housing-icons.generated";

/**
 * The suburb map's "highlight" toggle. Continuous metrics (price, population,
 * age, income, born-overseas) shade an amber sequential ramp; discrete metrics
 * (religion, language) paint each suburb by its dominant category with a fixed
 * qualitative palette — a gradient would imply an order these categories don't
 * have.
 */

// The fields a metric reads. SuburbDatum is structurally a superset of this, so
// metric accessors take this minimal shape and avoid importing the component.
export type SuburbMetricInput = {
  /** Properties declared in the federal registers of interests (0 for most suburbs). */
  politicianPropertyCount?: number;
  latestMedianPrice: number;
  population: number;
  medianAge: number;
  medianWeeklyHhdIncome: number;
  pctBornOverseas: number;
  topReligion: string; // '' if none
  topLanguage: string; // '' if none (no language other than English)
  pctTopLanguage: number;
  federalPartyAb: string; // '' if none — party holding the federal division
  federalTppAlp: number;  // 0..100 Labor two-party-preferred (0 = unknown)
  statePartyAb: string;   // '' if none/Hare-Clark — party holding the state seat
  // amenity/lifestyle metrics (Local Insights)
  schoolsTotal: number;
  schoolsGov: number; schoolsCatholic: number; schoolsIndependent: number;
  supermarketsTotal: number;
  colesCount: number; woolworthsCount: number; aldiCount: number; igaCount: number;
  pubsBars: number;
  amenityDensityScore: number; // 0..100
  gpCount: number;
  nearestTrainKm: number;
  distToCoastKm: number; // km to the national coastline (0 = beachfront)
  dominantNbnTech: string; // '' | Fixed Line | Fixed Wireless | Satellite
  // crime percentile ranks (0 = no data; > 0 always when covered)
  crimeBreakInsRank: number;
  crimeViolentRank: number;
  crimeMotorVehicleRank: number;
};

export type MetricKey =
  | "price" | "population" | "age" | "income" | "born_overseas" | "religion" | "language"
  | "federal_party" | "federal_lean" | "state_party" | "politician_property"
  | "crime_break_ins" | "crime_violent" | "crime_motor_vehicle"
  | "amenity_density" | "supermarkets" | "pubs" | "grocery" | "healthcare" | "school_sector" | "nearest_train" | "distance_to_coast" | "nbn"
  // Column-sourced metrics are named EXACTLY as the server registry keys
  // (postgres_suburb_columns.go) — the Go test pins the two vocabularies together.
  | "seifa_irsd_decile_state" | "seifa_irsad_decile_state" | "seifa_ier_decile_state" | "seifa_ieo_decile_state"
  | "unemployment_rate" | "pct_bachelor_or_higher" | "pct_low_personal_income" | "pct_high_personal_income"
  | "pct_flat_apartment" | "pct_lone_person_household" | "pct_couple_with_children"
  | "elevation_median_m" | "land_share_below_1m" | "land_share_below_2m" | "land_share_below_5m"
  | "permanent_water_share_pct"
  | "water_observed_share_pct" | "flood_planning_share_pct" | "bushfire_prone_share_pct"
  // Planning layer (suburb_planning, 000125)
  | "zone_res_low_share_pct" | "zone_res_medium_high_share_pct" | "zone_centre_mixed_share_pct"
  | "zone_industrial_share_pct" | "zone_rural_share_pct" | "zone_conservation_share_pct"
  | "zone_open_space_share_pct" | "dominant_zone_family" | "heritage_share_pct" | "nsw_height_median_m";

type Base = { key: MetricKey; label: string; legendLabel: string };

export type ContinuousMetric = Base & {
  kind: "continuous";
  value: (s: SuburbMetricInput) => number | null; // null = no data (hatch)
  format: (v: number) => string;
  sqrt?: boolean; // sqrt ramp for long-tailed metrics (price, population)
  /** fixed [min,max] (e.g. [0,100] for a percentage) instead of the data range. */
  domain?: [number, number];
  /** custom colour scale (e.g. diverging) instead of the amber ramp. */
  makeScale?: (min: number, max: number) => (v: number) => string;
};

export type CategoricalMetric = Base & {
  kind: "categorical";
  category: (s: SuburbMetricInput) => string | null; // null = no data (hatch)
  colorFor: (cat: string) => string;
  /** legend order (only entries that appear in the data are shown). */
  order: string[];
};

/**
 * A continuous metric whose values are NOT on the SuburbDatum row but fetched
 * as a packed column (GetSuburbMetricColumns, ~18 KB per state) keyed by the
 * same string as `key`. This is the scaling path for every new map metric: the
 * row payload stays fixed while the vocabulary grows.
 */
export type ColumnMetric = Base & {
  kind: "column";
  format: (v: number) => string;
  sqrt?: boolean;
  domain?: [number, number];
  makeScale?: (min: number, max: number) => (v: number) => string;
  /** Legend "no data" wording — column metrics have per-state coverage. */
  noDataLabel?: string;
  /** Section label in the picker. */
  group: ColumnMetricGroup;
};

/** Picker sections for column metrics, in display order. */
export const COLUMN_METRIC_GROUPS = [
  { key: "socio-economic", label: "Socio-economic" },
  { key: "households", label: "Households & dwellings" },
  { key: "terrain", label: "Terrain" },
  { key: "hazard", label: "Hazard exposure" },
  { key: "planning", label: "Planning & zoning" },
] as const;
export type ColumnMetricGroup = (typeof COLUMN_METRIC_GROUPS)[number]["key"];

/**
 * A CATEGORICAL metric fetched as a packed column: each present value is an
 * index into the column's server-sent `categoryLabels` dictionary (the label
 * set is the server's, so a new category never needs a web deploy to name
 * it). Colours are looked up by label from a serializable palette.
 */
export type ColumnCategoricalMetric = Base & {
  kind: "column-categorical";
  colorForLabel: (label: string) => string;
  noDataLabel?: string;
  group: "planning";
};

export type HighlightMetric = ContinuousMetric | CategoricalMetric | ColumnMetric | ColumnCategoricalMetric;

/** Column-sourced (packed column fetch) rather than read from the suburb row. */
export function isColumnSourced(m: HighlightMetric): m is ColumnMetric | ColumnCategoricalMetric {
  return m.kind === "column" || m.kind === "column-categorical";
}

const fmtCompact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`;
const fmtPct = (v: number) => `${Math.round(v)}%`;
const fmtMoneyWk = (v: number) => `$${Math.round(v).toLocaleString()}`;
const fmtPct1 = (v: number) => (v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

// --- Categorical palettes (qualitative, deliberately NOT the price amber) ---

// A muted, editorial qualitative set; pure red/green are avoided so categories
// never read as the product's semantic up/down.
const C = {
  slate: "#7c8aa0", indigo: "#5b6bb5", teal: "#4f9d99", plum: "#9b6a9e",
  moss: "#6f9a55", clay: "#c2763d", gold: "#d8a83a", rose: "#c77b9a",
  stone: "#9c8e7f", sky: "#5a93c4", olive: "#8a8a4a", brick: "#b15a4e",
  sand: "#d9d3c7", // neutral base for English-dominant suburbs
};

export const RELIGION_COLORS: Record<string, string> = {
  "No religion": C.slate,
  "Catholic": C.indigo,
  "Anglican": C.sky,
  "Other Christian": C.teal,
  "Islam": C.moss,
  "Hinduism": C.clay,
  "Buddhism": C.gold,
  "Judaism": C.rose,
  "Other": C.stone,
};
const RELIGION_ORDER = [
  "No religion", "Catholic", "Anglican", "Other Christian",
  "Islam", "Hinduism", "Buddhism", "Judaism", "Other",
];

export const LANGUAGE_COLORS: Record<string, string> = {
  "English": C.sand, // neutral base — lets non-English pockets pop
  "Mandarin": C.brick,
  "Cantonese": C.clay,
  "Italian": C.moss,
  "Greek": C.indigo,
  "Vietnamese": C.gold,
  "Arabic": C.plum,
  "Punjabi": C.olive,
  "Hindi": C.teal,
  "Spanish": C.rose,
  "German": C.stone,
  "Filipino": C.sky,
  "Tagalog": C.sky,
  "Other": C.slate,
};
const LANGUAGE_ORDER = [
  "Mandarin", "Cantonese", "Italian", "Greek", "Vietnamese", "Arabic",
  "Punjabi", "Hindi", "Spanish", "German", "Filipino", "Tagalog", "Other", "English",
];

// Below this share, a suburb's "top non-English language" is too thin to be
// meaningful — render it in the neutral English base so genuine community-
// language pockets stand out.
const LANGUAGE_MIN_PCT = 5;

// The collector withholds the whole Census culture block (labels and shares)
// below this population (censusDerivedRateMinPopulation in
// services/house-price-collector/census_expanded.go): at a few dozen perturbed
// residents a plurality is noise. Such a suburb has no language, so it must be
// no data here rather than fall through to the "English" base.
const CENSUS_CULTURE_MIN_POPULATION = 100;

export function religionColor(cat: string): string {
  return RELIGION_COLORS[cat] ?? C.stone;
}
export function languageColor(cat: string): string {
  return LANGUAGE_COLORS[cat] ?? C.slate;
}

// --- Politician-declared property palette (categorical) ---
// "None" takes the neutral base so the ~99% of suburbs with no declaration
// recede, and the few that do have one stand out. Same treatment as the
// language/grocery "no data" case.
const POLITICIAN_PROPERTY_ORDER = ["None", "1", "2", "3+"];
const POLITICIAN_PROPERTY_COLORS: Record<string, string> = {
  None: C.sand,
  "1": "#c9a227",
  "2": "#b5761f",
  "3+": "#8f4a17",
};
function politicianPropertyColor(label: string): string {
  return POLITICIAN_PROPERTY_COLORS[label] ?? C.sand;
}

// --- Federal party palette (categorical) ---
// Moved to @/lib/politics/party-palette so politician surfaces can colour by
// party without importing this module, which pulls in d3-scale for the
// choropleth ramps. Re-exported here so existing consumers are unchanged.
import {
  PARTY_LABEL,
  PARTY_ORDER,
  partyColor,
} from "@/lib/politics/party-palette";

export { PARTY_COLORS, partyColor } from "@/lib/politics/party-palette";

// --- Grocery competition palette (categorical) ---
export const GROCERY_COLORS: Record<string, string> = {
  "Aldi present": C.moss,           // discount competition
  "Coles + Woolworths": C.clay,     // the duopoly
  "IGA / independent": C.indigo,
  "Single major": C.stone,
  "No supermarket": C.sand,         // neutral base
};
const GROCERY_ORDER = ["Aldi present", "Coles + Woolworths", "IGA / independent", "Single major", "No supermarket"];
export function groceryColor(cat: string): string {
  return GROCERY_COLORS[cat] ?? C.stone;
}

// --- School sector palette (categorical; VIC + QLD coverage) ---
export const SCHOOL_SECTOR_COLORS: Record<string, string> = {
  "Government": C.sky,
  "Catholic": C.plum,
  "Independent": C.moss,
};
const SCHOOL_SECTOR_ORDER = ["Government", "Catholic", "Independent"];
export function schoolSectorColor(cat: string): string {
  return SCHOOL_SECTOR_COLORS[cat] ?? C.stone;
}

// --- NBN technology palette (categorical, tech-tier coloured) ---
export const NBN_COLORS: Record<string, string> = {
  "Fixed Line": C.teal,       // best (FTTP/HFC/FTTC/FTTN)
  "Fixed Wireless": C.gold,   // middle
  "Satellite": C.clay,        // remote / lowest
};
const NBN_ORDER = ["Fixed Line", "Fixed Wireless", "Satellite"];
export function nbnColor(cat: string): string {
  return NBN_COLORS[cat] ?? C.stone;
}

/**
 * The NBN technology we are prepared to publish for a suburb, or null.
 *
 * Both coarse tiers have been over-claimed by the footprint join
 * (web/scripts/geo/join-nbn.mjs). It once classed every sample point outside
 * the Fixed Line and Fixed Wireless footprints as Satellite — the source
 * publishes no satellite layer — so 7,491 of 15,329 suburbs, Bondi, Parramatta
 * and Point Cook (66,781 people) among them, read "NBN SATELLITE". And the
 * wireless footprint is a coarse tower grid that reaches over towns: Dubbo,
 * Orange, Pakenham and Sunbury read "Fixed Wireless", and one grid cell over
 * one sample point labelled Rouse Hill (11,349 people). Satellite on more than
 * 1,000 people and Fixed Wireless on more than 5,000 are therefore published
 * as no data. The API applies the same rule (nbnImplausibleTechPredicate in
 * postgres_suburb_columns.go); this copy keeps an ISR page baked from an older
 * response from repeating it.
 */
export const NBN_SATELLITE_MAX_POPULATION = 1_000;
export const NBN_FIXED_WIRELESS_MAX_POPULATION = 5_000;

export function publishableNbnTech(tech: string | undefined, population: number): string | null {
  if (!tech) return null;
  const t = tech.toUpperCase();
  if (t === "SATELLITE" && population > NBN_SATELLITE_MAX_POPULATION) return null;
  if ((t === "FIXED WIRELESS" || t === "FW") && population > NBN_FIXED_WIRELESS_MAX_POPULATION) return null;
  return tech;
}

export const HIGHLIGHT_METRICS: HighlightMetric[] = [
  {
    kind: "continuous", key: "price", label: "Median house price",
    legendLabel: "Median house price",
    value: (s) => (s.latestMedianPrice > 0 ? s.latestMedianPrice : null),
    format: fmtPriceShort, sqrt: true,
  },
  {
    kind: "continuous", key: "population", label: "Population",
    legendLabel: "Population",
    value: (s) => (s.population > 0 ? s.population : null),
    format: fmtCompact, sqrt: true,
  },
  {
    kind: "continuous", key: "age", label: "Median age",
    legendLabel: "Median age (years)",
    value: (s) => (s.medianAge > 0 ? s.medianAge : null),
    format: (v) => `${Math.round(v)}`,
  },
  {
    kind: "continuous", key: "income", label: "Household income",
    legendLabel: "Median weekly household income",
    value: (s) => (s.medianWeeklyHhdIncome > 0 ? s.medianWeeklyHhdIncome : null),
    format: fmtMoneyWk,
  },
  {
    kind: "continuous", key: "born_overseas", label: "Born overseas",
    legendLabel: "Born overseas",
    value: (s) => (s.pctBornOverseas > 0 ? s.pctBornOverseas : null),
    format: fmtPct,
  },
  {
    kind: "categorical", key: "religion", label: "Religion",
    legendLabel: "Dominant religion",
    category: (s) => s.topReligion || null,
    colorFor: religionColor, order: RELIGION_ORDER,
  },
  {
    kind: "categorical", key: "language", label: "Language",
    legendLabel: "Top language at home",
    category: (s) => {
      if (s.population < CENSUS_CULTURE_MIN_POPULATION) return null;
      if (s.topLanguage && s.pctTopLanguage >= LANGUAGE_MIN_PCT) return s.topLanguage;
      return "English";
    },
    colorFor: languageColor, order: LANGUAGE_ORDER,
  },
  {
    // CATEGORICAL, not continuous, and deliberately so: ~99% of suburbs have
    // zero declared properties, so a continuous amber ramp renders "none" and
    // "one" as indistinguishable pale shades. Buckets make the signal legible.
    kind: "categorical", key: "politician_property", label: "Politician-declared property",
    legendLabel: "Properties declared in the federal registers of interests",
    category: (s) => {
      if (s.population <= 0) return null;
      const n = s.politicianPropertyCount ?? 0;
      if (n <= 0) return "None";
      if (n === 1) return "1";
      if (n === 2) return "2";
      return "3+";
    },
    colorFor: politicianPropertyColor,
    order: POLITICIAN_PROPERTY_ORDER,
  },
  {
    kind: "categorical", key: "federal_party", label: "Federal party",
    legendLabel: "Party holding the seat",
    category: (s) => (s.federalPartyAb ? (PARTY_LABEL[s.federalPartyAb] ?? "Other") : null),
    colorFor: partyColor, order: PARTY_ORDER,
  },
  {
    kind: "continuous", key: "federal_lean", label: "Federal lean (2PP)",
    legendLabel: "Labor two-party-preferred",
    value: (s) => (s.federalTppAlp > 0 ? s.federalTppAlp : null),
    format: (v) => `${Math.round(v)}%`,
    domain: [0, 100], makeScale: () => politicalLeanScale(),
  },
  {
    kind: "categorical", key: "state_party", label: "State party",
    legendLabel: "Party holding the state seat",
    category: (s) => (s.statePartyAb ? (PARTY_LABEL[s.statePartyAb] ?? "Other") : null),
    colorFor: partyColor, order: PARTY_ORDER,
  },
  {
    kind: "continuous", key: "crime_break_ins", label: "Break-ins",
    legendLabel: "Break-ins (percentile within state)",
    value: (s) => (s.crimeBreakInsRank > 0 ? s.crimeBreakInsRank : null),
    format: (v) => `${Math.round(v)}th pctile`,
    domain: [0, 100], makeScale: () => crimeRankScale(),
  },
  {
    kind: "continuous", key: "crime_violent", label: "Violent crime",
    legendLabel: "Violent crime (percentile within state)",
    value: (s) => (s.crimeViolentRank > 0 ? s.crimeViolentRank : null),
    format: (v) => `${Math.round(v)}th pctile`,
    domain: [0, 100], makeScale: () => crimeRankScale(),
  },
  {
    kind: "continuous", key: "crime_motor_vehicle", label: "Car theft",
    legendLabel: "Motor-vehicle theft (percentile within state)",
    value: (s) => (s.crimeMotorVehicleRank > 0 ? s.crimeMotorVehicleRank : null),
    format: (v) => `${Math.round(v)}th pctile`,
    domain: [0, 100], makeScale: () => crimeRankScale(),
  },
  {
    kind: "continuous", key: "amenity_density", label: "Amenity density",
    legendLabel: "Amenity density (0–100)",
    value: (s) => (s.population > 0 ? s.amenityDensityScore : null),
    format: (v) => `${Math.round(v)}`, domain: [0, 100],
  },
  {
    kind: "continuous", key: "supermarkets", label: "Supermarkets",
    legendLabel: "Supermarkets in suburb",
    value: (s) => (s.population > 0 ? s.supermarketsTotal : null),
    format: (v) => `${Math.round(v)}`, sqrt: true,
  },
  {
    kind: "continuous", key: "pubs", label: "Pubs & bars",
    legendLabel: "Pubs & bars in suburb",
    value: (s) => (s.population > 0 ? s.pubsBars : null),
    format: (v) => `${Math.round(v)}`, sqrt: true,
  },
  {
    kind: "categorical", key: "grocery", label: "Grocery competition",
    legendLabel: "Supermarket competition",
    category: (s) => {
      if (s.population <= 0) return null;
      if (s.supermarketsTotal <= 0) return "No supermarket";
      if (s.aldiCount > 0) return "Aldi present";
      if (s.colesCount > 0 && s.woolworthsCount > 0) return "Coles + Woolworths";
      if (s.igaCount > 0) return "IGA / independent";
      return "Single major";
    },
    colorFor: groceryColor, order: GROCERY_ORDER,
  },
  {
    kind: "continuous", key: "healthcare", label: "GP access",
    legendLabel: "GP clinics in suburb",
    value: (s) => (s.population > 0 ? s.gpCount : null),
    format: (v) => `${Math.round(v)}`, sqrt: true,
  },
  {
    kind: "categorical", key: "school_sector", label: "School sector",
    legendLabel: "Dominant school sector",
    category: (s) => {
      const g = s.schoolsGov, c = s.schoolsCatholic, i = s.schoolsIndependent;
      if (g + c + i <= 0) return null; // no sector data (uncovered state / no schools)
      if (g >= c && g >= i) return "Government";
      if (c >= i) return "Catholic";
      return "Independent";
    },
    colorFor: schoolSectorColor, order: SCHOOL_SECTOR_ORDER,
  },
  {
    kind: "continuous", key: "nearest_train", label: "Distance to train",
    legendLabel: "Distance to nearest train station (km)",
    value: (s) => (s.population > 0 && s.nearestTrainKm > 0 ? s.nearestTrainKm : null),
    format: (v) => `${v.toFixed(1)} km`, sqrt: true,
  },
  {
    kind: "continuous", key: "distance_to_coast", label: "Distance to coast",
    legendLabel: "Distance to coastline (km)",
    value: (s) => (s.population > 0 ? s.distToCoastKm : null),
    format: (v) => (v < 20 ? `${v.toFixed(1)} km` : `${Math.round(v)} km`), sqrt: true,
  },
  {
    kind: "categorical", key: "nbn", label: "NBN technology",
    legendLabel: "Dominant NBN technology",
    category: (s) => publishableNbnTech(s.dominantNbnTech, s.population),
    colorFor: nbnColor, order: NBN_ORDER,
  },
  // --- socio-economic (ABS SEIFA 2021 + Census 2021 G17/G43/G49) ---
  // SEIFA deciles are ranked WITHIN the state, like every percentile on the
  // map; the Australia-wide deciles stay on the profile's SEIFA card. Decile 1
  // is the most disadvantaged tenth for IRSD/IRSAD, lowest-resourced for IER
  // and lowest education/occupation for IEO.
  ...(
    [
      ["seifa_irsd_decile_state", "Disadvantage (IRSD)", "IRSD decile within the state (1 = most disadvantaged)"],
      ["seifa_irsad_decile_state", "Advantage (IRSAD)", "IRSAD decile within the state (10 = most advantaged)"],
      ["seifa_ier_decile_state", "Economic resources (IER)", "IER decile within the state (10 = most resourced)"],
      ["seifa_ieo_decile_state", "Education & occupation (IEO)", "IEO decile within the state (10 = highest)"],
    ] as const
  ).map(([key, label, legendLabel]): ColumnMetric => ({
    kind: "column", key, label, legendLabel, group: "socio-economic",
    format: (v) => `Decile ${Math.round(v)}`, domain: [1, 10],
    noDataLabel: "Not ranked (small or no population)",
  })),
  // Census rates below are withheld under 100 residents (and, for the
  // dwelling-, household- and labour-force-denominated ones, under 50 in their
  // own denominator) at ingest — census_expanded.go. No data there is a floor,
  // not a zero.
  {
    kind: "column", key: "unemployment_rate", label: "Unemployment",
    legendLabel: "Unemployment rate (% of labour force)", group: "socio-economic",
    format: fmtPct1, noDataLabel: "Below Census floor",
  },
  {
    kind: "column", key: "pct_bachelor_or_higher", label: "Bachelor degree+",
    legendLabel: "Residents 15+ with a bachelor degree or higher", group: "socio-economic",
    format: fmtPct, noDataLabel: "Below Census floor",
  },
  {
    kind: "column", key: "pct_low_personal_income", label: "Low income",
    legendLabel: "Residents 15+ earning $1–$499 a week", group: "socio-economic",
    format: fmtPct, noDataLabel: "Below Census floor",
  },
  {
    kind: "column", key: "pct_high_personal_income", label: "High income",
    legendLabel: "Residents 15+ earning $2,000+ a week", group: "socio-economic",
    format: fmtPct, noDataLabel: "Below Census floor",
  },
  // --- households & dwellings (Census 2021 G36/G42) ---
  {
    kind: "column", key: "pct_flat_apartment", label: "Flats & apartments",
    legendLabel: "Occupied dwellings that are flats or apartments", group: "households",
    format: fmtPct, noDataLabel: "Below Census floor",
  },
  {
    kind: "column", key: "pct_lone_person_household", label: "Living alone",
    legendLabel: "Households of one person", group: "households",
    format: fmtPct, noDataLabel: "Below Census floor",
  },
  {
    kind: "column", key: "pct_couple_with_children", label: "Couples with kids",
    legendLabel: "Households that are a couple family with children", group: "households",
    format: fmtPct, noDataLabel: "Below Census floor",
  },
  // --- terrain (GA DEM-S, measured) ---
  // elevation_min_m / elevation_max_m stay off the picker: a suburb's lowest
  // point is its creek bed and its highest grows with its area, so neither
  // colours a map meaningfully. The profile's terrain card shows both.
  {
    kind: "column", key: "elevation_median_m", label: "Elevation",
    legendLabel: "Median elevation (m above sea level)", group: "terrain",
    format: (v) => `${Math.round(v)} m`, sqrt: true,
    makeScale: (min, max) => terrainScale(min, max),
  },
  {
    kind: "column", key: "land_share_below_1m", label: "Land below 1 m",
    legendLabel: "Land below 1 m elevation", group: "terrain",
    format: fmtPct1, domain: [0, 25], makeScale: () => waterScale(0, 25),
  },
  {
    kind: "column", key: "land_share_below_2m", label: "Land below 2 m",
    legendLabel: "Land below 2 m elevation", group: "terrain",
    format: fmtPct1, domain: [0, 50], makeScale: () => waterScale(0, 50),
  },
  {
    kind: "column", key: "land_share_below_5m", label: "Low-lying land",
    legendLabel: "Land below 5 m elevation", group: "terrain",
    format: fmtPct, domain: [0, 100], makeScale: () => waterScale(0, 100),
  },
  {
    // The 90%-of-observations-wet remainder of the DEA WOfS record: lakes,
    // estuaries and dams, not floods (those are the hazard layer below).
    kind: "column", key: "permanent_water_share_pct", label: "Permanent water",
    legendLabel: "Area that is permanent water (wet 90%+ of observations)", group: "terrain",
    format: fmtPct1, domain: [0, 25], makeScale: () => waterScale(0, 25),
    noDataLabel: "Not observed",
  },
  // --- hazard exposure (measured area shares; see lib/housing/overlays.ts for wording) ---
  {
    kind: "column", key: "water_observed_share_pct", label: "Observed surface water",
    legendLabel: "Land observed under water since 1987", group: "hazard",
    format: fmtPct1, domain: [0, 25], makeScale: () => waterScale(0, 25),
    noDataLabel: "Not observed",
  },
  {
    kind: "column", key: "flood_planning_share_pct", label: "Flood planning area",
    legendLabel: "Land in a flood planning area", group: "hazard",
    format: fmtPct, domain: [0, 100], makeScale: () => waterScale(0, 100),
    noDataLabel: "No statutory layer",
  },
  {
    kind: "column", key: "bushfire_prone_share_pct", label: "Bushfire prone land",
    legendLabel: "Land designated bushfire prone", group: "hazard",
    format: fmtPct, domain: [0, 100], makeScale: () => fireScale(0, 100),
    noDataLabel: "No statutory layer",
  },
  // --- planning (statutory zoning grouped into harmonised families) ---
  {
    kind: "column-categorical", key: "dominant_zone_family", label: "Main zoning",
    legendLabel: "Largest zoning family", group: "planning",
    // No data = no open zoning source, or one that maps under half the suburb.
    colorForLabel: zoneFamilyColorForLabel, noDataLabel: "No open zoning map covers it",
  },
  zoneShareMetric("zone_res_low_share_pct", "res_low", "Low-density residential zoning"),
  zoneShareMetric("zone_res_medium_high_share_pct", "res_medium_high", "Medium/high-density residential zoning"),
  zoneShareMetric("zone_centre_mixed_share_pct", "centre_mixed", "Centres & mixed-use zoning"),
  zoneShareMetric("zone_industrial_share_pct", "industrial", "Industrial zoning"),
  zoneShareMetric("zone_rural_share_pct", "rural", "Rural zoning"),
  zoneShareMetric("zone_conservation_share_pct", "conservation", "Conservation zoning"),
  zoneShareMetric("zone_open_space_share_pct", "open_space", "Open space zoning"),
  {
    kind: "column", key: "heritage_share_pct", label: "Heritage areas",
    legendLabel: "Land in a heritage area", group: "planning",
    format: fmtPct, domain: [0, 100], makeScale: () => familyScale("#8c5a3c", 0, 100),
    noDataLabel: "No open heritage layer covers it",
  },
  {
    kind: "column", key: "nsw_height_median_m", label: "Permitted height (NSW)",
    legendLabel: "Typical max building height on residential land (m)", group: "planning",
    format: (v) => `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)} m`, sqrt: true,
    // No data outside NSW, and where the LEP maps height on under half the
    // residential land (the median would be the centre's number).
    noDataLabel: "NSW only, where mapped",
  },
];

function zoneShareMetric(key: MetricKey, family: ZoneFamily, label: string): ColumnMetric {
  // label: the picker row; legendLabel: the legend heading.
  return {
    kind: "column", key, label, legendLabel: `Share of suburb zoned ${ZONE_FAMILY_SHORT[family].toLowerCase()}`,
    group: "planning", format: fmtPct, domain: [0, 100],
    makeScale: () => familyScale(ZONE_FAMILY_COLORS[family], 0, 100),
    noDataLabel: "No open zoning map covers it",
  };
}

/** Near-white → the family's own map colour, so a share map and the zoning
 * overlay speak the same colour language. */
export function familyScale(color: string, min: number, max: number): (v: number) => string {
  // d3-scale interpolates colour strings itself (as terrainScale relies on).
  const scale = scaleLinear<string>().domain([min, Math.max(min + 1, max)]).range(["#f7f5f0", color]).clamp(true);
  return (v: number) => scale(v);
}

export const METRIC_BY_KEY: Record<MetricKey, HighlightMetric> =
  Object.fromEntries(HIGHLIGHT_METRICS.map((m) => [m.key, m])) as Record<MetricKey, HighlightMetric>;

/** Icon (from the housing sprite) for each highlight metric — used in the
 * "Colour by" dropdown. Kept as a side map so the metric defs stay presentation-free. */
export const METRIC_ICON: Record<MetricKey, HousingIconName> = {
  price: "median-price", population: "population", age: "age", income: "income",
  born_overseas: "born-overseas", religion: "religion", language: "language",
  federal_party: "party", federal_lean: "federal-lean", state_party: "party",
  politician_property: "representation",
  crime_break_ins: "dwellings", crime_violent: "population", crime_motor_vehicle: "train",
  amenity_density: "amenity-density", supermarkets: "supermarket", pubs: "pubs",
  grocery: "grocery", healthcare: "healthcare", school_sector: "school",
  nearest_train: "train", distance_to_coast: "coast", nbn: "nbn",
  seifa_irsd_decile_state: "income", seifa_irsad_decile_state: "income",
  seifa_ier_decile_state: "debt", seifa_ieo_decile_state: "school",
  unemployment_rate: "population", pct_bachelor_or_higher: "school",
  pct_low_personal_income: "income", pct_high_personal_income: "income",
  pct_flat_apartment: "urban-skyline", pct_lone_person_household: "dwellings",
  pct_couple_with_children: "leafy-suburban",
  elevation_median_m: "hills-ranges", land_share_below_1m: "coastal-beach",
  land_share_below_2m: "coastal-beach", land_share_below_5m: "coastal-beach",
  permanent_water_share_pct: "river-valley",
  water_observed_share_pct: "river-valley", flood_planning_share_pct: "harbour",
  bushfire_prone_share_pct: "bushland",
  dominant_zone_family: "council", zone_res_low_share_pct: "leafy-suburban",
  zone_res_medium_high_share_pct: "dwellings", zone_centre_mixed_share_pct: "city",
  zone_industrial_share_pct: "urban-skyline", zone_rural_share_pct: "farmland",
  zone_conservation_share_pct: "bushland", zone_open_space_share_pct: "parkland",
  heritage_share_pct: "inner-terraces", nsw_height_median_m: "urban-skyline",
};

/** Amber sequential ramp over [min,max] for a continuous metric. */
export function amberScale(min: number, max: number, sqrt = false): (v: number) => string {
  const interp = (t: number) => interpolateOranges(0.18 + 0.74 * t);
  const s = sqrt ? scaleSequentialSqrt(interp) : scaleSequential(interp);
  return s.domain([min, Math.max(min + 1, max)]);
}

/** Diverging red(Labor)↔white↔blue(Coalition) for two-party-preferred %. */
export function politicalLeanScale(): (v: number) => string {
  // RdBu: 0=red, 0.5=white, 1=blue. We want high ALP-TPP → red, low → blue.
  return scaleDiverging<string>([0, 50, 100], (t) => interpolateRdBu(1 - t));
}

/** Blue-teal sequential ramp for water / flood shares — never the price amber,
 * so "more water" cannot be misread as "more expensive". */
export function waterScale(min: number, max: number): (v: number) => string {
  return scaleSequential((t: number) => interpolateBlues(0.15 + 0.8 * t)).domain([min, Math.max(min + 1, max)]);
}

/** Warm sequential ramp for bushfire-prone share. */
export function fireScale(min: number, max: number): (v: number) => string {
  return scaleSequential((t: number) => interpolateYlOrRd(0.2 + 0.75 * t)).domain([min, Math.max(min + 1, max)]);
}

/** Terrain: sea-level teal through green to brown at altitude (a hypsometric
 * ramp readers already know from atlases). sqrt so the coastal plain has range. */
export function terrainScale(min: number, max: number): (v: number) => string {
  const stops = ["#4f9d99", "#8fbf7a", "#d8c26a", "#b98a4c", "#8a5a3b"];
  const lo = Math.max(0, min);
  const hi = Math.max(lo + 1, max);
  // Piecewise domain so the stops land at equal steps of sqrt(elevation);
  // d3-scale interpolates colour strings itself, no extra dependency.
  const domain = stops.map((_, i) => lo + (hi - lo) * ((i / (stops.length - 1)) ** 2));
  const scale = scaleSqrt<string>().domain(domain).range(stops).clamp(true);
  return (v: number) => scale(v);
}

/** Sequential yellow-to-red danger ramp for crime percentile ranks (0..100). */
export function crimeRankScale(): (v: number) => string {
  return scaleSequential((t: number) => interpolateYlOrRd(0.15 + 0.8 * t)).domain([0, 100]);
}
