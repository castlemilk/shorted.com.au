# Economy Map Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `/economy` into a map-first explorer — national choropleth hero with a "Colour by" metric switcher, rich hover tooltips (value/YoY/sparkline/rank), and click-to-drill state dossiers — reusing the housing choropleth stack; frontend-only.

**Architecture:** New serializable metric registry (`@/lib/economy/map-metrics.ts`) + one client explorer component consuming `ChoroplethMap` (housing, reused as-is), `MapLegend`, `useTopojson`, and the shipped `EconomySeriesChart`/`getEconomicSeriesClient`. Deep links via the Suspense-wrapped `useSearchParams` sync pattern. Page stays ISR (`revalidate = 3600`).

**Tech Stack:** Next.js 14 App Router, d3 (via existing choropleth-map), @tanstack/react-query, @visx, existing Connect client actions.

**Spec:** `docs/superpowers/specs/2026-07-21-economy-map-explorer-design.md`
**Branch:** `feat/economy-map-explorer` (created off main; spec committed).

**Load-bearing contracts (extracted 2026-07-21 — do not rediscover):**
- `ChoroplethMap` props (`choropleth-map.tsx:34-71`): `topology, objectName, valueById: Map<string, number|null>, colorScale, nameById, fitValueById, selectedId, hoveredId, focusId, onFeatureClick, onFeatureHover(id, evt), ariaLabel, fitToData, fill, legend`. Null value → hatch fill automatically.
- `MapLegend` props (`map-legend.tsx:10-22`): `colorScale, min, max, label, format, showNoData, noDataLabel`.
- `useTopojson("/geo/states.topojson")` from `@/components/housing/use-topojson` (react-query, staleTime Infinity).
- Scale builders live in `@/lib/housing/highlight-metrics.ts` (`amberScale`) and `@/lib/housing/price-scale` — check what's exported; if `amberScale` is not exported, replicate it locally in map-metrics.ts (d3 `scaleSequential(interpolateOranges)`, sqrt option).
- Housing zoom map (`housing-zoom-map.tsx`) shows how state features are keyed: check `String(f.id)` values by inspecting how `stateStats` is keyed there and/or `web/scripts/geo/build-boundaries.mjs` — the plan assumes feature ids are uppercase state abbreviations ("NSW"..."ACT"); Task 1 Step 0 verifies and records the truth.
- Deep-link sync pattern: `industry-intelligence-client.tsx:43-59` (`DeepLinkSync` behind `<Suspense>`) + `history.replaceState` write (`:124-131`).
- Preload: `preload("/geo/states.topojson", { as: "fetch", crossOrigin: "anonymous" })` from `react-dom` — crossOrigin REQUIRED (housing/page.tsx:99-107).
- `EconomySeriesChart` props: `{ seriesKey, ariaLabel, format?: "aud"|"percent"|"index"|"megalitres"|"usd", height? }` via `@/components/economy/economy-charts` (ssr:false loader).
- `getEconomicSeriesClient(seriesKeys: string[])` from `@/app/actions/client/getEconomyClient`.

**Verified series-key facts (prod + local DB):**
- `labour.{unemployment_rate|participation_rate}.total.{state}.seasadj` — states: aus,nsw,vic,qld,sa,wa,tas ONLY (no nt/act upstream).
- `gdp.state_final_demand_chain_volume.total.{state}.seasadj` — 8 states, NO aus.
- `trade.{export_value|import_value}.total.{state}` — aus + all 8 states.
- `petroleum.sales.diesel_oil_total.{state}` — aus,nsw,vic,qld,sa,wa,tas,nt (NO act — folded into NSW upstream).
- Per-state top exports: `trade.export_value.<product>.{state}` for the 10 SITC products (slugs are in `services/economy-collector/trade.go` `sitcProducts` map — copy them into the dossier constant).

---

## Task 1: Metric registry + pure helpers (`@/lib/economy/map-metrics.ts`)

**Files:**
- Create: `web/src/@/lib/economy/map-metrics.ts`
- Test: `web/src/@/lib/economy/__tests__/map-metrics.test.ts` (match the repo's jest test location convention — check where `@/lib` tests live, e.g. colocated `*.test.ts`; follow reality)

- [ ] **Step 0: Verify state feature ids.** Run `node -e "const t=require('/Users/benebsworth/projects/shorted/web/public/geo/states.topojson'); const o=Object.keys(t.objects)[0]; console.log(o, t.objects[o].geometries.map(g=>g.id+':'+((g.properties||{}).name||'')))"`. Record the object name + id format in a comment at the top of map-metrics.ts. The code below assumes ids like "NSW"; adapt `STATE_IDS`/`toFeatureId` if reality differs (e.g. numeric codes → build the mapping from properties).

- [ ] **Step 1: Write failing tests:**

```ts
import {
  ECONOMY_MAP_METRICS,
  METRIC_BY_KEY,
  seriesKeysFor,
  buildStateValues,
  yoyPct,
  rankOf,
  type StateSeries,
} from "../map-metrics";

const mk = (state: string, values: number[], startYear = 2024): StateSeries => ({
  state,
  observations: values.map((v, i) => ({
    date: new Date(Date.UTC(startYear, i, 1)),
    value: v,
  })),
});

describe("map-metrics", () => {
  it("registry has 8 metrics with unique keys", () => {
    const keys = ECONOMY_MAP_METRICS.map((m) => m.key);
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
    expect(METRIC_BY_KEY.unemployment.label).toMatch(/unemployment/i);
  });

  it("seriesKeysFor templates state slugs and skips unavailable states", () => {
    const keys = seriesKeysFor(METRIC_BY_KEY.unemployment);
    expect(keys).toContain("labour.unemployment_rate.total.nsw.seasadj");
    expect(keys.some((k) => k.includes(".nt."))).toBe(false);
    expect(keys.some((k) => k.endsWith(".nt.seasadj"))).toBe(false);
  });

  it("trade_balance fetches both directions", () => {
    const keys = seriesKeysFor(METRIC_BY_KEY.trade_balance);
    expect(keys).toContain("trade.export_value.total.wa");
    expect(keys).toContain("trade.import_value.total.wa");
  });

  it("yoyPct computes % change vs ~12 months earlier", () => {
    const s = mk("nsw", Array.from({ length: 13 }, (_, i) => 100 + i)); // 100..112
    expect(yoyPct(s.observations)).toBeCloseTo(12, 5);
    expect(yoyPct(s.observations.slice(0, 6))).toBeNull(); // < a year of data
  });

  it("buildStateValues: plain metric uses latest value", () => {
    const values = buildStateValues(METRIC_BY_KEY.unemployment, {
      nsw: mk("nsw", [4.5, 4.2]),
      vic: mk("vic", [4.8, 4.9]),
    });
    expect(values.get("NSW")?.latest).toBe(4.2);
    expect(values.get("VIC")?.latest).toBe(4.9);
  });

  it("buildStateValues: derived balance = exports − imports per state", () => {
    const values = buildStateValues(METRIC_BY_KEY.trade_balance, {
      "wa:export": mk("wa", [100, 120]),
      "wa:import": mk("wa", [80, 90]),
    });
    expect(values.get("WA")?.latest).toBe(30);
  });

  it("rankOf ranks descending with 1 = highest", () => {
    const m = new Map([
      ["NSW", 5],
      ["VIC", 9],
      ["QLD", 7],
    ]);
    expect(rankOf(m, "VIC")).toEqual({ rank: 1, of: 3 });
    expect(rankOf(m, "NSW")).toEqual({ rank: 3, of: 3 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd web && npx jest map-metrics --silent` → fails (module missing).

- [ ] **Step 3: Implement `map-metrics.ts`:**

```ts
/**
 * Economy map metric registry — the serializable "Colour by" catalog for the
 * /economy choropleth. Mirrors @/lib/housing/highlight-metrics.ts. Feature ids
 * in /geo/states.topojson are uppercase abbreviations (verified <date>:
 * <object name>, ids: NSW VIC QLD SA WA TAS NT ACT) — adapt here if the
 * boundary file is ever rebuilt differently.
 */
import { scaleSequential, scaleDiverging } from "d3-scale";
import { interpolateOranges, interpolateRdBu } from "d3-scale-chromatic";

export type EconomyMapMetricKey =
  | "unemployment"
  | "participation"
  | "sfd"
  | "sfd_growth"
  | "exports"
  | "imports"
  | "trade_balance"
  | "diesel_sales";

/** lowercase collector slugs ↔ uppercase topojson feature ids */
export const STATE_SLUGS = ["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"] as const;
export type StateSlug = (typeof STATE_SLUGS)[number];
export const toFeatureId = (slug: string) => slug.toUpperCase();
export const toSlug = (featureId: string) => featureId.toLowerCase() as StateSlug;
export const STATE_NAMES: Record<StateSlug, string> = {
  nsw: "New South Wales", vic: "Victoria", qld: "Queensland", sa: "South Australia",
  wa: "Western Australia", tas: "Tasmania", nt: "Northern Territory",
  act: "Australian Capital Territory",
};

export interface EconomyMapMetric {
  key: EconomyMapMetricKey;
  label: string;
  legendLabel: string;
  /** "{state}" placeholder — e.g. "labour.unemployment_rate.total.{state}.seasadj" */
  seriesKeyTemplate: string;
  /** second template for derived "balance" metrics (imports side) */
  secondaryTemplate?: string;
  format: "percent" | "aud" | "megalitres";
  palette: "continuous" | "diverging";
  higherIsBad?: boolean;
  derived?: "yoy" | "balance";
  /** states with no upstream series — grey/hatch fill + tooltip note */
  unavailableStates?: StateSlug[];
  unavailableNote?: string;
}

export const ECONOMY_MAP_METRICS: EconomyMapMetric[] = [
  {
    key: "unemployment", label: "Unemployment rate", legendLabel: "Unemployment rate (seas. adj.)",
    seriesKeyTemplate: "labour.unemployment_rate.total.{state}.seasadj",
    format: "percent", palette: "continuous", higherIsBad: true,
    unavailableStates: ["nt", "act"],
    unavailableNote: "ABS does not publish seasonally adjusted labour force series for this territory",
  },
  {
    key: "participation", label: "Participation rate", legendLabel: "Participation rate (seas. adj.)",
    seriesKeyTemplate: "labour.participation_rate.total.{state}.seasadj",
    format: "percent", palette: "continuous",
    unavailableStates: ["nt", "act"],
    unavailableNote: "ABS does not publish seasonally adjusted labour force series for this territory",
  },
  {
    key: "sfd", label: "State final demand", legendLabel: "State final demand (quarterly, chain volume)",
    seriesKeyTemplate: "gdp.state_final_demand_chain_volume.total.{state}.seasadj",
    format: "aud", palette: "continuous",
  },
  {
    key: "sfd_growth", label: "SFD growth (YoY)", legendLabel: "State final demand, year-on-year",
    seriesKeyTemplate: "gdp.state_final_demand_chain_volume.total.{state}.seasadj",
    format: "percent", palette: "diverging", derived: "yoy",
  },
  {
    key: "exports", label: "Goods exports", legendLabel: "Goods exports (monthly)",
    seriesKeyTemplate: "trade.export_value.total.{state}",
    format: "aud", palette: "continuous",
  },
  {
    key: "imports", label: "Goods imports", legendLabel: "Goods imports (monthly)",
    seriesKeyTemplate: "trade.import_value.total.{state}",
    format: "aud", palette: "continuous",
  },
  {
    key: "trade_balance", label: "Trade balance", legendLabel: "Goods trade balance (exports − imports)",
    seriesKeyTemplate: "trade.export_value.total.{state}",
    secondaryTemplate: "trade.import_value.total.{state}",
    format: "aud", palette: "diverging", derived: "balance",
  },
  {
    key: "diesel_sales", label: "Diesel sales", legendLabel: "Diesel sales (monthly)",
    seriesKeyTemplate: "petroleum.sales.diesel_oil_total.{state}",
    format: "megalitres", palette: "continuous",
    unavailableStates: ["act"],
    unavailableNote: "DCCEEW folds ACT fuel sales into NSW",
  },
];

export const METRIC_BY_KEY = Object.fromEntries(
  ECONOMY_MAP_METRICS.map((m) => [m.key, m]),
) as Record<EconomyMapMetricKey, EconomyMapMetric>;

/** All RPC series keys a metric needs (primary + secondary), skipping unavailable states. */
export function seriesKeysFor(metric: EconomyMapMetric): string[] {
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
  metric: EconomyMapMetric,
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
```

(If `d3-scale`/`d3-scale-chromatic` aren't direct deps of web/, check how `highlight-metrics.ts` imports its scale machinery and mirror that import path exactly.)

- [ ] **Step 4: Tests pass** — `npx jest map-metrics --silent` all green; `npx tsc --noEmit | grep -i map-metrics` empty.
- [ ] **Step 5: Commit** — `git add web/src/@/lib/economy && git commit -m "feat(web): economy map metric registry + helpers"` (--no-verify ok).

---

## Task 2: Explorer component — map, switcher, legend, tooltip

**Files:**
- Create: `web/src/@/components/economy/economy-map-explorer.tsx` (client)
- Create: `web/src/@/components/economy/state-tooltip.tsx` (client, presentational)
- Create: `web/src/@/components/economy/economy-map-loader.tsx` (ssr:false dynamic wrapper)

- [ ] **Step 1: `state-tooltip.tsx`** — presentational card (housing suburb-tooltip look: `w-56 rounded-lg border bg-card p-3 shadow-lg pointer-events-none`):

```tsx
"use client";

import type { Obs, StateValue } from "@/lib/economy/map-metrics";

/** 200×32 sparkline, amber stroke (suburb-tooltip's Sparkline pattern). */
function Sparkline({ points }: { points: Obs[] }) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.date.getTime());
  const ys = points.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const pts = points
    .map((p) => {
      const x = ((p.date.getTime() - x0) / (x1 - x0 || 1)) * 200;
      const y = 30 - ((p.value - y0) / (y1 - y0 || 1)) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={200} height={32} aria-hidden className="mt-1">
      <polyline points={pts} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} />
    </svg>
  );
}

export function StateTooltip({
  name, value, metricLabel, format, period, yoy, higherIsBad, rank, spark, unavailableNote,
}: {
  name: string;
  value: number | null;
  metricLabel: string;
  format: (v: number) => string;
  period?: string;
  yoy?: number | null;
  higherIsBad?: boolean;
  rank?: { rank: number; of: number } | null;
  spark?: Obs[];
  unavailableNote?: string;
}) {
  return (
    <div className="w-56 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="font-serif text-sm font-semibold">{name}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {metricLabel}
        {period ? ` · ${period}` : null}
      </div>
      {value === null ? (
        <p className="mt-2 text-xs text-muted-foreground">{unavailableNote ?? "No data"}</p>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-lg tabular-nums">{format(value)}</span>
            {yoy != null && (
              <span
                className={`font-mono text-xs tabular-nums ${
                  (yoy >= 0) !== Boolean(higherIsBad) ? "text-emerald-600" : "text-red-600"
                }`}
              >
                {yoy >= 0 ? "+" : ""}
                {yoy.toFixed(1)}% y/y
              </span>
            )}
          </div>
          {rank && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              #{rank.rank} of {rank.of} states
            </div>
          )}
          {spark && <Sparkline points={spark} />}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `economy-map-explorer.tsx`.** Client component. Core structure (real code — adapt only where the contracts force it):

```tsx
"use client";

import { useMemo, useState, useCallback, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ChoroplethMap } from "@/components/housing/choropleth-map";
import { MapLegend } from "@/components/housing/map-legend";
import { useTopojson } from "@/components/housing/use-topojson";
import { getEconomicSeriesClient } from "@/app/actions/client/getEconomyClient";
import {
  ECONOMY_MAP_METRICS, METRIC_BY_KEY, MAP_FORMATS, STATE_NAMES, STATE_SLUGS,
  buildStateValues, continuousScale, divergingScale, rankOf, seriesKeysFor,
  toFeatureId, toSlug,
  type EconomyMapMetric, type EconomyMapMetricKey, type StateSeries, type StateValue,
} from "@/lib/economy/map-metrics";
import { StateTooltip } from "./state-tooltip";
import { StateDossier } from "./state-dossier";

const TOPO_OBJECT = "states"; // ← set from Task 1 Step 0's verified object name

/** Fetch + reshape one metric's series into StateSeries keyed for buildStateValues. */
function useMetricData(metric: EconomyMapMetric) {
  return useQuery({
    queryKey: ["economy-map", metric.key],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const keys = seriesKeysFor(metric);
      const resp = await getEconomicSeriesClient(keys);
      const byKey: Record<string, StateSeries> = {};
      for (const s of resp?.series ?? []) {
        const info = s.info;
        if (!info) continue;
        const state = info.regionCode; // "nsw"
        const observations = (s.observations ?? []).map((o) => ({
          date: new Date(Number(o.period?.seconds ?? 0n) * 1000),
          value: o.value,
        }));
        const suffix =
          metric.derived === "balance"
            ? info.seriesKey.includes(".import_value.") ? ":import" : ":export"
            : "";
        byKey[`${state}${suffix}`] = { state, observations };
      }
      return byKey;
    },
  });
}

function DeepLinkSync({ onApply }: { onApply: (state: string | null, metric: string | null) => void }) {
  const searchParams = useSearchParams();
  const state = searchParams.get("state");
  const metric = searchParams.get("metric");
  useEffect(() => onApply(state, metric), [state, metric, onApply]);
  return null;
}

export function EconomyMapExplorer() {
  const [metricKey, setMetricKey] = useState<EconomyMapMetricKey>("unemployment");
  const [selected, setSelected] = useState<string | null>(null); // slug ("wa")
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  const metric = METRIC_BY_KEY[metricKey];
  const { data: topo } = useTopojson("/geo/states.topojson");
  const { data: byKey, isError, refetch } = useMetricData(metric);

  const values = useMemo(
    () => (byKey ? buildStateValues(metric, byKey) : new Map<string, StateValue>()),
    [byKey, metric],
  );

  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const slug of STATE_SLUGS) {
      const v = values.get(toFeatureId(slug));
      m.set(toFeatureId(slug), v ? v.latest : null);
    }
    return m;
  }, [values]);

  const [min, max] = useMemo(() => {
    const nums = [...valueById.values()].filter((v): v is number => v != null);
    return nums.length ? [Math.min(...nums), Math.max(...nums)] : [0, 1];
  }, [valueById]);

  const scale = useMemo(
    () => (metric.palette === "diverging" ? divergingScale(min, max) : continuousScale(min, max)),
    [metric.palette, min, max],
  );

  const nameById = useMemo(
    () => new Map(STATE_SLUGS.map((s) => [toFeatureId(s), STATE_NAMES[s]])),
    [],
  );

  const format = MAP_FORMATS[metric.format];
  const latestRanks = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, v] of valueById) if (v != null) m.set(id, v);
    return m;
  }, [valueById]);

  // URL sync (write side)
  const syncUrl = useCallback((state: string | null, mk: EconomyMapMetricKey) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (state) url.searchParams.set("state", state); else url.searchParams.delete("state");
    url.searchParams.set("metric", mk);
    window.history.replaceState(null, "", url);
  }, []);

  const applyDeepLink = useCallback((state: string | null, mk: string | null) => {
    if (mk && mk in METRIC_BY_KEY) setMetricKey(mk as EconomyMapMetricKey);
    if (state && (STATE_SLUGS as readonly string[]).includes(state)) setSelected(state);
  }, []);

  const selectState = (slug: string | null) => {
    setSelected(slug);
    syncUrl(slug, metricKey);
  };
  const selectMetric = (mk: EconomyMapMetricKey) => {
    setMetricKey(mk);
    syncUrl(selected, mk);
  };

  const hoverValue = hover ? values.get(hover.id) : undefined;
  const hoverSlug = hover ? toSlug(hover.id) : null;
  const hoverUnavailable = hoverSlug ? metric.unavailableStates?.includes(hoverSlug) : false;

  return (
    <div className="relative">
      <Suspense fallback={null}>
        <DeepLinkSync onApply={applyDeepLink} />
      </Suspense>

      {/* Metric switcher */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Colour by</span>
        {ECONOMY_MAP_METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => selectMetric(m.key)}
            className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
              m.key === metricKey
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
        {isError && (
          <button type="button" onClick={() => refetch()} className="ml-2 text-xs text-red-600 underline">
            data unavailable — retry
          </button>
        )}
      </div>

      <div className="relative h-[520px] overflow-hidden rounded-xl border border-border bg-card">
        {topo && (
          <ChoroplethMap
            fill
            topology={topo}
            objectName={TOPO_OBJECT}
            valueById={valueById}
            colorScale={scale}
            nameById={nameById}
            fitValueById={valueById}
            selectedId={selected ? toFeatureId(selected) : undefined}
            focusId={selected ? toFeatureId(selected) : undefined}
            ariaLabel={`Australian states by ${metric.label}`}
            legend={
              <MapLegend
                colorScale={scale}
                min={min}
                max={max}
                label={metric.legendLabel}
                format={format}
                noDataLabel="Not published"
              />
            }
            onFeatureClick={(id) => selectState(selected === toSlug(id) ? null : toSlug(id))}
            onFeatureHover={(id, evt) => {
              if (!id || !evt) return setHover(null);
              setHover({ id, x: evt.clientX, y: evt.clientY });
            }}
          />
        )}
        {hover && (
          <div
            className="pointer-events-none fixed z-50"
            style={{ left: hover.x + 14, top: hover.y + 14 }}
          >
            <StateTooltip
              name={nameById.get(hover.id) ?? hover.id}
              value={hoverUnavailable ? null : hoverValue?.latest ?? null}
              metricLabel={metric.label}
              format={format}
              period={hoverValue?.latestDate.toLocaleDateString("en-AU", { month: "short", year: "numeric" })}
              yoy={hoverValue?.yoy}
              higherIsBad={metric.higherIsBad}
              rank={hover ? rankOf(latestRanks, hover.id) : null}
              spark={hoverValue?.spark}
              unavailableNote={metric.unavailableNote}
            />
          </div>
        )}
      </div>

      {selected && (
        <StateDossier state={selected} metricKey={metricKey} onClose={() => selectState(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: `economy-map-loader.tsx`:**

```tsx
"use client";

import dynamic from "next/dynamic";

// connect-web + d3 measure-on-client → client-only (housing-zoom-map-loader pattern).
export const EconomyMapExplorer = dynamic(
  () => import("./economy-map-explorer").then((m) => m.EconomyMapExplorer),
  { ssr: false, loading: () => <div className="h-[560px] w-full animate-pulse rounded-xl bg-muted" /> },
);
```

- [ ] **Step 4:** Typecheck (`npx tsc --noEmit | grep -iE "economy-map|state-tooltip"` empty). If ChoroplethMap's `onFeatureHover` event coordinates need viewport-relative maths different from `fixed` positioning, mirror whatever state-suburb-map.tsx does for its hover card positioning.
- [ ] **Step 5: Commit** — "feat(web): economy map explorer — choropleth, switcher, tooltips" (state-dossier import will fail to resolve until Task 3 — if so, stub `state-dossier.tsx` with a minimal placeholder component in THIS commit and note it).

---

## Task 3: State dossier + top exports

**Files:**
- Create: `web/src/@/components/economy/state-dossier.tsx`

- [ ] **Step 1: Implement.** Client component rendered inside the explorer (already behind ssr:false — direct imports fine):

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getEconomicSeriesClient } from "@/app/actions/client/getEconomyClient";
import { EconomySeriesChart } from "./economy-charts";
import { MAP_FORMATS, STATE_NAMES, type EconomyMapMetricKey, type StateSlug } from "@/lib/economy/map-metrics";

/** SITC product slugs — MUST match services/economy-collector/trade.go sitcProducts values. */
const SITC_PRODUCTS: { slug: string; label: string }[] = [
  // copy the 10 non-TOT entries from trade.go's sitcProducts map, with
  // human labels (e.g. { slug: "crude_materials_inedible_except_fuels", label: "Crude materials" })
];

const fmtAud = MAP_FORMATS.aud;

function TopExports({ state }: { state: StateSlug }) {
  const keys = SITC_PRODUCTS.map((p) => `trade.export_value.${p.slug}.${state}`);
  const { data } = useQuery({
    queryKey: ["economy-top-exports", state],
    staleTime: 60 * 60 * 1000,
    queryFn: () => getEconomicSeriesClient(keys),
  });
  const rows = (data?.series ?? [])
    .map((s) => {
      const obs = s.observations ?? [];
      const last = obs[obs.length - 1];
      const slug = s.info?.seriesKey.split(".")[2] ?? "";
      return last
        ? { label: SITC_PRODUCTS.find((p) => p.slug === slug)?.label ?? slug, value: last.value }
        : null;
    })
    .filter((r): r is { label: string; value: number } => !!r)
    .sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  const maxV = rows[0]!.value;
  return (
    <div>
      <h4 className="font-serif text-sm font-semibold">Top export commodities</h4>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-xs">
            <span className="w-40 truncate text-muted-foreground">{r.label}</span>
            <span className="h-2 rounded-sm bg-primary/70" style={{ width: `${(r.value / maxV) * 100}%`, minWidth: 2 }} />
            <span className="font-mono tabular-nums">{fmtAud(r.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const HAS_LABOUR: StateSlug[] = ["nsw", "vic", "qld", "sa", "wa", "tas"];
const HAS_DIESEL: StateSlug[] = ["nsw", "vic", "qld", "sa", "wa", "tas", "nt"];

export function StateDossier({
  state, metricKey, onClose,
}: {
  state: string;
  metricKey: EconomyMapMetricKey;
  onClose: () => void;
}) {
  const slug = state as StateSlug;
  const name = STATE_NAMES[slug];
  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-4" aria-label={`${name} dossier`}>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-serif text-xl font-semibold">{name}</h3>
          <p className="text-xs text-muted-foreground">State drill-down · sources: ABS, DCCEEW · CC BY 4.0</p>
        </div>
        <button type="button" onClick={onClose} className="font-mono text-xs text-muted-foreground hover:text-foreground">
          ✕ close
        </button>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {HAS_LABOUR.includes(slug) && (
          <div>
            <h4 className="mb-1 font-serif text-sm font-semibold">Unemployment rate</h4>
            <EconomySeriesChart seriesKey={`labour.unemployment_rate.total.${slug}.seasadj`} ariaLabel={`${name} unemployment rate`} format="percent" height={220} />
          </div>
        )}
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">State final demand</h4>
          <EconomySeriesChart seriesKey={`gdp.state_final_demand_chain_volume.total.${slug}.seasadj`} ariaLabel={`${name} state final demand`} format="aud" height={220} />
        </div>
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">Goods exports</h4>
          <EconomySeriesChart seriesKey={`trade.export_value.total.${slug}`} ariaLabel={`${name} goods exports`} format="aud" height={220} />
        </div>
        <div>
          <h4 className="mb-1 font-serif text-sm font-semibold">Goods imports</h4>
          <EconomySeriesChart seriesKey={`trade.import_value.total.${slug}`} ariaLabel={`${name} goods imports`} format="aud" height={220} />
        </div>
        {HAS_DIESEL.includes(slug) && (
          <div>
            <h4 className="mb-1 font-serif text-sm font-semibold">Diesel sales</h4>
            <EconomySeriesChart seriesKey={`petroleum.sales.diesel_oil_total.${slug}`} ariaLabel={`${name} diesel sales`} format="megalitres" height={220} />
          </div>
        )}
        <TopExports state={slug} />
      </div>
    </section>
  );
}
```

Fill `SITC_PRODUCTS` from `services/economy-collector/trade.go` (the `sitcProducts` map — 10 non-TOT slugs) with sensible short labels. (`metricKey` prop is currently only used for future emphasis — keep it in the signature per spec but it's fine to not branch on it yet.)

- [ ] **Step 2:** Typecheck clean; remove the Task 2 stub if one was committed.
- [ ] **Step 3: Commit** — "feat(web): economy state dossier — per-state charts + top exports".

---

## Task 4: Page integration + verification

**Files:**
- Modify: `web/src/app/economy/page.tsx`

- [ ] **Step 1: Integrate.** In page.tsx:
  - `import { preload } from "react-dom";` and add (top of the component body): `preload("/geo/states.topojson", { as: "fetch", crossOrigin: "anonymous" });`
  - `import { EconomyMapExplorer } from "@/components/economy/economy-map-loader";`
  - Insert `<section>` with a `SectionHeading title="Explore by state" sub="Colour the map, hover for detail, click a state to drill down."` + `<EconomyMapExplorer />` directly AFTER the tiles grid, BEFORE the Macro section.
  - REMOVE from the top-level sections (they now live in the dossier): unemployment NSW + VIC ChartCards (Macro), WA + QLD exports ChartCards (Trade), and the entire "State final demand" section (all four state ChartCards + its SectionHeading). Keep everything else (cash rate, CPI, unemployment AUS, AUD/USD, national exports/imports, all Energy charts, sources footer).
  - Update the JSON-LD Dataset description + metadata description to mention the interactive state map.
- [ ] **Step 2: Local verification** (backend 9091 + web 3020 with local-API env overrides, verify LISTEN pids; the local DB already has all data):
  - Playwright MCP: open /economy → screenshot map with default metric; hover WA → tooltip screenshot; switch metric to Trade balance (diverging palette) → screenshot; click WA → dossier + zoom screenshot; deep-link `http://localhost:3020/economy?state=qld&metric=exports` fresh-load → QLD selected + exports coloured; 390px mobile screenshot. Save to /tmp/econ-map-*.jpeg. Confirm no console errors (font-preload warnings exempt).
  - Check NT/ACT hatch + tooltip note under unemployment.
- [ ] **Step 3: Tests + build**: `npx jest src/app/actions src/@/components/economy src/@/lib/economy --silent` pass; kill dev server; `npm run build 2>&1 | tail -15` — /economy still ISR, no SSR crash.
- [ ] **Step 4: Commit** — "feat(web): /economy map-first layout — explorer hero, dossier drilldowns".

---

## Task 5: Final review + PR

- [ ] Full-diff review (main...HEAD) focused on: RSC boundary (no fn props from server), ssr:false chain integrity, registry/DB key agreement, removed-chart accounting (nothing orphaned), a11y (keyboard access to switcher buttons, aria labels).
- [ ] Push + `gh pr create` — title "feat(web): /economy map explorer — choropleth hero, state drilldowns"; body: summary, screenshots, spec/plan links, note "frontend-only, no backend changes". Do NOT merge.

---

## Self-review notes
- All ChoroplethMap/MapLegend/useTopojson props match the extracted contracts verbatim (choropleth-map.tsx:34-71, map-legend.tsx:10-22).
- Serializability: the registry carries only strings/enums; scales+formatters resolve client-side (MAP_FORMATS/continuousScale) — never cross RSC.
- The ?state deep link applies client-side via Suspense-wrapped useSearchParams (industry-intelligence landmine avoided); page.tsx never touches searchParams.
- Feature-id assumption ("NSW") is verified in Task 1 Step 0 before anything depends on it.
- Trade-balance needs 16 keys (8 states × 2) — under the 50-key RPC cap.
