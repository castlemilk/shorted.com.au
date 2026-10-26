import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getEconomicSeries } from "~/app/actions/getEconomy";
import type { GetEconomicSeriesResponse } from "~/gen/shorts/v1alpha1/economy_pb";
import { EconomyBreadcrumbs } from "@/components/economy/economy-breadcrumbs";
import {
  EconomyIcon,
  type EconomyIconName,
} from "@/components/economy/economy-icon";
import { StateBanner } from "@/components/economy/state-banner";
import { StateCharts } from "@/components/economy/state-charts-loader";
import { hasLabour } from "@/components/economy/availability";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  stateEconomyDescription,
  stateEconomyIndicators,
  stateEconomyTitle,
} from "./state-metadata";
import {
  ECONOMY_SERIES_FORMATTERS,
  STATE_NAMES,
  STATE_SLUGS,
  type StateSlug,
} from "@/lib/economy/map-metrics";
import {
  ECONOMY_TOPICS,
  PUBLISHED_ECONOMY_TOPIC_PAIRS,
  economyTopicCopyForState,
  economyTopicHeadlineKey,
  type EconomyTopicDefinition,
} from "@/lib/economy/topics";
import { JsonLd } from "~/@/components/seo/json-ld";

export const revalidate = 3600;

// The chips and the topic readings use only the newest observation of each
// series. Uncapped, the three chip keys alone return 566 observations (32 KB
// for Victoria), and the ten keys with the topic headlines 67 KB (measured
// 2026-10-21).
const LATEST_ONLY = 1;

interface PageProps {
  params: Promise<{ state: string }>;
}

function isStateSlug(s: string): s is StateSlug {
  return (STATE_SLUGS as readonly string[]).includes(s);
}

export function generateStaticParams(): { state: string }[] {
  return STATE_SLUGS.map((state) => ({ state }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { state } = await params;
  if (!isStateSlug(state)) return {};
  const url = `https://shorted.com.au/economy/${state}`;
  // Names only what the page reads: no unemployment for NT and ACT, no diesel
  // for ACT (state-metadata.ts).
  const title = stateEconomyTitle(state);
  const description = stateEconomyDescription(state);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      url,
      title,
      description,
      siteName: "Shorted",
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: "@shorted___",
      creator: "@shorted___",
    },
  };
}

// ── SSR chip helpers ─────────────────────────────────────────────────────────
function latest(
  response: GetEconomicSeriesResponse | undefined,
  key: string,
): number | undefined {
  const s = response?.series.find((d) => d.info?.seriesKey === key);
  const obs = s?.observations;
  return obs?.length ? obs[obs.length - 1]!.value : undefined;
}

/**
 * A period as its frequency reads it: "Aug 2026" for a month, "Apr–Jun 2026"
 * for a quarter (stored as the quarter's first day), "2025" for a year. A
 * month-only label named a quarter by its first month, so the June quarter's
 * state final demand read "Apr 2026".
 */
function periodLabel(seconds: bigint | undefined, frequency: string): string {
  if (!seconds) return "";
  const start = new Date(Number(seconds) * 1000);
  if (Number.isNaN(start.getTime())) return "";
  const year = start.getUTCFullYear();
  if (frequency === "annual") return String(year);
  const month = (date: Date) =>
    date.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  if (frequency === "quarterly" && start.getUTCMonth() % 3 === 0) {
    const end = new Date(Date.UTC(year, start.getUTCMonth() + 2, 1));
    return `${month(start)}–${month(end)} ${year}`;
  }
  return `${month(start)} ${year}`;
}

function latestPeriod(
  response: GetEconomicSeriesResponse | undefined,
  key: string,
): string {
  const s = response?.series.find((d) => d.info?.seriesKey === key);
  return periodLabel(
    s?.observations.at(-1)?.period?.seconds,
    s?.info?.frequency ?? "",
  );
}

/** "The unemployment rate was 5.2% in Aug 2026 (seasonally adjusted)." */
function topicReading(
  response: GetEconomicSeriesResponse | undefined,
  definition: EconomyTopicDefinition,
  state: StateSlug,
): string | undefined {
  const key = economyTopicHeadlineKey(definition, state);
  const value = latest(response, key);
  const period = latestPeriod(response, key);
  if (value === undefined || !Number.isFinite(value) || !period) {
    return undefined;
  }
  const { format, sentenceTemplate } = definition.headline;
  return sentenceTemplate
    .replace("{value}", ECONOMY_SERIES_FORMATTERS[format](value))
    .replace("{period}", period);
}

function TopicsSection({
  state,
  name,
  topics,
  headline,
}: {
  state: StateSlug;
  name: string;
  topics: EconomyTopicDefinition[];
  headline: GetEconomicSeriesResponse | undefined;
}) {
  return (
    <section
      aria-labelledby="state-topics-heading"
      className="border-t border-border/60 pt-7"
    >
      <h2 id="state-topics-heading" className="text-lg font-semibold">
        {name} economy by topic
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        The newest reading of one headline series per topic. Each topic page
        carries every published series for {name}, with changes and full
        history.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {topics.map((definition) => {
          const copy = economyTopicCopyForState(definition, state);
          return (
            <li
              key={definition.slug}
              className="rounded-lg border border-border/60 bg-card/40 p-4"
            >
              {/*
                No viewport prefetch: nine topic payloads (about 140 KB
                gzipped) per view, and a regeneration for each stale one.
              */}
              <Link
                href={`/economy/${state}/${definition.slug}`}
                prefetch={false}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {copy.h1}
              </Link>
              {/* Without a reading, the topic page's own summary stands in. */}
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {topicReading(headline, definition, state) ?? copy.description}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function fmtAud(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  return `${sign}$${a.toFixed(0)}`;
}

function Chip({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: EconomyIconName;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon ? <EconomyIcon name={icon} size={16} /> : null}
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

export default async function EconomyStatePage({ params }: PageProps) {
  const { state } = await params;
  if (!isStateSlug(state)) notFound();
  const name = STATE_NAMES[state];
  const url = `https://shorted.com.au/economy/${state}`;

  // ONE server RPC feeds the SSR chip strip and the topic readings.
  // Unemployment is only published (seasonally adjusted) where HAS_LABOUR —
  // the strip is undefined-tolerant, so a missing key just drops its chip
  // (same posture as the hub), and a missing topic reading falls back to the
  // topic's description.
  const unemploymentKey = `labour.unemployment_rate.total.${state}.seasadj`;
  const sfdKey = `gdp.state_final_demand_chain_volume.total.${state}.seasadj`;
  const exportsKey = `trade.export_value.total.${state}`;
  const chipKeys = [
    ...(hasLabour(state) ? [unemploymentKey] : []),
    sfdKey,
    exportsKey,
  ];
  const topics = PUBLISHED_ECONOMY_TOPIC_PAIRS.filter(
    (pair) => pair.state === state,
  ).map(({ topic }) => ECONOMY_TOPICS[topic]);
  const headlineKeys = [
    ...new Set([
      ...chipKeys,
      ...topics.map((definition) => economyTopicHeadlineKey(definition, state)),
    ]),
  ];
  const headline = await getEconomicSeries(headlineKeys, LATEST_ONLY).catch(
    () => undefined,
  );
  // A failed or cold read must not bake a page without its readings into the
  // route cache for the whole revalidate window.
  if (!headline?.series.length) await bailOnEmptyRender();

  const unemployment = hasLabour(state)
    ? latest(headline, unemploymentKey)
    : undefined;
  const sfd = latest(headline, sfdKey);
  const exportsAud = latest(headline, exportsKey);
  const hasChips = [unemployment, sfd, exportsAud].some((v) => v !== undefined);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${name} economic snapshot`,
    description: `${name}: ${stateEconomyIndicators(state).join(", ")}.`,
    creator: {
      "@type": "Organization",
      name: "Shorted",
      url: "https://shorted.com.au",
    },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    spatialCoverage: name,
    sourceOrganization: [
      {
        "@type": "GovernmentOrganization",
        name: "Australian Bureau of Statistics",
        url: "https://abs.gov.au",
      },
      {
        "@type": "GovernmentOrganization",
        name: "Department of Climate Change, Energy, the Environment and Water",
        url: "https://www.energy.gov.au",
      },
    ],
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={`${name} economy`}
        description={`${name}: ${stateEconomyIndicators(state).join(", ")}, plus the ASX companies operating there.`}
        url={url}
        dataSource="ABS, DCCEEW"
        dataFrequency="monthly / quarterly"
        keywords={[
          `${name} economy`,
          ...(hasLabour(state) ? [`${name} unemployment`] : []),
          `${name} state final demand`,
          `${name} exports`,
        ]}
      />
      <JsonLd data={jsonLd} />

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <EconomyBreadcrumbs stateName={name} stateSlug={state} />

        <StateBanner
          state={state}
          name={name}
          subtitle={
            <>
              Labour, demand, trade and petroleum for {name}, plus the ASX
              companies operating here — from ABS and DCCEEW open data. CC BY
              4.0.
            </>
          }
        />

        {hasChips ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {unemployment !== undefined ? (
              <Chip
                icon="unemployment"
                label="Unemployment"
                value={`${unemployment.toFixed(1)}%`}
                sub={`ABS, seas. adj. · ${latestPeriod(headline, unemploymentKey)}`}
              />
            ) : null}
            {sfd !== undefined ? (
              <Chip
                icon="sfd"
                label="State final demand"
                value={fmtAud(sfd)}
                sub={`ABS, chain volume · ${latestPeriod(headline, sfdKey)}`}
              />
            ) : null}
            {exportsAud !== undefined ? (
              <Chip
                icon="exports"
                label="Goods exports"
                value={fmtAud(exportsAud)}
                sub={`ABS · ${latestPeriod(headline, exportsKey)}`}
              />
            ) : null}
          </div>
        ) : null}

        <StateCharts state={state} />

        <TopicsSection
          state={state}
          name={name}
          topics={topics}
          headline={headline}
        />

        <section
          aria-labelledby="housing-context-heading"
          className="border-t border-border/60 pt-4"
        >
          <h2
            id="housing-context-heading"
            className="text-sm font-medium text-foreground"
          >
            Housing context
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Compare suburb medians and Census demographics on the{" "}
            <Link
              href={`/housing/${state}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {name} housing map
            </Link>
            , or review{" "}
            <Link
              href={`/price-drops?state=${state}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              state-filtered asking-price cuts
            </Link>
            .
          </p>
        </section>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Sources: Australian Bureau of Statistics (Labour Force, National
          Accounts, International Trade in Goods) and the Department of Climate
          Change, Energy, the Environment and Water (Australian Petroleum
          Statistics). All CC BY 4.0. Latest periods may be preliminary. Not
          financial advice.
        </p>
      </div>
    </DashboardLayout>
  );
}
