import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
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
  NoticeTable,
  OwnershipMethodology,
} from "~/@/components/ownership/ownership-parts";
import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { formLabel, formatPointChange, formatVotingPower, fundLabel, kindInfo } from "~/@/lib/ownership/kinds";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { eyebrow, lede, pageTitle, sectionTitle } from "@/lib/typography";
import { getInstitution } from "~/app/actions/getOwnership";

// On-demand ISR: rendered on first visit, cached for an hour. The empty
// generateStaticParams keeps the segment static (the stock tabs' rule).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

const SLUG = /^[a-z0-9-]{2,64}$/;

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const slug = (await params).slug;
  const data = SLUG.test(slug) ? await getInstitution(slug) : undefined;
  const inst = data?.institution;
  if (!inst) return { title: "Institution not found", robots: { index: false } };
  const url = `https://shorted.com.au/ownership/${inst.slug}`;
  const title = `${inst.name} ASX Holdings: Substantial Stakes and Fund Holdings`;
  const description = `What ${inst.name} (${kindInfo(inst.kind).label.toLowerCase()}) holds on the ASX: ${inst.substantialPositions} current substantial holdings from its notices${
    data.fundHoldings.length > 0 ? ", and the largest holdings in its published holdings files" : ""
  }.`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
  };
}

export default async function InstitutionPage({ params }: PageProps) {
  const slug = (await params).slug;
  if (!SLUG.test(slug)) notFound();
  const data = await getInstitution(slug);
  const inst = data?.institution;
  if (!data || !inst) notFound();

  const info = kindInfo(inst.kind);
  const etfs = data.funds.filter((f) => f.fundType === "etf");
  const superFunds = data.funds.filter((f) => f.fundType === "super_fund");

  return (
    <DashboardLayout fullWidth>
      <div className="mx-auto w-full max-w-[100rem] space-y-10">
        <Breadcrumbs
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: inst.name, href: `/ownership/${inst.slug}` },
          ]}
        />
        <header className="space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className={pageTitle}>{inst.name}</h1>
            <p className={eyebrow}>{info.label}</p>
          </div>
          <p className={lede}>
            {inst.description || info.note}
            {inst.website ? (
              <>
                {" "}
                <a
                  href={inst.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  Website <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </>
            ) : null}
          </p>
        </header>

        <section aria-label="Summary">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
            <div className="space-y-1 bg-card p-4">
              <dt className="text-xs text-muted-foreground">Current stakes of 5%+</dt>
              <dd className="text-2xl font-semibold tabular-nums">{inst.substantialPositions}</dd>
            </div>
            <div className="space-y-1 bg-card p-4">
              <dt className="text-xs text-muted-foreground">Notices read</dt>
              <dd className="text-2xl font-semibold tabular-nums">{inst.notices}</dd>
            </div>
            <div className="space-y-1 bg-card p-4">
              <dt className="text-xs text-muted-foreground">Latest notice</dt>
              <dd className="text-2xl font-semibold tabular-nums">{inst.latestNoticeDate || "n/a"}</dd>
            </div>
            <div className="space-y-1 bg-card p-4">
              <dt className="text-xs text-muted-foreground">{inst.hasAum ? "Total assets (APRA)" : "Listed funds"}</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {inst.hasAum
                  ? formatAmount(inst.aumAud, "AUD")
                  : inst.hasFundsSize
                    ? formatAmount(inst.fundsSizeAud, "AUD")
                    : "n/a"}
              </dd>
              {inst.hasAum && inst.aumAsAt ? (
                <dd className="text-xs tabular-nums text-muted-foreground">as at {inst.aumAsAt}</dd>
              ) : null}
            </div>
          </dl>
        </section>

        <section className="space-y-3" aria-labelledby="stakes">
          <h2 id="stakes" className={sectionTitle}>
            Substantial holdings
          </h2>
          {data.positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No current substantial holding on record: no notice read leaves {inst.name} with 5% or more of an ASX
              company.
            </p>
          ) : (
            <Table>
              <caption className="sr-only">{inst.name}&apos;s current substantial holdings</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Stock</TableHead>
                  <TableHead className="text-right">Voting power</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                  <TableHead>As at</TableHead>
                  <TableHead className="hidden md:table-cell">Notice</TableHead>
                  <TableHead>
                    <span className="sr-only">Document</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.positions.map((p) => (
                  <TableRow key={p.stockCode}>
                    <TableCell>
                      <Link
                        href={stockTabHref(p.stockCode, "company")}
                        prefetch={false}
                        className="font-semibold text-primary underline-offset-4 hover:underline"
                      >
                        {p.stockCode}
                      </Link>
                      {p.companyName ? (
                        <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">{p.companyName}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatVotingPower(p.votingPowerPct)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.hasPrevious ? formatPointChange(p.previousPct, p.votingPowerPct) : ""}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{p.eventDate || p.announcedOn}</TableCell>
                    <TableCell className="hidden md:table-cell">{formLabel(p.form, false)}</TableCell>
                    <TableCell>
                      <a
                        href={p.announcementUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hit-target inline-flex text-muted-foreground hover:text-primary"
                        aria-label={`${inst.name}'s ${p.stockCode} notice on ASX`}
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden />
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        {data.fundHoldings.length > 0 ? (
          <section className="space-y-3" aria-labelledby="files">
            <h2 id="files" className={sectionTitle}>
              From its holdings files
            </h2>
            <p className="max-w-[70ch] text-sm text-muted-foreground">
              The largest ASX holdings, by value, in the latest holdings files {inst.name} publishes
              {inst.kind === "super_fund" ? " (one investment option, not the whole fund)" : ""}.
            </p>
            <Table>
              <caption className="sr-only">{inst.name}&apos;s largest disclosed ASX holdings</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Stock</TableHead>
                  <TableHead>Fund</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Of fund</TableHead>
                  <TableHead className="text-right">Of shares</TableHead>
                  <TableHead>As at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.fundHoldings.map((h) => (
                  <TableRow key={`${h.fundName}|${h.stockCode}`}>
                    <TableCell>
                      <Link
                        href={stockTabHref(h.stockCode, "company")}
                        prefetch={false}
                        className="font-semibold text-primary underline-offset-4 hover:underline"
                      >
                        {h.stockCode}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                      {fundLabel(h.fundCode, h.fundName)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.hasValue ? formatAmount(h.valueAud, "AUD") : "n/a"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.hasWeight ? formatPct(h.weightPct, { digits: 2 }) : "n/a"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.hasPctOfIssued ? formatPct(h.pctOfIssued, { digits: 2 }) : "n/a"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{h.asAt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ) : null}

        {etfs.length + superFunds.length > 0 ? (
          <section className="space-y-3" aria-labelledby="products">
            <h2 id="products" className={sectionTitle}>
              Products
            </h2>
            <ul className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
              {[...superFunds, ...etfs].map((f) => (
                <li key={f.fundKey} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {f.asxCode ? <span className="font-semibold">{f.asxCode} </span> : null}
                    {f.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {f.hasSize ? formatAmount(f.sizeAud, "AUD") : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3" aria-labelledby="history">
          <h2 id="history" className={sectionTitle}>
            Notices
          </h2>
          <NoticeTable notices={data.notices} showHolder={false} caption={`${inst.name}'s substantial holding notices`} />
        </section>

        <section className="space-y-2" aria-label="Method">
          <div className="flex items-center gap-2">
            <KindBadge kind={inst.kind} />
            <span className="text-xs text-muted-foreground">{info.note}</span>
          </div>
          <OwnershipMethodology className="max-w-[80ch]" />
        </section>
      </div>
    </DashboardLayout>
  );
}
