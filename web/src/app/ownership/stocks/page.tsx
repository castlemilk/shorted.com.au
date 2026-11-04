import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { BreadcrumbStructuredData, Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { JsonLd } from "~/@/components/seo/json-ld";
import { OwnershipMethodology } from "~/@/components/ownership/ownership-parts";
import { OwnershipPlate, type PlateItem } from "~/@/components/ownership/ownership-plate";
import {
  OwnershipReportError,
  OwnershipSourceLines,
  type SourceLine,
} from "~/@/components/ownership/ownership-provenance";
import { RegistersExplorer } from "~/@/components/ownership/registers-explorer";
import { asAtRange } from "~/@/lib/ownership/kinds";
import { lede, pageTitle, sectionTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getOwnershipOverview } from "~/app/actions/getOwnership";
import { loadStockRegisters } from "~/app/actions/ownershipExplorer";
import type { OwnershipSource } from "~/gen/shorts/v1alpha1/ownership_pb";

const URL = "https://shorted.com.au/ownership/stocks";
const BASE_PATH = "/ownership/stocks";
const TITLE = "ASX substantial holder registers by stock";
// registers.lede: the page's lede and its description. The index fund and super
// option figures are dated where the page states them: the plate and the sources.
const LEDE =
  "Every stock with a current substantial holder, ranked by what its notices disclose: each interest counted once, not a share of the company, with the index fund and super option figures beside it.";
const LLM_SOURCE =
  "ASX substantial holding notices; index fund holdings files; super fund portfolio holdings disclosures; ASIC short position report";
const REPORT_SUBJECT = "Ownership data: registers";
const CRUMBS = [
  { label: "Ownership", href: "/ownership" },
  { label: "Registers", href: "/ownership/stocks" },
];
// scroll-mt-20 clears the sticky site header, so an anchor lands on its heading.
const SECTION_HEADING = `${sectionTitle} scroll-mt-20`;

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: LEDE,
  alternates: { canonical: URL },
  // This route has no card of its own, so it names the hub's. An openGraph object
  // without `images` would replace the parent's, and the twitter card has no image.
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
 * A source's date range, as the hub states it, or "" when the overview does not date
 * the source: it leaves the source out. A figure is never printed as "as at n/a".
 */
function rangeOf(source: OwnershipSource | undefined): string {
  if (!source || (source.asAtFrom === "" && source.asAt === "")) return "";
  return asAtRange(source.asAtFrom, source.asAt);
}

/**
 * The registers table on its default view: every stock with a current substantial
 * holder, by what its notices disclose, largest first, on the first page.
 *
 * A SERVER PAGE THAT READS NO SEARCH PARAMS, for the reason the notices page gives:
 * the island under it reads the link, and the default view is what this HTML holds.
 */
export default async function RegistersPage() {
  // The overview is read beside the list. Its source ranges date the index fund and
  // super option figures the table prints, as the hub dates the same files.
  const [registers, overview] = await Promise.all([loadStockRegisters({}), getOwnershipOverview()]);
  // A read that did not answer is a shell: the page bails, the build marks it for
  // the post-deploy re-prime, and the island asks the server again on mount when the
  // list itself failed. The dates are part of the page, so a missing overview bails
  // too, and the page is kept for a minute rather than an hour without them.
  const shell = !registers.ok || overview === undefined;
  if (shell) await bailOnEmptyRender();

  const asOf = registers.asOf;
  const sources = overview?.sources ?? [];
  const indexSource = sources.find((s) => s.source === "etf");
  const superSource = sources.find((s) => s.source === "super_phd");
  const indexRange = rangeOf(indexSource);
  const superRange = rangeOf(superSource);
  // Each figure carries its own range. A range the overview does not hold drops its
  // plate item (an empty item is never drawn) and its source line.
  const plate: PlateItem[] = [
    { text: asOf ? `Notices read to ${asOf}` : "", dateTime: asOf || undefined },
    { text: indexRange ? `index fund files ${indexRange}` : "" },
    { text: superRange ? `super option files ${superRange}` : "" },
    { text: "ASIC shorts T+4" },
  ];
  const sourceLines: SourceLine[] = [
    {
      text: `ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF${asOf ? `; read to ${asOf}` : ""}.`,
      asAt: asOf,
    },
    ...(indexSource && indexRange
      ? [
          {
            text: `Index fund holdings files (iShares, Vanguard, SPDR, Betashares): ${indexSource.funds.toLocaleString("en-AU")} files, ${indexRange}.`,
          },
        ]
      : []),
    ...(superSource && superRange
      ? [
          {
            text: `Super fund portfolio holdings disclosures (one investment option per fund): ${superSource.funds.toLocaleString("en-AU")} options, ${superRange}.`,
          },
        ]
      : []),
    {
      text: "ASIC short position report, published T+4; each stock's figure is as of its latest report.",
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TITLE,
    description: LEDE,
    url: URL,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isBasedOn: [
      "ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605)",
      "Index fund holdings files (iShares, Vanguard, SPDR, Betashares)",
      "Super fund portfolio holdings disclosures (one investment option each)",
      "ASIC short position report",
    ],
    ...(asOf ? { dateModified: asOf } : {}),
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
        keywords={["substantial holders", "substantial holder registers", "ASX ownership"]}
        lastUpdated={asOf || undefined}
      />
      <DashboardLayout fullWidth>
        <BreadcrumbStructuredData items={CRUMBS} />
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <Breadcrumbs items={CRUMBS} prefetch={false} />
          <header className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h1 className={pageTitle}>Registers by stock</h1>
            </div>
            <p className={lede}>{LEDE}</p>
          </header>
          <OwnershipPlate items={plate} />
          {shell ? <span hidden data-isr-shell="empty" /> : null}
          <RegistersExplorer initial={registers} loadPage={loadStockRegisters} basePath={BASE_PATH} />
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
