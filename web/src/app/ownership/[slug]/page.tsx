import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { BreadcrumbStructuredData, Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { ExternalLinkGlyph, ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { NoticeTable } from "~/@/components/ownership/notice-table";
import { KindBadge, OwnershipMethodology } from "~/@/components/ownership/ownership-parts";
import { FileHoldingsTable, SubstantialHoldingsTable } from "~/@/components/ownership/ownership-tables";
import { formatAmount } from "~/@/lib/fundamentals/format";
import { institutionIsIndexable } from "~/@/lib/ownership/indexability";
import { isInstitutionSlug, kindInfo } from "~/@/lib/ownership/kinds";
import { INSTITUTION_NOTICES_SHOWN, fileHoldingRow, holdingRow } from "~/@/lib/ownership/rows";
import { eyebrow, lede, pageTitle, sectionTitle } from "@/lib/typography";
import { getInstitutionOrNotFound } from "~/app/actions/getOwnership";
import { NotFoundError } from "~/app/actions/withRetry";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import type { GetInstitutionResponse } from "~/gen/shorts/v1alpha1/ownership_pb";

// On-demand ISR: rendered on first visit, cached for an hour. The empty
// generateStaticParams keeps the segment static (the stock tabs' rule).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

const NOINDEX = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
} as const;

// Titles stay inside Google's display width before the root template's
// " | Shorted": the old "<name> ASX Holdings: Substantial Stakes and Fund
// Holdings | Shorted" ran 70-85 characters. A name too long for the full form
// (21 of the 145 on the map) keeps the head term alone.
const TITLE_MAX = 60;

function institutionTitle(name: string): string {
  const full = `${name} ASX holdings and substantial stakes`;
  return full.length <= TITLE_MAX ? full : `${name} ASX holdings`;
}

/**
 * The page's one read, split by cause (loadStockOrFail's rule). Undefined for
 * a slug the API does not know, which is a 404. A failed read THROWS: ISR
 * caches whatever a regeneration renders, so answering it with notFound() put
 * a 404 in place of a live institution for the hour, where a failed
 * regeneration keeps serving the last good page. generateMetadata and the
 * page make the same call, so React's cache reads once.
 */
async function readInstitutionPage(slug: string): Promise<GetInstitutionResponse | undefined> {
  let data: GetInstitutionResponse | undefined;
  try {
    data = await getInstitutionOrNotFound(slug);
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
  if (!data) {
    throw new Error(
      `ownership data transiently unavailable for ${slug}; failing the ISR render instead of caching a 404`,
    );
  }
  return data;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const slug = (await params).slug;
  const data = isInstitutionSlug(slug) ? await readInstitutionPage(slug) : undefined;
  const inst = data?.institution;
  if (!inst) return { title: "Institution not found", robots: NOINDEX };
  const url = `https://shorted.com.au/ownership/${inst.slug}`;
  const title = institutionTitle(inst.name);
  const stakes = inst.substantialPositions;
  const holds = [
    stakes > 0 ? `${stakes} current substantial holding${stakes === 1 ? "" : "s"} from its notices` : "",
    data.fundHoldings.length > 0 ? "the largest holdings in its published holdings files" : "",
  ].filter(Boolean);
  const kind = kindInfo(inst.kind).label.toLowerCase();
  const description =
    holds.length > 0
      ? `What ${inst.name} (${kind}) holds on the ASX: ${holds.join(", and ")}.`
      : `${inst.name} (${kind}): no current substantial holding in an ASX company on record in its notices.`;
  // The one predicate the ownership sitemap also applies. Indexable means NO
  // robots key: Next merges metadata key by key, so `robots: undefined` would
  // replace the root layout's googleBot directives with nothing.
  const indexable = institutionIsIndexable({
    substantialPositions: stakes,
    fundHoldings: data.fundHoldings.length,
  });
  return {
    title,
    description,
    alternates: { canonical: url },
    ...(indexable ? {} : { robots: NOINDEX }),
    // No `images` on either: the segment's opengraph-image.tsx is the card,
    // and an explicit `images` would shadow it. `twitter` is set so its image
    // follows the card instead of the root layout's; it replaces the root's
    // object wholesale, so it repeats site and creator.
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
  };
}

export default async function InstitutionPage({ params }: PageProps) {
  const slug = (await params).slug;
  if (!isInstitutionSlug(slug)) notFound();
  const data = await readInstitutionPage(slug);
  const inst = data?.institution;
  if (!data || !inst) notFound();

  const info = kindInfo(inst.kind);
  const etfs = data.funds.filter((f) => f.fundType === "etf");
  const superFunds = data.funds.filter((f) => f.fundType === "super_fund");
  const crumbs = [
    { label: "Ownership", href: "/ownership" },
    { label: inst.name, href: `/ownership/${inst.slug}` },
  ];

  return (
    <DashboardLayout fullWidth>
      <BreadcrumbStructuredData items={crumbs} />
      <div className="mx-auto w-full max-w-[100rem] space-y-10">
        <ExternalLinkSymbol />
        <Breadcrumbs items={crumbs} />
        <header className="space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className={pageTitle}>{inst.name}</h1>
            <p className={eyebrow}>{info.label}</p>
          </div>
          <p className={lede}>
            {inst.description || info.note}
            {safeExternalHref(inst.website) ? (
              <>
                {" "}
                <a
                  href={safeExternalHref(inst.website)}
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
            limit={INSTITUTION_NOTICES_SHOWN}
            onRecord={inst.notices}
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
