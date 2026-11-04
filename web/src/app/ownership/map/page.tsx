import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { OwnershipMap } from "~/@/components/ownership/desk/ownership-map";
import { MapLede } from "~/@/components/ownership/desk/map-lede";
import { Inspector } from "~/@/components/ownership/workspace/inspector";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  loadFundPositionChanges,
  loadInspector,
  loadOwnershipMap,
  loadStockPanel,
} from "~/app/actions/ownershipDesk";

const URL = "https://shorted.com.au/ownership/map";
const TITLE = "Market map: disclosed ownership by sector";
const DESCRIPTION =
  "A treemap of the ASX by sector: what the substantial holding notices disclose, the holdings of the tracked index funds, hedge funds and institutions, and the short position, one stock at a time.";

/** The map reads the desk's default window, so the page is the same for every visitor and cached hourly. */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
};

/** The index fund files' span, as the coverage line prints it. */
function fundFilesLine(dates: readonly string[]): string {
  if (dates.length === 0) return "Fund files: n/a";
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? `Fund files: ${first}` : `Fund files: ${first} to ${last}`;
}

export default async function OwnershipMapPage() {
  const [map, funds] = await Promise.all([loadOwnershipMap({}), loadFundPositionChanges({})]);
  // A failed read is an outage, never an empty market: the cache is not kept with it.
  if (!map.ok) await bailOnEmptyRender();

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage
        inspector={<Inspector resolve={loadInspector} emptyText="Select a company to inspect its holding." />}
      >
        <div className="mx-auto w-full max-w-[100rem] space-y-6">
          {/* The build's render and an outage are the same shell: the sweep re-primes it (spec 14.7). */}
          {!map.ok ? <span hidden data-isr-shell="empty" /> : null}
          <header className="space-y-1.5">
            <h1 className={pageTitle}>Map the market</h1>
            <MapLede />
          </header>
          <p className="text-xs text-muted-foreground">
            {/* A failed fund read is an outage line, never "n/a": the page is cached with it as drawn. */}
            {funds.ok ? fundFilesLine(funds.snapshotDates ?? []) : "Fund files: could not be read just now"} · Latest
            available ·{" "}
            <Link href="/ownership#coverage" prefetch={false} className="text-primary underline-offset-4 hover:underline">
              Coverage
            </Link>
            : substantial notices and tracked index funds
          </p>
          <OwnershipMap
            initial={map}
            loadMap={loadOwnershipMap}
            loadPanel={loadStockPanel}
            basePath="/ownership/map"
            variant="full"
          />
          <p className="text-sm">
            <Link href="/ownership/stocks" prefetch={false} className="text-primary underline-offset-4 hover:underline">
              View all stocks in the registers →
            </Link>
          </p>
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
