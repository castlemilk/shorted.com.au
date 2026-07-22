"use client";

import {
  SeriesCorrelation,
  type CorrelationSeriesDef,
} from "@/components/economy/series-correlation";
import { industryShortInterestSeriesKey } from "@/lib/economy/industry-context";

const NATIONAL_ECONOMY_OVERLAYS: CorrelationSeriesDef[] = [
  {
    key: "commodities.price_index.bulk.aus",
    label: "Bulk commodity prices",
    format: "index",
  },
  {
    key: "commodities.price_index.all_items.aus",
    label: "Commodity prices (all items)",
    format: "index",
  },
  {
    key: "credit.growth_yoy.business.aus.seasadj",
    label: "Business credit growth",
    format: "percent",
  },
  {
    key: "labour.job_vacancies.aus",
    label: "Job vacancies",
    format: "number",
  },
  {
    key: "wages.wpi_yoy.aus",
    label: "Wage growth",
    format: "percent",
  },
  {
    key: "cpi.annual_change.all_groups.aus",
    label: "Inflation",
    format: "percent",
  },
];

/** Selected-industry bridge into the generic economy correlation surface. */
export function IndustryEconomyContext({
  industryName,
}: {
  industryName: string;
}) {
  return (
    <SeriesCorrelation
      anchor={{
        key: industryShortInterestSeriesKey(industryName),
        label: `${industryName} short interest`,
        format: "percent",
      }}
      overlayCandidates={NATIONAL_ECONOMY_OVERLAYS}
      title={`${industryName} short interest vs the economy`}
      description="Compare the industry’s average short interest with national commodity, credit, labour, wage and inflation indicators."
      sectionAriaLabel={`${industryName} economy context`}
      chartAriaLabel={`${industryName} industry short interest versus`}
      defaultOverlayKey="commodities.price_index.bulk.aus"
      requireAnchor
      missingAnchorMessage={`No derived short-interest history is available for ${industryName} yet. Smaller industries may not meet the current constituent threshold.`}
    />
  );
}
