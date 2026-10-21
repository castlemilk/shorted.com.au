import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { ExternalLinkGlyph, ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import {
  KindBadge,
  NoticeTable,
  OwnershipMethodology,
} from "~/@/components/ownership/ownership-parts";
import { FileHoldingsTable, SubstantialHoldingsTable } from "~/@/components/ownership/ownership-tables";
import { formatAmount } from "~/@/lib/fundamentals/format";
import { kindInfo } from "~/@/lib/ownership/kinds";
import { INSTITUTION_ROWS_SHOWN, fileHoldingRow, holdingRow } from "~/@/lib/ownership/rows";
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
        <ExternalLinkSymbol />
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
                  Website <ExternalLinkGlyph className="h-3 w-3" />
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
            <SubstantialHoldingsTable
              rows={data.positions.map(holdingRow)}
              holder={inst.name}
              caption={`${inst.name}'s current substantial holdings`}
              limit={INSTITUTION_ROWS_SHOWN}
            />
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
            <FileHoldingsTable
              rows={data.fundHoldings.map(fileHoldingRow)}
              caption={`${inst.name}'s largest disclosed ASX holdings`}
              limit={INSTITUTION_ROWS_SHOWN}
            />
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
          <NoticeTable
            notices={data.notices}
            showHolder={false}
            caption={`${inst.name}'s substantial holding notices`}
            limit={INSTITUTION_ROWS_SHOWN}
          />
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
