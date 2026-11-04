import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Disclosure } from "~/@/components/ui/disclosure";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import {
  KindBadge,
  OwnershipMethodology,
  OwnershipStockTable,
} from "~/@/components/ownership/ownership-parts";
import { ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { NoticeTable } from "~/@/components/ownership/notice-table";
import { OwnershipPlate, type PlateItem } from "~/@/components/ownership/ownership-plate";
import {
  Dated,
  OwnershipReportError,
  OwnershipSourceLines,
  type SourceLine,
} from "~/@/components/ownership/ownership-provenance";
import { WithheldBreakdown } from "~/@/components/ownership/withheld-breakdown";
import { NOT_AVAILABLE, formatAmount } from "~/@/lib/fundamentals/format";
import {
  KIND_ORDER,
  WITHHOLDING_OUTCOMES,
  asAtRange,
  kindInfo,
  kindRank,
} from "~/@/lib/ownership/kinds";
import { cn } from "@/lib/utils";
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
import type {
  OwnershipInstitution,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { JsonLd } from "~/@/components/seo/json-ld";

const URL = "https://shorted.com.au/ownership";
const TITLE = "Who Owns the ASX: Super Funds, Index Funds and Hedge Funds";
const DESCRIPTION =
  "Which super funds, index funds, hedge funds, banks and other institutions hold ASX stocks: substantial holding notices read from their PDFs, the ASX holdings in the latest files of the index funds and super fund options tracked, and where crowded registers meet high short interest.";
const LLM_SOURCE =
  "ASX substantial holding notices; APRA fund-level statistics; ASX Investment Products report; the holdings files index funds and super fund options publish";
const REPORT_SUBJECT = "Ownership data: hub";

// What each register view counts, in the words the views are read by.
const CROWDED =
  "Stocks where investors (super funds, index and active managers, hedge funds, sovereign funds and insurers) disclose the most voting power between them. Banks and brokers (often securities lending), listed companies and private holders are not counted.";
const BOTH_WAYS =
  "Hedge funds and active managers together disclose 5% or more, and at least 3% of the shares are reported short. Two disclosures on one page, not a finding.";
const LENDING =
  "Banks and brokers with a substantial interest, often securities lending (shares lent to, or held as collateral from, short sellers), beside each stock's short interest.";
const INDEX =
  "The share of each company held by the index funds tracked (iShares, Vanguard, SPDR, Betashares), from their latest holdings files. Vanguard's files cover the whole fund behind each ETF, so VAS's figures are the fund's, not the ETF's alone.";
const superCopy = (range: string) =>
  `What the tracked super fund options hold most of, by combined value: each fund's default or balanced option, from its portfolio holdings disclosure, ${range}.`;

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

function Tile({
  value,
  label,
  meta,
  children,
}: {
  value: string;
  label: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1 bg-card p-4">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {meta ? <p className="text-xs tabular-nums text-muted-foreground">{meta}</p> : null}
      {children}
    </div>
  );
}

function InstitutionLink({ inst }: { inst: OwnershipInstitution }) {
  return (
    <Link href={`/ownership/${inst.slug}`} prefetch={false} className="text-primary underline-offset-4 hover:underline">
      {inst.name}
    </Link>
  );
}

/** An institution's size: a super fund's total assets, else its products'. */
function sizeOf(inst: OwnershipInstitution): string {
  if (inst.hasAum) return `${formatAmount(inst.aumAud, "AUD")} assets`;
  if (inst.hasFundsSize) return `${formatAmount(inst.fundsSizeAud, "AUD")} in ${inst.funds} listed fund${inst.funds === 1 ? "" : "s"}`;
  return "";
}

/** A ticker's shape: the panel's loader takes a code from the client, so it is checked before a read. */

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


  const kinds = [...(overview?.kinds ?? [])].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  const institutions = directory?.institutions ?? [];
  // Every kind keeps its group, even an empty one, so each flow link lands on its own anchor.
  const byKind = KIND_ORDER.map((kind) => ({
    kind,
    members: institutions.filter((i) => i.kind === kind),
  }));
  const asOf = overview?.asOf ?? "";
  const etfs = overview?.etfs ?? 0;
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

  // The tile counts the six withholding outcomes. The two that are not withheld
  // are named apart in the breakdown, never counted here.
  const outcomes = overview?.withheldByOutcome ?? [];
  const attempted = overview?.documentsAttempted ?? 0;
  const withheld =
    outcomes.length > 0
      ? outcomes.filter((o) => WITHHOLDING_OUTCOMES.includes(o.outcome)).reduce((n, o) => n + o.count, 0)
      : (overview?.noticesWithheld ?? 0);

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
          <section className="space-y-3" aria-labelledby="sources">
            <h2 id="sources" className={sectionTitle}>
              Sources and method
            </h2>
            <div id="method" className="scroll-mt-20">
              <OwnershipMethodology className="max-w-[80ch]" />
            </div>
            <p className="text-xs text-muted-foreground">
              <OwnershipReportError subject={REPORT_SUBJECT} />
            </p>
          </section>
        </div>
      </DashboardLayout>
    );
  }

  // The wireframe's lede, verbatim (spec 14.3); the file counts are the record's and sit beneath it.
  const ledeText = "Explore the market. Follow the connections. Inspect the changes.";
  // The line says the dates are mixed only when they are: the notices' date and each file's span.
  const mixedDates = new Set(
    [asOf, indexSource?.asAtFrom ?? "", indexSource?.asAt ?? "", superSource?.asAtFrom ?? "", superSource?.asAt ?? ""].filter(
      (date) => date !== "",
    ),
  ).size > 1;
  const statusParts = [asOf ? `Latest notices to ${asOf}` : "", mixedDates ? "Mixed disclosure dates" : ""];
  const statusLine = statusParts.filter((part) => part !== "").join(" · ");

  // The plate carries the dates the page's figures are read to, each with its own.
  const plate: PlateItem[] = [
    { text: asOf ? `Notices read to ${asOf}` : "", dateTime: asOf || undefined },
    { text: `index fund files ${indexRange}` },
    { text: `super option files ${superRange}` },
    { text: "ASIC shorts T+4" },
  ];

  const sourceLines: SourceLine[] = [
    ...sources.map((s) => ({
      text: `${s.description}: ${s.records.toLocaleString("en-AU")} records, ${asAtRange(s.asAtFrom, s.asAt)}`,
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
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          {/* The latest notices' ASX links point at it. */}
          <ExternalLinkSymbol />
          <header className="space-y-1.5">
            {title}
            <p className={lede}>{ledeText}</p>
            <p className="text-xs text-muted-foreground">{statusLine}</p>
          </header>
          <OwnershipPlate items={plate} />
          {/* The toolbar (spec 14.3): find a stock or holder, the panes' Source, and the window of change. */}
          <DeskToolbar
            stocks={map.ok ? map.stocks.map((stock) => ({ code: stock.code, name: stock.name })) : []}
            holders={institutions.map((institution) => ({ slug: institution.slug, name: institution.name }))}
            basePath="/ownership"
          />

          {/* Three compact panes in a 2 + 1 grid; each heading opens its full instrument (spec 14.3). */}
          <div className="grid gap-6 lg:grid-cols-3">
            <section className="min-w-0 space-y-3 lg:col-span-2" aria-labelledby="desk-map">
              <h2 id="desk-map" className={sectionTitle}>
                Market map{" "}
                <Link href="/ownership/map" prefetch={false} aria-label="Open the market map" className="text-primary no-underline">
                  ↗
                </Link>
              </h2>
              <OwnershipMap
                initial={map}
                loadMap={loadOwnershipMap}
                loadPanel={loadStockPanel}
                basePath="/ownership"
                variant="compact"
              />
            </section>
            <section className="min-w-0 space-y-3" aria-labelledby="desk-flows">
              <h2 id="desk-flows" className={sectionTitle}>
                Disclosed exposure{" "}
                <Link href="/ownership/connections" prefetch={false} aria-label="Open the connections" className="text-primary no-underline">
                  ↗
                </Link>
              </h2>
              <OwnershipFlows initial={flows} loadFlows={loadOwnershipFlows} basePath="/ownership" variant="compact" />
            </section>
            <section className="min-w-0 space-y-3 lg:col-span-2" aria-labelledby="desk-movement">
              <h2 id="desk-movement" className={sectionTitle}>
                Notice activity{" "}
                <Link href="/ownership/activity" prefetch={false} aria-label="Open the notice activity" className="text-primary no-underline">
                  ↗
                </Link>
              </h2>
              <MovementHeatmap
                initial={activity}
                loadActivity={loadOwnershipActivity}
                basePath="/ownership"
                variant="compact"
              />
            </section>
          </div>

          {/* The instrument draws its own heading, "Index fund positions", in both its states. */}
          <section className="space-y-3" aria-label="Index fund positions">
            <FundPositions initial={funds} loadPositions={loadFundPositionChanges} loadSeries={loadStockFundSeries} />
          </section>

          <section aria-label="Coverage" id="coverage" className="scroll-mt-20">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
              <Tile
                value={overview ? overview.noticesParsed.toLocaleString("en-AU") : NOT_AVAILABLE}
                label="Notices read"
                meta={asOf ? <Dated text={`to ${asOf}`} /> : undefined}
              />
              <Tile
                value={withheld.toLocaleString("en-AU")}
                label={outcomes.length > 0 ? "Notices withheld" : "Documents not parsed (all outcomes)"}
                meta={attempted > 0 ? `of ${attempted.toLocaleString("en-AU")} documents attempted` : undefined}
              >
                {outcomes.length > 0 ? (
                  <Disclosure title="Withheld, by outcome">
                    <WithheldBreakdown outcomes={outcomes} />
                  </Disclosure>
                ) : null}
              </Tile>
              {/* A file count the API does not hold reads n/a, never 0: a source
                  with a file is in the list, so 0 means the field is absent. */}
              <Tile
                value={indexFiles > 0 ? `${indexFiles.toLocaleString("en-AU")} of ${etfs.toLocaleString("en-AU")}` : NOT_AVAILABLE}
                label="Index fund files"
                meta={<Dated text={`of ${etfs.toLocaleString("en-AU")} exchange-traded products; ${indexRange}`} />}
              />
              <Tile
                value={superOptions > 0 ? `${superOptions.toLocaleString("en-AU")} of ${superFunds.toLocaleString("en-AU")}` : NOT_AVAILABLE}
                label="Super option files"
                meta={<Dated text={`of ${superFunds.toLocaleString("en-AU")} APRA funds; ${superRange}`} />}
              />
            </div>
          </section>

          <details className="group space-y-3 rounded-lg border border-border/60 p-4 open:pb-6">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2 id="map" className={cn(sectionTitle, "inline-flex items-center gap-3")}>
                The map
                <span aria-hidden className="text-base text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
                  ▸
                </span>
              </h2>
            </summary>
            <p className="max-w-[70ch] text-sm text-muted-foreground">
              Who holds a 5% or larger stake, by the kind of institution. A kind is the institution&apos;s main
              business, decided once by hand; a holder that is itself a listed company is a listed company, and the
              rest are unclassified.
            </p>
            <Table>
              <caption className="sr-only">Institutions and substantial holdings by kind</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">On the map</TableHead>
                  <TableHead className="text-right">Holding 5%+</TableHead>
                  <TableHead className="text-right">Stakes</TableHead>
                  <TableHead className="text-right">Stocks</TableHead>
                  <TableHead className="hidden lg:table-cell">What their stakes usually are</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kinds.map((k) => (
                  <TableRow key={k.kind}>
                    <TableCell>
                      <KindBadge kind={k.kind} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{k.institutions || ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.holders}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.positions}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.stocks}</TableCell>
                    <TableCell className="hidden max-w-[48ch] text-xs text-muted-foreground lg:table-cell">
                      {kindInfo(k.kind).note}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>

          <details className="group space-y-3 rounded-lg border border-border/60 p-4 open:pb-6">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2 id="holders" className={cn(sectionTitle, "inline-flex items-center gap-3")}>
                The biggest holders
                <span aria-hidden className="text-base text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
                  ▸
                </span>
              </h2>
            </summary>
            <Table>
              <caption className="sr-only">Institutions with the most current substantial holdings</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Stakes of 5%+</TableHead>
                  <TableHead className="text-right">Notices</TableHead>
                  <TableHead className="hidden md:table-cell">Latest notice</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.topHolders ?? []).map((inst) => (
                  <TableRow key={inst.slug}>
                    <TableCell>
                      <InstitutionLink inst={inst} />
                    </TableCell>
                    <TableCell>
                      <KindBadge kind={inst.kind} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{inst.substantialPositions}</TableCell>
                    <TableCell className="text-right tabular-nums">{inst.notices}</TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">{inst.latestNoticeDate}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">{sizeOf(inst)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>

          <details className="group space-y-3 rounded-lg border border-border/60 p-4 open:pb-6">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2 id="registers" className={cn(sectionTitle, "inline-flex items-center gap-3")}>
                Registers
                <span aria-hidden className="text-base text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
                  ▸
                </span>
              </h2>
            </summary>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Most crowded registers</CardTitle>
                  <CardDescription>{CROWDED}</CardDescription>
                </CardHeader>
                <CardContent>
                  <OwnershipStockTable
                    stocks={overview?.crowded ?? []}
                    columns={["institutional", "holders", "bar", "short"]}
                    caption="Most crowded registers"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Crowded both ways</CardTitle>
                  <CardDescription>{BOTH_WAYS}</CardDescription>
                </CardHeader>
                <CardContent>
                  <OwnershipStockTable
                    stocks={overview?.crowdedBothWays ?? []}
                    columns={["longActive", "short", "bar"]}
                    caption="Stocks crowded long and short"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Lending desks</CardTitle>
                  <CardDescription>{LENDING}</CardDescription>
                </CardHeader>
                <CardContent>
                  <OwnershipStockTable
                    stocks={overview?.lending ?? []}
                    columns={["bank", "short", "bar"]}
                    caption="Bank and broker substantial interests beside short interest"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Index fund ownership</CardTitle>
                  <CardDescription>{INDEX}</CardDescription>
                </CardHeader>
                <CardContent>
                  <OwnershipStockTable
                    stocks={overview?.passive ?? []}
                    columns={["index", "short"]}
                    caption="Stocks most owned by index funds"
                  />
                </CardContent>
              </Card>
              <Card className="xl:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Super funds&apos; consensus</CardTitle>
                  <CardDescription>
                    <Dated text={superCopy(superRange)} />
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <OwnershipStockTable
                    stocks={overview?.superConsensus ?? []}
                    columns={["superValue", "superOptions", "short"]}
                    caption="Super funds' largest combined holdings"
                  />
                </CardContent>
              </Card>
            </div>
          </details>

          <details className="group space-y-3 rounded-lg border border-border/60 p-4 open:pb-6">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2 id="notices" className={cn(sectionTitle, "inline-flex items-center gap-3")}>
                Latest notices
                <span aria-hidden className="text-base text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
                  ▸
                </span>
              </h2>
            </summary>
            <p className="text-sm">
              <Link
                href="/ownership/notices"
                prefetch={false}
                className="hit-target text-primary underline-offset-4 hover:underline"
              >
                All notices →
              </Link>
            </p>
            <NoticeTable notices={overview?.recent ?? []} caption="Latest substantial holding notices" />
          </details>

          <details className="group space-y-3 rounded-lg border border-border/60 p-4 open:pb-6">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2 id="directory" className={cn(sectionTitle, "inline-flex items-center gap-3")}>
                Institutions on the map
                <span aria-hidden className="text-base text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
                  ▸
                </span>
              </h2>
            </summary>
            {directory === undefined ? (
              <>
                <p className="max-w-[70ch] text-sm">
                  The institution list could not be read just now. Nothing here is missing from the register: this is
                  our end.
                </p>
                {/* The anchors stay, empty, so a link to one kind still lands in this section. */}
                {KIND_ORDER.map((kind) => (
                  <span key={kind} id={`directory-${kind}`} aria-hidden="true" className="block scroll-mt-20" />
                ))}
              </>
            ) : (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                {byKind.map((group) => (
                  <div key={group.kind} id={`directory-${group.kind}`} className="scroll-mt-20 space-y-2">
                    <h3 className="text-sm font-semibold">
                      {kindInfo(group.kind).plural}{" "}
                      <span className="font-normal text-muted-foreground">({group.members.length})</span>
                    </h3>
                    {group.members.length === 0 ? (
                      <p className="text-sm text-muted-foreground">None listed.</p>
                    ) : null}
                    <ul className="space-y-1 text-sm">
                      {group.members.map((inst) => (
                        <li key={inst.slug} className="flex justify-between gap-3">
                          <InstitutionLink inst={inst} />
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {inst.substantialPositions > 0
                              ? `${inst.substantialPositions} stake${inst.substantialPositions === 1 ? "" : "s"}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </details>

          <section className="space-y-3" aria-labelledby="sources">
            <h2 id="sources" className={sectionTitle}>
              Sources and method
            </h2>
            <OwnershipSourceLines lines={sourceLines} />
            <div id="method" className="scroll-mt-20">
              <OwnershipMethodology className="max-w-[80ch]" />
            </div>
            <p className="text-xs text-muted-foreground">
              <OwnershipReportError subject={REPORT_SUBJECT} />
            </p>
          </section>
        </div>
        </WorkspacePage>
      </DashboardLayout>
    </>
  );
}
