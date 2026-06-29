"use client";

import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";

type Summary = {
  salName: string; postcode: string; latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
};

function fmtAUD(v: number) {
  return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
}

/** Hover card: zero-latency stats + a lazy price sparkline keyed by region code. */
export function SuburbTooltip({ summary, regionCode }: { summary: Summary; regionCode?: string }) {
  const { data: series } = useQuery({
    queryKey: ["housing-series", regionCode ?? "", "median_price", "house", "spark"],
    queryFn: () => getHousePriceSeriesClient(regionCode!, "median_price", "house"),
    enabled: !!regionCode,
    staleTime: 60 * 60 * 1000,
  });
  const pts = (series?.points ?? []).map((p) => p.value).filter((v) => v > 0);
  return (
    <div className="pointer-events-none w-56 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="font-serif text-sm capitalize text-foreground">{summary.salName.toLowerCase()}</div>
      <div className="text-[11px] text-muted-foreground">{summary.postcode}</div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="font-mono text-lg tabular-nums text-foreground">
          {summary.latestMedianPrice > 0 ? fmtAUD(summary.latestMedianPrice) : "—"}
        </span>
        {summary.latestMedianPrice > 0 && summary.yoyPct !== 0 ? (
          <span className={summary.yoyPct >= 0 ? "text-[color:var(--semantic-green)]" : "text-[color:var(--semantic-red)]"}>
            {summary.yoyPct >= 0 ? "+" : ""}{summary.yoyPct.toFixed(1)}% yr
          </span>
        ) : null}
      </div>
      {pts.length > 1 ? <Sparkline values={pts} /> : null}
      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground">Population</dt><dd className="text-right tabular-nums">{summary.population.toLocaleString()}</dd>
        <dt className="text-muted-foreground">Median age</dt><dd className="text-right tabular-nums">{summary.medianAge || "—"}</dd>
        <dt className="text-muted-foreground">Hhd income/wk</dt><dd className="text-right tabular-nums">{summary.medianWeeklyHhdIncome ? fmtAUD(summary.medianWeeklyHhdIncome) : "—"}</dd>
      </dl>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 200, h = 32, min = Math.min(...values), max = Math.max(...values);
  const d = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg width={w} height={h} className="mt-2"><path d={d} fill="none" stroke="var(--accent-amber,#f59e0b)" strokeWidth={1.5} /></svg>;
}
