"use client";

import { useMemo, useState, useCallback, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { ChoroplethMap } from "@/components/housing/choropleth-map";
import { MapLegend } from "@/components/housing/map-legend";
import { useTopojson } from "@/components/housing/use-topojson";
import {
  getEconomicSeriesClient,
  getStateCompanyAggregatesClient,
} from "~/app/actions/client/getEconomyClient";
import {
  ECONOMY_MAP_METRICS, ECONOMY_SERIES_FORMATTERS, METRIC_BY_KEY, STATE_NAMES, STATE_SLUGS,
  buildStateValues, continuousScale, divergingScale, rankOf, seriesKeysFor,
  toFeatureId, toSlug, toTopoFeatureId, fromTopoFeatureId,
  type EconomyMapMetric, type EconomyMapMetricKey, type StateSeries, type StateValue,
} from "@/lib/economy/map-metrics";
import { StateTooltip } from "./state-tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";

// Verified in Task 1 Step 0: /geo/states.topojson's single object, with
// NUMERIC ABS STE_CODE21 feature ids "1".."8" (bridged below via
// toTopoFeatureId/fromTopoFeatureId — buildStateValues stays keyed by "NSW").
const TOPO_OBJECT = "STE_2021_AUST_GDA2020";

// StateTooltip is w-56 (224px); ~180px tall with sparkline. Used to flip the
// hover card away from viewport edges (state-suburb-map.tsx pattern —
// matching its 220px height allowance so the sparkline never clips at the
// bottom edge of the viewport).
const TOOLTIP_W = 224;
const TOOLTIP_H = 220;
const VISIBLE_METRIC_COUNT = 8;

/**
 * Safe topo-id → state abbreviation lookup: returns null for ids not in the
 * STE_CODE map (e.g. a future boundary rebuild adding "9"/Other Territories)
 * instead of letting fromTopoFeatureId throw mid-render.
 */
function abbrFromTopoId(id: string): string | null {
  try {
    return fromTopoFeatureId(id);
  } catch {
    return null;
  }
}

/** Fetch + reshape one metric's series into StateSeries keyed for buildStateValues. */
function useMetricData(metric: EconomyMapMetric) {
  return useQuery({
    queryKey: ["economy-map", metric.key],
    staleTime: 60 * 60 * 1000,
    enabled: metric.kind === "series",
    queryFn: async () => {
      if (metric.kind !== "series") return {};
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

interface AggValue {
  value: number;
  companyCount: number;
}

/**
 * One fetch covers BOTH aggregate metrics (footprint + short interest) — the
 * RPC returns every state's aggregate row in a single response, so the query
 * key is metric-independent.
 */
function useAggregateData(enabled: boolean) {
  return useQuery({
    queryKey: ["economy-map-agg"],
    staleTime: 60 * 60 * 1000,
    enabled,
    queryFn: async () => {
      const resp = await getStateCompanyAggregatesClient();
      if (!resp) throw new Error("state company aggregates unavailable");
      // keyed by lowercase state slug ("nsw"), per the RPC contract
      const byState: Record<string, {
        companyCount: number;
        exposureWeightedMarketCap: number;
        exposureWeightedShortPercent: number;
      }> = {};
      for (const a of resp.aggregates ?? []) {
        byState[a.state] = {
          companyCount: a.companyCount,
          exposureWeightedMarketCap: a.exposureWeightedMarketCap,
          exposureWeightedShortPercent: a.exposureWeightedShortPercent,
        };
      }
      return byState;
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
  const router = useRouter();
  const [metricKey, setMetricKey] = useState<EconomyMapMetricKey>("unemployment");
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null); // id = topo id "1".."8"
  // < 640px: the tooltip pins to the bottom of the map instead of floating at
  // the pointer (floating cards overflow small viewports). SSR-safe: this is
  // a client-only component, and the effect only runs in the browser.
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const metric = METRIC_BY_KEY[metricKey];
  const isAggregate = metric.kind === "aggregate";
  const { data: topo } = useTopojson("/geo/states.topojson");
  const seriesQuery = useMetricData(metric);
  const aggQuery = useAggregateData(isAggregate);
  const byKey = seriesQuery.data;
  const isError = isAggregate ? aggQuery.isError : seriesQuery.isError;
  const refetch = isAggregate ? aggQuery.refetch : seriesQuery.refetch;

  // Keyed by "NSW"-style abbreviations (buildStateValues contract).
  const values = useMemo(
    () =>
      metric.kind === "series" && byKey
        ? buildStateValues(metric, byKey)
        : new Map<string, StateValue>(),
    [byKey, metric],
  );

  // Aggregate metrics: value + company count keyed by "NSW"-style abbreviations.
  const aggValues = useMemo(() => {
    const m = new Map<string, AggValue>();
    if (metric.kind !== "aggregate" || !aggQuery.data) return m;
    for (const [slug, row] of Object.entries(aggQuery.data)) {
      m.set(toFeatureId(slug), {
        value: row[metric.aggField],
        companyCount: row.companyCount,
      });
    }
    return m;
  }, [aggQuery.data, metric]);

  // Bridge: ChoroplethMap wants maps keyed by the REAL topojson feature ids.
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const slug of STATE_SLUGS) {
      const abbr = toFeatureId(slug);
      const v = isAggregate ? aggValues.get(abbr)?.value : values.get(abbr)?.latest;
      m.set(toTopoFeatureId(slug), v ?? null);
    }
    return m;
  }, [values, aggValues, isAggregate]);

  const [min, max] = useMemo(() => {
    const nums = [...valueById.values()].filter((v): v is number => v != null);
    return nums.length ? [Math.min(...nums), Math.max(...nums)] : [0, 1];
  }, [valueById]);

  const scale = useMemo(
    () => (metric.palette === "diverging" ? divergingScale(min, max) : continuousScale(min, max)),
    [metric.palette, min, max],
  );

  const nameById = useMemo(
    () => new Map(STATE_SLUGS.map((s) => [toTopoFeatureId(s), STATE_NAMES[s]])),
    [],
  );

  const format = ECONOMY_SERIES_FORMATTERS[metric.format];
  const latestRanks = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, v] of valueById) if (v != null) m.set(id, v);
    return m;
  }, [valueById]);

  // URL sync (write side) — metric only now; a selected state is its own route.
  const syncMetric = useCallback((mk: EconomyMapMetricKey) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("metric", mk);
    window.history.replaceState(null, "", url);
  }, []);

  // Deep-link read side: ?metric= still selects a metric; the legacy ?state=X
  // link now REDIRECTS to the real /economy/X route (the SPA dossier is gone).
  const applyDeepLink = useCallback((state: string | null, mk: string | null) => {
    if (mk && mk in METRIC_BY_KEY) setMetricKey(mk as EconomyMapMetricKey);
    if (state && (STATE_SLUGS as readonly string[]).includes(state)) {
      router.replace(`/economy/${state}`);
    }
  }, [router]);

  const selectMetric = (mk: EconomyMapMetricKey) => {
    setMetricKey(mk);
    syncMetric(mk);
  };
  const visibleMetrics = useMemo(() => {
    const first = ECONOMY_MAP_METRICS.slice(0, VISIBLE_METRIC_COUNT);
    const selected = METRIC_BY_KEY[metricKey];
    if (first.some((candidate) => candidate.key === selected.key)) {
      return first;
    }
    return [...first.slice(0, VISIBLE_METRIC_COUNT - 1), selected];
  }, [metricKey]);
  const visibleMetricKeys = useMemo(
    () => new Set(visibleMetrics.map((candidate) => candidate.key)),
    [visibleMetrics],
  );
  const overflowMetrics = useMemo(
    () =>
      ECONOMY_MAP_METRICS.filter(
        (candidate) => !visibleMetricKeys.has(candidate.key),
      ),
    [visibleMetricKeys],
  );

  const hoverAbbr = hover ? abbrFromTopoId(hover.id) : null;
  const hoverValue = hoverAbbr ? values.get(hoverAbbr) : undefined;
  const hoverAgg = hoverAbbr ? aggValues.get(hoverAbbr) : undefined;
  const hoverSlug = hoverAbbr ? toSlug(hoverAbbr) : null;
  const hoverUnavailable =
    hoverSlug && metric.kind === "series"
      ? metric.unavailableStates?.includes(hoverSlug)
      : false;

  return (
    <div className="relative">
      <Suspense fallback={null}>
        <DeepLinkSync onApply={applyDeepLink} />
      </Suspense>

      {/* Metric switcher */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Colour by</span>
        {visibleMetrics.map((m) => (
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
        {overflowMetrics.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                More
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {overflowMetrics.map((m) => (
                <DropdownMenuItem
                  key={m.key}
                  onSelect={() => selectMetric(m.key)}
                >
                  {m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
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
            onFeatureClick={(id) => {
              const abbr = abbrFromTopoId(id);
              if (!abbr) return; // unknown topo id (e.g. Other Territories)
              router.push(`/economy/${toSlug(abbr)}`);
            }}
            onFeatureHover={(id, evt) => {
              if (!id || !evt || !abbrFromTopoId(id)) return setHover(null);
              setHover({ id, x: evt.clientX, y: evt.clientY });
            }}
          />
        )}
        {hover && (() => {
          const card = isAggregate ? (
            <StateTooltip
              pinned={isNarrow}
              name={nameById.get(hover.id) ?? hover.id}
              value={hoverAgg?.value ?? null}
              metricLabel={metric.label}
              format={format}
              higherIsBad={metric.higherIsBad}
              rank={rankOf(latestRanks, hover.id)}
              companyCount={hoverAgg?.companyCount}
            />
          ) : (
            <StateTooltip
              pinned={isNarrow}
              name={nameById.get(hover.id) ?? hover.id}
              value={hoverUnavailable ? null : hoverValue?.latest ?? null}
              metricLabel={metric.label}
              format={format}
              period={hoverValue?.latestDate.toLocaleDateString("en-AU", { month: "short", year: "numeric" })}
              yoy={hoverValue?.yoy}
              higherIsBad={metric.higherIsBad}
              rank={rankOf(latestRanks, hover.id)}
              spark={hoverValue?.spark}
              unavailableNote={metric.kind === "series" ? metric.unavailableNote : undefined}
            />
          );
          // Small viewports: pin the card to the bottom of the map container
          // — always inside bounds, regardless of where the tap landed.
          if (isNarrow) {
            return (
              <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-50">
                {card}
              </div>
            );
          }
          // Desktop: float at the pointer, CLAMPED to the viewport (flip-only
          // logic still overflowed near corners).
          const left = Math.min(Math.max(hover.x + 14, 8), window.innerWidth - TOOLTIP_W - 8);
          const top = Math.min(Math.max(hover.y + 14, 8), window.innerHeight - TOOLTIP_H - 8);
          return (
            <div className="pointer-events-none fixed z-50" style={{ left, top }}>
              {card}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
