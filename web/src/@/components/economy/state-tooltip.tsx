"use client";

import type { Obs } from "@/lib/economy/map-metrics";

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
  name, value, metricLabel, format, period, yoy, higherIsBad, rank, spark, unavailableNote, companyCount, pinned,
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
  /** aggregate metrics only — "N companies operating here" (no sparkline/yoy) */
  companyCount?: number;
  /** small-viewport variant: full-width panel pinned inside the map container */
  pinned?: boolean;
}) {
  return (
    <div
      className={`${pinned ? "w-auto" : "w-56"} max-w-full rounded-lg border border-border bg-card p-3 shadow-lg`}
    >
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
          {companyCount != null && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {companyCount} {companyCount === 1 ? "company" : "companies"} operating here
            </div>
          )}
          {spark && <Sparkline points={spark} />}
        </>
      )}
    </div>
  );
}
