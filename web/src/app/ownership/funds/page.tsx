import type { Metadata } from "next";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { FUND_STATUS_COPY, FundExposureMap } from "~/@/components/ownership/funds/fund-exposure-map";
import { Inspector } from "~/@/components/ownership/workspace/inspector";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { MethodDisclosure } from "~/@/components/ownership/workspace/method-disclosure";
import { lede, pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { loadFunds, resolveFundSelection } from "~/app/actions/ownershipFunds";

// The fund list is the workspace's Funds page (spec 14.3). Static ISR: it reads no
// search parameter; the exposure map reads its own from the URL in the browser.
export const revalidate = 3600;

const URL = "https://shorted.com.au/ownership/funds";
const TITLE = "Fund portfolios: index funds and super options";
const DESCRIPTION =
  "The ASX holdings in the latest files of the index funds and super fund options tracked: each fund's sector weights and largest positions, and what changed between two of its files.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
};

const CRUMBS = [
  { label: "Ownership", href: "/ownership" },
  { label: "Funds", href: "/ownership/funds" },
];

export default async function FundsPage() {
  const page = await loadFunds();
  // An outage is not an empty fund list: the page says so and its cache is shortened.
  if (!page.ok) await bailOnEmptyRender();

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage inspector={<Inspector resolve={resolveFundSelection} emptyText="Select a fund to inspect its portfolio." />}>
        <div className="space-y-6">
          <Breadcrumbs items={CRUMBS} />
          <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <h1 className={pageTitle}>Explore fund portfolios</h1>
              <p className={lede}>Compare the shape of reported portfolios, then open a fund.</p>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{FUND_STATUS_COPY}</p>
          </header>
          {page.ok ? (
            <FundExposureMap funds={page.funds} />
          ) : (
            <>
              {/* The build's render and an outage are the same shell: the sweep re-primes it (spec 14.7). */}
              <span hidden data-isr-shell="empty" />
              <p className="text-muted-foreground">
                The funds could not be read just now. Nothing here is missing from the register: this is our end.
              </p>
            </>
          )}
          <MethodDisclosure />
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
