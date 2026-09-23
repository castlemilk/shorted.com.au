/**
 * The council level of the state map: what a council can be coloured by.
 *
 * Server code passes only a CouncilMetricKey (a string) across the RSC
 * boundary; the accessor, formatter and colour scale are looked up here on the
 * client. Every value reads a CouncilSummary field from ListCouncils, and an
 * absent field is "no source covers this council" — it hatches, never shades
 * as a zero.
 */
import { scaleDiverging, scaleSequential, scaleSequentialSqrt } from "d3-scale";
import { interpolateOranges, interpolatePuOr } from "d3-scale-chromatic";
import type { CouncilSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import type { HousingIconName } from "@/components/housing/housing-icons.generated";
import { fmtPriceShort } from "./price-scale";

/** The CouncilSummary fields a metric reads (a structural subset). */
export type CouncilMetricInput = Pick<
  CouncilSummary,
  | "population" | "erpYear" | "popGrowthPct" | "densityPerSqkm" | "councilHouseMedian"
  | "councilHouseMedianPeriod" | "fagPerResident" | "fagYear" | "approvalsPer1000"
  | "approvalsThrough" | "seifaIrsadDecile" | "floodSharePct" | "bushfireSharePct" | "priceDropShare"
>;

export type CouncilMetricKey =
  | "population" | "population_growth" | "density" | "house_median" | "fag_per_resident"
  | "approvals_per_1000" | "irsad_decile" | "flood_share" | "bushfire_share" | "price_drop_share";

export interface CouncilMetric {
  key: CouncilMetricKey;
  label: string;
  /** Legend title; carries the unit and the council-level qualifier. */
  legendLabel: string;
  icon: HousingIconName;
  value: (c: CouncilMetricInput) => number | null;
  format: (v: number) => string;
  /** Plain-language source + date for the legend footnote. */
  source: (sample: CouncilMetricInput | undefined) => string;
  sqrt?: boolean;
  domain?: [number, number];
  /** Diverging around zero (growth can be negative). */
  diverging?: boolean;
  noDataLabel: string;
}

const present = (v: number | undefined): number | null => (v === undefined || !Number.isFinite(v) ? null : v);
const fmtCount = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 10_000 ? `${Math.round(v / 1000)}k` : Math.round(v).toLocaleString("en-AU");
const fmtSigned = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtPct = (v: number) => (v > 0 && v < 1 ? "<1%" : `${Math.round(v)}%`);

export const COUNCIL_METRICS: readonly CouncilMetric[] = [
  {
    key: "population", label: "Population", legendLabel: "Estimated resident population", icon: "population",
    value: (c) => (c.population > 0 ? c.population : null), format: fmtCount, sqrt: true,
    source: (s) => `ABS estimated resident population${s?.erpYear ? `, 30 June ${s.erpYear}` : ""}`,
    noDataLabel: "No estimate",
  },
  {
    key: "population_growth", label: "Population growth", legendLabel: "Population change in a year", icon: "population",
    value: (c) => present(c.popGrowthPct), format: fmtSigned, diverging: true,
    source: (s) => `ABS estimated resident population, year to 30 June${s?.erpYear ? ` ${s.erpYear}` : ""}`,
    noDataLabel: "No estimate",
  },
  {
    key: "density", label: "Density", legendLabel: "Residents per km²", icon: "dwellings",
    value: (c) => present(c.densityPerSqkm), format: (v) => `${fmtCount(v)}/km²`, sqrt: true,
    source: (s) => `ABS estimated resident population${s?.erpYear ? ` ${s.erpYear}` : ""} over ABS LGA 2024 area`,
    noDataLabel: "No estimate",
  },
  {
    key: "house_median", label: "Council-wide house median", legendLabel: "Council-wide established-house median", icon: "median-price",
    value: (c) => (c.councilHouseMedianPeriod ? present(c.councilHouseMedian) : null), format: fmtPriceShort, sqrt: true,
    source: (s) => `ABS Data by Region, whole-council transfers${s?.councilHouseMedianPeriod ? `, ${s.councilHouseMedianPeriod}` : ""}`,
    noDataLabel: "No council median",
  },
  {
    key: "fag_per_resident", label: "Federal grants per resident", legendLabel: "Financial Assistance Grant per resident", icon: "grants",
    value: (c) => (c.fagYear ? present(c.fagPerResident) : null), format: (v) => `$${Math.round(v).toLocaleString("en-AU")}`, sqrt: true,
    source: (s) => `Financial Assistance Grants${s?.fagYear ? ` ${s.fagYear}` : ""} over ABS estimated resident population`,
    noDataLabel: "No grant matched",
  },
  {
    key: "approvals_per_1000", label: "Dwelling approvals", legendLabel: "Dwellings approved per 1,000 residents, last 12 months", icon: "dwellings",
    value: (c) => (c.approvalsThrough ? present(c.approvalsPer1000) : null), format: (v) => v.toFixed(1), sqrt: true,
    source: (s) => `ABS Building Approvals, 12 months to ${s?.approvalsThrough ? s.approvalsThrough : "latest month"}`,
    noDataLabel: "No approvals series",
  },
  {
    key: "irsad_decile", label: "Advantage (SEIFA IRSAD)", legendLabel: "SEIFA IRSAD national decile (10 = most advantaged)", icon: "income",
    value: (c) => present(c.seifaIrsadDecile), format: (v) => `Decile ${Math.round(v)}`, domain: [1, 10],
    source: () => "ABS SEIFA 2021, council level",
    noDataLabel: "No SEIFA score",
  },
  {
    key: "flood_share", label: "Flood planning land", legendLabel: "Residents' suburbs in flood planning areas (population-weighted)", icon: "river-valley",
    value: (c) => present(c.floodSharePct), format: fmtPct,
    source: () => "State planning flood layers, weighted by Census 2021 residents over member suburbs",
    noDataLabel: "No flood layer covers it",
  },
  {
    key: "bushfire_share", label: "Bushfire-prone land", legendLabel: "Residents' suburbs on bushfire-prone land (population-weighted)", icon: "bushland",
    value: (c) => present(c.bushfireSharePct), format: fmtPct,
    source: () => "State bushfire-prone land maps, weighted by Census 2021 residents over member suburbs",
    noDataLabel: "No bushfire layer covers it",
  },
  {
    key: "price_drop_share", label: "Asking-price cuts", legendLabel: "Share of tracked listings with an asking-price cut", icon: "price-index",
    value: (c) => (c.priceDropShare === undefined ? null : c.priceDropShare * 100), format: fmtPct,
    source: () => "Shorted listing crawl, aggregated; published only where 3+ listings were cut",
    noDataLabel: "Not tracked, or under 3 cuts",
  },
];

export const COUNCIL_METRIC_BY_KEY: Record<CouncilMetricKey, CouncilMetric> = Object.fromEntries(
  COUNCIL_METRICS.map((m) => [m.key, m]),
) as Record<CouncilMetricKey, CouncilMetric>;

export const DEFAULT_COUNCIL_METRIC: CouncilMetricKey = "population";

export function isCouncilMetricKey(value: string | null | undefined): value is CouncilMetricKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COUNCIL_METRIC_BY_KEY, value);
}

/** Colour scale for a metric over the values actually present. */
export function councilMetricScale(metric: CouncilMetric, values: readonly number[]): {
  scale: (v: number) => string; min: number; max: number;
} {
  const [lo, hi] = metric.domain ?? [
    values.length ? Math.min(...values) : 0,
    values.length ? Math.max(...values) : 1,
  ];
  if (metric.diverging) {
    const span = Math.max(Math.abs(lo), Math.abs(hi), 0.1);
    // PuOr: orange = growth, purple = decline; white at zero.
    const s = scaleDiverging<string>([-span, 0, span], (t: number) => interpolatePuOr(1 - t));
    return { scale: (v) => s(v), min: lo, max: hi };
  }
  const interp = (t: number) => interpolateOranges(0.18 + 0.74 * t);
  const s = (metric.sqrt ? scaleSequentialSqrt(interp) : scaleSequential(interp)).domain([lo, hi > lo ? hi : lo + 1]);
  return { scale: (v) => s(v), min: lo, max: hi };
}
