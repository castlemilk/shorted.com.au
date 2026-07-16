import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { PropertyHistoryView } from "@/components/housing/property-history-view-loader";

export const revalidate = 3600;

interface PageProps {
  params: Promise<{ addressKey: string }>;
}

/**
 * "1-centre-road-brighton-vic-3186" -> "1 Centre Road Brighton Vic 3186".
 * address_key is derived from street+suburb+state+postcode (see
 * services/house-price-collector/crawl_address.go), so a dash-split title-case
 * is a reasonable fallback while the real display address loads client-side
 * (the page itself fetches over connect-web, which can't run server-side).
 */
function prettifyAddressKey(key: string): string {
  return key
    .split("-")
    .filter(Boolean)
    .join(" ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { addressKey } = await params;
  const name = prettifyAddressKey(addressKey);
  const title = `${name} — Property Price History`;
  const description = `Price and listing history for ${name}, tracked from realestate.com.au and Domain listings.`;
  const url = `https://shorted.com.au/housing/property/${addressKey}`;
  return {
    title, description, alternates: { canonical: url },
    // Individual address pages are derived from a flag-gated, still-rolling-out
    // crawl tier — keep them out of the index until the data is consistently
    // populated (same posture as /chat and other data-dependent app surfaces).
    robots: { index: false, follow: false },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary", title, description, creator: "@shorted___" },
  };
}

export default async function PropertyHistoryPage({ params }: PageProps) {
  const { addressKey } = await params;
  if (!addressKey) notFound();
  const name = prettifyAddressKey(addressKey);

  return (
    <DashboardLayout>
      <LLMMeta
        title={`${name} Property Price History`}
        description={`Price and listing history for ${name}.`}
        url={`https://shorted.com.au/housing/property/${addressKey}`}
        dataSource="realestate.com.au, domain.com.au"
        dataFrequency="daily"
        keywords={[`${name} price history`, `${name} listing history`]}
      />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <HousingBreadcrumb />
        <PropertyHistoryView addressKey={addressKey} />
      </div>
    </DashboardLayout>
  );
}
