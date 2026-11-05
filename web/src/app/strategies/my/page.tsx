import { type Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { siteConfig } from "~/@/config/site";
import { lede, pageTitle } from "~/@/lib/typography";
import { MyStrategiesIsland } from "./my-strategies-island";

// My strategies: the signed-in viewer's saved strategies, with today's counts.
// The page is a static shell; everything per-viewer happens in the island, after
// the session is known. The route is private (robots.txt disallows it), so it is
// noindex, follows its links, and nothing here reads a request.
const TITLE = "My strategies";
const DESCRIPTION =
  "Your saved ASX stock-picking strategies, with today's signal counts.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: true },
  alternates: { canonical: `${siteConfig.url}/strategies/my` },
  openGraph: {
    title: `${TITLE} | ${siteConfig.name}`,
    description: DESCRIPTION,
    url: `${siteConfig.url}/strategies/my`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
};

export default function MyStrategiesPage() {
  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div className="min-w-0">
          <h1 className={pageTitle}>My strategies</h1>
          <p className={lede}>
            The strategies you have saved, with how many stocks meet their rules today.
          </p>
        </div>
        <MyStrategiesIsland />
      </div>
    </DashboardLayout>
  );
}
