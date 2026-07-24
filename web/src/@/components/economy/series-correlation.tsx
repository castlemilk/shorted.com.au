"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  getEconomicSeriesClient,
  listSeriesCorrelationsClient,
} from "~/app/actions/client/getEconomyClient";
import {
  ECONOMY_SERIES_FORMATTERS,
  observationsFor,
  type EconomyCorrelationSeriesDef,
} from "@/lib/economy/map-metrics";
import { topCorrelations } from "@/lib/economy/correlation";
import { EconomyIcon } from "./economy-icon";
import { DualAxisChart } from "./dual-axis-chart";

export type CorrelationSeriesDef = EconomyCorrelationSeriesDef;

export interface SeriesCorrelationProps {
  anchor: CorrelationSeriesDef;
  overlayCandidates: CorrelationSeriesDef[];
  title: string;
  description: string;
  sectionAriaLabel: string;
  chartAriaLabel: string;
  defaultOverlayKey?: string;
  precomputedBaseKey?: string;
  /** Industry series are derived and may not exist; state anchors retain legacy permissive behaviour. */
  requireAnchor?: boolean;
  missingAnchorMessage?: string;
}

function formatCoefficient(value: number): string {
  return `r = ${value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;
}

/**
 * Shared arbitrary-series correlation surface. It owns data loading, rolling
 * Pearson ranking, chips, the overlay switcher and both client-side formatters.
 * Callers supply only serializable series definitions and copy.
 */
export function SeriesCorrelation({
  anchor,
  overlayCandidates,
  title,
  description,
  sectionAriaLabel,
  chartAriaLabel,
  defaultOverlayKey,
  precomputedBaseKey,
  requireAnchor = false,
  missingAnchorMessage = "No anchor-series history is available yet.",
}: SeriesCorrelationProps) {
  const overlayKeys = useMemo(
    () => overlayCandidates.map((candidate) => candidate.key),
    [overlayCandidates],
  );
  const candidateByKey = useMemo(
    () =>
      new Map(
        overlayCandidates.map((candidate) => [candidate.key, candidate]),
      ),
    [overlayCandidates],
  );
  const precomputedQuery = useQuery({
    queryKey: ["economy-series-correlations", precomputedBaseKey],
    queryFn: () => listSeriesCorrelationsClient(precomputedBaseKey!),
    enabled: precomputedBaseKey !== undefined,
    staleTime: 60 * 60 * 1000,
  });
  const precomputedRows = useMemo(
    () => precomputedQuery.data?.correlations ?? [],
    [precomputedQuery.data],
  );
  const useLegacyComputation =
    precomputedBaseKey === undefined ||
    (precomputedQuery.isFetched && precomputedRows.length === 0);
  const anchorQuery = useQuery({
    queryKey: ["economy-series-correlation-anchor", anchor.key],
    queryFn: () => getEconomicSeriesClient([anchor.key]),
    staleTime: 60 * 60 * 1000,
  });
  const overlayQuery = useQuery({
    queryKey: ["economy-series-correlation-overlays", ...overlayKeys],
    queryFn: () => getEconomicSeriesClient(overlayKeys),
    enabled: useLegacyComputation && overlayKeys.length > 0,
    staleTime: 60 * 60 * 1000,
  });
  const legacyData = useMemo(
    () => ({
      series: [
        ...(anchorQuery.data?.series ?? []),
        ...(overlayQuery.data?.series ?? []),
      ],
    }),
    [anchorQuery.data, overlayQuery.data],
  );

  const anchorObservations = useMemo(
    () => observationsFor(anchorQuery.data, anchor.key),
    [anchor.key, anchorQuery.data],
  );
  const legacyAvailable = useMemo(
    () =>
      overlayCandidates
        .map((candidate) => ({
          ...candidate,
          series: observationsFor(legacyData, candidate.key),
        }))
        .filter((candidate) => candidate.series.length >= 2),
    [legacyData, overlayCandidates],
  );
  const legacyRanked = useMemo(
    () =>
      topCorrelations(
        anchorObservations,
        legacyAvailable.map((candidate) => ({
          key: candidate.key,
          label: candidate.label,
          series: candidate.series,
        })),
        { minAbsR: 0.4, minN: 12, windowMonths: 24 },
      ),
    [anchorObservations, legacyAvailable],
  );
  const precomputedAvailable = useMemo(
    () =>
      precomputedRows.flatMap((correlation) => {
        const candidate = candidateByKey.get(correlation.overlaySeriesKey);
        return candidate
          ? [
              {
                ...candidate,
                r: correlation.r,
                n: correlation.n,
              },
            ]
          : [];
      }),
    [candidateByKey, precomputedRows],
  );
  const available = useLegacyComputation
    ? legacyAvailable
    : precomputedAvailable;
  const ranked = useLegacyComputation
    ? legacyRanked
    : precomputedAvailable;

  const fallbackKey =
    ranked[0]?.key ??
    (defaultOverlayKey &&
    available.some((candidate) => candidate.key === defaultOverlayKey)
      ? defaultOverlayKey
      : available[0]?.key) ??
    "";
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const activeKey =
    selectedKey && available.some((candidate) => candidate.key === selectedKey)
      ? selectedKey
      : fallbackKey;
  const precomputedOverlayQuery = useQuery({
    queryKey: ["economy-series-correlation-overlay", activeKey],
    queryFn: () => getEconomicSeriesClient([activeKey]),
    enabled:
      precomputedBaseKey !== undefined &&
      !useLegacyComputation &&
      activeKey !== "",
    staleTime: 60 * 60 * 1000,
  });
  const activeCandidate = useLegacyComputation
    ? legacyAvailable.find((candidate) => candidate.key === activeKey)
    : precomputedAvailable.find((candidate) => candidate.key === activeKey);
  const activeSeries = useMemo(
    () =>
      useLegacyComputation
        ? legacyAvailable.find((candidate) => candidate.key === activeKey)
            ?.series ?? []
        : observationsFor(precomputedOverlayQuery.data, activeKey),
    [
      activeKey,
      legacyAvailable,
      precomputedOverlayQuery.data,
      useLegacyComputation,
    ],
  );
  const active = useMemo(
    () =>
      activeCandidate && activeSeries.length >= 2
        ? { ...activeCandidate, series: activeSeries }
        : undefined,
    [activeCandidate, activeSeries],
  );
  const chartSecondary = useMemo(() => {
    if (!active) return [];
    const anchorStart = anchorObservations[0]?.date.getTime();
    if (anchorStart === undefined) return active.series;
    return active.series.filter(
      (observation) => observation.date.getTime() >= anchorStart,
    );
  }, [active, anchorObservations]);
  const isLoading =
    anchorQuery.isLoading ||
    (precomputedBaseKey !== undefined && precomputedQuery.isLoading) ||
    (useLegacyComputation
      ? overlayQuery.isLoading
      : precomputedOverlayQuery.isLoading);

  if (isLoading) {
    return <div className="h-[320px] w-full animate-pulse rounded bg-muted" />;
  }

  if (!requireAnchor && available.length === 0 && anchorObservations.length < 2) {
    return null;
  }

  const missingRequiredAnchor = requireAnchor && anchorObservations.length < 2;

  return (
    <section aria-label={sectionAriaLabel} className="space-y-4">
      <div>
        <h3 className="flex items-center gap-1.5 font-serif text-lg font-semibold">
          <EconomyIcon name="short-interest" size={20} />
          {title}
        </h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {description}
        </p>
      </div>

      {missingRequiredAnchor ? (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {missingAnchorMessage}
        </p>
      ) : (
        <>
          {ranked.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {ranked.slice(0, 3).map((correlation) => (
                <button
                  key={correlation.key}
                  type="button"
                  onClick={() => setSelectedKey(correlation.key)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    activeKey === correlation.key
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <EconomyIcon name="short-interest" size={14} />
                  <span className="font-medium text-foreground">
                    {correlation.label}
                  </span>
                  <span className="text-muted-foreground">
                    vs {anchor.label.toLowerCase()}
                  </span>
                  <span className="font-mono tabular-nums">
                    · {formatCoefficient(correlation.r)} · {correlation.n}m
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {active ? (
            <div className="rounded-lg border border-border bg-card p-4">
              <DualAxisChart
                primary={anchorObservations}
                secondary={chartSecondary}
                primaryLabel={anchor.label}
                secondaryLabel={active.label}
                formatPrimary={ECONOMY_SERIES_FORMATTERS[anchor.format]}
                formatSecondary={ECONOMY_SERIES_FORMATTERS[active.format]}
                ariaLabel={`${chartAriaLabel} ${active.label}`}
                height={280}
              />
              {available.length > 1 ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Compare against:
                  </span>
                  {available.map((candidate) => (
                    <button
                      key={candidate.key}
                      type="button"
                      onClick={() => setSelectedKey(candidate.key)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        activeKey === candidate.key
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {candidate.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              Not enough overlapping data to chart a correlation yet.
            </p>
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Correlations are descriptive, not causal · current-constituent weighting.
      </p>
    </section>
  );
}
