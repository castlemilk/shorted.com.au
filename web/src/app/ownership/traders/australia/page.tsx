import type { Metadata } from "next";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { AustralianInvestorDirectory } from "~/@/components/ownership/traders/australian-investor-directory";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { AUSTRALIAN_INVESTORS_PATH } from "~/@/lib/ownership/australian-investors";
import { TRADERS_PATH } from "~/@/lib/ownership/traders";
import { pageTitle } from "~/@/lib/typography";
import { formatIsoDate } from "~/@/lib/strategies/format";
import { getInvestorDiscovery } from "~/app/actions/australianInvestors";
import { bailOnEmptyRender } from "~/app/actions/config";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Australian investor tracker",
  description:
    "Find people named in ASX notices, annual top-20 registers and substantial shareholder lists. Follow their disclosed interests by issuer.",
  alternates: {
    canonical: `https://shorted.com.au${AUSTRALIAN_INVESTORS_PATH}`,
  },
};

export default async function AustralianInvestorsPage() {
  const feed = await getInvestorDiscovery();
  if (feed.status !== "complete") await bailOnEmptyRender();
  return (
    <DashboardLayout>
      <div className="mx-auto min-w-0 max-w-6xl space-y-4 sm:space-y-5">
        <Breadcrumbs
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Traders", href: TRADERS_PATH },
            { label: "Australian investors", href: AUSTRALIAN_INVESTORS_PATH },
          ]}
          prefetch={false}
        />
        <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
          <div>
            <h1 className={pageTitle}>Australian investor tracker</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Shareholders named in ASX notices and company annual reports.
            </p>
          </div>
          {feed.asOf && (
            <p className="text-xs text-muted-foreground sm:text-right">
              Filings through{" "}
              <time
                className="text-foreground sm:mt-0.5 sm:block sm:text-sm"
                dateTime={feed.asOf}
              >
                {formatIsoDate(feed.asOf)}
              </time>
            </p>
          )}
        </header>
        {feed.status !== "complete" && <span data-isr-shell="empty" hidden />}
        <AustralianInvestorDirectory feed={feed} />
      </div>
    </DashboardLayout>
  );
}
