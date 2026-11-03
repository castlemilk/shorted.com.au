import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { BreadcrumbStructuredData, Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { JsonLd } from "~/@/components/seo/json-ld";
import { InsightCards } from "~/@/components/ownership/insights/insight-cards";
import { InsightsExplorer } from "~/@/components/ownership/insights/insights-explorer";
import { OwnershipMethodology } from "~/@/components/ownership/ownership-parts";
import { OwnershipPlate, type PlateItem } from "~/@/components/ownership/ownership-plate";
import {
  OwnershipReportError,
  OwnershipSourceLines,
  type SourceLine,
} from "~/@/components/ownership/ownership-provenance";
import { DISCLOSED_CAPTION, windowText } from "~/@/lib/ownership/insights/format";
import { eyebrow, lede, pageTitle, sectionTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { loadOwnershipInsights } from "~/app/actions/ownershipInsights";

const URL = "https://shorted.com.au/ownership/insights";
const TITLE = "ASX ownership insights: market map, money flow and position changes";
// insights.lede: the page's lede and its description. Every figure on the page
// states its own dates where it is drawn.
const LEDE =
  "Where the index funds and substantial holders sit across the ASX, and how their positions move: a market map by sector and stock, the money flow from institutions to sectors, and the change in positions week by week, in one time window you can slide.";
const LLM_SOURCE =
  "Index fund holdings files; super fund portfolio holdings disclosures; ASX substantial holding notices; ASIC short position report";
const REPORT_SUBJECT = "Ownership data: insights";
const CRUMBS = [
  { label: "Ownership", href: "/ownership" },
  { label: "Insights", href: "/ownership/insights" },
];
const SECTION_HEADING = `${sectionTitle} scroll-mt-20`;

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: LEDE,
  alternates: { canonical: URL },
  // This route has no card of its own, so it names the hub's. An openGraph object
  // without `images` would replace the parent's.
  openGraph: {
    type: "website",
    url: URL,
    title: TITLE,
    description: LEDE,
    siteName: "Shorted",
    locale: "en_AU",
    images: [{ url: "/ownership/opengraph-image", alt: "Who owns the ASX, on Shorted" }],
  },
  twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
};

/**
 * The insights explorer on its default window: the desk, then the market map,
 * the position heatmap and the money flow, each with its table.
 *
 * A SERVER PAGE THAT READS NO SEARCH PARAMS, as the notice feed and the register
 * list: the island under it reads the link, and the default view is what this
 * HTML holds, so the page stays ISR and indexable.
 */
export default async function InsightsPage() {
  const insights = await loadOwnershipInsights({});
  // A read that did not answer is a shell: the page bails, the build marks it for
  // the post-deploy re-prime, and the island asks the server again on mount.
  const shell = !insights.ok;
  if (shell) await bailOnEmptyRender();

  const w = insights.window;
  const plate: PlateItem[] = [
    { text: w.from ? `Window ${windowText(w.from, w.to)}` : "" },
    { text: w.endFilesFrom ? `index fund files ${windowText(w.endFilesFrom, w.endFilesTo)}` : "" },
    { text: w.noticesAsOf ? `Notices read to ${w.noticesAsOf}` : "", dateTime: w.noticesAsOf || undefined },
  ];
  const sourceLines: SourceLine[] = [
    {
      text: `Index fund holdings files (iShares, Vanguard, SPDR, Betashares), one file per fund per date on record: ${w.snapshotDates.length.toLocaleString("en-AU")} file dates${w.snapshotDates.length > 0 ? `, ${windowText(w.snapshotDates[0]!, w.snapshotDates[w.snapshotDates.length - 1]!)}` : ""}. Vanguard's files are the pooled fund behind each ETF.`,
    },
    {
      text: "Super fund portfolio holdings disclosures, one investment option per fund, semi-annual; a super option is never the whole fund.",
    },
    {
      text: `ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF${w.noticesFrom ? `; dated ${windowText(w.noticesFrom, w.noticesTo)}` : ""}${w.noticesAsOf ? `; read to ${w.noticesAsOf}` : ""}.`,
      asAt: w.noticesAsOf,
    },
    { text: "Company sectors and market caps from company metadata; shares on issue from ASIC's latest short position report." },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TITLE,
    description: LEDE,
    url: URL,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isBasedOn: [
      "Index fund holdings files (iShares, Vanguard, SPDR, Betashares)",
      "Super fund portfolio holdings disclosures (one investment option each)",
      "ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605)",
    ],
    ...(w.from && w.to ? { temporalCoverage: `${w.from}/${w.to}` } : {}),
    ...(w.noticesAsOf ? { dateModified: w.noticesAsOf } : {}),
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <LLMMeta
        title={TITLE}
        description={LEDE}
        url={URL}
        dataSource={LLM_SOURCE}
        dataFrequency="daily"
        keywords={["ASX ownership", "index fund holdings", "substantial holders", "market map", "money flow"]}
        lastUpdated={w.noticesAsOf || undefined}
      />
      <DashboardLayout fullWidth>
        <BreadcrumbStructuredData items={CRUMBS} />
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <Breadcrumbs items={CRUMBS} prefetch={false} />
          <header className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h1 className={pageTitle}>Ownership insights</h1>
              <p className={eyebrow}>Ownership</p>
            </div>
            <p className={lede}>{LEDE}</p>
          </header>
          <OwnershipPlate items={plate} />
          {shell ? <span hidden data-isr-shell="empty" /> : null}
          {insights.ok ? <InsightCards page={insights} /> : null}
          <InsightsExplorer initial={insights} loadInsights={loadOwnershipInsights} />
          <section className="space-y-3" aria-labelledby="method">
            <h2 id="method" className={SECTION_HEADING}>
              Sources and method
            </h2>
            <OwnershipSourceLines lines={sourceLines} />
            <div className="max-w-[80ch] space-y-2 text-xs text-muted-foreground">
              <p>
                A fund&apos;s position at a date is its newest file on or before that date. A change compares each index
                fund with its own earlier file: its file at the window&apos;s start (or its first file inside the window)
                against its newest file at the end, so a fund whose first file falls inside the window is never read as
                new money. Shares are compared, and the change is valued at the later file&apos;s price, so a price move
                is not a position move. A window that holds one file per fund states levels only: every change is n/a.
              </p>
              <p>
                A notice&apos;s change is its present less its previous voting power, where it states both. The heatmap
                sums those changes in percentage points across a sector&apos;s notices: a direction and a size, not a
                share of anything. A notice is dated by its event, else its release. Disclosed stakes are the register
                as the newest notices read state it, each interest counted once, times the company&apos;s market cap:{" "}
                {DISCLOSED_CAPTION}. No past register is rebuilt from notices: a withheld notice would make it a guess.
              </p>
            </div>
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
