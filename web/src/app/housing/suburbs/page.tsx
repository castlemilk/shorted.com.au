import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { SuburbExplorer } from "@/components/housing/suburb-explorer-loader";
import { LLMMeta } from "@/components/seo/llm-meta";

const URL = "https://shorted.com.au/housing/suburbs";
const TITLE = "Australian Suburb House Prices";
const DESCRIPTION =
  "Explore median house prices by suburb across South Australia and Victoria — quarterly (SA) and annual (VIC) medians sourced from the state Valuer-General offices (CC BY).";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "suburb house prices Australia",
    "median house price by suburb",
    "Adelaide suburb prices",
    "Melbourne suburb prices",
    "Valuer-General median house",
  ],
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

export default function SuburbsPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Australian Suburb Median House Prices",
    description: DESCRIPTION,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    spatialCoverage: "South Australia; Victoria",
    sourceOrganization: [
      { "@type": "GovernmentOrganization", name: "Valuer-General South Australia" },
      { "@type": "GovernmentOrganization", name: "Valuer-General Victoria" },
    ],
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="SA & VIC Valuer-General"
        dataFrequency="quarterly / annual"
        keywords={["suburb house prices", "median house price by suburb", "Valuer-General"]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <header>
          <Link href="/housing" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            ← Australian house prices
          </Link>
          <h1 className="mt-2 font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Suburb house prices
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Median house price by suburb, from the South Australian and Victorian
            Valuer-General offices. Search a suburb to see its full price history.
          </p>
        </header>

        <SuburbExplorer />

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Sources: Valuer-General South Australia (metro Adelaide, quarterly) and
          Valuer-General Victoria (VPSR, annual) — both CC BY. Medians from small
          sample sizes may be volatile or preliminary. Not financial advice.
        </p>
      </div>
    </DashboardLayout>
  );
}
