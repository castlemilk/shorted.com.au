import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EconomySeriesChartView } from "~/@/components/economy/economy-charts";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { siteConfig } from "~/@/config/site";
import {
  ECONOMY_SERIES_FORMATTERS,
  STATE_NAMES,
  STATE_SLUGS,
  type EconomySeriesDisplayFormat,
  type StateSlug,
} from "~/@/lib/economy/map-metrics";
import {
  ECONOMY_TOPICS,
  PUBLISHED_ECONOMY_TOPIC_PAIRS,
  economyTopicCopyForState,
  getEconomyTopic,
  isPublishedEconomyTopic,
  type EconomyTopicDefinition,
  type EconomyTopicSlug,
} from "~/@/lib/economy/topics";
import { bailOnEmptyRender } from "~/app/actions/config";
import { listStateCompanies } from "~/app/actions/getEconomy";
import {
  getEconomyTopicSnapshot,
  type EconomyTopicSeriesSnapshot,
} from "~/app/actions/getEconomyTopic";

export const revalidate = 3600;
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ state: string; topic: string }>;
}

function isStateSlug(value: string): value is StateSlug {
  return (STATE_SLUGS as readonly string[]).includes(value);
}

function resolveRoute(stateValue: string, topicValue: string) {
  const definition = getEconomyTopic(topicValue);
  if (
    !isStateSlug(stateValue) ||
    !definition ||
    !isPublishedEconomyTopic(stateValue, definition.slug)
  ) {
    notFound();
  }
  return { state: stateValue, definition };
}

export function generateStaticParams() {
  return PUBLISHED_ECONOMY_TOPIC_PAIRS.map(({ state, topic }) => ({
    state,
    topic,
  }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { state: stateValue, topic } = await params;
  const { state, definition } = resolveRoute(stateValue, topic);
  const copy = economyTopicCopyForState(definition, state);
  const url = `${siteConfig.url}/economy/${state}/${definition.slug}`;

  return {
    title: copy.title,
    description: copy.description,
    keywords: copy.keywords,
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
    openGraph: {
      type: "website",
      url,
      title: `${copy.title} | ${siteConfig.name}`,
      description: copy.description,
      siteName: siteConfig.name,
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      site: "@shorted___",
      creator: "@shorted___",
    },
  };
}

const METRIC_LABELS: Record<string, string> = {
  balance: "Trade balance",
  dwelling_units: "Dwelling units approved",
  dwelling_units_per_100k: "Dwelling units approved per 100,000 people",
  employed_persons: "Employed people",
  erp: "Estimated resident population",
  household: "Household spending",
  household_per_capita: "Household spending per capita",
  household_yoy: "Household spending growth, year-on-year",
  job_vacancies: "Job vacancies",
  natural_increase: "Natural increase",
  net_interstate_migration: "Net interstate migration",
  net_overseas_migration: "Net overseas migration",
  new_commitments: "New lending commitments",
  participation_rate: "Participation rate",
  real_wpi_yoy: "Real wage growth, year-on-year",
  sales: "Business sales",
  state_final_demand_chain_volume: "State final demand, chain volume",
  state_final_demand_per_capita: "State final demand per capita",
  unemployment_rate: "Unemployment rate",
  wage_price_index: "Wage price index",
  wages: "Business wages and salaries",
  work_done: "Construction work done",
  wpi: "Wage price index",
  wpi_yoy: "Wage growth, year-on-year",
};

function humanize(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();
  return spaced ? `${spaced[0]!.toUpperCase()}${spaced.slice(1)}` : "Series";
}

function seriesName(series: EconomyTopicSeriesSnapshot): string {
  const metric = METRIC_LABELS[series.metric] ?? humanize(series.metric);
  if (!series.product || series.product === "total") return metric;
  return `${metric} — ${humanize(series.product)}`;
}

function formatForUnit(unit: string): EconomySeriesDisplayFormat {
  const normalized = unit.trim().toLowerCase();
  if (normalized.includes("percent") || normalized === "%") return "percent";
  if (normalized.includes("aud") || normalized.includes("dollar")) return "aud";
  if (normalized.includes("index")) return "index";
  if (normalized.includes("megalitre")) return "megalitres";
  if (normalized.includes("rate") || normalized.includes("per_100")) return "rate";
  return "number";
}

function formatChange(
  value: number,
  format: EconomySeriesDisplayFormat,
): string {
  const formatted = ECONOMY_SERIES_FORMATTERS[format](value);
  return value > 0 ? `+${formatted}` : formatted;
}

function displayMetadata(value: string, fallback = "Not specified"): string {
  return value.trim() ? humanize(value) : fallback;
}

function adjustmentLabel(adjustment: string): string {
  if (adjustment === "seasadj") return "Seasonally adjusted";
  if (adjustment === "original") return "Original";
  if (adjustment === "trend") return "Trend";
  return displayMetadata(adjustment);
}

function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return period;
  return date.toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function SeriesCard({
  series,
  stateName,
}: {
  series: EconomyTopicSeriesSnapshot;
  stateName: string;
}) {
  const label = seriesName(series);
  const format = formatForUnit(series.unit);
  const latest = series.observations.at(-1);
  const prior = series.observations.at(-2);
  const change = latest && prior ? latest.value - prior.value : null;

  return (
    <article className="overflow-hidden rounded-xl border border-border/60 bg-card/50">
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:p-6">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {series.seriesKey}
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{label}</h2>

          {latest ? (
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Latest value</p>
                <p className="mt-1 font-mono text-3xl font-semibold tabular-nums">
                  {ECONOMY_SERIES_FORMATTERS[format](latest.value)}
                </p>
                <time
                  dateTime={latest.period}
                  className="mt-1 block text-xs text-muted-foreground"
                >
                  {formatPeriod(latest.period)}
                </time>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Change from prior period
                </p>
                <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                  {change === null ? "Not available" : formatChange(change, format)}
                </p>
                {prior ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    from {formatPeriod(prior.period)}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/50 pt-4 text-xs">
            <div>
              <dt className="text-muted-foreground">Unit</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {series.unit || "Not specified"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Frequency</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {displayMetadata(series.frequency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Adjustment</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {adjustmentLabel(series.adjustment)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Latest catalog period</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {series.latestPeriod
                  ? formatPeriod(series.latestPeriod)
                  : "Not specified"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="mt-0.5 break-words font-medium text-foreground">
                {series.sourceKey || "Not specified"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Source licence</dt>
              <dd className="mt-0.5 break-words font-medium text-foreground">
                {series.sourceLicence || "Not specified"}
              </dd>
            </div>
          </dl>
        </div>

        <div className="min-w-0 lg:border-l lg:border-border/50 lg:pl-6">
          <EconomySeriesChartView
            points={series.observations.map((observation) => ({
              date: observation.period,
              value: observation.value,
            }))}
            seriesKey={series.seriesKey}
            ariaLabel={`${stateName} ${label.toLowerCase()} history`}
            format={format}
            height={260}
          />
        </div>
      </div>
    </article>
  );
}

interface EditorialCompany {
  stockCode: string;
  companyName: string;
  industry: string;
  weight: number;
  basis: string;
  source: string;
}

function exposureBand(weight: number): string {
  if (weight >= 0.5) return "Majority of operations (estimate)";
  if (weight >= 0.25) return "Significant operations exposure (estimate)";
  return "Some operations exposure (estimate)";
}

function CompaniesSection({
  companies,
  stateName,
}: {
  companies: EditorialCompany[];
  stateName: string;
}) {
  if (companies.length === 0) return null;

  return (
    <section aria-labelledby="state-companies-heading" className="border-t border-border/60 pt-7">
      <h2 id="state-companies-heading" className="text-lg font-semibold">
        ASX companies operating in {stateName}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Coarse operating-exposure bands are AI estimates based on public company
        information. Headquarters-only matches are withheld.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {companies.map((company) => (
          <li
            key={company.stockCode}
            className="rounded-lg border border-border/60 bg-card/40 p-4"
          >
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Link
                href={`/shorts/${company.stockCode}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                <span className="font-mono font-semibold">
                  {company.stockCode}
                </span>{" "}
                {company.companyName}
              </Link>
              {company.industry ? (
                <span className="text-xs text-muted-foreground">
                  {company.industry}
                </span>
              ) : null}
            </p>
            <p className="mt-2 text-xs font-medium text-foreground">
              {exposureBand(company.weight)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Basis: {company.basis}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RelatedTopics({
  state,
  definition,
}: {
  state: StateSlug;
  definition: EconomyTopicDefinition;
}) {
  const sameTopicStates = PUBLISHED_ECONOMY_TOPIC_PAIRS.filter(
    (pair) => pair.topic === definition.slug && pair.state !== state,
  );
  const stateTopics = PUBLISHED_ECONOMY_TOPIC_PAIRS.filter(
    (pair) => pair.state === state && pair.topic !== definition.slug,
  );

  return (
    <section aria-labelledby="related-economy-heading" className="border-t border-border/60 pt-7">
      <h2 id="related-economy-heading" className="text-lg font-semibold">
        Explore related economy data
      </h2>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {definition.name} in other states
          </h3>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {sameTopicStates.map((pair) => (
              <li key={pair.state}>
                <Link
                  href={`/economy/${pair.state}/${pair.topic}`}
                  className="text-primary hover:underline"
                >
                  {STATE_NAMES[pair.state]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            More {STATE_NAMES[state]} topics
          </h3>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {stateTopics.map((pair) => (
              <li key={pair.topic}>
                <Link
                  href={`/economy/${pair.state}/${pair.topic}`}
                  className="text-primary hover:underline"
                >
                  {ECONOMY_TOPICS[pair.topic].name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mt-6 text-sm">
        <Link href={`/economy/${state}`} className="text-primary hover:underline">
          Back to the {STATE_NAMES[state]} economy overview
        </Link>
      </p>
    </section>
  );
}

export default async function EconomyTopicPage({ params }: PageProps) {
  const { state: stateValue, topic } = await params;
  const { state, definition } = resolveRoute(stateValue, topic);
  const stateName = STATE_NAMES[state];
  const copy = economyTopicCopyForState(definition, state);
  const url = `${siteConfig.url}/economy/${state}/${definition.slug}`;

  const [snapshot, companyResponse] = await Promise.all([
    getEconomyTopicSnapshot(state, definition.slug),
    listStateCompanies(state, 8).catch(() => undefined),
  ]);
  const series = snapshot?.series ?? [];
  if (series.length === 0) bailOnEmptyRender();

  // Apply the stock-page editorial rule: expose only evidence-backed LLM
  // operating estimates. Headquarters fallbacks and basis-less rows would
  // imply a precision the underlying company research does not support.
  const companies = (companyResponse?.companies ?? [])
    .filter(
      (company) =>
        company.source === "llm" &&
        Number.isFinite(company.weight) &&
        company.weight > 0 &&
        company.basis.trim().length > 0,
    )
    .map((company) => ({
      stockCode: company.stockCode,
      companyName: company.companyName,
      industry: company.industry,
      weight: company.weight,
      basis: company.basis,
      source: company.source,
    }));

  const sources = [...new Set(series.map((item) => item.sourceKey).filter(Boolean))];
  const licences = [
    ...new Set(series.map((item) => item.sourceLicence).filter(Boolean)),
  ];
  const frequencies = [
    ...new Set(series.map((item) => item.frequency).filter(Boolean)),
  ];
  const breadcrumbItems = [
    { label: "Economy", href: "/economy" },
    { label: stateName, href: `/economy/${state}` },
    { label: definition.name, href: `/economy/${state}/${definition.slug}` },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: copy.h1,
    description: copy.description,
    url,
    isAccessibleForFree: true,
    creator: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    spatialCoverage: stateName,
    license:
      licences.length === 1
        ? licences[0]
        : licences.length > 1
          ? licences
          : undefined,
    sourceOrganization: sources.map((source) => ({
      "@type": "Organization",
      name: source,
    })),
    variableMeasured: series.map((item) => ({
      "@type": "PropertyValue",
      name: seriesName(item),
      unitText: item.unit,
      measurementTechnique: `${item.frequency}; ${adjustmentLabel(item.adjustment)}`,
    })),
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={copy.h1}
        description={copy.description}
        url={url}
        dataSource={sources.join(", ") || "Official economic series"}
        dataFrequency={frequencies.join(" / ") || "varies by series"}
        keywords={copy.keywords}
      />
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <Breadcrumbs items={breadcrumbItems} />

        <header className="border-b border-border/50 pb-7">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            {stateName} economy · {definition.name}
          </p>
          <h1 className="mt-2 font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
            {copy.h1}
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
            {copy.lede}
          </p>
          {series.length > 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {series.length} published {series.length === 1 ? "series" : "series"}
              {sources.length > 0 ? ` · ${sources.join(", ")}` : ""}
            </p>
          ) : null}
        </header>

        {series.length > 0 ? (
          <section aria-label={`${copy.h1} series`} className="space-y-5">
            {series.map((item) => (
              <SeriesCard key={item.seriesKey} series={item} stateName={stateName} />
            ))}
          </section>
        ) : (
          <section className="rounded-lg border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">
            Economic series are temporarily unavailable. This page will retry
            without caching an empty result.
          </section>
        )}

        <section aria-labelledby="about-topic-heading" className="max-w-3xl space-y-3">
          <h2 id="about-topic-heading" className="text-lg font-semibold">
            About {definition.name.toLowerCase()}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {definition.explainer}
          </p>
        </section>

        <CompaniesSection companies={companies} stateName={stateName} />
        <RelatedTopics state={state} definition={definition} />

        <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
          Every chart reports its source, unit, frequency, adjustment and source
          licence from the economic-series catalogue. Latest periods may be
          preliminary or revised by the publisher. Historical data only; not a
          forecast or financial advice.
        </p>
      </div>
    </DashboardLayout>
  );
}
