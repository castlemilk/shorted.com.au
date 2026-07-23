"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import type { GetEconomicSeriesResponse } from "~/gen/shorts/v1alpha1/economy_pb";
import {
  STATE_NAMES,
  type EconomySeriesDisplayFormat,
  type Obs,
  type StateSlug,
} from "@/lib/economy/map-metrics";
import { EconomyIcon } from "./economy-icon";
import { EconomySeriesChartView } from "./economy-charts";

export const CRIME_OFFENCES = [
  { slug: "homicide", label: "Homicide" },
  { slug: "assault", label: "Assault" },
  { slug: "sexual-assault", label: "Sexual assault" },
  { slug: "robbery", label: "Robbery" },
  { slug: "unlawful-entry", label: "Unlawful entry" },
  { slug: "motor-vehicle-theft", label: "Motor vehicle theft" },
  { slug: "other-theft", label: "Other theft" },
] as const;

type CrimeOffence = (typeof CRIME_OFFENCES)[number]["slug"];
type CrimeMeasure = "count" | "rate";

const CRIME_MEASURES: Record<
  CrimeMeasure,
  {
    prefix: "crime.victims" | "crime.victims_rate_100k";
    label: string;
    format: EconomySeriesDisplayFormat;
  }
> = {
  count: { prefix: "crime.victims", label: "Count", format: "number" },
  rate: {
    prefix: "crime.victims_rate_100k",
    label: "Rate per 100,000",
    format: "rate",
  },
};

function seriesKey(
  state: StateSlug,
  offence: CrimeOffence,
  measure: CrimeMeasure,
): string {
  return `${CRIME_MEASURES[measure].prefix}.${offence}.${state}`;
}

function crimeKeys(state: StateSlug): string[] {
  return CRIME_OFFENCES.flatMap(({ slug }) => [
    seriesKey(state, slug, "count"),
    seriesKey(state, slug, "rate"),
  ]);
}

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

/** Annual ABS Recorded Crime — Victims card for an individual state page. */
export function StateCrimeCard({ state }: { state: StateSlug }) {
  const [selectedOffence, setSelectedOffence] =
    useState<CrimeOffence>("homicide");
  const [measure, setMeasure] = useState<CrimeMeasure>("count");
  const keys = useMemo(() => crimeKeys(state), [state]);
  const { data, isLoading } = useQuery({
    queryKey: ["economy-state-crime", state],
    queryFn: () => getEconomicSeriesClient(keys),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="h-[340px] w-full animate-pulse rounded bg-muted" />;
  }

  const availableKeys = new Set(
    (data?.series ?? [])
      .filter((item) => item.observations.length > 0)
      .map((item) => item.info?.seriesKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (availableKeys.size === 0) return null;

  const firstAvailableOffence =
    CRIME_OFFENCES.find(({ slug }) =>
      (["count", "rate"] as const).some((candidateMeasure) =>
        availableKeys.has(seriesKey(state, slug, candidateMeasure)),
      ),
    )?.slug ?? "homicide";
  const activeOffence = CRIME_OFFENCES.some(
    ({ slug }) =>
      slug === selectedOffence &&
      (["count", "rate"] as const).some((candidateMeasure) =>
        availableKeys.has(seriesKey(state, slug, candidateMeasure)),
      ),
  )
    ? selectedOffence
    : firstAvailableOffence;
  const activeKey = seriesKey(state, activeOffence, measure);
  const activeOffenceLabel =
    CRIME_OFFENCES.find(({ slug }) => slug === activeOffence)?.label ??
    activeOffence;
  const showComparabilityCaveat =
    activeOffence === "assault" || activeOffence === "sexual-assault";
  const name = STATE_NAMES[state];

  return (
    <section
      aria-label={`${name} recorded crime`}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 font-serif text-lg font-semibold">
            <EconomyIcon name="state-finances" size={20} />
            Recorded crime victims
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Annual recorded victims in {name}.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Offence
            <select
              value={activeOffence}
              onChange={(event) =>
                setSelectedOffence(event.target.value as CrimeOffence)
              }
              className="min-h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground"
            >
              {CRIME_OFFENCES.map((offence) => (
                <option key={offence.slug} value={offence.slug}>
                  {offence.label}
                </option>
              ))}
            </select>
          </label>
          <div
            role="group"
            aria-label="Crime measure"
            className="flex rounded-md border border-border p-0.5"
          >
            {(
              Object.entries(CRIME_MEASURES) as [
                CrimeMeasure,
                (typeof CRIME_MEASURES)[CrimeMeasure],
              ][]
            ).map(([key, definition]) => (
              <button
                key={key}
                type="button"
                aria-pressed={measure === key}
                onClick={() => setMeasure(key)}
                className={`min-h-8 rounded px-2.5 text-xs transition-colors ${
                  measure === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {definition.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <EconomySeriesChartView
          points={observationsFor(data, activeKey)}
          seriesKey={activeKey}
          ariaLabel={`${name} ${activeOffenceLabel.toLowerCase()} ${
            measure === "count" ? "victim count" : "victims per 100,000"
          }`}
          format={CRIME_MEASURES[measure].format}
          height={240}
        />
      </div>

      {showComparabilityCaveat ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          ABS cautions that recording practices for this offence vary across
          jurisdictions; compare trends within this state only.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        Source: ABS Recorded Crime — Victims. CC BY 4.0.
      </p>
    </section>
  );
}
