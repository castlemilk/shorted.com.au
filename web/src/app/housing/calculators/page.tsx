import type { Metadata } from "next";
import { Suspense } from "react";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getHousingOverview } from "~/app/actions/getHousing";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingIcon } from "@/components/housing/housing-icon";
import { QueryPrefilledCalculators, QueryPrefillNote } from "./calculator-prefill";
import { CalculatorSet, PrefillNote } from "./calculator-set";
import { resolvePrefill } from "./prefill";
import { JsonLd } from "~/@/components/seo/json-ld";

const URL = "https://shorted.com.au/housing/calculators";
const TITLE = "Home Loan & Deposit Calculators — Australian House Prices";
const DESCRIPTION =
  "Free Australian mortgage, deposit, stamp-duty and rent-vs-buy calculators — simulate repayments with extra payments and an offset, see rate-shock scenarios, work out years to a deposit, estimate transfer duty in every state, and project whether buying or renting leaves you better off.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "mortgage repayment calculator Australia",
    "stamp duty calculator by state",
    "home deposit savings calculator",
    "offset account calculator",
    "extra repayments calculator",
    "rent vs buy calculator Australia",
  ],
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

export default async function HousingCalculatorsPage() {
  // Live default: the national mean dwelling price from the ABS-fed tracker.
  const overview = await getHousingOverview("");
  const national = overview?.metrics?.find(
    (m) => m.regionCode === "AUS" && m.measure === "mean_price",
  );
  const liveDefault = national?.value
    ? Math.round(national.value / 10_000) * 10_000
    : 1_000_000;
  // The hard-coded $1m default is this page's data-empty render: a minute in
  // the route cache, not the hour.
  if (!national?.value) await bailOnEmptyRender();

  // The page is ISR, so it never reads the query: a suburb's ?price=&state=
  // is applied in the browser by the two Query* islands below. Each sits under
  // a real Suspense boundary whose fallback is the unprefilled render, which is
  // what the static HTML (and so a crawler) gets: the same markup the
  // canonical URL always served.
  const unprefilled = resolvePrefill(null, liveDefault);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: TITLE,
    description: DESCRIPTION,
    url: URL,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "AUD" },
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="ABS (defaults), state revenue offices (duty schedules)"
        dataFrequency="quarterly"
        keywords={["mortgage calculator", "stamp duty", "home deposit", "Australia"]}
      />
      <JsonLd data={jsonLd} />

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <header>
          <h1 className="flex items-center gap-3 font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            <HousingIcon name="mortgage" size={36} /> Home loan calculators
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Four calculators for Australian buyers: simulate mortgage
            repayments (with extra payments, a lump sum and an offset account),
            work out how long a deposit will take to save, estimate stamp
            duty in every state and territory, and compare whether buying or
            renting leaves you better off.
            <Suspense fallback={<PrefillNote prefill={unprefilled} />}>
              <QueryPrefillNote liveDefault={liveDefault} />
            </Suspense>
          </p>
        </header>

        <Suspense fallback={<CalculatorSet {...unprefilled} />}>
          <QueryPrefilledCalculators liveDefault={liveDefault} />
        </Suspense>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Estimates only, not financial advice; excludes LMI, fees; verify duty
          with your state revenue office. Duty schedules baked from the 2025–26
          general rates; thresholds in some states are indexed annually. The
          rent-vs-buy projection is highly assumption-sensitive — treat it as a
          scenario tool, not a forecast.
        </p>
      </div>
    </DashboardLayout>
  );
}
