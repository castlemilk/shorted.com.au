import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { HolderLanes } from "~/@/components/ownership/holder-lanes";
import { NoticeTable } from "~/@/components/ownership/notice-table";
import { OwnershipMethodology } from "~/@/components/ownership/ownership-parts";
import { OwnershipPlate, type PlateItem } from "~/@/components/ownership/ownership-plate";
import {
  OwnershipReportError,
  OwnershipSourceLines,
  type SourceLine,
} from "~/@/components/ownership/ownership-provenance";
import { RegisterReadout } from "~/@/components/ownership/register-readout";
import { StockFundTable } from "~/@/components/ownership/stock-fund-table";
import { BreadcrumbStructuredData, Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { JsonLd } from "~/@/components/seo/json-ld";
import { NOT_AVAILABLE, formatAmount, formatPct, formatShares } from "~/@/lib/fundamentals/format";
import { REGISTER_CODE_PATTERN, asAtRange, registerHref } from "~/@/lib/ownership/kinds";
import { defaultNoticeQuery, NOTICE_WINDOW_ALL, serialiseNoticeParams } from "~/@/lib/ownership/query";
import { registerIsIndexable } from "~/@/lib/ownership/register-indexability";
import { buildHolderLanes } from "~/@/lib/ownership/trace";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { eyebrow, lede, pageTitle, sectionTitle } from "@/lib/typography";
import { STOCK_CODE_PATTERN } from "~/app/shorts/[stockCode]/stock-page-shared";
import {
  asAtSpan,
  count,
  disclosedOf,
  indexFilesOf,
  interestsOf,
  isUnknownRegister,
  readRegister,
  registerCompany,
  registerDescription,
  registerTitle,
  type IndexFiles,
  type RegisterResponse,
} from "./register-data";

// On-demand ISR, as the institution page: rendered on first visit and cached for
// an hour. The empty generateStaticParams keeps the segment static (the stock
// tabs' rule).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ code: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ code: string }>;
}

const NOINDEX = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
} as const;

/** Notices drawn before "Show all": the newest, as the institution page draws them. */
const NOTICES_SHOWN = 25;

/** The three sources a register is built from, for the Dataset's isBasedOn. */
const SOURCES = [
  "ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605)",
  "Index fund holdings files (iShares, Vanguard, SPDR, Betashares)",
  "Super fund portfolio holdings disclosures (one investment option each)",
];

/**
 * The section headings. scroll-mt-20 clears the sticky site header (h-16), so a
 * link such as the Company card's "#funds" lands on its heading, not under it.
 */
const SECTION_HEADING = `${sectionTitle} scroll-mt-20`;

function canonicalOf(code: string): string {
  return `https://shorted.com.au${registerHref(code)}`;
}

/** The register.withheld copy, with its noun and verb for one notice. */
function withheldSentence(n: number, code: string): string {
  const verb = n === 1 ? "was" : "were";
  return `${count(n, "notice")} listed under ${code} ${verb} withheld: not read or not reconcilable, never estimated.`;
}

/**
 * The register.ceased copy. The count is the notices read for the stock (the
 * history total, which the Company tab states too), not the lines drawn: a holder
 * with a 603 and a 605 is one line and two notices. "Has since ceased" is said of
 * each holding, not of the notices: a trail that opens with a 603 does not end in
 * a cessation, but every holding it disclosed has.
 */
function ceasedSentence(code: string, notices: number): string {
  return `No current substantial holder read for ${code}: each holding in the ${count(notices, "notice")} read for it has since ceased (Form 605, under 5%). The lines below are what was read.`;
}

/** The nameplate's facts. Each one is in only when the register holds its data. */
function plateItems(
  data: RegisterResponse,
  indexFiles: IndexFiles,
  superSpan: { from: string; to: string },
): PlateItem[] {
  const { summary } = data;
  const items: PlateItem[] = [];
  if (data.asOf) items.push({ text: `Notices read to ${data.asOf}`, dateTime: data.asOf });
  if (summary.hasShortPct) {
    const shares = data.hasSharesOnIssue ? ` of ${formatShares(data.sharesOnIssue)} shares on issue` : "";
    // A report date the API does not hold is left out, never "as of n/a".
    const asOf = summary.shortAsOf ? `, as of ${summary.shortAsOf}` : "";
    items.push({
      text: `short interest ${formatPct(summary.shortPct, { digits: 2 })}${shares}${asOf} (ASIC, T+4)`,
      dateTime: summary.shortAsOf || undefined,
    });
  }
  if (indexFiles.files > 0) {
    items.push({ text: `index fund files ${asAtRange(indexFiles.from, indexFiles.to)}` });
  }
  if (summary.superOptions > 0) {
    items.push({ text: `super options ${asAtRange(superSpan.from, superSpan.to)}` });
  }
  return items;
}

/** Each source with its own date. A source the stock does not appear in is not listed. */
function sourceLines(
  code: string,
  data: RegisterResponse,
  superSpan: { from: string; to: string },
  indexFiles: IndexFiles,
): SourceLine[] {
  const { summary } = data;
  const lines: SourceLine[] = [
    {
      text: `ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF${data.asOf ? `; read to ${data.asOf}` : ""}.`,
      asAt: data.asOf,
    },
  ];
  if (indexFiles.files > 0) {
    lines.push({
      text: `Index fund holdings files: ${count(indexFiles.files, "file")} holding ${code}, ${asAtRange(indexFiles.from, indexFiles.to)}.`,
    });
  }
  if (summary.superOptions > 0) {
    lines.push({
      text: `Super fund portfolio holdings disclosures, one option per fund: ${count(summary.superOptions, "option")} holding ${code}, ${asAtRange(superSpan.from, superSpan.to)}.`,
    });
  }
  if (summary.hasShortPct) {
    lines.push({
      text: `ASIC short position report${summary.shortAsOf ? `, as of ${summary.shortAsOf}` : ""}, published T+4.`,
      asAt: summary.shortAsOf,
    });
  }
  return lines;
}

function StockLinks({ code }: { code: string }) {
  const link = "hit-target text-primary underline-offset-4 hover:underline";
  return (
    <ul aria-label="Stock pages" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      <li>
        <Link href={stockTabHref(code, "overview")} prefetch={false} className={link}>
          Stock overview →
        </Link>
      </li>
      <li>
        <Link href={`${stockTabHref(code, "company")}#ownership`} prefetch={false} className={link}>
          Company tab →
        </Link>
      </li>
      <li>
        <Link href={stockTabHref(code, "short-interest")} prefetch={false} className={link}>
          Short interest →
        </Link>
      </li>
    </ul>
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).code.toUpperCase();
  if (!REGISTER_CODE_PATTERN.test(code)) return { title: "Stock not found", robots: NOINDEX };
  const data = await readRegister(code);
  if (isUnknownRegister(data)) return { title: "Stock not found", robots: NOINDEX };

  const company = registerCompany(code, data);
  const title = registerTitle(code, company);
  const description = registerDescription(code, company, data);
  const url = canonicalOf(code);
  // Indexable means NO robots key: Next merges metadata key by key, so
  // `robots: undefined` would replace the root layout's googleBot directives.
  const indexable = registerIsIndexable({ holders: data.summary.holders });
  return {
    title,
    description,
    alternates: { canonical: url },
    ...(indexable ? {} : { robots: NOINDEX }),
    // No `images`: the segment's opengraph-image.tsx is the card, and an explicit
    // `images` would shadow it. `twitter` replaces the root's object whole, so
    // it repeats site and creator.
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
  };
}

export default async function RegisterPage({ params }: PageProps) {
  const code = (await params).code.toUpperCase();
  if (!REGISTER_CODE_PATTERN.test(code)) notFound();
  const data = await readRegister(code);
  if (isUnknownRegister(data)) notFound();

  const { summary } = data;
  const company = registerCompany(code, data);
  const description = registerDescription(code, company, data);
  const url = canonicalOf(code);
  const holders = summary.holders;
  const withheld = data.withheldListed;
  const superSpan = asAtSpan(data.fundHoldings, "super_phd");
  const indexFiles = indexFilesOf(data.fundHoldings);
  const drawn = buildHolderLanes({
    holders: data.holders,
    history: data.history,
    asOf: data.asOf,
    historyTotal: data.historyTotal,
  });
  const crumbs = [
    { label: "Ownership", href: "/ownership" },
    { label: "Registers", href: "/ownership/stocks" },
    { label: `${code} register`, href: registerHref(code) },
  ];
  // The feed's whole-register view of this stock. Its default window is the last 30
  // days, and this link promises every notice read for the stock. Each filtered view
  // repeats the feed's default HTML under another canonical, so the link is nofollow.
  const allNotices = `/ownership/notices?${serialiseNoticeParams({
    ...defaultNoticeQuery(),
    windowDays: NOTICE_WINDOW_ALL,
    stockCode: code,
  }).toString()}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${company} (${code}) substantial holders`,
    description,
    url,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isBasedOn: SOURCES,
    ...(data.asOf ? { dateModified: data.asOf } : {}),
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <DashboardLayout fullWidth>
        <BreadcrumbStructuredData items={crumbs} />
        <div className="mx-auto w-full max-w-[100rem] space-y-10">
          <ExternalLinkSymbol />
          <Breadcrumbs items={crumbs} prefetch={false} />
          <header className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h1 className={pageTitle}>{company} substantial holders</h1>
              <p className={eyebrow}>ASX:{code} register</p>
            </div>
            <p className={lede}>
              Who holds {code} as its ASX substantial holding notices state it: every holder of 5% or more whose notice
              we could read, what that notice states, and how each holding stepped from notice to notice. Index fund
              files and super fund option disclosures sit beside the notices, never added to them.
            </p>
            <OwnershipPlate items={plateItems(data, indexFiles, superSpan)} />
            {summary.hasShortPct && STOCK_CODE_PATTERN.test(code) ? <StockLinks code={code} /> : null}
          </header>

          {/* A plain wrapper: the readout below is the one region this block names "The register". */}
          <div className="space-y-3">
            <h2 id="register" className={SECTION_HEADING}>
              The register
            </h2>
            <RegisterReadout
              code={code}
              disclosed={holders > 0 ? disclosedOf(summary) : NOT_AVAILABLE}
              interests={interestsOf(summary)}
              holders={holders}
              asOf={data.asOf}
              indexPct={summary.hasIndexPct ? formatPct(summary.indexPct, { digits: 2 }) : null}
              indexFiles={indexFiles.files}
              indexFrom={indexFiles.from}
              indexTo={indexFiles.to}
              superOptions={summary.superOptions}
              superValue={summary.hasSuperValue ? formatAmount(summary.superValueAud, "AUD") : null}
              superFrom={superSpan.from}
              superTo={superSpan.to}
              segments={summary.byKind}
              total={summary.disclosedPct}
            />
          </div>

          <section className="space-y-3" aria-labelledby="holders">
            <h2 id="holders" className={SECTION_HEADING}>
              Substantial holders
            </h2>
            {holders === 0 && drawn.lanes.length > 0 ? (
              <p className="text-sm tabular-nums">{ceasedSentence(code, data.historyTotal)}</p>
            ) : null}
            {drawn.lanes.length > 0 ? (
              <HolderLanes
                lanes={drawn.lanes}
                from={drawn.from}
                to={drawn.to}
                yearLabels={drawn.yearLabels}
                truncated={drawn.truncated}
                code={code}
                historyTotal={data.historyTotal}
                withheldListed={withheld}
              />
            ) : (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  No substantial holder notices read for this stock. A holder of 5% or more may still exist: a notice
                  never lodged is not on record, and a notice we could not read is withheld.{" "}
                  <Link
                    href="/ownership#method"
                    prefetch={false}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    How ownership is read →
                  </Link>
                </p>
                {withheld > 0 ? <p className="tabular-nums">{withheldSentence(withheld, code)}</p> : null}
              </div>
            )}
          </section>

          <section className="space-y-3" aria-labelledby="funds">
            <h2 id="funds" className={SECTION_HEADING}>
              Index funds and super options
            </h2>
            <StockFundTable rows={data.fundHoldings} code={code} />
          </section>

          <section className="space-y-3" aria-labelledby="notices">
            <h2 id="notices" className={SECTION_HEADING}>
              Notices
            </h2>
            {data.historyTotal > 0 ? (
              <p className="text-sm">
                <Link
                  href={allNotices}
                  rel="nofollow"
                  prefetch={false}
                  className="hit-target text-primary underline-offset-4 hover:underline"
                >
                  All notices for {code} →
                </Link>
              </p>
            ) : null}
            {data.historyTotal > data.history.length ? (
              <p className="text-sm tabular-nums text-muted-foreground">
                {`The latest ${data.history.length.toLocaleString("en-AU")} of ${data.historyTotal.toLocaleString("en-AU")} notices read for ${code}.`}
              </p>
            ) : null}
            <NoticeTable
              notices={data.history}
              showStock={false}
              showHolder
              caption={`${code}'s substantial holding notices`}
              limit={NOTICES_SHOWN}
              onRecord={data.historyTotal}
            />
          </section>

          <section className="space-y-3" aria-labelledby="method">
            <h2 id="method" className={SECTION_HEADING}>
              Sources and method
            </h2>
            <OwnershipSourceLines lines={sourceLines(code, data, superSpan, indexFiles)} />
            {holders > 0 && withheld > 0 ? (
              <p className="text-xs tabular-nums text-muted-foreground">{withheldSentence(withheld, code)}</p>
            ) : null}
            <OwnershipMethodology className="max-w-[80ch]" />
            <p className="text-xs text-muted-foreground">
              <OwnershipReportError subject={`Ownership data: ${code} register`} />
            </p>
            <p className="text-sm">
              <Link href="/ownership" prefetch={false} className="text-primary underline-offset-4 hover:underline">
                Who owns the ASX →
              </Link>
            </p>
          </section>
        </div>
      </DashboardLayout>
    </>
  );
}
