import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { StateSuburbExplorer } from "@/components/housing/state-suburb-explorer-loader";
import { StateSuburbDirectorySection } from "@/components/housing/state-suburb-directory";
import { buildStateSuburbDirectory } from "@/lib/housing/state-suburb-directory";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getStateSuburbIndex } from "~/app/actions/getHousingStateIndex";
import { SuburbPriceDropsPanel } from "@/components/housing/suburb-price-drops-panel-loader";
import { ALL_STATES, STATE_NAMES, slugToState, stateSlug, titleCaseName } from "@/lib/housing/states";

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
  // Lead with the state's own numbers when the (24h-cached) index is available;
  // the templated sentence is the fallback, never an error, so a backend blip
  // cannot turn into a missing description on an ISR page.
  let description = `Median house prices and ABS Census demographics by suburb across ${name}.`;
  try {
    const d = buildStateSuburbDirectory(await getStateSuburbIndex(code));
    const dearest = d.mostExpensive[0];
    if (d.pricedCount > 0) {
      description =
        `Median house prices for ${d.pricedCount.toLocaleString("en-AU")} ${name} suburbs from Valuer-General open data` +
        (d.averageOfMedians ? ` (average of suburb medians ${fmtPriceShort(d.averageOfMedians)})` : "") +
        (dearest ? `, from ${titleCaseName(dearest.salName)} at ${fmtPriceShort(dearest.latestMedianPrice)} down` : "") +
        `. ABS Census demographics, electorates, schools and amenities for all ${d.total.toLocaleString("en-AU")} suburbs.`;
    } else if (d.total > 0) {
      description =
        `Suburb profiles for ${d.total.toLocaleString("en-AU")} ${name} suburbs: ABS Census population, income and age, ` +
        `schools, amenities, councils and electorates. No published Valuer-General price feed for ${name}.`;
    }
  } catch (error) {
    console.warn(`[housing/state] suburb index unavailable for metadata (${code}):`, error);
  }
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
  // The crawlable directory needs the state's suburb list. It is the same
  // 24h-cached projection every suburb page in the state reads, so this adds
  // no new upstream load — and on failure the page degrades to the explorer
  // alone without letting ISR bake the degraded render (bailOnEmptyRender).
  const directory = await getStateSuburbIndex(code)
    .then((suburbs) => buildStateSuburbDirectory(suburbs))
    .catch(async (error: unknown) => {
      console.warn(`[housing/state] suburb index unavailable for ${code}:`, error);
      await bailOnEmptyRender();
      return null;
    });
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
        {directory ? <StateSuburbDirectorySection stateCode={code} directory={directory} /> : null}
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
            , browse every{" "}
            <Link
              href={`/housing/${stateSlug(code)}/council`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {name} council
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
