import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { OwnershipFlows } from "~/@/components/ownership/desk/ownership-flows";
import { Inspector } from "~/@/components/ownership/workspace/inspector";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { lede, pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { loadInspector, loadOwnershipFlows } from "~/app/actions/ownershipDesk";

const URL = "https://shorted.com.au/ownership/connections";
const TITLE = "Ownership connections: holder types to sectors";
const DESCRIPTION =
  "How the disclosed interests of each kind of holder (super funds, index managers, hedge funds, banks and brokers) connect to each ASX sector, as a sankey of estimated disclosed exposure, with the notices behind every band.";

/** The default window's flows are the same for every visitor, so the page is cached hourly. */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
};

export default async function OwnershipConnectionsPage() {
  const flows = await loadOwnershipFlows({});
  // A failed read is an outage, never an empty sankey: the cache is not kept with it.
  if (!flows.ok) await bailOnEmptyRender();

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage
        inspector={<Inspector resolve={loadInspector} emptyText="Select a connection to inspect its holders." />}
      >
        <div className="mx-auto w-full max-w-[100rem] space-y-6">
          {/* The build's render and an outage are the same shell: the sweep re-primes it (spec 14.7). */}
          {!flows.ok ? <span hidden data-isr-shell="empty" /> : null}
          <header className="space-y-1.5">
            <h1 className={pageTitle}>Follow the ownership connections</h1>
            <p className={lede}>Disclosed interests by holder type and sector</p>
          </header>
          <OwnershipFlows initial={flows} loadFlows={loadOwnershipFlows} basePath="/ownership/connections" variant="full" />
          <p className="text-sm">
            <Link href="/ownership/notices" prefetch={false} className="text-primary underline-offset-4 hover:underline">
              All substantial notices →
            </Link>
          </p>
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
