import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { getEconomicSeries } from "~/app/actions/getEconomy";
import type { GetEconomicSeriesResponse } from "~/gen/shorts/v1alpha1/economy_pb";
import { EconomyBreadcrumbs } from "@/components/economy/economy-breadcrumbs";
import { EconomyIcon, type EconomyIconName } from "@/components/economy/economy-icon";
import { StateCharts } from "@/components/economy/state-charts-loader";
import { StateLocatorMap } from "@/components/economy/state-locator-map-loader";
import { hasLabour } from "@/components/economy/availability";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  STATE_NAMES,
  STATE_SLUGS,
  type StateSlug,
} from "@/lib/economy/map-metrics";

export const revalidate = 3600;

interface PageProps {
  params: Promise<{ state: string }>;
}

function isStateSlug(s: string): s is StateSlug {
  return (STATE_SLUGS as readonly string[]).includes(s);
}

export function generateStaticParams(): { state: string }[] {
  return STATE_SLUGS.map((state) => ({ state }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { state } = await params;
  if (!isStateSlug(state)) return {};
  const name = STATE_NAMES[state];
  const url = `https://shorted.com.au/economy/${state}`;
  const title = `${name} economy — unemployment, state final demand, trade`;
  const description = `${name} economic snapshot: unemployment, state final demand, goods exports and imports, diesel sales and the ASX companies operating there — from ABS and DCCEEW open data.`;
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

function latestPeriod(
  response: GetEconomicSeriesResponse | undefined,
  key: string,
): string {
  const s = response?.series.find((d) => d.info?.seriesKey === key);
  const obs = s?.observations;
  const seconds = obs?.length ? obs[obs.length - 1]!.period?.seconds : undefined;
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000).toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export default async function EconomyStatePage({ params }: PageProps) {
  const { state } = await params;
  if (!isStateSlug(state)) notFound();
  const name = STATE_NAMES[state];
  const url = `https://shorted.com.au/economy/${state}`;

  // ONE server RPC feeds the SSR chip strip. Unemployment is only published
  // (seasonally adjusted) where HAS_LABOUR — the strip is undefined-tolerant,
  // so a missing key just drops its chip (same posture as the hub).
  const unemploymentKey = `labour.unemployment_rate.total.${state}.seasadj`;
  const sfdKey = `gdp.state_final_demand_chain_volume.total.${state}.seasadj`;
  const exportsKey = `trade.export_value.total.${state}`;
  const chipKeys = [
    ...(hasLabour(state) ? [unemploymentKey] : []),
    sfdKey,
    exportsKey,
  ];
  const headline = await getEconomicSeries(chipKeys).catch(() => undefined);

  const unemployment = hasLabour(state) ? latest(headline, unemploymentKey) : undefined;
  const sfd = latest(headline, sfdKey);
  const exportsAud = latest(headline, exportsKey);
  const hasChips = [unemployment, sfd, exportsAud].some((v) => v !== undefined);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${name} economic snapshot`,
    description: `Unemployment, state final demand, trade and petroleum indicators for ${name}.`,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    spatialCoverage: name,
    sourceOrganization: [
      { "@type": "GovernmentOrganization", name: "Australian Bureau of Statistics", url: "https://abs.gov.au" },
      { "@type": "GovernmentOrganization", name: "Department of Climate Change, Energy, the Environment and Water", url: "https://www.energy.gov.au" },
    ],
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={`${name} economy`}
        description={`Unemployment, state final demand, trade and petroleum indicators for ${name}, plus the ASX companies operating there.`}
        url={url}
        dataSource="ABS, DCCEEW"
        dataFrequency="monthly / quarterly"
        keywords={[`${name} economy`, `${name} unemployment`, `${name} state final demand`, `${name} exports`]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <EconomyBreadcrumbs stateName={name} stateSlug={state} />

        <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
          <header>
            <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              {name} economy
            </h1>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Labour, demand, trade and petroleum for {name}, plus the ASX
              companies operating here — from ABS and DCCEEW open data. CC BY 4.0.
            </p>

            {hasChips ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
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
          </header>

          <StateLocatorMap state={state} />
        </div>

        <StateCharts state={state} />

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
