/**
 * Economy map metric registry — the serializable "Colour by" catalog for the
 * /economy choropleth. Mirrors @/lib/housing/highlight-metrics.ts.
 *
 * Step 0 verification (2026-07-21): `web/public/geo/states.topojson` object
 * name is "STE_2021_AUST_GDA2020" and feature ids are the ABS STE_CODE21
 * NUMERIC strings "1".."8" (NOT uppercase state abbreviations as the plan's
 * template assumed) — verified via:
 *   node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync('web/public/geo/states.topojson','utf8'));const o=Object.keys(t.objects)[0];console.log(o, t.objects[o].geometries.map(g=>g.id+':'+g.properties.STE_NAME21))"
 * → STE_2021_AUST_GDA2020, "1":New South Wales .. "8":Australian Capital Territory
 *
 * DEVIATION: because real topojson feature ids are numeric (not "NSW" etc.),
 * `toFeatureId`/`toSlug` below intentionally stay as simple uppercase/
 * lowercase abbreviation converters (NOT real topojson feature ids) — this
 * keeps the metric-value maps keyed by stable, human-readable state
 * abbreviations ("NSW", "VIC", ...) matching the spec's test fixtures. The
 * repo already has the canonical numeric-id↔abbreviation mapping for this
 * exact file at @/lib/housing/states.ts (`STE_CODE_TO_STATE`/
 * `STATE_TO_STE_CODE`, used by housing-zoom-map.tsx) — re-exported here as
 * `toTopoFeatureId`/`fromTopoFeatureId` for Task 2 (the explorer component)
 * to translate abbreviation-keyed value maps into the numeric-id-keyed
 * `valueById` that `ChoroplethMap` actually expects.
 */
import { scaleSequential, scaleDiverging } from "d3-scale";
import { interpolateOranges, interpolateRdBu } from "d3-scale-chromatic";
import { STE_CODE_TO_STATE, STATE_TO_STE_CODE } from "@/lib/housing/states";

export type EconomyMapMetricKey =
  | "unemployment"
  | "participation"
  | "sfd"
  | "sfd_growth"
  | "exports"
  | "imports"
  | "trade_balance"
  | "diesel_sales"
  | "company_footprint"
  | "local_short_interest";

/** lowercase collector slugs ↔ uppercase state abbreviations (NOT the real numeric topojson feature id — see file header). */
export const STATE_SLUGS = ["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"] as const;
export type StateSlug = (typeof STATE_SLUGS)[number];
export const toFeatureId = (slug: string) => slug.toUpperCase();
export const toSlug = (featureId: string) => featureId.toLowerCase() as StateSlug;
export const STATE_NAMES: Record<StateSlug, string> = {
  nsw: "New South Wales", vic: "Victoria", qld: "Queensland", sa: "South Australia",
  wa: "Western Australia", tas: "Tasmania", nt: "Northern Territory",
  act: "Australian Capital Territory",
};

/** Real /geo/states.topojson feature id (ABS STE_CODE21) for a state abbreviation, e.g. "NSW" -> "1". */
export const toTopoFeatureId = (abbr: string): string => {
  const code = STATE_TO_STE_CODE[abbr.toUpperCase()];
  if (code === undefined) throw new Error(`Unknown state abbreviation: ${abbr}`);
  return code;
};
/** Real /geo/states.topojson feature id (ABS STE_CODE21) back to a state abbreviation, e.g. "1" -> "NSW". */
export const fromTopoFeatureId = (topoId: string): string => {
  const abbr = STE_CODE_TO_STATE[topoId];
  if (abbr === undefined) throw new Error(`Unknown topojson feature id: ${topoId}`);
  return abbr;
};

interface EconomyMapMetricBase {
  key: EconomyMapMetricKey;
  label: string;
  legendLabel: string;
  format: "percent" | "aud" | "megalitres";
  palette: "continuous" | "diverging";
  higherIsBad?: boolean;
}

/** Time-series-fed metric — colours the map from GetEconomicSeries observations. */
export interface EconomySeriesMetric extends EconomyMapMetricBase {
  kind: "series";
  /** "{state}" placeholder — e.g. "labour.unemployment_rate.total.{state}.seasadj" */
  seriesKeyTemplate: string;
  /** second template for derived "balance" metrics (imports side) */
  secondaryTemplate?: string;
  derived?: "yoy" | "balance";
  /** states with no upstream series — grey/hatch fill + tooltip note */
  unavailableStates?: StateSlug[];
  unavailableNote?: string;
}

/**
 * Aggregate-fed metric — colours the map from a single
 * GetStateCompanyAggregates call (one point per state, no history →
 * no sparkline / no y/y in the tooltip).
 */
export interface EconomyAggregateMetric extends EconomyMapMetricBase {
  kind: "aggregate";
  /** which StateCompanyAggregate field carries the value */
  aggField: "exposureWeightedMarketCap" | "exposureWeightedShortPercent";
}

export type EconomyMapMetric = EconomySeriesMetric | EconomyAggregateMetric;

/** kind:"series" spread helper so the 8 original entries stay terse. */
const series = (m: Omit<EconomySeriesMetric, "kind">): EconomySeriesMetric => ({
  kind: "series",
  ...m,
});

export const ECONOMY_MAP_METRICS: EconomyMapMetric[] = [
  series({
    key: "unemployment", label: "Unemployment rate", legendLabel: "Unemployment rate (seas. adj.)",
    seriesKeyTemplate: "labour.unemployment_rate.total.{state}.seasadj",
    format: "percent", palette: "continuous", higherIsBad: true,
    unavailableStates: ["nt", "act"],
    unavailableNote: "ABS does not publish seasonally adjusted labour force series for this territory",
  }),
  series({
    key: "participation", label: "Participation rate", legendLabel: "Participation rate (seas. adj.)",
    seriesKeyTemplate: "labour.participation_rate.total.{state}.seasadj",
    format: "percent", palette: "continuous",
    unavailableStates: ["nt", "act"],
    unavailableNote: "ABS does not publish seasonally adjusted labour force series for this territory",
  }),
  series({
    key: "sfd", label: "State final demand", legendLabel: "State final demand (quarterly, chain volume)",
    seriesKeyTemplate: "gdp.state_final_demand_chain_volume.total.{state}.seasadj",
    format: "aud", palette: "continuous",
  }),
  series({
    key: "sfd_growth", label: "SFD growth (YoY)", legendLabel: "State final demand, year-on-year",
    seriesKeyTemplate: "gdp.state_final_demand_chain_volume.total.{state}.seasadj",
    format: "percent", palette: "diverging", derived: "yoy",
  }),
  series({
    key: "exports", label: "Goods exports", legendLabel: "Goods exports (monthly)",
    seriesKeyTemplate: "trade.export_value.total.{state}",
    format: "aud", palette: "continuous",
  }),
  series({
    key: "imports", label: "Goods imports", legendLabel: "Goods imports (monthly)",
    seriesKeyTemplate: "trade.import_value.total.{state}",
    format: "aud", palette: "continuous",
  }),
  series({
    key: "trade_balance", label: "Trade balance", legendLabel: "Goods trade balance (exports − imports)",
    seriesKeyTemplate: "trade.export_value.total.{state}",
    secondaryTemplate: "trade.import_value.total.{state}",
    format: "aud", palette: "diverging", derived: "balance",
  }),
  series({
    key: "diesel_sales", label: "Diesel sales", legendLabel: "Diesel sales (monthly)",
    seriesKeyTemplate: "petroleum.sales.diesel_oil_total.{state}",
    format: "megalitres", palette: "continuous",
    unavailableStates: ["act"],
    unavailableNote: "DCCEEW folds ACT fuel sales into NSW",
  }),
  {
    kind: "aggregate",
    key: "company_footprint", label: "Company footprint",
    legendLabel: "ASX company footprint (exposure-weighted market cap)",
    format: "aud", palette: "continuous",
    aggField: "exposureWeightedMarketCap",
  },
  {
    kind: "aggregate",
    key: "local_short_interest", label: "Local short interest",
    legendLabel: "Short interest of locally-operating companies (exposure-weighted)",
    format: "percent", palette: "continuous", higherIsBad: true,
    aggField: "exposureWeightedShortPercent",
  },
];

export const METRIC_BY_KEY = Object.fromEntries(
  ECONOMY_MAP_METRICS.map((m) => [m.key, m]),
) as Record<EconomyMapMetricKey, EconomyMapMetric>;

/**
 * All RPC series keys a metric needs (primary + secondary), skipping
 * unavailable states. Takes EconomySeriesMetric ONLY — aggregate metrics have
 * no series templates, so passing one is a compile error by design.
 */
export function seriesKeysFor(metric: EconomySeriesMetric): string[] {
  const states = STATE_SLUGS.filter((s) => !metric.unavailableStates?.includes(s));
  const keys = states.map((s) => metric.seriesKeyTemplate.replace("{state}", s));
  if (metric.secondaryTemplate) {
    keys.push(...states.map((s) => metric.secondaryTemplate!.replace("{state}", s)));
  }
  return keys;
}

// ── pure computation helpers ────────────────────────────────────────────────

export interface Obs { date: Date; value: number }
export interface StateSeries { state: string; observations: Obs[] }

export interface StateValue {
  latest: number;
  latestDate: Date;
  yoy: number | null;
  spark: Obs[]; // last 24 observations
}

/** % change vs the observation closest to 12 months before the latest (null if < ~11 months of data). */
export function yoyPct(obs: Obs[]): number | null {
  if (obs.length < 2) return null;
  const last = obs[obs.length - 1]!;
  const target = last.date.getTime() - 365 * 24 * 3600 * 1000;
  let best: Obs | null = null;
  for (const o of obs) {
    if (!best || Math.abs(o.date.getTime() - target) < Math.abs(best.date.getTime() - target)) best = o;
  }
  if (!best || best === last) return null;
  // require the comparison point to actually be ~a year back (±45 days)
  if (Math.abs(best.date.getTime() - target) > 45 * 24 * 3600 * 1000) return null;
  if (best.value === 0) return null;
  return ((last.value - best.value) / Math.abs(best.value)) * 100;
}

/**
 * Compute per-feature-id map values for a metric.
 * `byKey` maps arbitrary keys → StateSeries; for plain/yoy metrics one entry
 * per state; for `balance` metrics two entries per state whose keys END with
 * ":export"/":import" (the explorer builds them that way from the two templates).
 */
export function buildStateValues(
  metric: EconomySeriesMetric,
  byKey: Record<string, StateSeries>,
): Map<string, StateValue> {
  const out = new Map<string, StateValue>();
  if (metric.derived === "balance") {
    const states = new Set(Object.values(byKey).map((s) => s.state));
    for (const st of states) {
      const exp = Object.entries(byKey).find(([k, v]) => v.state === st && k.endsWith(":export"))?.[1];
      const imp = Object.entries(byKey).find(([k, v]) => v.state === st && k.endsWith(":import"))?.[1];
      if (!exp?.observations.length || !imp?.observations.length) continue;
      // align on shared dates, subtract
      const impByTime = new Map(imp.observations.map((o) => [o.date.getTime(), o.value]));
      const merged: Obs[] = exp.observations
        .filter((o) => impByTime.has(o.date.getTime()))
        .map((o) => ({ date: o.date, value: o.value - impByTime.get(o.date.getTime())! }));
      if (!merged.length) continue;
      const last = merged[merged.length - 1]!;
      out.set(toFeatureId(st), {
        latest: last.value, latestDate: last.date, yoy: yoyPct(merged), spark: merged.slice(-24),
      });
    }
    return out;
  }
  for (const s of Object.values(byKey)) {
    if (!s.observations.length) continue;
    const obs = s.observations;
    const last = obs[obs.length - 1]!;
    if (metric.derived === "yoy") {
      const y = yoyPct(obs);
      if (y === null) continue;
      // yoy series for spark: rolling yoy over the last 24 points
      const spark: Obs[] = [];
      for (let i = Math.max(0, obs.length - 24); i < obs.length; i++) {
        const y2 = yoyPct(obs.slice(0, i + 1));
        if (y2 !== null) spark.push({ date: obs[i]!.date, value: y2 });
      }
      out.set(toFeatureId(s.state), { latest: y, latestDate: last.date, yoy: null, spark });
    } else {
      out.set(toFeatureId(s.state), {
        latest: last.value, latestDate: last.date, yoy: yoyPct(obs), spark: obs.slice(-24),
      });
    }
  }
  return out;
}

/** 1 = highest value. */
export function rankOf(values: Map<string, number>, id: string): { rank: number; of: number } | null {
  const v = values.get(id);
  if (v === undefined) return null;
  const sorted = [...values.values()].sort((a, b) => b - a);
  return { rank: sorted.indexOf(v) + 1, of: sorted.length };
}

// ── scales & formats (client-side only — never cross the RSC boundary) ─────

export function continuousScale(min: number, max: number): (v: number) => string {
  const s = scaleSequential(interpolateOranges).domain([min, max === min ? min + 1 : max]);
  return (v: number) => s(v);
}

/** diverging around 0 (trade balance) or around 0% (yoy growth) */
export function divergingScale(min: number, max: number): (v: number) => string {
  const bound = Math.max(Math.abs(min), Math.abs(max), 1e-9);
  const s = scaleDiverging([-bound, 0, bound], (t: number) => interpolateRdBu(t));
  return (v: number) => s(v);
}

export const MAP_FORMATS: Record<EconomyMapMetric["format"], (v: number) => string> = {
  percent: (v) => `${v.toFixed(1)}%`,
  aud: (v) => {
    const a = Math.abs(v);
    const sign = v < 0 ? "−" : "";
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
    return `${sign}$${a.toFixed(0)}`;
  },
  megalitres: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}GL` : `${v.toFixed(0)}ML`),
};
