import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { OwnershipMap } from "~/@/components/ownership/desk/ownership-map";
import { MapLede } from "~/@/components/ownership/desk/map-lede";
import { Inspector } from "~/@/components/ownership/workspace/inspector";
import { WorkspacePage } from "~/@/components/workspace/workspace-page";
import { pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  loadInspector,
  loadOwnershipMap,
  loadStockPanel,
  type OwnershipMapPage,
} from "~/app/actions/ownershipDesk";
import { MethodDisclosure } from "~/@/components/ownership/workspace/method-disclosure";

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

/** The desk's method, as the insights page stated it: the self-comparison, and the notice change. */
const FUND_METHOD =
  "A fund's position at a date is its newest file on or before that date. A change compares each index fund with its own earlier file: its file at the window's start (or its first file inside the window) against its newest file at the end, so a fund whose first file falls inside the window is never read as new money. Shares are compared, and each fund's change is valued at its own later file's price (its start file's when the position has left it), so a price move is not a position move. A fund whose file states a value but no shares, on either side of its pair, is left out of the change and counts only in the value held. A window that holds one file per fund states levels only: every change is n/a.";
/** The notice method, before and after the link to Activity's heatmap (spec 14.10). */
const NOTICE_METHOD_BEFORE =
  "A notice's change is its present less its previous voting power, where it states both; a ceased notice counts its previous figure as a fall. On the map's net change lens a stock's figure is its net change across the window's notices, in percentage points: a direction and a size, not a share of anything. A notice is dated by the day ASX released it. Disclosed stakes are the register as the newest notices read state it, each interest counted once, times the company's market cap: what the notices disclose, not a share of the company. No past register is rebuilt from notices: a withheld notice would make it a guess. The same changes, by sector and week, are in the ";
const NOTICE_METHOD_AFTER = ".";

export default async function OwnershipMapPage() {
  const map = await loadOwnershipMap({});
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
          <OwnershipMap
            initial={map}
            loadMap={loadOwnershipMap}
            loadPanel={loadStockPanel}
            basePath="/ownership/map"
            variant="full"
          />
          {/* The method is folded to one line at the foot of the page (backlog B1); its text stays in the HTML. */}
          <MethodDisclosure
            extra={[
              <p key="fund">{FUND_METHOD}</p>,
              <p key="notice">
                {NOTICE_METHOD_BEFORE}
                <Link href="/ownership/activity" prefetch={false} className="text-primary underline-offset-4 hover:underline">
                  sector heatmap on Activity
                </Link>
                {NOTICE_METHOD_AFTER}
              </p>,
            ]}
          />
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
