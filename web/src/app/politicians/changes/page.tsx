import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { CaveatNote, SourceLine } from "@/components/politicians/compliance";
import { RegisterActivityExplorer } from "@/components/politicians/register-activity-explorer";
import {
  getRegisterActivityAsAt,
  loadRegisterActivity,
} from "~/app/actions/registerActivity";
import { listPoliticians } from "~/app/actions/getPoliticians";
import { bailOnEmptyRender } from "~/app/actions/config";
import { pageTitle, eyebrow, lede } from "@/lib/typography";
import { partyLabel } from "@/lib/politics/party-palette";

const URL = "https://shorted.com.au/politicians/changes";
const TITLE = "Register of Interests — Recent Additions and Removals";
const DESCRIPTION =
  "Entries added to or removed from the Registers of Members' and Senators' Interests, with the date each change appeared. A removal is not a transaction.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", creator: "@shorted___" },
};

/**
 * The register activity explorer.
 *
 * A SERVER PAGE THAT NEVER READS `searchParams`. This is a static-ISR route, and
 * reading the query string here silently flips it to dynamic and kills the ISR —
 * the trap /price-drops already paid for. Filter state therefore lives in the
 * island below, which re-queries through a server action; the DEFAULT window's
 * strip, feed and rails are rendered into this HTML, so a crawler and a reader
 * with JavaScript off still get the real thing.
 *
 * EDITORIAL. Every row names a real person. The page publishes counts and dates
 * and nothing else, its strongest characterisation is "most dated register
 * events" (a count ordering), and the method note below states the three things
 * a reader must know to read any of it correctly: the measures are dated-only,
 * undated entries are excluded from every count, and activity reflects our
 * extraction coverage as much as anyone's lodgement.
 */
export default async function RegisterChangesPage() {
  // The default view: no filters, the 90-day window the backend defaults to.
  const page = await loadRegisterActivity({});
  const asAt = await getRegisterActivityAsAt(page.windowDays);
  // `railsOk` is in here for the same reason `ok` is: this is an ISR route, so
  // whatever renders now is BAKED for an hour. A transient aggregate failure
  // during a regen would otherwise freeze the strip's outage copy and three
  // "unavailable" rails into a static page long after the rpc recovered — the
  // outage wording is honest live and stale within minutes. Bailing keeps the
  // last good page instead.
  if (!page.ok || !page.railsOk || page.events.length === 0) bailOnEmptyRender();

  // The party filter's options come from the ROLL, never from the palette:
  // PARTY_LABEL maps both LP and LIB onto "Liberal", and the backend filters on
  // the abbreviation — so a palette-derived list would pick one and silently
  // drop every member recorded under the other.
  const roll = await listPoliticians("", "", "", "", 500, 0);
  const partyOptions = [
    ...new Set((roll?.politicians ?? []).map((p) => p.partyAb).filter(Boolean)),
  ].sort((a, b) => partyLabel(a).localeCompare(partyLabel(b)));

  return (
    <>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="Registers of Members' and Senators' Interests, Parliament of Australia"
        dataFrequency="continuous during sitting periods"
      />
      <DashboardLayout>
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
          <header className="space-y-3">
            <p className={eyebrow}>
              <Link href="/politicians" className="hover:underline">
                Parliament&rsquo;s Portfolio
              </Link>
            </p>
            <h1 className={pageTitle}>Register additions and removals</h1>
            <p className={lede}>
              Entries that entered or left the registers, newest first. These are register
              events, not transactions — an entry can disappear because an asset was disposed
              of, because a declaration was corrected, or because the member left parliament.
            </p>
          </header>

          <RegisterActivityExplorer
            initialPage={page}
            loadPage={loadRegisterActivity}
            partyOptions={partyOptions}
          />

          <footer className="space-y-3 border-t pt-6">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Method: every count on this page is of DATED register events — an entry whose
              start date the register never stated has no point on a timeline and is excluded
              rather than placed at a parliament&rsquo;s opening. Counts are of entries and of
              people; the registers record no quantity and no value. A member&rsquo;s event
              count reflects how much of their register we have read as well as what they
              lodged, so a low count is coverage, not a finding.
            </p>
            <SourceLine surface="register changes" asAt={asAt} />
            <CaveatNote />
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
