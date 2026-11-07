import { type Metadata } from "next";
import { Suspense } from "react";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { siteConfig } from "~/@/config/site";
import { lede, pageTitle } from "~/@/lib/typography";
import { CompareIsland } from "./compare-island";

// Compare strategies: two or three canonical strategies side by side over their
// common window. The route is private (robots.txt disallows it), so it is noindex
// and its links are followed. A static shell: the comparison is read per visitor
// by the island, through a signed-in action, and nothing here reads the request.
// The island reads ?ids= under its own Suspense.
const TITLE = "Compare strategies";
const DESCRIPTION = "Compare two or three ASX stock-picking strategies over their common window.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: true },
  alternates: { canonical: `${siteConfig.url}/strategies/compare` },
  openGraph: {
    title: `${TITLE} | ${siteConfig.name}`,
    description: DESCRIPTION,
    url: `${siteConfig.url}/strategies/compare`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
};

export default function CompareStrategiesPage() {
  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div className="min-w-0">
          <h1 className={pageTitle}>Compare strategies</h1>
          <p className={lede}>
            Two or three strategies over the window they all cover, with their curves on one scale.
          </p>
        </div>
        <Suspense fallback={<div role="status" aria-busy="true" aria-label="Loading" className="text-sm text-muted-foreground">Loading the comparison…</div>}>
          <CompareIsland />
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
