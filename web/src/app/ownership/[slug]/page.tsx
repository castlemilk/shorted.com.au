import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { BreadcrumbStructuredData, Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { ExternalLinkGlyph, ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { NoticeTable } from "~/@/components/ownership/notice-table";
import { KindBadge } from "~/@/components/ownership/ownership-parts";
import { OwnershipReportError } from "~/@/components/ownership/ownership-provenance";
import { FileHoldingsTable, SubstantialHoldingsTable } from "~/@/components/ownership/ownership-tables";
import { ShowAll } from "~/@/components/ownership/show-all";
import { MethodDisclosure } from "~/@/components/ownership/workspace/method-disclosure";
import { formatAmount } from "~/@/lib/fundamentals/format";
import { institutionIsIndexable } from "~/@/lib/ownership/indexability";
import { isInstitutionSlug, kindInfo } from "~/@/lib/ownership/kinds";
import { defaultNoticeQuery, NOTICE_WINDOW_ALL, serialiseNoticeParams } from "~/@/lib/ownership/query";
import { fileHoldingRow, holdingRow } from "~/@/lib/ownership/rows";
import { eyebrow, lede, pageTitle, sectionTitle } from "@/lib/typography";
import { getInstitutionOrNotFound } from "~/app/actions/getOwnership";
import { NotFoundError } from "~/app/actions/withRetry";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { HolderConnectionsMap } from "~/@/components/ownership/holders/holder-connections-map";
import {
  connectionsPage,
  holderFundRow,
  holderInspectorContent,
  holderRowFrom,
  marketCapsOf,
} from "~/@/components/ownership/holders/holder-tree";
import { HolderInspector } from "~/@/components/ownership/workspace/inspectors/holder-inspector";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { loadOwnershipMap } from "~/app/actions/ownershipDesk";
import { loadHolderConnections, resolveHolderInspector } from "~/app/actions/ownershipHolders";
import type { GetInstitutionResponse, SubstantialHolding } from "~/gen/shorts/v1alpha1/ownership_pb";

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

/**
 * Each list's rows drawn before its "Show all" disclosure. The rest stay in the HTML.
 */
const SECTION_ROWS_SHOWN = 10;

/**
 * The stakes, largest first: voting power times the stock's market cap where the row has one,
 * else voting power alone. The two keys are in different units (dollars against a share of the
 * vote), so every row with a market cap sorts ahead of every row without one, and the two groups
 * are ordered within themselves. The sort is stable, so equal keys keep the API's order.
 */
function stakesLargestFirst(
  positions: readonly SubstantialHolding[],
  caps: ReadonlyMap<string, number | null> | null,
): SubstantialHolding[] {
  const dollars = (p: SubstantialHolding): number | null => {
    const cap = caps?.get(p.stockCode);
    return cap ? p.votingPowerPct * cap : null;
  };
  return [...positions].sort((a, b) => {
    const da = dollars(a);
    const db = dollars(b);
    if (da !== null && db !== null) return db - da;
    if (da !== null) return -1;
    if (db !== null) return 1;
    return b.votingPowerPct - a.votingPowerPct;
  });
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

  // The connections map and the inspector read the institution's own positions, joined to
  // each stock's market cap from the desk's map. The map is a pane here, not the page's
  // content: a map that cannot be read draws every width as a hairline and the pane says so
  // (its outage line), and the page caches as usual (spec 14.7).
  const desk = await loadOwnershipMap({});
  const caps = desk.ok ? marketCapsOf(desk.stocks) : null;
  const holder = holderRowFrom(inst);
  const funds = data.funds.map(holderFundRow);
  const connections = connectionsPage(holder, data.positions, caps, funds);
  const inspector = holderInspectorContent(holder, connections.positions, null, connections.funds);

  const info = kindInfo(inst.kind);
  const stakes = stakesLargestFirst(data.positions, caps).map(holdingRow);
  const files = data.fundHoldings.map(fileHoldingRow);
  const products = [...data.funds.filter((f) => f.fundType === "super_fund"), ...data.funds.filter((f) => f.fundType === "etf")];
  const crumbs = [
    { label: "Ownership", href: "/ownership" },
    { label: inst.name, href: `/ownership/${inst.slug}` },
  ];
  // The feed's whole-register view of this holder, for the same reason as the register
  // page's link: the default window is 30 days, and the link promises every notice.
  const allNotices = `/ownership/notices?${serialiseNoticeParams({
    ...defaultNoticeQuery(),
    windowDays: NOTICE_WINDOW_ALL,
    institutionSlug: inst.slug,
  }).toString()}`;

  return (
    <DashboardLayout fullWidth>
      <BreadcrumbStructuredData items={crumbs} />
      <WorkspacePage
        inspector={
          <HolderInspector
            initial={inspector}
            defaultKey={inst.slug}
            fixedKey={inst.slug}
            resolve={resolveHolderInspector}
          />
        }
      >
      <div className="space-y-10">
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

        <HolderConnectionsMap
          defaultKey={inst.slug}
          fixedKey={inst.slug}
          initial={connections}
          loadConnections={loadHolderConnections}
        />

        <section className="space-y-3" aria-labelledby="stakes">
          <h2 id="stakes" className={sectionTitle}>
            Substantial holdings
          </h2>
          {stakes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No current substantial holding on record: no notice read leaves {inst.name} with 5% or more of an ASX
              company.
            </p>
          ) : (
            <ShowAll
              total={stakes.length}
              limit={SECTION_ROWS_SHOWN}
              rest={
                <SubstantialHoldingsTable
                  rows={stakes.slice(SECTION_ROWS_SHOWN)}
                  holder={inst.name}
                  caption={`${inst.name}'s other current substantial holdings`}
                />
              }
            >
              <SubstantialHoldingsTable
                rows={stakes.slice(0, SECTION_ROWS_SHOWN)}
                holder={inst.name}
                caption={`${inst.name}'s current substantial holdings`}
              />
            </ShowAll>
          )}
        </section>

        {files.length > 0 ? (
          <section className="space-y-3" aria-labelledby="files">
            <h2 id="files" className={sectionTitle}>
              From its holdings files
            </h2>
            <p className="max-w-[70ch] text-sm text-muted-foreground">
              The largest ASX holdings, by value, in the latest holdings files {inst.name} publishes
              {inst.kind === "super_fund" ? " (one investment option, not the whole fund)" : ""}.
            </p>
            <ShowAll
              total={files.length}
              limit={SECTION_ROWS_SHOWN}
              rest={
                <FileHoldingsTable
                  rows={files.slice(SECTION_ROWS_SHOWN)}
                  caption={`${inst.name}'s other disclosed ASX holdings`}
                />
              }
            >
              <FileHoldingsTable
                rows={files.slice(0, SECTION_ROWS_SHOWN)}
                caption={`${inst.name}'s largest disclosed ASX holdings`}
              />
            </ShowAll>
            {data.fundHoldingsTotal > files.length ? (
              <p className="text-xs text-muted-foreground">
                {`The largest ${files.length.toLocaleString("en-AU")} of ${data.fundHoldingsTotal.toLocaleString("en-AU")} ASX holdings in its files.`}
              </p>
            ) : null}
          </section>
        ) : null}

        {products.length > 0 ? (
          <section className="space-y-3" aria-labelledby="products">
            <h2 id="products" className={sectionTitle}>
              Products
            </h2>
            <ShowAll
              total={products.length}
              limit={SECTION_ROWS_SHOWN}
              rest={
                <ul className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
                  {products.slice(SECTION_ROWS_SHOWN).map((f) => (
                    <ProductItem key={f.fundKey} fund={f} />
                  ))}
                </ul>
              }
            >
              <ul className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
                {products.slice(0, SECTION_ROWS_SHOWN).map((f) => (
                  <ProductItem key={f.fundKey} fund={f} />
                ))}
              </ul>
            </ShowAll>
          </section>
        ) : null}

        <section className="space-y-3" aria-labelledby="history">
          <h2 id="history" className={sectionTitle}>
            Notices
          </h2>
          {inst.notices > 0 ? (
            <p className="text-sm">
              <Link
                href={allNotices}
                rel="nofollow"
                prefetch={false}
                className="hit-target text-primary underline-offset-4 hover:underline"
              >
                All notices →
              </Link>
            </p>
          ) : null}
          {inst.notices > data.notices.length ? (
            <p className="text-xs text-muted-foreground">
              {`The newest ${data.notices.length.toLocaleString("en-AU")} of ${inst.notices.toLocaleString("en-AU")} notices on record.`}
            </p>
          ) : null}
          <ShowAll
            total={data.notices.length}
            limit={SECTION_ROWS_SHOWN}
            rest={
              <NoticeTable
                notices={data.notices.slice(SECTION_ROWS_SHOWN)}
                showHolder={false}
                caption={`${inst.name}'s other substantial holding notices`}
              />
            }
          >
            <NoticeTable
              notices={data.notices.slice(0, SECTION_ROWS_SHOWN)}
              showHolder={false}
              caption={`${inst.name}'s substantial holding notices`}
            />
          </ShowAll>
        </section>

        <MethodDisclosure
          extra={[
            <div key="kind" className="flex items-center gap-2">
              <KindBadge kind={inst.kind} />
              <span>{info.note}</span>
            </div>,
            <p key="report">
              <OwnershipReportError subject={`Ownership data: ${inst.name}`} />
            </p>,
          ]}
        />
      </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}

/** One product of the institution: its ASX code, name and size where it is stated. */
function ProductItem({ fund: f }: { fund: GetInstitutionResponse["funds"][number] }) {
  return (
    <li className="flex min-w-0 justify-between gap-3">
      <span className="min-w-0 truncate">
        {f.asxCode ? <span className="font-semibold">{f.asxCode} </span> : null}
        {f.name}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{f.hasSize ? formatAmount(f.sizeAud, "AUD") : ""}</span>
    </li>
  );
}
