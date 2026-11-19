import Link from "next/link";
import { AUSTRALIAN_INVESTORS_PATH } from "~/@/lib/ownership/australian-investors";
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
    "Find investment managers, ASX directors and people named in Australian shareholder registers and substantial holding notices.",
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
        <Link href={AUSTRALIAN_INVESTORS_PATH} prefetch={false} className="block rounded-md border-l-2 border-primary bg-muted/30 px-5 py-4 hover:bg-muted/50">
          <span className="font-serif text-xl font-semibold text-primary">Australian investor tracker →</span>
          <span className="mt-1 block text-sm text-muted-foreground">Find named holders in ASX filings and annual top-20 registers. Save the people you follow.</span>
        </Link>
        <TraderDirectory />
      </div>
    </DashboardLayout>
  );
}
