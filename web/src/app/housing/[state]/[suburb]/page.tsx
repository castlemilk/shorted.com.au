import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { SuburbProfile } from "@/components/housing/suburb-profile-loader";
import { getSuburbProfile } from "~/app/actions/getHousing";
import { STATE_NAMES, slugToState, stateSlug } from "@/lib/housing/states";

export const revalidate = 86400;

interface PageProps {
  params: Promise<{ state: string; suburb: string }>;
  searchParams: Promise<{ sal?: string }>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { state, suburb } = await params;
  const { sal } = await searchParams;
  const code = slugToState(state);
  if (!code || !sal) return {};
  const profile = await getSuburbProfile(sal).catch(() => null);
  const name = profile?.summary?.salName ?? suburb.replace(/-/g, " ");
  const url = `https://shorted.com.au/housing/${stateSlug(code)}/${suburb}`;
  const title = `${name} House Prices & Demographics`;
  const description = `Median house price, ABS Census demographics and trends for ${name}, ${STATE_NAMES[code]}.`;
  return {
    title, description, alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description, creator: "@shorted___" },
  };
}

export default async function SuburbPage({ params, searchParams }: PageProps) {
  const { state, suburb } = await params;
  const { sal } = await searchParams;
  const code = slugToState(state);
  if (!code || !sal) notFound();
  const profile = await getSuburbProfile(sal).catch(() => null);
  if (!profile?.summary) notFound();
  const name = profile.summary.salName;
  return (
    <DashboardLayout>
      <LLMMeta title={`${name} House Prices`} description={`Median house price and demographics for ${name}.`}
        url={`https://shorted.com.au/housing/${stateSlug(code)}/${suburb}`} dataSource="ABS Census, Valuer-General" dataFrequency="quarterly / 5-yearly"
        keywords={[`${name} house prices`, `${name} demographics`]} />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <HousingBreadcrumb stateCode={code} suburb={name} />
        <SuburbProfile salCode={sal} regionCode={undefined} stateCode={code} />
      </div>
    </DashboardLayout>
  );
}
