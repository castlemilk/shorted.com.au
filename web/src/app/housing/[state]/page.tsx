import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { StateSuburbExplorer } from "@/components/housing/state-suburb-explorer-loader";
import { SuburbPriceDropsPanel } from "@/components/housing/suburb-price-drops-panel-loader";
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
        <HousingBreadcrumb stateCode={code} />
        <header>
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{name} suburbs</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">Suburbs shaded by their latest median house price where available, over an ABS Census base. Hover for demographics, click to open the full profile.</p>
        </header>
        <StateSuburbExplorer stateCode={code} />
        <SuburbPriceDropsPanel stateCode={code} title={`${name} suburb prices & movers`} />
        <aside
          aria-labelledby="related-state-context-heading"
          className="border-t border-border/60 pt-4"
        >
          <h2
            id="related-state-context-heading"
            className="text-sm font-medium text-foreground"
          >
            Related state context
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Put these suburb results alongside the{" "}
            <Link
              href={`/economy/${stateSlug(code)}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {name} economy
            </Link>
            , compare every state on the{" "}
            <Link
              href="/housing"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              national housing dashboard
            </Link>
            , or review{" "}
            <Link
              href={`/price-drops?state=${stateSlug(code)}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              state-filtered asking-price cuts
            </Link>
            .
          </p>
        </aside>
      </div>
    </DashboardLayout>
  );
}
