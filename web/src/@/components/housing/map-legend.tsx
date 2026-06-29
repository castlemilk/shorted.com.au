"use client";

import { fmtPriceShort } from "@/lib/housing/price-scale";

/**
 * Decodes the choropleth: a gradient bar sampled from the SAME colour scale the
 * map uses, with min/max ticks, plus a "no price data" hatch swatch so the grey
 * suburbs explain themselves.
 */
export function MapLegend({
  colorScale, min, max, label = "Median house price", showNoData = true,
  format = fmtPriceShort, noDataLabel = "No price data",
}: {
  colorScale: (v: number) => string;
  min: number;
  max: number;
  label?: string;
  showNoData?: boolean;
  /** tick formatter — defaults to compact AUD for the price ramp. */
  format?: (v: number) => string;
  noDataLabel?: string;
}) {
  const lo = min > 0 ? min : 0;
  const stops = Array.from({ length: 10 }, (_, i) => i / 9);
  const gradient = `linear-gradient(to right, ${stops
    .map((t) => colorScale(lo + t * (max - lo)))
    .join(", ")})`;
  const mid = lo + (max - lo) / 2;

  return (
    <div className="pointer-events-none rounded-lg border border-border bg-card/90 px-3 py-2 shadow-sm backdrop-blur">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 h-2 w-40 rounded-sm" style={{ background: gradient }} />
      <div className="mt-0.5 flex w-40 justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>{format(lo)}</span>
        <span>{format(mid)}</span>
        <span>{format(max)}</span>
      </div>
      {showNoData ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-sm border border-border"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, hsl(var(--muted)), hsl(var(--muted)) 2px, hsl(var(--border)) 2px, hsl(var(--border)) 3px)",
            }}
          />
          {noDataLabel}
        </div>
      ) : null}
    </div>
  );
}
