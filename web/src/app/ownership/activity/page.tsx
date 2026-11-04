import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { MovementHeatmap } from "~/@/components/ownership/desk/movement-heatmap";
import { Inspector } from "~/@/components/ownership/workspace/inspector";
import { WorkspacePage } from "~/@/components/workspace/workspace-page";
import { MethodDisclosure } from "~/@/components/ownership/workspace/method-disclosure";
import { lede, pageTitle } from "@/lib/typography";
import { formatFlowPp } from "~/@/components/ownership/desk/lens-legend";
import { inclusiveDays, largestMoveLines } from "~/@/lib/ownership/largest-moves";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { bailOnEmptyRender } from "~/app/actions/config";
import { loadInspector, loadOwnershipActivity } from "~/app/actions/ownershipDesk";

const URL = "https://shorted.com.au/ownership/activity";
const TITLE = "Ownership activity: substantial notices by sector and week";
const DESCRIPTION =
  "Substantial holding notices by ASX sector and week over the last year: how many were released, and the net change in disclosed voting power they state, with each week's notices one click away.";

/** The movement's default view is the same for every visitor, so the page is cached hourly. */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
};

export default async function OwnershipActivityPage() {
  const activity = await loadOwnershipActivity({});
  // A failed read is an outage, never an empty grid: the cache is not kept with it.
  if (!activity.ok) await bailOnEmptyRender();
  // The rail's empty state lists the window's largest moves (spec 14.10), read with the page's activity:
  // the server ranks them over the same weeks, every holder type (the page never narrows its read). The
  // window runs from the first week's Monday to the newest notice's date. An unread activity draws no block.
  const largestMoves = activity.ok
    ? {
        windowDays: inclusiveDays(activity.fromWeek, activity.asOf),
        from: activity.fromWeek,
        to: activity.asOf,
        lines: largestMoveLines(activity.largestMoves, formatFlowPp, safeExternalHref),
      }
    : null;

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage
        inspector={
          <Inspector
            resolve={loadInspector}
            emptyText="Select a cell to inspect the notices behind it."
            largestMoves={largestMoves}
          />
        }
      >
        <div className="mx-auto w-full max-w-[100rem] space-y-6">
          {/* The build's render and an outage are the same shell: the sweep re-primes it (spec 14.7). */}
          {!activity.ok ? <span hidden data-isr-shell="empty" /> : null}
          <header className="space-y-1.5">
            <h1 className={pageTitle}>Where ownership activity is changing</h1>
            <p className={lede}>Explore notices across sectors and time</p>
          </header>
          <MovementHeatmap
            initial={activity}
            loadActivity={loadOwnershipActivity}
            basePath="/ownership/activity"
            variant="full"
          />
          <p className="text-sm">
            <Link href="/ownership/notices" prefetch={false} className="text-primary underline-offset-4 hover:underline">
              View the notices feed →
            </Link>
          </p>
          <MethodDisclosure />
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
