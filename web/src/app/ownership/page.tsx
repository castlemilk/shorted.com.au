import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { Disclosure } from "~/@/components/ui/disclosure";
import { ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { OwnershipPlate, type PlateItem } from "~/@/components/ownership/ownership-plate";
import {
  OwnershipReportError,
  OwnershipSourceLines,
  type SourceLine,
} from "~/@/components/ownership/ownership-provenance";
import { WithheldBreakdown } from "~/@/components/ownership/withheld-breakdown";
import { MethodDisclosure } from "~/@/components/ownership/workspace/method-disclosure";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { WITHHOLDING_OUTCOMES, asAtRange } from "~/@/lib/ownership/kinds";
import { weekList, weekTotals } from "~/@/components/ownership/desk/movement-heatmap-static";
import { lede, pageTitle, sectionTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getOwnershipOverview, listInstitutions } from "~/app/actions/getOwnership";
import {
  loadFundPositionChanges,
  loadInspector,
  loadOwnershipActivity,
  loadOwnershipFlows,
  loadOwnershipMap,
  loadStockFundSeries,
  loadStockPanel,
} from "~/app/actions/ownershipDesk";
import { DeskToolbar } from "~/@/components/ownership/desk/desk-toolbar";
import { FundPositions } from "~/@/components/ownership/desk/fund-positions";
import { MovementHeatmap } from "~/@/components/ownership/desk/movement-heatmap";
import { OwnershipFlows } from "~/@/components/ownership/desk/ownership-flows";
import { OwnershipMap } from "~/@/components/ownership/desk/ownership-map";
import { Inspector } from "~/@/components/ownership/workspace/inspector";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { JsonLd } from "~/@/components/seo/json-ld";

const URL = "https://shorted.com.au/ownership";
const TITLE = "Who Owns the ASX: Super Funds, Index Funds and Hedge Funds";
const DESCRIPTION =
  "Which super funds, index funds, hedge funds, banks and other institutions hold ASX stocks: substantial holding notices read from their PDFs, the ASX holdings in the latest files of the index funds and super fund options tracked, and where crowded registers meet high short interest.";
const LLM_SOURCE =
  "ASX substantial holding notices; APRA fund-level statistics; ASX Investment Products report; the holdings files index funds and super fund options publish";
const REPORT_SUBJECT = "Ownership data: hub";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "substantial holders asx",
    "who owns asx stocks",
    "super fund holdings",
    "hedge fund holdings australia",
    "institutional ownership asx",
    "index fund ownership",
  ],
  alternates: { canonical: URL },
  // No `images` key on either: this route ships its own opengraph-image.tsx,
  // and an explicit `images` here would shadow the file convention. `twitter`
  // replaces the root layout's object wholesale, so it repeats site and
  // creator.
  openGraph: {
    type: "website",
    url: URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Shorted",
    locale: "en_AU",
  },
  twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
};

/** A count in the headline band: the one figure of its sentence, in mono. */
function Figure({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums text-foreground">{children}</span>;
}

function count(value: number): string {
  return value.toLocaleString("en-AU");
}

/**
 * A record's label on the Records row: its name, and its count when the page holds a count above
 * zero. A count the page does not have is left out, never printed as 0.
 */
function recordLabel(name: string, value: number | undefined): string {
  return value !== undefined && value > 0 ? `${name} · ${count(value)}` : name;
}

/** The pane titles are the links to each instrument's own page. */
const paneTitleLink = "underline-offset-4 hover:underline";

export default async function OwnershipPage() {
  // The desk's instruments read the default view here, so the HTML carries it. Each
  // island reads the URL itself under its own Suspense (spec 13.1).
  const [overview, directory, map, flows, activity, funds] = await Promise.all([
    getOwnershipOverview(),
    listInstitutions("", "", 200, 0),
    loadOwnershipMap({}),
    loadOwnershipFlows({}),
    loadOwnershipActivity({}),
    loadFundPositionChanges({}),
  ]);
  // Nothing to show: a failed read, or a database the first `shorted
  // ownership` run has not filled yet. The page says so instead of drawing
  // empty tables, and its cache is shortened so the data shows once it lands.
  // A failed instrument read, or a failed directory read, shortens the cache
  // the same way; the section itself says it is an outage.
  const empty = !overview || (overview.noticesParsed === 0 && overview.superFunds === 0);
  const deskOk = map.ok && flows.ok && activity.ok && funds.ok;
  // listInstitutions answers undefined on any failure: that is an outage, never an empty registry.
  const directoryOk = directory !== undefined;
  if (empty || !deskOk || !directoryOk) await bailOnEmptyRender();

  const institutions = directory?.institutions ?? [];
  const asOf = overview?.asOf ?? "";
  const etfs = overview?.etfs ?? 0;
  // The universe the tracked funds are measured against: ASX's Australian-equity ETFs when the
  // API states the count, every ETF on the report otherwise (an older API).
  const etfsAustralianEquity = overview?.etfsAustralianEquity ?? 0;
  const lics = overview?.lics ?? 0;
  const superFunds = overview?.superFunds ?? 0;

  // A source the API leaves out holds no files: its count is a real zero, and
  // only its date range is unknown.
  const sources = overview?.sources ?? [];
  const indexSource = sources.find((s) => s.source === "etf");
  const superSource = sources.find((s) => s.source === "super_phd");
  const indexFiles = indexSource?.funds ?? 0;
  const superOptions = superSource?.funds ?? 0;
  const indexRange = asAtRange(indexSource?.asAtFrom ?? "", indexSource?.asAt ?? "");
  const superRange = asAtRange(superSource?.asAtFrom ?? "", superSource?.asAt ?? "");
  // A date the API does not hold drops its clause from the band, rather than printing "as at n/a".
  const dated = (...dates: (string | undefined)[]) => dates.some((date) => date !== undefined && date !== "");
  const indexDates = dated(indexSource?.asAt, indexSource?.asAtFrom) ? indexRange : "";
  const superDates = dated(superSource?.asAt, superSource?.asAtFrom) ? superRange : "";

  // The tile counts the six withholding outcomes. The two that are not withheld
  // are named apart in the breakdown, never counted here.
  const outcomes = overview?.withheldByOutcome ?? [];
  const attempted = overview?.documentsAttempted ?? 0;
  const withheld =
    outcomes.length > 0
      ? outcomes.filter((o) => WITHHOLDING_OUTCOMES.includes(o.outcome)).reduce((n, o) => n + o.count, 0)
      : (overview?.noticesWithheld ?? 0);
  // The two outcomes that are not withheld notices (a document that was never a form, a download still
  // to retry) are "set aside" in the sentence, so read + withheld + set aside = attempted and the band
  // reconciles; the breakdown names them.
  const setAside = outcomes.filter((o) => !WITHHOLDING_OUTCOMES.includes(o.outcome)).reduce((n, o) => n + o.count, 0);

  // The newest week of the activity the page loads, over every sector: "released this week" in the
  // band. Dropped when the read names no week, never printed as 0.
  const newestWeek = activity.ok ? weekList(activity.fromWeek, activity.toWeek).at(-1) : undefined;
  const thisWeek: number | undefined = newestWeek === undefined ? undefined : weekTotals(activity.rows, [newestWeek])[0];

  const title = <h1 className={pageTitle}>The ownership landscape</h1>;

  if (empty) {
    return (
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <header className="space-y-1.5">{title}</header>
          <section aria-label="Status" className="rounded-lg border bg-card p-6">
            <p className="max-w-[70ch] text-sm">
              Ownership data is not available yet. It is collected once a day from ASX substantial holding notices,
              APRA, ASX&apos;s investment products report and the funds&apos; own holdings files. Check back later
              today.
            </p>
          </section>
          <div className="space-y-3">
            <MethodDisclosure />
            <p className="text-xs text-muted-foreground">
              <OwnershipReportError subject={REPORT_SUBJECT} />
            </p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // The wireframe's lede, verbatim (spec 14.3); the file counts are the record's and sit in the band.
  const ledeText = "Explore the market. Follow the connections. Inspect the changes.";

  // The plate carries the dates the page's figures are read to, each with its own.
  const plate: PlateItem[] = [
    { text: asOf ? `Notices read to ${asOf}` : "", dateTime: asOf || undefined },
    { text: `index fund files ${indexRange}` },
    { text: `super option files ${superRange}` },
    { text: "ASIC shorts T+4" },
  ];

  // The records behind each row, counted from what the page already holds. The registers are the stocks
  // with a disclosed holding; the directory's total is the institutions on the map.
  const records: { href: string; name: string; count: number | undefined }[] = [
    { href: "/ownership/stocks", name: "Stocks on the map", count: map.ok ? map.stocks.length : undefined },
    // The API caps the holders list at 25, so its length is a list cap, not a count of the record: no count.
    { href: "/ownership/holders", name: "Biggest holders", count: undefined },
    {
      href: "/ownership/stocks",
      name: "Registers",
      count: map.ok ? map.stocks.filter((stock) => stock.disclosedPct > 0).length : undefined,
    },
    { href: "/ownership/notices", name: "Latest notices", count: overview?.noticesParsed },
    { href: "/ownership/holders", name: "Institutions on the map", count: directory?.total },
  ];

  // The notices the parser withheld and a model read (read_by = model), named on the notices' source line.
  const readByModel = overview?.noticesReadByModel ?? 0;
  const sourceLines: SourceLine[] = [
    ...sources.map((s) => ({
      text: `${s.description}: ${s.records.toLocaleString("en-AU")} records${
        s.source === "substantial_notices" && readByModel > 0
          ? `, ${readByModel.toLocaleString("en-AU")} read by model`
          : ""
      }, ${asAtRange(s.asAtFrom, s.asAt)}`,
    })),
    {
      text: `ASX Investment Products report and APRA fund-level statistics: ${etfs.toLocaleString("en-AU")} exchange-traded products, ${lics.toLocaleString("en-AU")} listed investment companies and trusts, ${superFunds.toLocaleString("en-AU")} APRA-regulated super funds.`,
    },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TITLE,
    description: DESCRIPTION,
    url: URL,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isBasedOn: [
      "ASX substantial holding notices (Corporations Act s671B)",
      "APRA annual fund-level superannuation statistics",
      "ASX Investment Products monthly report",
      "Index fund holdings files (iShares, Vanguard, SPDR, Betashares)",
      "Super fund portfolio holdings disclosures",
    ],
    ...(asOf ? { dateModified: asOf } : {}),
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource={LLM_SOURCE}
        dataFrequency="daily"
        keywords={["substantial holders", "super fund holdings", "index fund ownership", "hedge funds"]}
        lastUpdated={asOf || undefined}
      />
      <DashboardLayout fullWidth>
        <WorkspacePage
          inspector={<Inspector resolve={loadInspector} emptyText="Select a company to inspect its holding." />}
        >
        {/* A flex column, not space-y, so the order classes below can move the band, the records and the
            method after the panes on a phone (backlog D2). The DOM order is unchanged: the focus order
            still runs the band first, and the order classes only change what a sighted reader sees. */}
        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-8">
          {/* Kept by backlog B2 for the record links that use it; nothing on the hub references it today. */}
          <ExternalLinkSymbol />
          <header className="space-y-1.5">
            {title}
            <p className={lede}>{ledeText}</p>
          </header>

          {/* One toolbar row (backlog B2): the search, the Source and the window. The plate (backlog D2) is
              drawn once inside it, so a phone's first screen is the title, this fold, and the first pane. */}
          <DeskToolbar
            plate={<OwnershipPlate items={plate} />}
            stocks={map.ok ? map.stocks.map((stock) => ({ code: stock.code, name: stock.name })) : []}
            holders={institutions.map((institution) => ({ slug: institution.slug, name: institution.name }))}
          />

          {/* The headline band: four sentences, each a figure the record states (backlog B2). The coverage
              id is the map's coverage line's target. Below lg it follows the panes (order-[10]), so the
              first instrument is in view under the title (backlog D2). */}
          <section aria-label="Coverage" id="coverage" className="order-[10] scroll-mt-20 lg:order-none">
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-card p-3 text-sm text-muted-foreground">
                <Figure>{overview ? count(overview.noticesParsed) : NOT_AVAILABLE}</Figure> notices read
                {asOf ? ` to ${asOf}` : ""}
                {thisWeek === undefined ? null : (
                  <>
                    , <Figure>{count(thisWeek)}</Figure> released this week
                  </>
                )}
              </div>
              <div className="space-y-2 bg-card p-3 text-sm text-muted-foreground">
                <p>
                  <Figure>{count(withheld)}</Figure> {outcomes.length > 0 ? "notices withheld" : "documents not parsed"}
                  {setAside > 0 ? (
                    <>
                      , <Figure>{count(setAside)}</Figure> set aside,
                    </>
                  ) : null}
                  {attempted > 0 ? (
                    <>
                      {" "}
                      of <Figure>{count(attempted)}</Figure> documents attempted
                    </>
                  ) : null}
                </p>
                {/* A figure the outcomes are kept under, folded so the band stays four sentences. */}
                {outcomes.length > 0 ? (
                  <Disclosure title="By outcome">
                    <WithheldBreakdown outcomes={outcomes} />
                  </Disclosure>
                ) : null}
              </div>
              {/* The tracked funds against the ASX ETFs and APRA funds on record (the 471 and 72 are products,
                  not files; the files' dates follow). A count the API does not hold reads n/a, never 0: a
                  source with a file is in the list, so 0 means the field is absent. */}
              <div className="bg-card p-3 text-sm text-muted-foreground">
                {indexFiles > 0 ? (
                  <>
                    <Figure>{count(indexFiles)}</Figure> of{" "}
                    {etfsAustralianEquity > 0 ? (
                      <>
                        <Figure>{count(etfsAustralianEquity)}</Figure> Australian-equity ETFs tracked
                      </>
                    ) : (
                      <>
                        <Figure>{count(etfs)}</Figure> ASX ETFs tracked
                      </>
                    )}
                    {indexDates ? `, files ${indexDates}` : ""}
                  </>
                ) : (
                  <>
                    <Figure>{NOT_AVAILABLE}</Figure> index funds tracked
                  </>
                )}
              </div>
              <div className="bg-card p-3 text-sm text-muted-foreground">
                {superOptions > 0 ? (
                  <>
                    <Figure>{count(superOptions)}</Figure> of <Figure>{count(superFunds)}</Figure> APRA super funds tracked, one
                    option each{superDates ? `, ${superDates}` : ""}
                  </>
                ) : (
                  <>
                    <Figure>{NOT_AVAILABLE}</Figure> super funds tracked
                  </>
                )}
              </div>
            </div>
          </section>

          {/* Row 1: the market map and the disclosed exposure, each a fixed 420px from lg. Each title is the
              link to its page; the pane draws the instrument with no control row of its own. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="min-w-0 space-y-3 lg:flex lg:h-[420px] lg:flex-col lg:overflow-hidden" aria-labelledby="desk-map">
              <h2 id="desk-map" className={sectionTitle}>
                <Link href="/ownership/map" prefetch={false} className={paneTitleLink}>
                  Market map
                </Link>
              </h2>
              {/* The pane's sort is "Changed" when the link names none (backlog C3); the hub has no sort control. */}
              <OwnershipMap
                initial={map}
                loadMap={loadOwnershipMap}
                loadPanel={loadStockPanel}
                basePath="/ownership"
                variant="compact"
                sort="changed"
              />
            </section>
            <section className="min-w-0 space-y-3 lg:flex lg:h-[420px] lg:flex-col lg:overflow-hidden" aria-labelledby="desk-flows">
              <h2 id="desk-flows" className={sectionTitle}>
                <Link href="/ownership/connections" prefetch={false} className={paneTitleLink}>
                  Disclosed exposure
                </Link>
              </h2>
              <OwnershipFlows initial={flows} loadFlows={loadOwnershipFlows} basePath="/ownership" variant="compact" />
            </section>
          </div>

          {/* Row 2: the notice activity and the index fund positions, each a fixed 320px from lg. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="min-w-0 space-y-3 lg:h-[320px] lg:overflow-hidden" aria-labelledby="desk-movement">
              <h2 id="desk-movement" className={sectionTitle}>
                <Link href="/ownership/activity" prefetch={false} className={paneTitleLink}>
                  Notice activity
                </Link>
              </h2>
              <MovementHeatmap
                initial={activity}
                loadActivity={loadOwnershipActivity}
                basePath="/ownership"
                variant="compact"
                sort="changed"
              />
            </section>
            {/* The instrument draws its own title, a link to the map's index lens, in both its states. */}
            <section className="min-w-0 lg:h-[320px] lg:overflow-hidden" aria-label="Index fund positions">
              <FundPositions
                initial={funds}
                loadPositions={loadFundPositionChanges}
                loadSeries={loadStockFundSeries}
                variant="compact"
              />
            </section>
          </div>

          {/* The records, one row of links with their counts; the record pages hold the tables. Below lg
              they follow the band (order-[11]), as the desk's order does. */}
          <nav aria-label="Records" className="order-[11] flex flex-wrap items-center gap-x-6 gap-y-2 text-sm lg:order-none">
            {records.map((record) => (
              <Link
                key={record.name}
                href={record.href}
                prefetch={false}
                className="hit-target text-primary underline-offset-4 hover:underline"
              >
                {recordLabel(record.name, record.count)}
              </Link>
            ))}
          </nav>

          <div className="order-[12] space-y-3 lg:order-none">
            {/* The dated source list is part of how the figures are read, so it folds with the method. */}
            <MethodDisclosure extra={[<OwnershipSourceLines key="sources" lines={sourceLines} />]} />
            <p className="text-xs text-muted-foreground">
              <OwnershipReportError subject={REPORT_SUBJECT} />
            </p>
          </div>
        </div>
        </WorkspacePage>
      </DashboardLayout>
    </>
  );
}
