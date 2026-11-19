import type { Metadata } from "next";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { AustralianInvestorDirectory } from "~/@/components/ownership/traders/australian-investor-directory";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { AUSTRALIAN_INVESTORS_PATH } from "~/@/lib/ownership/australian-investors";
import { TRADERS_PATH } from "~/@/lib/ownership/traders";
import { lede, pageTitle } from "~/@/lib/typography";
import { getInvestorDiscovery } from "~/app/actions/australianInvestors";
import { bailOnEmptyRender } from "~/app/actions/config";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Australian investor tracker",
  description:
    "Find people named in ASX substantial holding notices and annual top-20 registers. Follow their disclosed interests by issuer.",
  alternates: {
    canonical: `https://shorted.com.au${AUSTRALIAN_INVESTORS_PATH}`,
  },
};

export default async function AustralianInvestorsPage() {
  const feed = await getInvestorDiscovery();
  if (feed.status !== "complete") await bailOnEmptyRender();
  return (
    <DashboardLayout>
      <div className="mx-auto min-w-0 max-w-6xl space-y-7">
        <Breadcrumbs
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Traders", href: TRADERS_PATH },
            { label: "Australian investors", href: AUSTRALIAN_INVESTORS_PATH },
          ]}
          prefetch={false}
        />
        <header>
          <h1 className={pageTitle}>Australian investor tracker</h1>
          <p className={lede}>
            Find people through the ASX companies they hold. Explore voting
            interests from substantial holding notices and named shareholders in
            annual top-20 registers.
          </p>
        </header>
        {feed.status !== "complete" && <span data-isr-shell="empty" hidden />}
        <AustralianInvestorDirectory feed={feed} />
      </div>
    </DashboardLayout>
  );
}
