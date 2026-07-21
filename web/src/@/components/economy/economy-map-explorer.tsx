"use client";

import { useMemo, useState, useCallback, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ChoroplethMap } from "@/components/housing/choropleth-map";
import { MapLegend } from "@/components/housing/map-legend";
import { useTopojson } from "@/components/housing/use-topojson";
import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import {
  ECONOMY_MAP_METRICS, METRIC_BY_KEY, MAP_FORMATS, STATE_NAMES, STATE_SLUGS,
  buildStateValues, continuousScale, divergingScale, rankOf, seriesKeysFor,
  toFeatureId, toSlug, toTopoFeatureId, fromTopoFeatureId,
  type EconomyMapMetric, type EconomyMapMetricKey, type StateSeries, type StateValue,
} from "@/lib/economy/map-metrics";
import { StateTooltip } from "./state-tooltip";
import { StateDossier } from "./state-dossier";

// Verified in Task 1 Step 0: /geo/states.topojson's single object, with
// NUMERIC ABS STE_CODE21 feature ids "1".."8" (bridged below via
// toTopoFeatureId/fromTopoFeatureId — buildStateValues stays keyed by "NSW").
const TOPO_OBJECT = "STE_2021_AUST_GDA2020";

// StateTooltip is w-56 (224px); ~180px tall with sparkline. Used to flip the
// hover card away from viewport edges (state-suburb-map.tsx pattern).
const TOOLTIP_W = 224;
const TOOLTIP_H = 190;

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
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null); // id = topo id "1".."8"

  const metric = METRIC_BY_KEY[metricKey];
  const { data: topo } = useTopojson("/geo/states.topojson");
  const { data: byKey, isError, refetch } = useMetricData(metric);

  // Keyed by "NSW"-style abbreviations (buildStateValues contract).
  const values = useMemo(
    () => (byKey ? buildStateValues(metric, byKey) : new Map<string, StateValue>()),
    [byKey, metric],
  );

  // Bridge: ChoroplethMap wants maps keyed by the REAL topojson feature ids.
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const slug of STATE_SLUGS) {
      const v = values.get(toFeatureId(slug));
      m.set(toTopoFeatureId(slug), v ? v.latest : null);
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
    () => new Map(STATE_SLUGS.map((s) => [toTopoFeatureId(s), STATE_NAMES[s]])),
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

  const hoverValue = hover ? values.get(fromTopoFeatureId(hover.id)) : undefined;
  const hoverSlug = hover ? toSlug(fromTopoFeatureId(hover.id)) : null;
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
            selectedId={selected ? toTopoFeatureId(selected) : undefined}
            focusId={selected ? toTopoFeatureId(selected) : undefined}
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
              const slug = toSlug(fromTopoFeatureId(id));
              selectState(selected === slug ? null : slug);
            }}
            onFeatureHover={(id, evt) => {
              if (!id || !evt) return setHover(null);
              setHover({ id, x: evt.clientX, y: evt.clientY });
            }}
          />
        )}
        {hover && (
          <div
            className="pointer-events-none fixed z-50"
            style={{
              left: hover.x + TOOLTIP_W + 18 > window.innerWidth ? hover.x - TOOLTIP_W - 14 : hover.x + 14,
              top: hover.y + TOOLTIP_H + 18 > window.innerHeight ? hover.y - TOOLTIP_H : hover.y + 14,
            }}
          >
            <StateTooltip
              name={nameById.get(hover.id) ?? hover.id}
              value={hoverUnavailable ? null : hoverValue?.latest ?? null}
              metricLabel={metric.label}
              format={format}
              period={hoverValue?.latestDate.toLocaleDateString("en-AU", { month: "short", year: "numeric" })}
              yoy={hoverValue?.yoy}
              higherIsBad={metric.higherIsBad}
              rank={rankOf(latestRanks, hover.id)}
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
