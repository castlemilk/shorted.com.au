import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { StateSuburbExplorer } from "@/components/housing/state-suburb-explorer-loader";
import { ALL_STATES, STATE_NAMES, slugToState, stateSlug } from "@/lib/housing/states";

export const revalidate = 86400;

interface PageProps { params: Promise<{ state: string }> }

export async function generateStaticParams(): Promise<{ state: string }[]> {
  return ALL_STATES.map((s) => ({ state: stateSlug(s) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { state } = await params;
  const code = slugToState(state);
  if (!code) return {};
  const name = STATE_NAMES[code]!;
  const url = `https://shorted.com.au/housing/${stateSlug(code)}`;
  const title = `${name} Suburb House Prices`;
  const description = `Median house prices and ABS Census demographics by suburb across ${name}.`;
  return {
    title, description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description, creator: "@shorted___" },
  };
}

export default async function StatePage({ params }: PageProps) {
  const { state } = await params;
  const code = slugToState(state);
  if (!code) notFound();
  const name = STATE_NAMES[code]!;
  const url = `https://shorted.com.au/housing/${stateSlug(code)}`;
  return (
    <DashboardLayout>
      <LLMMeta title={`${name} Suburb House Prices`}
        description={`Median house prices and demographics by suburb across ${name}.`}
        url={url} dataSource="ABS Census, state Valuer-General" dataFrequency="quarterly / 5-yearly"
        keywords={[`${name} suburb house prices`, "median house price by suburb"]} />
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <HousingBreadcrumb trail={[{ label: "Housing", href: "/housing" }, { label: name }]} />
        <header>
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{name} suburbs</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">Each suburb shaded by its latest median house price. Hover for demographics, click to open its full profile.</p>
        </header>
        <StateSuburbExplorer stateCode={code} />
      </div>
    </DashboardLayout>
  );
}
