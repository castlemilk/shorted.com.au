import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { preload } from "react-dom";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { getEconomicSeries } from "~/app/actions/getEconomy";
import { bailOnEmptyRender } from "~/app/actions/config";
import type { GetEconomicSeriesResponse } from "~/gen/shorts/v1alpha1/economy_pb";
import { EconomySeriesChart } from "@/components/economy/economy-charts";
import { EconomyIcon, type EconomyIconName } from "@/components/economy/economy-icon";
import { EconomyMapExplorer } from "@/components/economy/economy-map-loader";
import { WhenVisible } from "@/components/housing/when-visible";
import { LLMMeta } from "@/components/seo/llm-meta";

const URL = "https://shorted.com.au/economy";
const TITLE = "Australian Economy Snapshot";
const DESCRIPTION =
  "Live snapshot of the Australian economy with an interactive state map: colour Australia by unemployment, trade or state final demand, then drill into any state — plus the RBA cash rate, inflation and petroleum refining, from ABS, RBA and DCCEEW open data.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${TITLE} — cash rate, inflation, labour, trade, petroleum`,
  description: DESCRIPTION,
  keywords: [
    "Australian economy",
    "RBA cash rate",
    "Australia CPI inflation",
    "Australia unemployment rate",
    "Australia trade exports imports",
    "Australia petroleum refining",
  ],
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

// One RPC call feeds every headline tile. Keys are verified against the
// economic_series catalog — see docs/superpowers/plans/2026-07-21-economy-data-platform.md.
const HEADLINE_KEYS = [
  "rates.cash_rate_target.aus",
  "cpi.annual_change.all_groups.aus",
  "labour.unemployment_rate.total.aus.seasadj",
  "trade.export_value.total.aus",
  "trade.import_value.total.aus",
  "rates.aud_usd.aus",
  "petroleum.sales.diesel_oil_total.aus",
];

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

function BigStat({
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
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon ? <EconomyIcon name={icon} size={18} /> : null}
        {label}
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  source,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  source: string;
  icon?: EconomyIconName;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <h3 className="flex items-center gap-2 font-serif text-lg text-foreground">
          {icon ? <EconomyIcon name={icon} size={22} /> : null}
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
      <p className="mt-3 text-[11px] text-muted-foreground/80">Source: {source} · CC BY 4.0</p>
    </div>
  );
}

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 className="font-serif text-2xl text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
    </div>
  );
}

export default async function EconomyPage() {
  preload("/geo/states.topojson", { as: "fetch", crossOrigin: "anonymous" });
  const headline = await getEconomicSeries(HEADLINE_KEYS).catch(() => undefined);

  const cashRate = latest(headline, "rates.cash_rate_target.aus");
  const cpiYoy = latest(headline, "cpi.annual_change.all_groups.aus");
  const unemployment = latest(headline, "labour.unemployment_rate.total.aus.seasadj");
  const exportsAud = latest(headline, "trade.export_value.total.aus");
  const importsAud = latest(headline, "trade.import_value.total.aus");
  const audUsd = latest(headline, "rates.aud_usd.aus");
  const dieselSales = latest(headline, "petroleum.sales.diesel_oil_total.aus");

  const tradeBalance =
    exportsAud !== undefined && importsAud !== undefined
      ? exportsAud - importsAud
      : undefined;

  const hasTiles = [cashRate, cpiYoy, unemployment, tradeBalance, audUsd, dieselSales].some(
    (v) => v !== undefined,
  );
  // A failed/cold fetch must not bake the "data is loading" shell into the
  // route cache for the whole revalidate window.
  if (!hasTiles) bailOnEmptyRender();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Australian Economy Snapshot",
    description: DESCRIPTION,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    spatialCoverage: "Australia",
    sourceOrganization: [
      { "@type": "GovernmentOrganization", name: "Australian Bureau of Statistics", url: "https://abs.gov.au" },
      { "@type": "Organization", name: "Reserve Bank of Australia", url: "https://rba.gov.au" },
      { "@type": "GovernmentOrganization", name: "Department of Climate Change, Energy, the Environment and Water", url: "https://www.energy.gov.au" },
    ],
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="ABS, RBA, DCCEEW"
        dataFrequency="monthly"
        keywords={["Australian economy", "RBA cash rate", "CPI inflation", "unemployment rate", "trade balance"]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-10 px-4 py-8">
        <header>
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Australian economy
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Rates, prices, labour, trade and petroleum — a live snapshot from
            ABS, RBA and DCCEEW open data. CC BY 4.0.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Property-focused?{" "}
            <Link href="/housing" className="font-medium text-primary underline-offset-4 hover:underline">
              See the house prices tracker →
            </Link>
          </p>
        </header>

        {!hasTiles ? (
          <p className="rounded-lg border border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            Economic data is loading — check back shortly.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cashRate !== undefined ? (
              <BigStat
                label="RBA cash rate target"
                icon="cash-rate"
                value={`${cashRate.toFixed(2)}%`}
                sub={`RBA · ${latestPeriod(headline, "rates.cash_rate_target.aus")}`}
              />
            ) : null}
            {cpiYoy !== undefined ? (
              <BigStat
                label="CPI annual change"
                icon="cpi"
                value={`${cpiYoy.toFixed(1)}%`}
                sub={`ABS monthly CPI indicator · ${latestPeriod(headline, "cpi.annual_change.all_groups.aus")}`}
              />
            ) : null}
            {unemployment !== undefined ? (
              <BigStat
                label="Unemployment rate"
                icon="unemployment"
                value={`${unemployment.toFixed(1)}%`}
                sub={`ABS, seasonally adjusted · ${latestPeriod(headline, "labour.unemployment_rate.total.aus.seasadj")}`}
              />
            ) : null}
            {tradeBalance !== undefined ? (
              <BigStat
                label="Goods trade balance"
                icon="trade-balance"
                value={`${tradeBalance >= 0 ? "+" : "−"}$${Math.abs(tradeBalance / 1_000_000_000).toFixed(1)}B`}
                sub={`Exports − imports · ABS · ${latestPeriod(headline, "trade.export_value.total.aus")}`}
              />
            ) : null}
            {audUsd !== undefined ? (
              <BigStat
                label="AUD / USD"
                icon="aud-usd"
                value={audUsd.toFixed(4)}
                sub={`RBA · ${latestPeriod(headline, "rates.aud_usd.aus")}`}
              />
            ) : null}
            {dieselSales !== undefined ? (
              <BigStat
                label="National diesel sales"
                icon="diesel"
                value={`${(dieselSales / 1_000).toFixed(1)}GL`}
                sub={`DCCEEW Australian Petroleum Statistics · ${latestPeriod(headline, "petroleum.sales.diesel_oil_total.aus")}`}
              />
            ) : null}
          </div>
        )}

        {/* ── Explore by state ──────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading
            title="Explore by state"
            blurb="Colour the map, hover for detail, click a state to drill down."
          />
          <EconomyMapExplorer />
        </section>

        {/* ── Macro ─────────────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading
            title="Macro"
            blurb="Monetary policy, consumer prices and the labour market."
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="RBA cash rate target" subtitle="Monthly · per cent" source="Reserve Bank of Australia, F1.1" icon="cash-rate">
              <WhenVisible>
                <EconomySeriesChart seriesKey="rates.cash_rate_target.aus" format="percent" ariaLabel="RBA cash rate target over time" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="Consumer price index" subtitle="All groups, quarterly · index" source="Australian Bureau of Statistics, Consumer Price Index" icon="cpi">
              <WhenVisible>
                <EconomySeriesChart seriesKey="cpi.index.all_groups.aus" format="index" ariaLabel="Consumer price index, all groups" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="Unemployment rate — Australia" subtitle="Monthly, seasonally adjusted · per cent" source="Australian Bureau of Statistics, Labour Force" icon="unemployment">
              <WhenVisible>
                <EconomySeriesChart seriesKey="labour.unemployment_rate.total.aus.seasadj" format="percent" ariaLabel="National unemployment rate" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="AUD/USD exchange rate" subtitle="Daily · US dollars per AUD" source="Reserve Bank of Australia, F11" icon="aud-usd">
              <WhenVisible>
                <EconomySeriesChart seriesKey="rates.aud_usd.aus" format="usd" ariaLabel="AUD to USD exchange rate" />
              </WhenVisible>
            </ChartCard>
          </div>
        </section>

        {/* ── Trade ─────────────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading
            title="Trade"
            blurb="National goods exports and imports — per-state trade lives in the map above."
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="National goods exports" subtitle="Monthly · A$" source="Australian Bureau of Statistics, International Trade in Goods" icon="exports">
              <WhenVisible>
                <EconomySeriesChart seriesKey="trade.export_value.total.aus" format="aud" ariaLabel="National goods exports" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="National goods imports" subtitle="Monthly · A$" source="Australian Bureau of Statistics, International Trade in Goods" icon="imports">
              <WhenVisible>
                <EconomySeriesChart seriesKey="trade.import_value.total.aus" format="aud" ariaLabel="National goods imports" />
              </WhenVisible>
            </ChartCard>
          </div>
        </section>

        {/* ── Energy ────────────────────────────────────────────────── */}
        <section className="space-y-4">
          <SectionHeading
            title="Energy & petroleum"
            blurb="Refinery output, fuel imports and national fuel sales, in megalitres."
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="Refinery output — diesel" subtitle="Monthly · megalitres" source="DCCEEW, Australian Petroleum Statistics" icon="refinery">
              <WhenVisible>
                <EconomySeriesChart seriesKey="petroleum.refinery_output.diesel_oil.aus" format="megalitres" ariaLabel="Australian refinery diesel output" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="Refinery output — petrol" subtitle="Automotive gasoline, monthly · megalitres" source="DCCEEW, Australian Petroleum Statistics" icon="refinery">
              <WhenVisible>
                <EconomySeriesChart seriesKey="petroleum.refinery_output.automotive_gasoline.aus" format="megalitres" ariaLabel="Australian refinery petrol output" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="Refinery output — jet fuel" subtitle="Aviation turbine fuel, monthly · megalitres" source="DCCEEW, Australian Petroleum Statistics" icon="refinery">
              <WhenVisible>
                <EconomySeriesChart seriesKey="petroleum.refinery_output.aviation_turbine_fuel.aus" format="megalitres" ariaLabel="Australian refinery jet fuel output" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="Diesel imports" subtitle="Monthly · megalitres — Australia imports most of its diesel" source="DCCEEW, Australian Petroleum Statistics" icon="diesel">
              <WhenVisible>
                <EconomySeriesChart seriesKey="petroleum.imports.diesel_oil.aus" format="megalitres" ariaLabel="Australian diesel imports" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="National diesel sales" subtitle="Monthly · megalitres" source="DCCEEW, Australian Petroleum Statistics" icon="diesel">
              <WhenVisible>
                <EconomySeriesChart seriesKey="petroleum.sales.diesel_oil_total.aus" format="megalitres" ariaLabel="National diesel sales" />
              </WhenVisible>
            </ChartCard>
            <ChartCard title="Refinery input" subtitle="Total refinery intake, monthly · megalitres" source="DCCEEW, Australian Petroleum Statistics" icon="refinery">
              <WhenVisible>
                <EconomySeriesChart seriesKey="petroleum.refinery_input.total.aus" format="megalitres" ariaLabel="Total Australian refinery input" />
              </WhenVisible>
            </ChartCard>
          </div>
        </section>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Sources: Australian Bureau of Statistics (Consumer Price Index, Labour
          Force, International Trade in Goods, National Accounts), Reserve Bank
          of Australia (F1.1, F11) and the Department of Climate Change, Energy,
          the Environment and Water (Australian Petroleum Statistics). All CC BY
          4.0. Latest months may be preliminary. Not financial advice.
        </p>
      </div>
    </DashboardLayout>
  );
}
