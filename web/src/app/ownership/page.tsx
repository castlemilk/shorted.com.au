import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
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
import { formatAmount } from "~/@/lib/fundamentals/format";
import { KIND_ORDER, kindInfo, kindRank } from "~/@/lib/ownership/kinds";
import { eyebrow, lede, pageTitle, sectionTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getOwnershipOverview, listInstitutions } from "~/app/actions/getOwnership";
import type { OwnershipInstitution } from "~/gen/shorts/v1alpha1/ownership_pb";
import { JsonLd } from "~/@/components/seo/json-ld";

const URL = "https://shorted.com.au/ownership";
const TITLE = "Who Owns the ASX: Super Funds, Index Funds and Hedge Funds";
const DESCRIPTION =
  "Which super funds, index funds, hedge funds, banks and other institutions hold ASX stocks: every substantial holding notice read from its PDF, the holdings of the largest index ETFs and super funds, and where crowded registers meet high short interest.";

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

function Tile({ value, label, meta }: { value: string; label: string; meta?: string }) {
  return (
    <div className="space-y-1 bg-card p-4">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {meta ? <p className="text-xs tabular-nums text-muted-foreground">{meta}</p> : null}
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

export default async function OwnershipPage() {
  const [overview, directory] = await Promise.all([getOwnershipOverview(), listInstitutions("", "", 200, 0)]);
  // Nothing to show: a failed read, or a database the first `shorted
  // ownership` run has not filled yet. The page says so instead of drawing
  // empty tables, and its cache is shortened so the data shows once it lands.
  const empty = !overview || (overview.noticesParsed === 0 && overview.superFunds === 0);
  if (empty) await bailOnEmptyRender();

  const kinds = [...(overview?.kinds ?? [])].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  const institutions = directory?.institutions ?? [];
  const byKind = KIND_ORDER.map((kind) => ({
    kind,
    members: institutions.filter((i) => i.kind === kind),
  })).filter((g) => g.members.length > 0);
  const asOf = overview?.asOf ?? "";

  const header = (
    <header className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className={pageTitle}>Who owns the ASX</h1>
        <p className={eyebrow}>Ownership</p>
      </div>
      <p className={lede}>
        Super funds, index funds, hedge funds, banks and the rest of the register: every substantial holding notice
        read from its PDF, the full holdings of the largest index ETFs and super fund options, and where a crowded
        register meets heavy short interest.
        {asOf ? (
          <>
            {" "}
            Notices to <span className="whitespace-nowrap">{asOf}</span>.
          </>
        ) : null}
      </p>
    </header>
  );

  if (empty) {
    return (
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          {header}
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
            <OwnershipMethodology className="max-w-[80ch]" />
          </section>
        </div>
      </DashboardLayout>
    );
  }

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
      "Index ETF holdings files (iShares, Vanguard, SPDR, Betashares)",
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
        dataSource="ASX substantial holding notices; APRA; ASX Investment Products report; ETF and super fund holdings disclosures"
        dataFrequency="daily"
        keywords={["substantial holders", "super fund holdings", "index fund ownership", "hedge funds"]}
        lastUpdated={asOf || undefined}
      />
      <DashboardLayout fullWidth>
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          {/* The latest notices' ASX links point at it. */}
          <ExternalLinkSymbol />
          {header}

          <section aria-label="Coverage">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
              <Tile
                value={String(overview?.superFunds ?? 0)}
                label="APRA-regulated super funds"
                meta={overview?.superAssetsAud ? `${formatAmount(overview.superAssetsAud, "AUD")} in assets` : undefined}
              />
              <Tile
                value={String(overview?.etfs ?? 0)}
                label="ASX exchange-traded products"
                meta={overview?.etfFumAud ? `${formatAmount(overview.etfFumAud, "AUD")} under management` : undefined}
              />
              <Tile
                value={String(overview?.lics ?? 0)}
                label="Listed investment companies and trusts"
                meta={overview?.licMarketCapAud ? `${formatAmount(overview.licMarketCapAud, "AUD")} market cap` : undefined}
              />
              <Tile
                value={(overview?.noticesParsed ?? 0).toLocaleString("en-AU")}
                label="Substantial holding notices read"
                meta={overview?.noticesWithheld ? `${overview.noticesWithheld.toLocaleString("en-AU")} withheld (unreadable)` : undefined}
              />
            </div>
          </section>

          <section className="space-y-3" aria-labelledby="map">
            <h2 id="map" className={sectionTitle}>
              The map
            </h2>
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
          </section>

          <section className="space-y-3" aria-labelledby="holders">
            <h2 id="holders" className={sectionTitle}>
              The biggest holders
            </h2>
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
          </section>

          <section className="space-y-3" aria-labelledby="registers">
            <h2 id="registers" className={sectionTitle}>
              Registers
            </h2>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Most crowded registers</CardTitle>
                  <CardDescription>
                    Stocks where institutions disclose the most voting power between them. Listed companies and
                    private holders are not counted.
                  </CardDescription>
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
                  <CardDescription>
                    Hedge funds and active managers together hold 5% or more, and at least 3% of the shares are
                    reported short.
                  </CardDescription>
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
                  <CardDescription>
                    Banks and brokers with a substantial interest, mostly stock lent to or held as collateral from
                    short sellers, beside each stock&apos;s short interest.
                  </CardDescription>
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
                  <CardDescription>
                    The share of each company held by the index funds tracked (iShares, Vanguard, SPDR, Betashares),
                    from their holdings files. Vanguard&apos;s files cover the whole fund behind each ETF, its
                    unlisted classes included, so VAS&apos;s figures are the fund&apos;s, not the ETF&apos;s alone.
                  </CardDescription>
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
                    What the tracked super fund options hold most of, by combined value. Each fund&apos;s default or
                    balanced option, from its portfolio holdings disclosure.
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
          </section>

          <section className="space-y-3" aria-labelledby="notices">
            <h2 id="notices" className={sectionTitle}>
              Latest notices
            </h2>
            <NoticeTable notices={overview?.recent ?? []} caption="Latest substantial holding notices" />
          </section>

          <section className="space-y-4" aria-labelledby="directory">
            <h2 id="directory" className={sectionTitle}>
              Institutions on the map
            </h2>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {byKind.map((group) => (
                <div key={group.kind} className="space-y-2">
                  <h3 className="text-sm font-semibold">
                    {kindInfo(group.kind).plural}{" "}
                    <span className="font-normal text-muted-foreground">({group.members.length})</span>
                  </h3>
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
          </section>

          <section className="space-y-3" aria-labelledby="sources">
            <h2 id="sources" className={sectionTitle}>
              Sources and method
            </h2>
            <ul className="space-y-1 text-sm">
              {(overview?.sources ?? []).map((s) => (
                <li key={s.source}>
                  {s.description}: {s.records.toLocaleString("en-AU")} records
                  {s.asAt ? <span className="tabular-nums text-muted-foreground">, as at {s.asAt}</span> : null}
                </li>
              ))}
            </ul>
            <OwnershipMethodology className="max-w-[80ch]" />
          </section>
        </div>
      </DashboardLayout>
    </>
  );
}
