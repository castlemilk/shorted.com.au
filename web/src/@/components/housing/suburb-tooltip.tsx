"use client";

import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";
import { cn } from "@/lib/utils";

type Summary = {
  salName: string; postcode: string; latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
  pctBornOverseas?: number; topReligion?: string; topLanguage?: string; pctTopLanguage?: number;
  federalDivision?: string; federalMember?: string; federalPartyAb?: string; stateDistrict?: string;
};

function fmtAUD(v: number) {
  return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
}
// Precise dollars for weekly amounts — k-rounding is misleading at income scale.
const fmtMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;
// AEC member names come as "Steve GEORGANAS" (UPPER surname) → title-case.
const fmtName = (n: string) => n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

/**
 * Suburb hover card: zero-latency stats + a lazy price sparkline keyed by region
 * code. When `onOpenProfile` is supplied it becomes the interactive "selected"
 * card — pointer-events on, a profile CTA, and a close affordance.
 */
export function SuburbTooltip({
  summary, regionCode, onOpenProfile, onClose,
}: {
  summary: Summary;
  regionCode?: string;
  onOpenProfile?: () => void;
  onClose?: () => void;
}) {
  const { data: series } = useQuery({
    queryKey: ["housing-series", regionCode ?? "", "median_price", "house", "spark"],
    queryFn: () => getHousePriceSeriesClient(regionCode!, "median_price", "house"),
    enabled: !!regionCode,
    staleTime: 60 * 60 * 1000,
  });
  const pts = (series?.points ?? []).map((p) => p.value).filter((v) => v > 0);
  const interactive = !!onOpenProfile;
  return (
    <div className={cn(
      "relative w-56 rounded-lg border border-border bg-card p-3 shadow-lg",
      interactive ? "pointer-events-auto" : "pointer-events-none",
    )}>
      {onClose ? (
        <button
          type="button" aria-label="Clear selection" onClick={onClose}
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="text-sm leading-none">×</span>
        </button>
      ) : null}
      <div className="pr-5 font-serif text-sm capitalize text-foreground">{summary.salName.toLowerCase()}</div>
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
        <dt className="text-muted-foreground">Hhd income/wk</dt><dd className="text-right tabular-nums">{summary.medianWeeklyHhdIncome ? fmtMoney(summary.medianWeeklyHhdIncome) : "—"}</dd>
        {summary.pctBornOverseas != null && summary.pctBornOverseas > 0 ? (
          <><dt className="text-muted-foreground">Born overseas</dt><dd className="text-right tabular-nums">{Math.round(summary.pctBornOverseas)}%</dd></>
        ) : null}
      </dl>
      {[summary.topReligion, summary.topLanguage, summary.federalMember].some(Boolean) ? (
        <dl className="mt-1.5 space-y-0.5 border-t border-border/60 pt-1.5 text-[11px]">
          {summary.topReligion ? (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">Religion</dt><dd className="truncate text-right text-foreground">{summary.topReligion}</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Language</dt>
            <dd className="truncate text-right text-foreground">
              {summary.topLanguage
                ? `${summary.topLanguage}${summary.pctTopLanguage ? ` (${Math.round(summary.pctTopLanguage)}%)` : ""}`
                : "English only"}
            </dd>
          </div>
          {summary.federalMember ? (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">Federal MP</dt>
              <dd className="truncate text-right text-foreground">
                {fmtName(summary.federalMember)}{summary.federalPartyAb ? ` (${summary.federalPartyAb})` : ""}
              </dd>
            </div>
          ) : null}
          {summary.stateDistrict ? (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">State seat</dt>
              <dd className="truncate text-right text-foreground">{summary.stateDistrict}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {onOpenProfile ? (
        <button
          type="button" onClick={onOpenProfile}
          className="mt-2.5 w-full rounded-md border border-border bg-foreground/[0.03] px-2 py-1.5 text-center text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          Open full profile →
        </button>
      ) : null}
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
