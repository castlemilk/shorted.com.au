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
import {
  GLOBAL_ECONOMY_SERIES,
  GLOBAL_SERIES_GROUPS,
} from "@/lib/economy/global-series";
import { WhenVisible } from "@/components/housing/when-visible";
import { LLMMeta } from "@/components/seo/llm-meta";

const URL = "https://shorted.com.au/economy";
const TITLE = "Australian Economy Snapshot";
const DESCRIPTION =
  "Live snapshot of the Australian economy with an interactive state map: colour Australia by unemployment, trade or state final demand, then drill into any state — plus the RBA cash rate, inflation and petroleum refining, and the world prices and US rates that drive them: iron ore, coal, gold, LNG, crude, the US Treasury curve and the major currency pairs. ABS, RBA, DCCEEW, World Bank and FRED open data.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${TITLE} — cash rate, inflation, labour, trade, commodities, US rates`,
  description: DESCRIPTION,
  keywords: [
    "Australian economy",
    "RBA cash rate",
    "Australia CPI inflation",
    "Australia unemployment rate",
    "Australia trade exports imports",
    "Australia petroleum refining",
    "iron ore price",
    "gold price",
    "thermal coal price",
    "US Treasury yields",
    "exchange rates",
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
  "commodities.spot_price.gold.world",
  "commodities.crude_oil.brent.eur",
  "rates.treasury_yield.10y.usa",
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
  // The page is no longer all-CC-BY: the FRED half is US government output in
  // the public domain. Stating one licence for both would be wrong about one
  // of them, so the card takes it rather than assuming it.
  licence = "CC BY 4.0",
  children,
}: {
  title: string;
  subtitle: string;
  source: string;
  icon?: EconomyIconName;
  licence?: string;
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
      <p className="mt-3 text-[11px] text-muted-foreground/80">
        Source: {source} · {licence}
      </p>
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
  const gold = latest(headline, "commodities.spot_price.gold.world");
  const brent = latest(headline, "commodities.crude_oil.brent.eur");
  const usTenYear = latest(headline, "rates.treasury_yield.10y.usa");

  const tradeBalance =
    exportsAud !== undefined && importsAud !== undefined
      ? exportsAud - importsAud
      : undefined;

  const hasTiles = [
    cashRate,
    cpiYoy,
    unemployment,
    tradeBalance,
    audUsd,
    dieselSales,
    gold,
    brent,
    usTenYear,
  ].some((v) => v !== undefined);
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
    // The Australian and World Bank halves are CC BY 4.0; the FRED half is US
    // government output in the public domain. schema.org takes one license, so
    // this names the more restrictive of the two rather than over-claiming
    // public domain for series that are not.
    license: "https://creativecommons.org/licenses/by/4.0/",
    spatialCoverage: "Australia",
    sourceOrganization: [
      { "@type": "GovernmentOrganization", name: "Australian Bureau of Statistics", url: "https://abs.gov.au" },
      { "@type": "Organization", name: "Reserve Bank of Australia", url: "https://rba.gov.au" },
      { "@type": "GovernmentOrganization", name: "Department of Climate Change, Energy, the Environment and Water", url: "https://www.energy.gov.au" },
      { "@type": "Organization", name: "World Bank", url: "https://www.worldbank.org/en/research/commodity-markets" },
      { "@type": "Organization", name: "Federal Reserve Bank of St. Louis (FRED)", url: "https://fred.stlouisfed.org/" },
    ],
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="ABS, RBA, DCCEEW, World Bank, FRED"
        dataFrequency="monthly"
        keywords={["Australian economy", "RBA cash rate", "CPI inflation", "unemployment rate", "trade balance", "iron ore price", "gold price", "US Treasury yields"]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-10 px-4 py-8">
        <header>
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Australian economy
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Rates, prices, labour, trade and petroleum from ABS, RBA and DCCEEW
            — plus the world commodity prices and US rates the Australian
            market actually trades against, from the World Bank and FRED.
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
            {gold !== undefined ? (
              <BigStat
                label="Gold"
                icon="crude-materials"
                value={`US$${Math.round(gold).toLocaleString("en-US")}/oz`}
                sub={`World Bank Pink Sheet · ${latestPeriod(headline, "commodities.spot_price.gold.world")}`}
              />
            ) : null}
            {brent !== undefined ? (
              <BigStat
                label="Brent crude"
                icon="mineral-fuels"
                value={`US$${brent.toFixed(2)}/bbl`}
                sub={`EIA via FRED · ${latestPeriod(headline, "commodities.crude_oil.brent.eur")}`}
              />
            ) : null}
            {usTenYear !== undefined ? (
              <BigStat
                label="US 10-year Treasury"
                icon="cash-rate"
                value={`${usTenYear.toFixed(2)}%`}
                sub={`Federal Reserve H.15 via FRED · ${latestPeriod(headline, "rates.treasury_yield.10y.usa")}`}
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

        {/* ── World prices & global rates ───────────────────────────── */}
        {/*
          Rendered from GLOBAL_ECONOMY_SERIES rather than hand-listed, so a
          series added to the FRED or Pink Sheet importer appears here without
          a second edit. A Go test (registry_drift_test.go) fails the build if
          the registry and the importers disagree — the failure mode this
          replaces is a series ingested, published through the API, and shown
          on no page at all.
        */}
        {GLOBAL_SERIES_GROUPS.map(({ group, title, blurb }) => {
          const series = GLOBAL_ECONOMY_SERIES.filter(
            (definition) => definition.group === group,
          );
          if (series.length === 0) return null;
          return (
            <section key={group} className="space-y-4">
              <SectionHeading title={title} blurb={blurb} />
              <div className="grid gap-6 lg:grid-cols-2">
                {series.map((definition) => (
                  <ChartCard
                    key={definition.key}
                    title={definition.title}
                    subtitle={definition.subtitle}
                    source={definition.source}
                    icon={definition.icon}
                    licence={
                      definition.source.includes("World Bank")
                        ? "CC BY 4.0"
                        : "US government, public domain"
                    }
                  >
                    <WhenVisible>
                      <EconomySeriesChart
                        seriesKey={definition.key}
                        format={definition.format}
                        ariaLabel={definition.title}
                      />
                    </WhenVisible>
                  </ChartCard>
                ))}
              </div>
            </section>
          );
        })}

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Australian sources: Australian Bureau of Statistics (Consumer Price
          Index, Labour Force, International Trade in Goods, National Accounts),
          Reserve Bank of Australia (F1.1, F11) and the Department of Climate
          Change, Energy, the Environment and Water (Australian Petroleum
          Statistics) — all CC BY 4.0. World commodity prices are the World Bank
          Commodity Markets &ldquo;Pink Sheet&rdquo;, CC BY 4.0. US rates,
          prices and exchange rates come from FRED (Federal Reserve Bank of St.
          Louis), sourced from the Federal Reserve, the Bureau of Labor
          Statistics and the Energy Information Administration — US government
          works in the public domain. Latest months may be preliminary. Not
          financial advice.
        </p>
      </div>
    </DashboardLayout>
  );
}
