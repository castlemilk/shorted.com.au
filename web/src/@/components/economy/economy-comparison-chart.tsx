"use client";

import { useQuery } from "@tanstack/react-query";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import {
  ECONOMY_SERIES_FORMATTERS,
  observationsFor,
  type EconomySeriesDisplayFormat,
} from "@/lib/economy/map-metrics";
import { DualAxisChart } from "./dual-axis-chart";

/** Fetches and plots two economic series through the existing two-line chart primitive. */
export function EconomyComparisonChart({
  primaryKey,
  secondaryKey,
  primaryLabel,
  secondaryLabel,
  ariaLabel,
  format,
  height = 220,
  sharedScale = false,
}: {
  primaryKey: string;
  secondaryKey: string;
  primaryLabel: string;
  secondaryLabel: string;
  ariaLabel: string;
  format: EconomySeriesDisplayFormat;
  height?: number;
  sharedScale?: boolean;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["economy-series-comparison", primaryKey, secondaryKey],
    queryFn: () => getEconomicSeriesClient([primaryKey, secondaryKey]),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div
        className="w-full animate-pulse rounded bg-muted"
        style={{ height }}
      />
    );
  }

  const formatter = ECONOMY_SERIES_FORMATTERS[format];
  return (
    <DualAxisChart
      primary={observationsFor(data, primaryKey)}
      secondary={observationsFor(data, secondaryKey)}
      primaryLabel={primaryLabel}
      secondaryLabel={secondaryLabel}
      formatPrimary={formatter}
      formatSecondary={formatter}
      ariaLabel={ariaLabel}
      height={height}
      sharedScale={sharedScale}
    />
  );
}
