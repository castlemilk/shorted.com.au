"use client";

import { useQuery } from "@tanstack/react-query";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import type { GetEconomicSeriesResponse } from "~/gen/shorts/v1alpha1/economy_pb";
import {
  ECONOMY_SERIES_FORMATTERS,
  type EconomySeriesDisplayFormat,
  type Obs,
} from "@/lib/economy/map-metrics";
import { DualAxisChart } from "./dual-axis-chart";

function observationsFor(
  response: Pick<GetEconomicSeriesResponse, "series"> | undefined,
  key: string,
): Obs[] {
  const series = response?.series.find((item) => item.info?.seriesKey === key);
  return (series?.observations ?? [])
    .filter((observation) => observation.period != null)
    .map((observation) => ({
      date: new Date(Number(observation.period!.seconds) * 1000),
      value: observation.value,
    }))
    .filter((point) => !Number.isNaN(point.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Fetches and plots two economic series through the existing two-line chart primitive. */
export function EconomyComparisonChart({
  primaryKey,
  secondaryKey,
  primaryLabel,
  secondaryLabel,
  ariaLabel,
  format,
  height = 220,
}: {
  primaryKey: string;
  secondaryKey: string;
  primaryLabel: string;
  secondaryLabel: string;
  ariaLabel: string;
  format: EconomySeriesDisplayFormat;
  height?: number;
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
    />
  );
}
