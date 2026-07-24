"use client";

import { SeriesCorrelation } from "@/components/economy/series-correlation";
import { industryShortInterestSeriesKey } from "@/lib/economy/industry-context";
import { NATIONAL_ECONOMY_OVERLAYS } from "@/lib/economy/map-metrics";

/** Selected-industry bridge into the generic economy correlation surface. */
export function IndustryEconomyContext({
  industryName,
}: {
  industryName: string;
}) {
  const anchorKey = industryShortInterestSeriesKey(industryName);
  const title = `${industryName} short interest vs the economy`;
  const description =
    "Compare the industry’s average short interest with national commodity, credit, labour, wage and inflation indicators.";
  const missingAnchorMessage = `No derived short-interest history is available for ${industryName} yet. Smaller industries may not meet the current constituent threshold.`;

  if (anchorKey === null) {
    return (
      <section aria-label={`${industryName} economy context`} className="space-y-4">
        <div>
          <h3 className="font-serif text-lg font-semibold">{title}</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {missingAnchorMessage}
        </p>
      </section>
    );
  }

  return (
    <SeriesCorrelation
      anchor={{
        key: anchorKey,
        label: `${industryName} short interest`,
        format: "percent",
      }}
      overlayCandidates={NATIONAL_ECONOMY_OVERLAYS}
      title={title}
      description={description}
      sectionAriaLabel={`${industryName} economy context`}
      chartAriaLabel={`${industryName} industry short interest versus`}
      defaultOverlayKey="commodities.price_index.bulk.aus"
      precomputedBaseKey={anchorKey}
      requireAnchor
      missingAnchorMessage={missingAnchorMessage}
    />
  );
}
