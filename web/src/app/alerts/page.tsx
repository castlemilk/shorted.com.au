import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
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

export default function AlertsPage({
  searchParams,
}: {
  searchParams?: { industry?: string | string[] };
}) {
  const industry = Array.isArray(searchParams?.industry)
    ? searchParams.industry[0]
    : searchParams?.industry;

  return <AlertsContent initialIndustry={industry} />;
}
