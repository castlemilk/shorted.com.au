import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { getIndustryData } from "~/app/actions/industry/getIndustryData";
import { AlertsContent } from "./alerts-content";

// An account tool, not a landing page: the monitor builder sits behind the
// Premium gate and saves to the signed-in account. It was indexable with 211
// words and no canonical (robots.txt disallows `/alerts/`, which does not cover
// the bare path), so it is noindexed with its links still followed, and the
// canonical folds the `?industry=` deep links into one URL. No brand in the
// title: the root layout's `%s | Shorted` template appends it.
export const metadata: Metadata = {
  title: "Short-Interest Alerts",
  description:
    "Premium monitors for ASX short interest: a stock or industry crossing a threshold, rising by set points, or entering the top ten, checked daily or weekly.",
  robots: { index: false, follow: true },
  alternates: { canonical: `${siteConfig.url}/alerts` },
};

/**
 * Industry names for the builder's datalist. The feed is cached, and a failed
 * read leaves the list empty rather than failing the page: the server checks
 * the industry on save either way.
 */
async function loadIndustryNames(): Promise<string[]> {
  try {
    const industries = await getIndustryData();
    const names = new Set<string>();
    for (const industry of industries) {
      const name = industryLabel(industry.name);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams?: { industry?: string | string[] };
}) {
  const industry = Array.isArray(searchParams?.industry)
    ? searchParams.industry[0]
    : searchParams?.industry;
  const industryNames = await loadIndustryNames();

  return (
    <AlertsContent initialIndustry={industry} industryNames={industryNames} />
  );
}
