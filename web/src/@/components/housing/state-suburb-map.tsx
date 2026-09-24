"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { listCouncilsClient } from "~/app/actions/client/getHousingClient";
import { ChoroplethMap, type OverlayHit } from "./choropleth-map";
import { MapLegend } from "./map-legend";
import { CategoricalLegend } from "./categorical-legend";
import { makePriceScale, robustDomainTop } from "@/lib/housing/price-scale";
import {
  COLUMN_METRIC_GROUPS, HIGHLIGHT_METRICS, METRIC_BY_KEY, METRIC_ICON, amberScale, isColumnSourced, type MetricKey, type HighlightMetric,
} from "@/lib/housing/highlight-metrics";
import {
  OVERLAYS, OVERLAY_BY_KEY, overlayAvailable, parseOverlayParam, serializeOverlayParam, type OverlayKey,
} from "@/lib/housing/overlays";
import { HousingIcon } from "./housing-icon";
import { useTopojson } from "./use-topojson";
import { useSuburbColumns } from "./use-suburb-columns";
import { useOverlayLayers } from "./use-overlay-layers";
import { OverlayControl, OverlayLegend, OverlaySources, type OverlayOpacities } from "./overlay-control";
import { SuburbTooltip, type TooltipExtra } from "./suburb-tooltip";
import { CouncilLevelMap } from "./council-level-map";
import { councilBorders, lgaCodesFromColumn } from "@/lib/housing/council-geometry";
import {
  COUNCIL_METRICS, DEFAULT_COUNCIL_METRIC, isCouncilMetricKey, type CouncilMetricKey,
} from "@/lib/housing/council-metrics";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export type SuburbDatum = {
  salCode: string; salName: string; postcode: string;
  latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
  pctBornOverseas: number; topReligion: string; topLanguage: string; pctTopLanguage: number;
  federalDivision: string; federalMember: string; federalParty: string;
  federalPartyAb: string; federalTppAlp: number; stateDistrict: string;
  stateMember: string; stateParty: string; statePartyAb: string;
  regionCode?: string;
  // amenity/lifestyle metrics (Local Insights)
  schoolsTotal: number;
  schoolsGov: number; schoolsCatholic: number; schoolsIndependent: number;
  schoolsPrimary: number; schoolsSecondary: number; nearestSecondaryKm: number;
  supermarketsTotal: number;
  colesCount: number; woolworthsCount: number; aldiCount: number; igaCount: number;
  pubsBars: number; parksCount: number; librariesCount: number;
  nearestSupermarketKm: number; amenityDensityScore: number;
  hospitalsCount: number; gpCount: number; pharmacyCount: number;
  nearestTrainKm: number; nearestHospitalKm: number; distToCoastKm: number;
  dominantNbnTech: string; connectivityQualityScore: number;
  crimeBreakInsRank: number; crimeViolentRank: number; crimeMotorVehicleRank: number;
  politicianPropertyCount: number;
};

const TOOLTIP_W = 224;
const TOOLTIP_H = 260;

const ROW_METRICS = HIGHLIGHT_METRICS.filter((m) => !isColumnSourced(m));
// Column metrics (continuous and categorical) are picker sections, in
// COLUMN_METRIC_GROUPS order.
const COLUMN_SECTIONS = COLUMN_METRIC_GROUPS.map((group) => ({
  ...group,
  metrics: HIGHLIGHT_METRICS.filter((m) => isColumnSourced(m) && m.group === group.key),
})).filter((section) => section.metrics.length > 0);

// Per-viewer overlay opacities. A convenience, not state worth a URL: the
// right weighting depends on the reader's display, so it is remembered here
// and never shared. Reads/writes are wrapped because storage can throw.
const OPACITY_STORAGE_KEY = "housing.overlay.opacity";
function readOpacities(): OverlayOpacities {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(OPACITY_STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: OverlayOpacities = {};
    for (const o of OVERLAYS) {
      const v = parsed[o.key];
      if (typeof v === "number" && v >= 0.1 && v <= 0.9) out[o.key] = v;
    }
    return out;
  } catch {
    return {};
  }
}
function writeOpacities(next: OverlayOpacities) {
  try { window.localStorage.setItem(OPACITY_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
}

function isMetricKey(value: string | null): value is MetricKey {
  return value !== null && value in METRIC_BY_KEY;
}

export type MapLevel = "suburb" | "council";

/** The lga_code column (dominant council per suburb) — requested only when used. */
const LGA_COLUMN = ["lga_code"] as const;
const NO_COLUMNS: readonly string[] = [];

export interface MapView {
  level: MapLevel;
  metricKey: MetricKey;
  councilMetricKey: CouncilMetricKey;
  overlays: readonly OverlayKey[];
  councilBorders: boolean;
  defaultMetric: MetricKey;
}

/**
 * The view (level + metric + overlays + council borders) as URL params.
 * Defaults are omitted so the canonical `/housing/nsw` stays clean for the
 * crawler. At council level `metric` names a COUNCIL metric key
 * (`?level=council&metric=population_growth`); borders are implied there.
 */
export function viewSearchParams(view: MapView, base: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(base);
  if (view.level === "council") {
    out.set("level", "council");
    if (view.councilMetricKey === DEFAULT_COUNCIL_METRIC) out.delete("metric");
    else out.set("metric", view.councilMetricKey);
    out.delete("boundaries");
  } else {
    out.delete("level");
    if (view.metricKey === view.defaultMetric) out.delete("metric");
    else out.set("metric", view.metricKey);
    if (view.councilBorders) out.set("boundaries", "councils");
    else out.delete("boundaries");
  }
  const serialized = serializeOverlayParam(view.overlays);
  if (serialized) out.set("overlays", serialized);
  else out.delete("overlays");
  return out;
}

/**
 * Writes the view into the URL without a navigation, so a map someone has set
 * up is a link they can send. Same mechanism as the economy explorer
 * (`economy-map-explorer.tsx`).
 */
function syncViewToUrl(view: MapView) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.search = viewSearchParams(view, url.searchParams).toString();
  window.history.replaceState(null, "", url);
}

export function StateSuburbMap({
  stateCode, suburbs, selectedSalCode, hoveredSalCode, onSelect, onHover, onOpenProfile,
}: {
  stateCode: string; // e.g. "NSW"
  suburbs: SuburbDatum[];
  selectedSalCode?: string;
  hoveredSalCode?: string;
  onSelect: (salCode: string | null) => void;
  onHover?: (salCode: string | null) => void;
  onOpenProfile: (salCode: string) => void;
}) {
  const { data: topo, isLoading, isError } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const searchParams = useSearchParams();
  const [hover, setHover] = useState<{ d: SuburbDatum; x: number; y: number; hits?: OverlayHit[] } | null>(null);
  const deepLinkedMetric = searchParams.get("metric");
  // The ACT is one council (Unincorporated ACT): no council level, no borders.
  const councilsSupported = stateCode !== "ACT";
  const deepLinkedCouncil = councilsSupported && searchParams.get("level") === "council";
  const [level, setLevel] = useState<MapLevel>(deepLinkedCouncil ? "council" : "suburb");
  const [councilMetricKey, setCouncilMetricKey] = useState<CouncilMetricKey>(
    deepLinkedCouncil && isCouncilMetricKey(deepLinkedMetric) ? deepLinkedMetric : DEFAULT_COUNCIL_METRIC);
  const [showCouncilBorders, setShowCouncilBorders] = useState(
    councilsSupported && searchParams.get("boundaries") === "councils");
  const suburbDeepLink = !deepLinkedCouncil && isMetricKey(deepLinkedMetric) ? deepLinkedMetric : null;
  const [metricKey, setMetricKey] = useState<MetricKey>(suburbDeepLink ?? "price");
  const [overlays, setOverlays] = useState<OverlayKey[]>(() => parseOverlayParam(searchParams.get("overlays")));
  const [opacities, setOpacities] = useState<OverlayOpacities>(() => readOpacities());
  const setOpacity = useCallback((key: OverlayKey, opacity: number) => {
    setOpacities((prev) => {
      const next = { ...prev, [key]: opacity };
      writeOpacities(next);
      return next;
    });
  }, []);
  const [mapReady, setMapReady] = useState(false);
  const metric: HighlightMetric = METRIC_BY_KEY[metricKey];

  useEffect(() => {
    setMapReady(false);
    if (!topo) return;

    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setMapReady(true));
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [topo]);

  // When the loaded state has no priced suburbs, defaulting to "price" paints a
  // blank map. Fall back to population (always populated from the Census) so
  // the map is immediately useful — unless the user (or the URL) picked one.
  const userPickedMetric = useRef(suburbDeepLink !== null);
  const defaultMetric = useRef<MetricKey>("price");
  useEffect(() => {
    if (suburbs.length === 0) return;
    const anyPriced = suburbs.some((s) => s.latestMedianPrice > 0);
    defaultMetric.current = anyPriced ? "price" : "population";
    if (userPickedMetric.current) return;
    setMetricKey(defaultMetric.current);
  }, [suburbs]);

  const view: MapView = {
    level, metricKey, councilMetricKey, overlays, councilBorders: showCouncilBorders,
    defaultMetric: defaultMetric.current,
  };
  const viewRef = useRef(view);
  viewRef.current = view;
  const updateView = useCallback((patch: Partial<MapView>) => {
    syncViewToUrl({ ...viewRef.current, ...patch, defaultMetric: defaultMetric.current });
  }, []);
  const selectMetric = useCallback((key: MetricKey) => {
    userPickedMetric.current = true;
    setMetricKey(key);
    updateView({ metricKey: key });
  }, [updateView]);
  const selectCouncilMetric = useCallback((key: CouncilMetricKey) => {
    setCouncilMetricKey(key);
    updateView({ councilMetricKey: key });
  }, [updateView]);
  const selectLevel = useCallback((next: MapLevel) => {
    setLevel(next);
    updateView({ level: next });
  }, [updateView]);
  const toggleCouncilBorders = useCallback(() => {
    const next = !viewRef.current.councilBorders;
    setShowCouncilBorders(next);
    updateView({ councilBorders: next });
  }, [updateView]);
  const selectOverlays = useCallback((next: OverlayKey[]) => {
    setOverlays(next);
    updateView({ overlays: next });
  }, [updateView]);

  // Council level + council borders both need each suburb's dominant council
  // (one ~18 KB column, fetched only once either is on) — the council shapes
  // are merged from the suburb topology on the client, no new geometry asset.
  const needCouncils = councilsSupported && (level === "council" || showCouncilBorders);
  const lgaColumn = useSuburbColumns(stateCode, needCouncils ? LGA_COLUMN : NO_COLUMNS);
  const lgaBySal = useMemo(() => lgaCodesFromColumn(lgaColumn.data?.get("lga_code")), [lgaColumn.data]);
  const councilList = useQuery({
    queryKey: ["councils", stateCode],
    queryFn: () => listCouncilsClient(stateCode),
    staleTime: 60 * 60 * 1000,
    // Borders mode needs it too: the suburb tooltip names the council.
    enabled: needCouncils,
  });
  const councilNameByCode = useMemo(
    () => new Map((councilList.data?.councils ?? []).map((c) => [c.lgaCode, c.displayName] as const)),
    [councilList.data],
  );

  // Columnar fetch: the coloured metric when it is column-sourced, plus the
  // share behind every active overlay so the tooltip can quote a number for the
  // layer the reader is looking at. ~18 KB each; the index is shared.
  const activeOverlays = useMemo(
    () => overlays.filter((k) => overlayAvailable(k, stateCode)), [overlays, stateCode]);
  const columnKeys = useMemo(() => {
    const keys = new Set<string>();
    if (isColumnSourced(metric)) keys.add(metric.key);
    for (const k of activeOverlays) keys.add(OVERLAY_BY_KEY[k].metricKey);
    return [...keys];
  }, [metric, activeOverlays]);
  const columns = useSuburbColumns(stateCode, columnKeys);
  const overlayLayers = useOverlayLayers(stateCode, activeOverlays, opacities);
  const removeOverlay = useCallback((key: OverlayKey) => selectOverlays(overlays.filter((k) => k !== key)), [overlays, selectOverlays]);

  const byCode = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s])), [suburbs]);

  // Stable price map — drives the price metric AND the fitToData framing (kept
  // independent of the toggled metric so switching never resets the zoom).
  const priceValueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of suburbs) m.set(s.salCode, s.latestMedianPrice > 0 ? s.latestMedianPrice : null);
    return m;
  }, [suburbs]);
  const priceScale = useMemo(() => {
    const vals = suburbs.map((s) => s.latestMedianPrice).filter((v) => v > 0);
    const min = vals.length ? Math.min(...vals) : 0;
    // Percentile, not max: see robustDomainTop. Anchoring on the raw maximum put
    // the MEDIAN NSW suburb at 9.5% of the ramp and painted the state one colour.
    const max = robustDomainTop(vals);
    const clamped = vals.some((v) => v > max);
    return { scale: makePriceScale(max), min, max, clamped };
  }, [suburbs]);
  const nameById = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s.salName])), [suburbs]);

  // Continuous metric → value map + scale over its own range. Row metrics read
  // the SuburbDatum; column metrics read the fetched column.
  const continuous = useMemo(() => {
    if (metric.kind === "categorical" || metric.kind === "column-categorical") return null;
    if (metric.key === "price") {
      return {
        valueById: priceValueById, scale: priceScale.scale,
        min: priceScale.min, max: priceScale.max, clamped: priceScale.clamped,
      };
    }
    let m: Map<string, number | null>;
    if (metric.kind === "column") {
      const col = columns.data?.get(metric.key);
      if (!col) return null;
      m = col;
    } else {
      m = new Map<string, number | null>();
      for (const s of suburbs) m.set(s.salCode, metric.value(s));
    }
    const vals: number[] = [];
    for (const v of m.values()) if (v != null) vals.push(v);
    // An explicit domain (crime ranks, political lean, shares) is already
    // bounded and is left exactly alone; only data-derived domains get the
    // percentile top.
    const [min, max] = metric.domain ?? [
      vals.length ? Math.min(...vals) : 0,
      robustDomainTop(vals),
    ];
    const clamped = vals.some((v) => v > max);
    const scale = metric.makeScale ? metric.makeScale(min, max) : amberScale(min, max, metric.sqrt);
    return { valueById: m, scale, min, max, clamped };
  }, [metric, suburbs, priceValueById, priceScale, columns.data]);

  // Categorical metric → category map + the legend entries actually present.
  const categorical = useMemo(() => {
    if (metric.kind === "column-categorical") {
      // Server-labelled column: the legend lists the dictionary entries present.
      const col = columns.categories?.get(metric.key);
      if (!col) return null;
      const present = new Set<string>();
      for (const c of col.byId.values()) if (c) present.add(c);
      const entries = col.labels.filter((l) => present.has(l)).map((l) => ({ label: l, color: metric.colorForLabel(l) }));
      return { categoryById: col.byId, entries };
    }
    if (metric.kind !== "categorical") return null;
    const m = new Map<string, string | null>();
    const present = new Set<string>();
    for (const s of suburbs) {
      const c = metric.category(s);
      m.set(s.salCode, c);
      if (c) present.add(c);
    }
    const entries = metric.order.filter((o) => present.has(o)).map((o) => ({ label: o, color: metric.colorFor(o) }));
    return { categoryById: m, entries };
  }, [metric, suburbs, columns.categories]);

  // Tooltip rows: the column metric being coloured (if any) and one row per
  // active overlay, so the picture and the number travel together.
  const extrasFor = useCallback((salCode: string, hits?: readonly OverlayHit[]): TooltipExtra[] => {
    const rows: TooltipExtra[] = [];
    // Hover identify: the zoning class under the pointer, first — it answers
    // "what is THIS spot zoned?", which the suburb-level share cannot.
    for (const h of hits ?? []) {
      rows.push({ label: `${OVERLAY_BY_KEY[h.key as OverlayKey]?.label ?? h.key} here`, value: h.label, color: h.color });
    }
    const seen = new Set<string>();
    const push = (key: string, label: string, format: (v: number) => string, color?: string, missing = "—") => {
      if (seen.has(key)) return;
      seen.add(key);
      const col = columns.data?.get(key);
      if (!col) return;
      const v = col.get(salCode);
      rows.push({ label, value: v == null ? missing : format(v), color });
    };
    // With council borders on, name the suburb's dominant council — the lines
    // alone do not say which side is which.
    const council = showCouncilBorders ? councilNameByCode.get(lgaBySal.get(salCode) ?? "") : undefined;
    if (council) rows.push({ label: "Council", value: council });
    const pushCategory = (key: string, label: string, colorForLabel: (l: string) => string, missing = "—") => {
      if (seen.has(key)) return;
      seen.add(key);
      const col = columns.categories?.get(key);
      if (!col) return;
      const v = col.byId.get(salCode);
      rows.push({ label, value: v ?? missing, color: v ? colorForLabel(v) : undefined });
    };
    if (metric.kind === "column") push(metric.key, metric.label, metric.format);
    if (metric.kind === "column-categorical") pushCategory(metric.key, metric.label, metric.colorForLabel);
    for (const k of activeOverlays) {
      const o = OVERLAY_BY_KEY[k];
      const def = METRIC_BY_KEY[o.metricKey as MetricKey];
      if (def?.kind === "column-categorical") pushCategory(o.metricKey, o.shareLabel, def.colorForLabel);
      else push(o.metricKey, o.shareLabel, def?.kind === "column" ? def.format : (v) => `${Math.round(v)}%`, o.color);
    }
    return rows;
  }, [metric, activeOverlays, columns.data, columns.categories, showCouncilBorders, councilNameByCode, lgaBySal]);

  // Council borders over the suburb map: shared arcs between suburbs in
  // different councils (topojson.mesh), drawn as a non-scaling line layer.
  const councilLines = useMemo(() => {
    if (!showCouncilBorders || !topo || lgaBySal.size === 0) return undefined;
    const geometry = councilBorders(topo, Object.keys(topo.objects)[0]!, lgaBySal);
    return geometry ? [{ key: "council-borders", geometry, width: 1.3, opacity: 0.75 }] : undefined;
  }, [showCouncilBorders, topo, lgaBySal]);

  const metricItem = (m: HighlightMetric) => (
    <SelectItem key={m.key} value={m.key}>
      <span className="flex items-center gap-2">
        <HousingIcon name={METRIC_ICON[m.key]} size={16} />
        {m.label}
      </span>
    </SelectItem>
  );

  const levelToggle = councilsSupported ? (
    <div role="group" aria-label="Map level" className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
      {(["suburb", "council"] as const).map((l) => (
        <button
          key={l} type="button" aria-pressed={level === l} onClick={() => selectLevel(l)}
          className={`h-8 px-2.5 transition-colors ${level === l ? "bg-foreground/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {l === "suburb" ? "Suburbs" : "Councils"}
        </button>
      ))}
    </div>
  ) : null;

  const councilControls = (
    <div className="flex w-full flex-wrap items-center gap-2">
      {levelToggle}
      <span className="shrink-0 text-xs text-muted-foreground">Colour by</span>
      <Select value={councilMetricKey} onValueChange={(v) => selectCouncilMetric(v as CouncilMetricKey)}>
        <SelectTrigger aria-label="Colour the councils by" className="h-8 min-w-0 flex-1 text-xs sm:w-[220px] sm:flex-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COUNCIL_METRICS.map((m) => (
            <SelectItem key={m.key} value={m.key}>
              <span className="flex items-center gap-2">
                <HousingIcon name={m.icon} size={16} />
                {m.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <OverlayControl
        stateCode={stateCode} active={overlays} opacities={opacities} loading={overlayLayers.loadingKeys}
        onChange={selectOverlays} onOpacityChange={setOpacity}
      />
    </div>
  );

  const suburbControls = (
    <div className="flex w-full flex-wrap items-center gap-2">
      {levelToggle}
      <span className="shrink-0 text-xs text-muted-foreground">Colour by</span>
      <Select value={metricKey} onValueChange={(v) => selectMetric(v as MetricKey)}>
        <SelectTrigger aria-label="Colour the map by" className="h-8 min-w-0 flex-1 text-xs sm:w-[220px] sm:flex-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROW_METRICS.map(metricItem)}
          {COLUMN_SECTIONS.map((section) => (
            <Fragment key={section.key}>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{section.label}</SelectLabel>
                {section.metrics.map(metricItem)}
              </SelectGroup>
            </Fragment>
          ))}
        </SelectContent>
      </Select>
      {councilsSupported ? (
        <button
          type="button" aria-pressed={showCouncilBorders} onClick={toggleCouncilBorders}
          className={`h-8 shrink-0 rounded-md border px-2.5 text-xs transition-colors ${showCouncilBorders ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
        >
          Council borders
        </button>
      ) : null}
      <OverlayControl
        stateCode={stateCode} active={overlays} opacities={opacities} loading={overlayLayers.loadingKeys}
        onChange={selectOverlays} onOpacityChange={setOpacity}
      />
    </div>
  );
  const controls = level === "council" ? councilControls : suburbControls;

  if (isError) {
    return (
      <div className="flex h-[460px] w-full items-center justify-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Map unavailable — browse suburbs in the list.
      </div>
    );
  }
  const mapFrame = (children: ReactNode) => (
    <div className="flex min-h-[520px] flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        {controls}
      </div>
      <div className="relative flex min-h-[460px] flex-1 flex-col overflow-hidden rounded-xl">
        {children}
      </div>
      <OverlaySources
        stateCode={stateCode} active={activeOverlays}
        metricKey={level === "council" ? undefined : metric.key} className="mt-2"
      />
    </div>
  );

  if (isLoading || !topo || !mapReady) {
    return (
      mapFrame(<div className="absolute inset-0 animate-pulse bg-muted" />)
    );
  }
  const objectName = Object.keys(topo.objects)[0]!;

  if (level === "council") {
    const councils = councilList.data?.councils ?? [];
    const failed = (!lgaColumn.isLoading && !lgaColumn.data) || (!councilList.isLoading && councils.length === 0);
    if (failed) {
      return mapFrame(
        <div className="absolute inset-0 flex items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground" role="status">
          Council map unavailable right now.{" "}
          <button type="button" className="ml-1 underline" onClick={() => { void lgaColumn.refetch(); void councilList.refetch(); }}>Retry</button>
        </div>,
      );
    }
    if (lgaBySal.size === 0 || councils.length === 0) {
      return mapFrame(
        <div className="absolute inset-0 animate-pulse bg-muted" role="status" aria-label="Loading councils" />,
      );
    }
    return mapFrame(
      <CouncilLevelMap
        stateCode={stateCode} topology={topo} objectName={objectName} lgaBySal={lgaBySal}
        councils={councils} metricKey={councilMetricKey} overlays={overlayLayers.layers}
        dropsStamps={{ asOf: councilList.data?.priceDropsAsOf, dataThrough: councilList.data?.priceDropsDataThrough }}
        legendExtra={<OverlayLegend stateCode={stateCode} active={overlays} opacities={opacities} onRemove={removeOverlay} />}
      />,
    );
  }

  const selected = selectedSalCode ? byCode.get(selectedSalCode) : undefined;
  const columnReady = metric.kind === "column-categorical" ? Boolean(categorical) : Boolean(continuous);
  const columnPending = isColumnSourced(metric) && !columnReady && columns.isLoading;
  const columnFailed = isColumnSourced(metric) && !columnReady && !columns.isLoading;

  const colourLegend = metric.kind === "categorical" || metric.kind === "column-categorical"
    ? (categorical?.entries.length
        ? <CategoricalLegend label={metric.legendLabel} entries={categorical.entries}
            noDataLabel={metric.kind === "column-categorical" ? (metric.noDataLabel ?? "No data") : "No data"} />
        : null)
    : (continuous
        ? <MapLegend
            colorScale={(v) => continuous.scale(v)} min={continuous.min} max={continuous.max}
            clamped={continuous.clamped}
            label={metric.legendLabel} format={metric.format}
            noDataLabel={metric.key === "price" ? "No price data" : metric.kind === "column" ? (metric.noDataLabel ?? "No data") : "No data"} />
        : null);
  const legend = (
    <div className="flex flex-col gap-1.5">
      {colourLegend}
      <OverlayLegend stateCode={stateCode} active={overlays} opacities={opacities} onRemove={removeOverlay} />
    </div>
  );

  return mapFrame(
    <>
        <ChoroplethMap
          fill
          topology={topo}
          objectName={objectName}
          valueById={continuous?.valueById ?? (isColumnSourced(metric) ? new Map() : priceValueById)}
          colorScale={(v) => (continuous?.scale ?? priceScale.scale)(v)}
          categoryById={categorical?.categoryById}
          categoryColor={metric.kind === "categorical" ? metric.colorFor : metric.kind === "column-categorical" ? metric.colorForLabel : undefined}
          fitValueById={priceValueById}
          nameById={nameById}
          selectedId={selectedSalCode}
          hoveredId={hoveredSalCode}
          focusId={selectedSalCode}
          fitToData
          ariaLabel={`${stateCode} suburbs by ${metric.label}${activeOverlays.length ? `, with ${activeOverlays.map((k) => OVERLAY_BY_KEY[k].label.toLowerCase()).join(" and ")} overlay` : ""}`}
          legend={legend}
          overlays={overlayLayers.layers}
          lines={councilLines}
          onFeatureClick={(id) => onSelect(id)}
          onFeatureHover={(id, evt, hits) => {
            onHover?.(id);
            if (!id || !evt) return setHover(null);
            const d = byCode.get(id);
            if (d) setHover({ d, x: evt.clientX, y: evt.clientY, hits });
          }}
        />

        {(columnPending || overlayLayers.isLoading) ? (
          <div className="pointer-events-none absolute right-2 top-12 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur" role="status">
            Loading {columnPending ? metric.label.toLowerCase() : "overlay"}…
          </div>
        ) : null}
        {columnFailed ? (
          <div className="absolute right-2 top-12 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur" role="status">
            {metric.label} unavailable right now.{" "}
            <button type="button" className="underline" onClick={() => columns.refetch()}>Retry</button>
          </div>
        ) : null}

        {/* Selected suburb: persistent, interactive card with a profile CTA. */}
        {selected ? (
          <div className="absolute left-2 top-2 z-20">
            <SuburbTooltip
              summary={selected}
              regionCode={selected.regionCode}
              extras={extrasFor(selected.salCode)}
              onOpenProfile={() => onOpenProfile(selected.salCode)}
              onClose={() => onSelect(null)}
            />
          </div>
        ) : null}

        {/* Hover card (transient, at cursor) — suppressed while a suburb is selected. */}
        {hover && !selected ? (
          <div
            className="pointer-events-none fixed z-50"
            style={{
              left: hover.x + TOOLTIP_W + 18 > window.innerWidth ? hover.x - TOOLTIP_W - 14 : hover.x + 14,
              top: hover.y + TOOLTIP_H + 18 > window.innerHeight ? hover.y - TOOLTIP_H : hover.y + 14,
            }}
          >
            <SuburbTooltip summary={hover.d} regionCode={hover.d.regionCode} extras={extrasFor(hover.d.salCode, hover.hits)} />
          </div>
        ) : null}
    </>,
  );
}
