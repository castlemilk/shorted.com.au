import type { Metadata } from "next";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { TraderDirectory } from "~/@/components/ownership/traders/trader-directory";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { TRADERS_PATH } from "~/@/lib/ownership/traders";
import { lede, pageTitle } from "~/@/lib/typography";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Trader profiles and disclosed holdings",
  description:
    "Find investment managers and ASX directors. Explore the holdings their firms report and the changes directors disclose in company filings.",
  alternates: { canonical: `https://shorted.com.au${TRADERS_PATH}` },
};

export default function TradersPage() {
  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-8">
        <Breadcrumbs
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Traders", href: TRADERS_PATH },
          ]}
          prefetch={false}
        />
        <header>
          <h1 className={pageTitle}>Trader profiles</h1>
          <p className={lede}>
            Follow an investment manager through their firm’s holdings, or find
            a director’s disclosed transactions in an ASX company.
          </p>
        </header>
        <TraderDirectory />
      </div>
    </DashboardLayout>
  );
}
