import Link from "next/link";

import { STATE_NAMES, type StateSlug } from "@/lib/economy/map-metrics";
import { cn } from "@/lib/utils";

export interface StockStateExposureItem {
  state: StateSlug;
  weight: number;
  basis: string;
  source: string;
}

function exposureBand(weight: number): string {
  if (weight >= 0.5) return "Majority of operations (estimate)";
  if (weight >= 0.25) return "Significant operations exposure (estimate)";
  return "Some operations exposure (estimate)";
}

/**
 * Crawlable stock-to-economy links with deliberately coarse exposure claims.
 * Headquarters-only rows and estimates without a supporting basis are withheld.
 */
export function StockStateExposure({
  exposures,
  className,
}: {
  exposures: StockStateExposureItem[];
  className?: string;
}) {
  const operations = exposures
    .filter(
      (exposure) =>
        exposure.source === "llm" &&
        Number.isFinite(exposure.weight) &&
        exposure.weight > 0 &&
        exposure.basis.trim().length > 0,
    )
    .sort((a, b) => b.weight - a.weight);

  if (operations.length === 0) return null;

  return (
    <section
      aria-labelledby="stock-operations-exposure-heading"
      className={cn("-mt-3 mb-6", className)}
    >
      <h2
        id="stock-operations-exposure-heading"
        className="text-xs font-medium text-muted-foreground"
      >
        Operations exposure
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
        {operations.map((exposure) => (
          <li key={exposure.state} className="min-w-0 max-w-sm text-xs">
            <p className="flex flex-wrap items-baseline gap-x-1.5">
              <Link
                href={`/economy/${exposure.state}`}
                prefetch={false}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {STATE_NAMES[exposure.state]}
              </Link>
              <span className="text-muted-foreground">
                {exposureBand(exposure.weight)}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Basis: <span>{exposure.basis}</span>
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Coarse bands are AI estimates based on public company information.
      </p>
    </section>
  );
}
