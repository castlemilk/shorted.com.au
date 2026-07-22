import type { Metadata } from "next";
import type { ReactNode } from "react";
import { preload } from "react-dom";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { getHousingOverview } from "~/app/actions/getHousing";
import { bailOnEmptyRender } from "~/app/actions/config";
import { HousingTiles, type HousingTile } from "@/components/housing/housing-tiles";
import { HousingSeriesChart } from "@/components/housing/housing-charts";
import { HousingZoomMap } from "@/components/housing/housing-zoom-map-loader";
import { SuburbPriceDropsPanel } from "@/components/housing/suburb-price-drops-panel-loader";
import { WhenVisible } from "@/components/housing/when-visible";
import { GCCSA_TO_STATE } from "@/lib/housing/states";
import type { StateStat } from "@/lib/housing/map-lod";
import { LLMMeta } from "@/components/seo/llm-meta";
import { cn } from "@/lib/utils";
import { HousingIcon, type HousingIconName } from "@/components/housing/housing-icon";

const URL = "https://shorted.com.au/housing";
const TITLE = "Australian House Prices Tracker";
const DESCRIPTION =
  "Live Australian house-price data — national and capital-city mean & median dwelling prices, quarterly change, and household debt-to-income — sourced from the ABS and RBA.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "Australian house prices",
    "capital city median house price",
    "ABS residential property prices",
    "household debt to income",
    "Sydney Melbourne Brisbane house prices",
  ],
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

function fmtAUD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

function yoyDelta(pct: number): { delta: string; tone: "up" | "down" } {
  return { delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% yr`, tone: pct >= 0 ? "up" : "down" };
}

function quarterLabel(seconds?: bigint): string {
  if (!seconds) return "";
  const d = new Date(Number(seconds) * 1000);
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

function BigStat({ label, value, delta, tone, sub, icon }: { label: string; value: string; delta?: string; tone?: "up" | "down"; sub?: string; icon?: HousingIconName }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon ? <HousingIcon name={icon} size={15} /> : null}{label}
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-foreground">{value}</div>
      {delta ? (
        <div className={cn("mt-1 font-mono text-sm tabular-nums", tone === "up" ? "text-[color:var(--semantic-green)]" : "text-[color:var(--semantic-red)]")}>
          {delta}
        </div>
      ) : null}
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function ChartCard({ title, subtitle, children, icon }: { title: string; subtitle: string; children: ReactNode; icon?: HousingIconName }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <h3 className="flex items-center gap-2 font-serif text-lg text-foreground">
          {icon ? <HousingIcon name={icon} size={18} /> : null}{title}
        </h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

export default async function HousingPage() {
  const overview = await getHousingOverview("");
  const metrics = overview?.metrics ?? [];
  // A failed/cold fetch must not bake the "data is loading" shell into the
  // route cache for the whole revalidate window.
  if (metrics.length === 0) bailOnEmptyRender();

  const national = metrics.find((m) => m.regionCode === "AUS" && m.measure === "mean_price");
  const dti = metrics.find((m) => m.regionCode === "AUS" && m.measure === "debt_to_income");
  const index = metrics.find((m) => m.regionCode === "AUS" && m.measure === "price_index");
  const capitals = metrics
    .filter((m) => m.regionType === "gccsa" && m.measure === "median_price" && m.dwellingType === "established_house")
    .sort((a, b) => b.value - a.value);

  // Warm the 493KB national boundary file while the page hydrates, instead of
  // waiting for the (dynamic, ssr:false) map chunk to download + mount before
  // use-topojson.ts can even fire its fetch. Only when the map will render.
  if (metrics.length > 0) {
    // crossOrigin:"anonymous" is REQUIRED for the preload to be reused by
    // use-topojson.ts's `fetch()` (cors mode, credentials same-origin) — a bare
    // as:"fetch" preload mismatches and double-downloads the 493KB file.
    preload("/geo/states.topojson", { as: "fetch", crossOrigin: "anonymous" });
  }

  const asOf = quarterLabel(overview?.asOf?.seconds);

  // Map GCCSA medians + change onto their state for the national choropleth hover.
  const stateStats = new Map<string, StateStat>();
  for (const m of capitals) {
    const st = GCCSA_TO_STATE[m.regionCode];
    if (st) stateStats.set(st, { median: m.value, yoyPct: m.yoyPct, qoqPct: m.qoqPct, capital: m.regionName });
  }

  const capitalTiles: HousingTile[] = capitals.map((m) => {
    const d = yoyDelta(m.yoyPct);
    const st = GCCSA_TO_STATE[m.regionCode];
    return {
      label: m.regionName.replace("Greater ", ""),
      value: fmtAUD(m.value),
      delta: d.delta,
      tone: d.tone,
      sub: `${m.qoqPct >= 0 ? "+" : ""}${m.qoqPct.toFixed(1)}% qtr`,
      href: st ? `/housing/${st.toLowerCase()}` : undefined,
    };
  });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Australian House Prices",
    description: DESCRIPTION,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    spatialCoverage: "Australia",
    temporalCoverage: "2003/..",
    sourceOrganization: [
      { "@type": "GovernmentOrganization", name: "Australian Bureau of Statistics", url: "https://abs.gov.au" },
      { "@type": "Organization", name: "Reserve Bank of Australia", url: "https://rba.gov.au" },
    ],
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="ABS, RBA"
        dataFrequency="quarterly"
        keywords={["Australian house prices", "ABS residential property", "household debt to income"]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-10 px-4 py-8">
        <header>
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Australian house prices
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            National and capital-city dwelling prices and household debt, quarterly,
            from the Australian Bureau of Statistics and the Reserve Bank
            {asOf ? ` · as of ${asOf}` : ""}.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Looking for the broader picture?{" "}
            <Link href="/economy" className="font-medium text-primary underline-offset-4 hover:underline">
              Explore the Australian economy dashboard →
            </Link>
          </p>
        </header>

        {metrics.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            House-price data is loading — check back shortly.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {national ? (
                <BigStat
                  icon="median-price"
                  label="National mean dwelling"
                  value={fmtAUD(national.value)}
                  {...yoyDelta(national.yoyPct)}
                  sub={`${national.qoqPct >= 0 ? "+" : ""}${national.qoqPct.toFixed(1)}% this quarter`}
                />
              ) : null}
              {dti ? (
                <BigStat
                  icon="debt"
                  label="Household debt-to-income"
                  value={`${dti.value.toFixed(0)}%`}
                  delta={`${dti.yoyPct >= 0 ? "+" : ""}${dti.yoyPct.toFixed(1)}pp yr`}
                  tone={dti.yoyPct >= 0 ? "down" : "up"}
                  sub="RBA — among the world's highest"
                />
              ) : null}
              {index ? (
                <BigStat
                  icon="price-index"
                  label="8-capital price index"
                  value={index.value.toFixed(1)}
                  sub="ABS RPPI (2011–12 = 100, to 2021)"
                />
              ) : null}
            </div>

            <section className="space-y-3">
              <h2 className="flex items-center gap-2 font-serif text-2xl text-foreground">
                <HousingIcon name="location" size={22} /> Explore by state
              </h2>
              <p className="text-sm text-muted-foreground">
                Shaded by greater-capital median house price. Click a state to fly into its suburbs — and zoom back out.
              </p>
              <div className="overflow-hidden rounded-xl border border-border bg-card p-3">
                <HousingZoomMap stateStats={stateStats} />
              </div>
            </section>

            <section className="space-y-4">
              <h2 className="flex items-center gap-2 font-serif text-2xl text-foreground">
                <HousingIcon name="city" size={22} /> Capital-city medians
              </h2>
              <p className="text-sm text-muted-foreground">
                Median price of established house transfers, by greater capital-city
                area. YoY change shown; quarter change below.
              </p>
              <HousingTiles tiles={capitalTiles} />
            </section>

            <section>
              <Link
                href="/price-drops"
                className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50"
              >
                <div>
                  <h2 className="flex items-center gap-2 font-serif text-xl text-foreground">
                    <HousingIcon name="median-price" size={20} /> Price drops — by state, suburb &amp; agency
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Where asking prices are falling: cuts ranked by state, suburb,
                    individual address and real-estate agency, tracked daily from
                    live portal listings.
                  </p>
                </div>
                <span className="font-mono text-sm text-primary transition-transform group-hover:translate-x-0.5">
                  Open price drops →
                </span>
              </Link>
            </section>

            <SuburbPriceDropsPanel title="Biggest price drops by suburb" limit={25} />

            <section>
              <Link
                href="/housing/calculators"
                className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50"
              >
                <div>
                  <h2 className="flex items-center gap-2 font-serif text-xl text-foreground">
                    <HousingIcon name="mortgage" size={20} /> Home loan &amp; deposit calculators
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Simulate repayments with extras and an offset, see rate-shock
                    scenarios, count the years to a deposit, and estimate stamp
                    duty in every state.
                  </p>
                </div>
                <span className="font-mono text-sm text-primary transition-transform group-hover:translate-x-0.5">
                  Open calculators →
                </span>
              </Link>
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <ChartCard icon="median-price" title="National mean dwelling price" subtitle="ABS Total Value of Dwellings · quarterly">
                <WhenVisible>
                  <HousingSeriesChart regionCode="AUS" measure="mean_price" ariaLabel="National mean dwelling price" format="aud" />
                </WhenVisible>
              </ChartCard>
              <ChartCard icon="debt" title="Household debt-to-income" subtitle="RBA Table E2 · quarterly">
                <WhenVisible>
                  <HousingSeriesChart regionCode="AUS" measure="debt_to_income" ariaLabel="Household debt to income ratio" format="percent" />
                </WhenVisible>
              </ChartCard>
            </section>
          </>
        )}

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Sources: Australian Bureau of Statistics (Residential Dwellings, CC BY 4.0)
          and Reserve Bank of Australia. Quarterly; the most recent quarter may be
          preliminary. Not financial advice.
        </p>
      </div>
    </DashboardLayout>
  );
}
