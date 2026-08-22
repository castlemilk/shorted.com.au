// Server component. Two smoothed distributions of the suburb's own state, with a
// marker where this suburb falls — the visual answer to "is $3.4M a lot?".
//
// Rendered as plain SVG on the server: no chart library, no client bundle, no
// ssr:false island. The curves come from the state suburb list the page already
// holds (see lib/housing/suburb-stats), which is why each panel states the exact
// population it is drawn over.
//
// Exported without card chrome on purpose. It used to be its own card, six
// sections above "How it compares" — two renderings of one idea, separated by the
// whole page. They now sit in one section: the curve shows the population, the
// bars show the distance to the baselines.
import { DENSITY_H, DENSITY_W, ordinal, type Density } from "@/lib/housing/suburb-stats";

export type SuburbDistributionPanelsProps = {
  priceDist: Density | null;
  pricePct: number | null;
  incomeDist: Density | null;
  incomePct: number | null;
  fmtPrice: (v: number) => string;
  fmtIncome: (v: number) => string;
  censusYear?: number;
};

export function SuburbDistributionPanels({
  priceDist,
  pricePct,
  incomeDist,
  incomePct,
  fmtPrice,
  fmtIncome,
  censusYear,
}: SuburbDistributionPanelsProps) {
  if (!priceDist && !incomeDist) return null;
  return (
    <div className="grid gap-7 sm:grid-cols-2">
      {priceDist ? (
        <Panel
          label="Median house price"
          pct={pricePct}
          dist={priceDist}
          fmt={fmtPrice}
          footnote={`${priceDist.n.toLocaleString()} priced suburbs`}
        />
      ) : null}
      {incomeDist ? (
        <Panel
          label="Household income / wk"
          pct={incomePct}
          dist={incomeDist}
          fmt={fmtIncome}
          footnote={`ABS Census${censusYear ? ` ${censusYear}` : ""}`}
        />
      ) : null}
    </div>
  );
}

function Panel({
  label,
  pct,
  dist,
  fmt,
  footnote,
}: {
  label: string;
  pct: number | null;
  dist: Density;
  fmt: (v: number) => string;
  footnote: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{label}</span>
        {pct !== null ? (
          <span className="font-mono font-semibold tabular-nums text-primary">
            {ordinal(pct)} percentile
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${DENSITY_W} ${DENSITY_H}`}
        className="mt-1.5 block w-full"
        role="img"
        aria-label={
          pct !== null
            ? `${label}: this suburb sits at the ${ordinal(pct)} percentile of the state distribution`
            : `${label}: distribution across the state`
        }
      >
        <path d={dist.path} fill="hsl(var(--muted))" stroke="hsl(var(--border))" />
        <line
          x1={dist.markerX}
          y1="2"
          x2={dist.markerX}
          y2={DENSITY_H - 2}
          stroke="hsl(var(--primary))"
          strokeWidth="2"
        />
        <circle cx={dist.markerX} cy="2.5" r="2.5" fill="hsl(var(--primary))" />
      </svg>
      <div className="mt-1 flex justify-between gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
        {/* The domain is trimmed to the 1st..99th percentile, so an edge label
            gets a marker rather than claiming to be the true extreme. */}
        <span>{dist.clippedLow ? `<${fmt(dist.min)}` : fmt(dist.min)}</span>
        <span>{footnote}</span>
        <span>{dist.clippedHigh ? `${fmt(dist.max)}+` : fmt(dist.max)}</span>
      </div>
    </div>
  );
}
