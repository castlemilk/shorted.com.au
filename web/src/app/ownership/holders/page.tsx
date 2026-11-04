import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { HolderBrowser } from "~/@/components/ownership/holders/holder-browser";
import { HolderConnectionsMap } from "~/@/components/ownership/holders/holder-connections-map";
import { HolderInspector } from "~/@/components/ownership/workspace/inspectors/holder-inspector";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { holderInspectorContent, type HolderConnectionsPage } from "~/@/components/ownership/holders/holder-tree";
import { lede, pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  loadHolderConnections,
  loadHolders,
  resolveHolderInspector,
} from "~/app/actions/ownershipHolders";

/** The page's shape when the directory names no holder to read: the outage copy, no request made. */
const UNREAD: HolderConnectionsPage = { ok: false, error: "", holder: null, positions: [], funds: [], capsOk: false };

const URL = "https://shorted.com.au/ownership/holders";
const TITLE = "Who holds the ASX: holders of listed companies";
const DESCRIPTION =
  "Institutions, super funds, managers and banks that hold ASX companies, as their substantial holding notices state it, with each holder's disclosed connections by sector and company.";

// Static ISR, as the other workspace pages: the default holder's map and inspector
// are in the HTML, and the islands read the URL for every other view.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    type: "website",
    url: URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Shorted",
    locale: "en_AU",
    images: [{ url: "/ownership/opengraph-image", alt: "Who owns the ASX, on Shorted" }],
  },
  twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
};

/**
 * The holders workspace (spec 14.3): the directory as a browser, the default
 * holder's connections map and its inspector. A server page that reads no search
 * params: the islands read `?holder=` and `?sel=` themselves, under Suspense.
 */
export default async function HoldersPage() {
  const directory = await loadHolders();
  // A directory that did not answer, or answered empty, is a shell: the page bails
  // so the build re-primes it, as the registers page does.
  const directoryFailed = !directory.ok || directory.holders.length === 0;
  if (directoryFailed) await bailOnEmptyRender();
  const defaultKey = directory.holders[0]?.key ?? "";
  // One read of the default holder, shared by the map and the inspector's first paint.
  const initial = defaultKey === "" ? UNREAD : await loadHolderConnections(defaultKey);
  // A failed read or market caps that did not load draw an empty or all-hairline map: bail so the shell is not cached.
  const connectionsFailed = !initial.ok || !initial.capsOk;
  if (connectionsFailed) await bailOnEmptyRender();
  // The build-time shell carries the marker the shell re-prime looks for (spec 14.7).
  const shell = directoryFailed || connectionsFailed;
  const inspector =
    initial.ok && initial.holder !== null
      ? holderInspectorContent(initial.holder, initial.positions, null, initial.funds)
      : null;

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage
        inspector={
          <HolderInspector initial={inspector} defaultKey={defaultKey} resolve={resolveHolderInspector} />
        }
      >
        <div className="space-y-8">
          <header className="space-y-2">
            <h1 className={pageTitle}>Who holds the market?</h1>
            <p className={lede}>
              Explore institutions, organisations and people through their disclosed interests.
            </p>
          </header>
          {shell ? <span hidden data-isr-shell="empty" /> : null}
          <HolderBrowser holders={directory.holders} defaultKey={defaultKey}>
            <HolderConnectionsMap defaultKey={defaultKey} initial={initial} loadConnections={loadHolderConnections} />
          </HolderBrowser>
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
