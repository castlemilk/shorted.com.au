"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import type { GetEconomicSeriesResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { STATE_NAMES, type StateSlug } from "@/lib/economy/map-metrics";
import type { Obs } from "@/lib/economy/map-metrics";
import { topCorrelations } from "@/lib/economy/correlation";
import { hasDiesel, hasLabour } from "./availability";
import { EconomyIcon } from "./economy-icon";
import { DualAxisChart } from "./dual-axis-chart";

// Formatter chosen by a serializable key (this is a client component, so a
// small local map is fine — but keys keep it consistent with the rest of the
// economy surface where the server picks the format).
type FormatKey = "aud" | "percent" | "index" | "megalitres";
const FORMATTERS: Record<FormatKey, (v: number) => string> = {
  aud: (v) => {
    const a = Math.abs(v);
    const sign = v < 0 ? "−" : "";
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
    return `${sign}$${a.toFixed(0)}`;
  },
  percent: (v) => `${v.toFixed(1)}%`,
  index: (v) => v.toFixed(1),
  megalitres: (v) => (Math.abs(v) >= 1_000 ? `${(v / 1_000).toFixed(1)}GL` : `${v.toFixed(0)}ML`),
};

interface CandidateDef {
  key: string;
  label: string;
  format: FormatKey;
}

/** The state's economic series we test against local short interest. */
function candidateDefs(state: StateSlug): CandidateDef[] {
  const defs: CandidateDef[] = [
    { key: `trade.export_value.total.${state}`, label: "Goods exports", format: "aud" },
    { key: `trade.import_value.total.${state}`, label: "Goods imports", format: "aud" },
    {
      key: `gdp.state_final_demand_chain_volume.total.${state}.seasadj`,
      label: "State final demand",
      format: "aud",
    },
    { key: `govfin.revenue.total.${state}`, label: "Govt revenue", format: "aud" },
  ];
  if (hasLabour(state)) {
    defs.push({
      key: `labour.unemployment_rate.total.${state}.seasadj`,
      label: "Unemployment rate",
      format: "percent",
    });
  }
  if (hasDiesel(state)) {
    defs.push({
      key: `petroleum.sales.diesel_oil_total.${state}`,
      label: "Diesel sales",
      format: "megalitres",
    });
  }
  return defs;
}

/** Extract a series' observations from the batched response by series key. */
function obsFor(res: GetEconomicSeriesResponse | undefined, key: string): Obs[] {
  const s = res?.series.find((d) => d.info?.seriesKey === key);
  return (s?.observations ?? [])
    .map((o) => ({
      date: new Date(Number(o.period?.seconds ?? 0n) * 1000),
      value: o.value,
    }))
    .filter((p) => !Number.isNaN(p.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Format a coefficient with a proper minus sign, e.g. "r = −0.62". */
function fmtR(r: number): string {
  return `r = ${r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}`;
}

const SHORT_LABEL = "Local short interest";

/**
 * "Local short interest vs …" — correlates the state's exposure-weighted short
 * interest against its economic series. Renders rolling-Pearson chips (|r| ≥ 0.4,
 * ≥ 12 aligned months) and a dual-axis overlay with a secondary-series switcher.
 *
 * Descriptive only — the footnote states correlation ≠ causation. On a sparse
 * local short series (prod has ~138 months, dev ~5) the chips are correctly
 * absent; the overlay still renders whatever overlaps.
 */
export function StateCorrelations({ state }: { state: StateSlug }) {
  const name = STATE_NAMES[state];
  const shortKey = `markets.short_interest_wavg.${state}`;
  const defs = useMemo(() => candidateDefs(state), [state]);
  const allKeys = useMemo(() => [shortKey, ...defs.map((d) => d.key)], [shortKey, defs]);

  const { data, isLoading } = useQuery({
    queryKey: ["economy-correlations", state],
    queryFn: () => getEconomicSeriesClient(allKeys),
    staleTime: 60 * 60 * 1000,
  });

  const shortObs = useMemo(() => obsFor(data, shortKey), [data, shortKey]);

  // Candidate series that actually returned data (>= 2 points to draw a line).
  const available = useMemo(
    () => defs.map((d) => ({ ...d, series: obsFor(data, d.key) })).filter((d) => d.series.length >= 2),
    [defs, data],
  );

  const ranked = useMemo(
    () =>
      topCorrelations(
        shortObs,
        available.map((d) => ({ key: d.key, label: d.label, series: d.series })),
        { minAbsR: 0.4, minN: 12, windowMonths: 24 },
      ),
    [shortObs, available],
  );

  // Default overlay pairing: strongest |r|, else goods exports, else first available.
  const exportsKey = `trade.export_value.total.${state}`;
  const defaultKey =
    ranked[0]?.key ??
    (available.some((d) => d.key === exportsKey) ? exportsKey : available[0]?.key) ??
    "";
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const activeKey = selectedKey ?? defaultKey;
  const active = available.find((d) => d.key === activeKey);

  if (isLoading) {
    return <div className="h-[320px] w-full animate-pulse rounded bg-muted" />;
  }

  // Nothing to correlate against and no short series at all → drop the section.
  if (available.length === 0 && shortObs.length < 2) return null;

  return (
    <section aria-label={`${name} short interest correlations`} className="space-y-4">
      <div>
        <h3 className="flex items-center gap-1.5 font-serif text-lg font-semibold">
          <EconomyIcon name="short-interest" size={20} />
          Local short interest vs the {name} economy
        </h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Exposure-weighted short interest across ASX companies operating in {name},
          overlaid on the state&rsquo;s economic series.
        </p>
      </div>

      {ranked.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {ranked.slice(0, 3).map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSelectedKey(c.key)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                activeKey === c.key
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              <EconomyIcon name="short-interest" size={14} />
              <span className="font-medium text-foreground">{c.label}</span>
              <span className="text-muted-foreground">vs {SHORT_LABEL.toLowerCase()}</span>
              <span className="font-mono tabular-nums">· {fmtR(c.r)} · {c.n}m</span>
            </button>
          ))}
        </div>
      ) : null}

      {active ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <DualAxisChart
            primary={shortObs}
            secondary={active.series}
            primaryLabel={SHORT_LABEL}
            secondaryLabel={active.label}
            formatPrimary={FORMATTERS.percent}
            formatSecondary={FORMATTERS[active.format]}
            ariaLabel={`${name} local short interest versus ${active.label}`}
            height={280}
          />
          {available.length > 1 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Compare against:</span>
              {available.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setSelectedKey(d.key)}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    activeKey === d.key
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Not enough overlapping data to chart a correlation yet.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Correlations are descriptive, not causal · current-constituent weighting.
      </p>
    </section>
  );
}
