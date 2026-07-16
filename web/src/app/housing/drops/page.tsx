import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { AddressDropsBoard } from "@/components/housing/address-drops-board-loader";

export const revalidate = 3600;

const TITLE = "Biggest House Price Drops by Address";
const DESCRIPTION =
  "Individual Australian properties ranked by how far their for-sale asking price has fallen, tracked from realestate.com.au and Domain listings.";
const URL = "https://shorted.com.au/housing/drops";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  // Derived from a flag-gated, still-rolling-out crawl tier — keep it out of the
  // index until the data is consistently populated (same posture as the
  // per-address history pages).
  robots: { index: false, follow: false },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

export default function AddressDropsPage() {
  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="realestate.com.au, domain.com.au"
        dataFrequency="daily"
        keywords={["biggest house price drops", "reduced asking price", "price drops by address"]}
      />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <HousingBreadcrumb suburb="Price drops" />
        <AddressDropsBoard />
      </div>
    </DashboardLayout>
  );
}
