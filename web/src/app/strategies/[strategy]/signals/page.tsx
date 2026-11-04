import { type Metadata } from "next";
import { notFound } from "next/navigation";

import { siteConfig } from "~/@/config/site";
import { SIGNALS_PUBLIC_ROWS } from "~/@/lib/strategies/signals";
import { STRATEGY_SLUGS, getStrategy } from "~/@/lib/strategies/registry";
import { firstNonEmpty } from "~/@/lib/strategies/format";
import type { SignalRule } from "~/@/lib/strategies/signals";
import { getStrategyPicks } from "~/app/actions/getStrategyPicks";
import { bailOnEmptyRender } from "~/app/actions/config";
import { SignalsIsland, type SignalsIslandProps } from "./signals-island";

// The Signals tab: which stocks meet the strategy's rules, from the same ranked
// read as the Overview. Its ISR is the segment's (the layout owns the params);
// no searchParams are read here, the ?sel= selection is read client-side by the
// island under its own <Suspense>.
//
// Anonymous visitors get the top SIGNALS_PUBLIC_ROWS rows and the count of the
// rest. The page is noindex, follow: the strategy's Overview is the indexable
// page for the same rankings.
export const revalidate = 3600;
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ strategy: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();
  const url = `${siteConfig.url}/strategies/${seo.slug}/signals`;
  return {
    title: `Signals: ${seo.h1}`,
    description: `Which ASX stocks meet the ${seo.h1} rules today, rule by rule, with the evidence for each.`,
    robots: { index: false, follow: true },
    alternates: { canonical: url },
  };
}

export default async function StrategySignalsPage({ params }: PageProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();

  const data = await getStrategyPicks(seo.slug);
  // A failed or cold read must not bake an empty tab into the route cache.
  if (!data) await bailOnEmptyRender();

  const strategy = data?.strategy ?? null;
  const rules: SignalRule[] = (strategy?.rules ?? []).map((rule) => ({
    id: rule.id,
    title: rule.title,
    core: rule.core,
    trigger: rule.trigger === true,
    evaluation: rule.evaluation,
    threshold: rule.threshold,
    unit: rule.unit,
    comparator: rule.comparator,
  }));

  const props: SignalsIslandProps = {
    slug: seo.slug,
    available: data !== null,
    strategyName: firstNonEmpty(strategy?.name, seo.label),
    rules,
    rows: (data?.picks ?? []).slice(0, SIGNALS_PUBLIC_ROWS),
    counts: data?.statusCounts ?? null,
    total: data?.totalCount ?? 0,
    asOf: data?.asOf ?? "",
    shortReportDate: data?.shortReportDate,
    shortAvailableDate: data?.shortAvailableDate,
    stale: data?.stale === true,
    version: data?.version,
    regime: data?.regime ?? null,
    universeLabel: data?.universeLabel ?? "",
    strategies: STRATEGY_SLUGS.map((id) => ({
      id,
      label: getStrategy(id)?.label ?? id,
    })),
  };

  return <SignalsIsland {...props} />;
}
