import type { Metadata } from "next";
import styles from "./profile.module.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ExternalLinkSymbol } from "~/@/components/ownership/external-link-glyph";
import { NoticeTable } from "~/@/components/ownership/notice-table";
import { SubstantialHoldingsTable } from "~/@/components/ownership/ownership-tables";
import { SecPositions } from "~/@/components/ownership/traders/sec-positions";
import { TraderPublicAccounts } from "~/@/components/ownership/traders/trader-public-accounts";
import {
  InvestorPhotoCredit,
  InvestorProfileHeader,
} from "~/@/components/ownership/traders/investor-profile-header";
import {
  defaultNoticeQuery,
  NOTICE_WINDOW_ALL,
  serialiseNoticeParams,
} from "~/@/lib/ownership/query";
import { holdingRow } from "~/@/lib/ownership/rows";
import {
  directorHref,
  TRADERS,
  TRADERS_PATH,
  traderHref,
} from "~/@/lib/ownership/traders";
import { eyebrow, sectionTitle } from "~/@/lib/typography";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { getInstitutionOrNotFound } from "~/app/actions/getOwnership";
import { NotFoundError } from "~/app/actions/withRetry";
import { getSecHoldings } from "~/server/traders/get-sec-holdings";

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

type Props = { params: Promise<{ slug: string }> };
const link =
  "text-sm text-primary underline underline-offset-4 hover:decoration-2";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const person = TRADERS.find((p) => p.slug === slug);
  if (!person) return { title: "Trader not found", robots: { index: false } };
  return {
    title: `${person.name} | Disclosed holdings`,
    description: `Explore ${person.name}’s connection to ${person.firm} and see the firm’s dated disclosures and source filings.`,
    alternates: { canonical: `https://shorted.com.au${traderHref(person)}` },
  };
}

async function AsxPositions({ holder }: { holder: string }) {
  let answer;
  try {
    answer = await getInstitutionOrNotFound(holder);
  } catch (error) {
    if (error instanceof NotFoundError)
      return <p>This firm is currently outside the ownership register.</p>;
    throw error;
  }
  // A transport failure must preserve the previous ISR page, including its actual holdings.
  if (!answer?.institution)
    throw new Error(`Ownership disclosures are unavailable for ${holder}`);
  const { institution, positions, notices } = answer;
  const latest = notices[0];
  const latestSource = safeExternalHref(latest?.announcementUrl);
  const feed = serialiseNoticeParams({
    ...defaultNoticeQuery(),
    institutionSlug: holder,
    windowDays: NOTICE_WINDOW_ALL,
  });
  return (
    <div className="min-w-0 space-y-8">
      <ExternalLinkSymbol />
      <section className="space-y-3">
        <h2 className={sectionTitle}>Disclosed voting interests</h2>
        <p className="text-sm text-muted-foreground">
          Reported by {institution.name}, largest voting interest first.
        </p>
        {latest && (
          <a
            className={`inline-flex min-h-10 items-center gap-x-1 ${link}`}
            href={latestSource ?? "#recent-holder-notices"}
          >
            Latest notice · {latest.stockCode} ·{" "}
            <time dateTime={latest.announcedOn}>{latest.announcedOn}</time>
          </a>
        )}
        {positions.length ? (
          <SubstantialHoldingsTable
            rows={positions.map(holdingRow)}
            holder={institution.name}
            caption={`Voting interests attributed to ${institution.name}`}
          />
        ) : (
          <p className="rounded-md border p-4 text-sm">
            No current substantial interest appears in the notices read for this
            firm.
          </p>
        )}
      </section>
      <section
        id="recent-holder-notices"
        tabIndex={-1}
        className={`scroll-mt-32 space-y-3 ${styles.notices}`}
      >
        <h2 className={sectionTitle}>Recent holder notices</h2>
        <NoticeTable
          notices={notices}
          showHolder
          caption={`ASX notices associated with ${institution.name}`}
          limit={5}
          onRecord={institution.notices}
        />
        <Link
          prefetch={false}
          href={`/ownership/notices?${feed.toString()}`}
          className={`block w-fit ${link}`}
        >
          Explore the firm’s notice history →
        </Link>
      </section>
    </div>
  );
}

export default async function TraderPage({ params }: Props) {
  const { slug } = await params;
  const person = TRADERS.find((p) => p.slug === slug);
  if (!person) notFound();
  const { reporting, director } = person;
  const sec =
    reporting.market === "US" ? await getSecHoldings(reporting.cik) : null;
  const crumbs = [
    { label: "Ownership", href: "/ownership" },
    { label: "Traders", href: TRADERS_PATH },
    { label: person.name, href: traderHref(person) },
  ];
  return (
    <DashboardLayout>
      <div className="mx-auto min-w-0 max-w-6xl space-y-4 max-[359px]:-mx-5 sm:space-y-6">
        <InvestorProfileHeader
          person={person}
          crumbs={crumbs}
          description={`${person.role} · ${person.firm}`}
        />
        <div className="grid min-w-0 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div
            id="investor-filings"
            tabIndex={-1}
            role="region"
            aria-label="Investor filings"
            className="min-w-0 scroll-mt-32 lg:col-start-1 lg:row-start-1"
          >
            {reporting.market === "US" && sec ? (
              <SecPositions cik={reporting.cik} data={sec} />
            ) : (
              reporting.market === "ASX" && (
                <AsxPositions holder={reporting.holder} />
              )
            )}
          </div>
          <aside className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-1 lg:border-l lg:pl-5">
            <TraderPublicAccounts trader={person} />
            <section
              aria-label="Reporting manager"
              className="space-y-3 border-t pt-4"
            >
              <h2 className={eyebrow}>Reporting manager</h2>
              <p className="text-base font-semibold">{person.firm}</p>
              <p className="text-sm text-muted-foreground">
                {person.firm} reports these holdings. Personal positions require
                a separately named filing.
              </p>
              <ul className="space-y-2">
                <li>
                  <a className={link} href={person.roleSource}>
                    Person and firm source ↗
                  </a>
                </li>
                <li>
                  {reporting.market === "ASX" ? (
                    <Link
                      prefetch={false}
                      className={link}
                      href={`/ownership/${reporting.holder}`}
                    >
                      Firm ownership profile →
                    </Link>
                  ) : (
                    <a
                      className={link}
                      href={`https://www.sec.gov/edgar/browse/?CIK=${reporting.cik}`}
                    >
                      All SEC filings ↗
                    </a>
                  )}
                </li>
              </ul>
              {director && (
                <div className="space-y-2 border-t pt-3">
                  <h3 className={eyebrow}>Director disclosures</h3>
                  <Link
                    prefetch={false}
                    className={link}
                    href={directorHref(director.code, director.name)}
                  >
                    View {director.name} at ASX:{director.code} →
                  </Link>
                  <p>
                    <a className={link} href={director.source}>
                      Named Appendix 3Y filing ↗
                    </a>
                  </p>
                </div>
              )}
            </section>
            <InvestorPhotoCredit slug={person.slug} />
          </aside>
        </div>
      </div>
    </DashboardLayout>
  );
}
