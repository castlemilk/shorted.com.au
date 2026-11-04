import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { BreadcrumbStructuredData, Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { JsonLd } from "~/@/components/seo/json-ld";
import { ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { NoticeFeedExplorer } from "~/@/components/ownership/notice-feed-explorer";
import { OwnershipMethodology } from "~/@/components/ownership/ownership-parts";
import { OwnershipPlate, type PlateItem } from "~/@/components/ownership/ownership-plate";
import {
  OwnershipReportError,
  OwnershipSourceLines,
  type SourceLine,
} from "~/@/components/ownership/ownership-provenance";
import { lede, pageTitle, sectionTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { listInstitutions } from "~/app/actions/getOwnership";
import { loadNoticeFeed } from "~/app/actions/ownershipExplorer";

const URL = "https://shorted.com.au/ownership/notices";
const BASE_PATH = "/ownership/notices";
const TITLE = "ASX substantial holding notices, newest first";
// feed.lede (section 7 of the explorer spec): the page's lede and its description.
const LEDE =
  "Substantial holding notices we could read, newest release first: who became substantial, whose holding changed by a percentage point or more, and who ceased. A fall is reported as a fall, not as a disposal: share counts change too.";
const NOTICE_SOURCE = "ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605)";
const REPORT_SUBJECT = "Ownership data: notices feed";
const CRUMBS = [
  { label: "Ownership", href: "/ownership" },
  { label: "Notices", href: "/ownership/notices" },
];
// scroll-mt-20 clears the sticky site header, so an anchor lands on its heading.
const SECTION_HEADING = `${sectionTitle} scroll-mt-20`;

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: LEDE,
  alternates: { canonical: URL },
  // No `images` on either: this route ships its own opengraph-image.tsx, and an
  // explicit `images` here would shadow it. `twitter` replaces the root layout's
  // object wholesale, so it repeats site and creator.
  openGraph: { type: "website", url: URL, title: TITLE, description: LEDE, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
};

/**
 * The notice feed's default view: the last 30 days, newest release first, with
 * the window's weekly counts on the first page.
 *
 * A SERVER PAGE THAT READS NO SEARCH PARAMS. This is a static ISR route, and a
 * read of the query string here turns it dynamic and throws the cache away. The
 * island under it reads the link itself and asks the server action for any other
 * view, so a reader without JavaScript still gets this first page.
 */
export default async function NoticesPage() {
  const [feed, directory] = await Promise.all([loadNoticeFeed({}), listInstitutions("", "", 200, 0)]);
  // A read that did not answer is a shell: the page bails, the build marks it for
  // the post-deploy re-prime, and the island asks the server again on mount when the
  // feed itself failed. The holder select is part of the default view's HTML, so a
  // registry that did not answer would bake an empty select in for the hour: it is a
  // shell too. An answered empty window bails for a minute, not an hour, and is not
  // marked: the marker is for a read that failed.
  const failed = !feed.ok || !feed.activityOk || directory === undefined;
  if (failed || feed.rows.length === 0) await bailOnEmptyRender();

  // The registry the island's holder select reads, and only the whole directory: a partial
  // list would print a select that looks complete and is not. Without one the select lists
  // no holder, and a link's holder still goes to the API, which checks it against the whole
  // registry.
  const holders =
    directory !== undefined && directory.total <= directory.institutions.length
      ? directory.institutions.map((inst) => ({ slug: inst.slug, name: inst.name }))
      : [];
  const asOf = feed.asOf;
  const plate: PlateItem[] = [{ text: asOf ? `Notices read to ${asOf}` : "", dateTime: asOf || undefined }];
  const sourceLines: SourceLine[] = [
    {
      text: `${NOTICE_SOURCE}, read from the notice PDF${asOf ? `; read to ${asOf}` : ""}.`,
      asAt: asOf,
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TITLE,
    description: LEDE,
    url: URL,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isBasedOn: [NOTICE_SOURCE],
    ...(asOf ? { dateModified: asOf } : {}),
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <LLMMeta
        title={TITLE}
        description={LEDE}
        url={URL}
        dataSource={NOTICE_SOURCE}
        dataFrequency="daily"
        keywords={["substantial holding notices", "substantial holders", "ASX ownership"]}
        lastUpdated={asOf || undefined}
      />
      <DashboardLayout fullWidth>
        <BreadcrumbStructuredData items={CRUMBS} />
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          {/* The feed's ASX links point at it. */}
          <ExternalLinkSymbol />
          <Breadcrumbs items={CRUMBS} prefetch={false} />
          <header className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h1 className={pageTitle}>Substantial holding notices</h1>
            </div>
            <p className={lede}>{LEDE}</p>
          </header>
          <OwnershipPlate items={plate} />
          {failed ? <span hidden data-isr-shell="empty" /> : null}
          <NoticeFeedExplorer initial={feed} loadPage={loadNoticeFeed} holders={holders} basePath={BASE_PATH} />
          <section className="space-y-3" aria-labelledby="method">
            <h2 id="method" className={SECTION_HEADING}>
              Sources and method
            </h2>
            <OwnershipSourceLines lines={sourceLines} />
            <OwnershipMethodology className="max-w-[80ch]" />
            <p className="text-xs text-muted-foreground">
              <OwnershipReportError subject={REPORT_SUBJECT} />
            </p>
          </section>
        </div>
      </DashboardLayout>
    </>
  );
}
