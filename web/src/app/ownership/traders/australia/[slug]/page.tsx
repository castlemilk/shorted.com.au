import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { AnnualRanks } from "~/@/components/ownership/traders/annual-ranks";
import { FilingHistory } from "~/@/components/ownership/traders/filing-history";
import { FollowInvestor } from "~/@/components/ownership/traders/investor-follow";
import { TraderPublicAccounts } from "~/@/components/ownership/traders/trader-public-accounts";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  AUSTRALIAN_INVESTORS_PATH,
  investorBySlug,
  investorHref,
  investorPct,
  ranksForInvestor,
} from "~/@/lib/ownership/australian-investors";
import { readFilingIdentity } from "~/@/lib/ownership/investor-disclosures";
import { registerHref } from "~/@/lib/ownership/kinds";
import { TRADERS_PATH } from "~/@/lib/ownership/traders";
import { lede, pageTitle, sectionTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getStockOwnership } from "~/app/actions/getOwnership";
import { publicAccounts } from "~/server/traders/public-accounts";

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const person = investorBySlug((await params).slug);
  if (!person) notFound();
  return {
    title: `${person.name} · ASX ownership disclosures`,
    description: person.description,
    alternates: {
      canonical: `https://shorted.com.au${investorHref(person.slug)}`,
    },
  };
}

const link = "text-primary underline-offset-4 hover:underline";

export default async function AustralianInvestorPage({ params }: Props) {
  const person = investorBySlug((await params).slug);
  if (!person) notFound();
  const registers = await Promise.all(
    person.filings.map(async (f) =>
      readFilingIdentity(f, await getStockOwnership(f.code)),
    ),
  );
  if (registers.some((r) => !r.asOf)) await bailOnEmptyRender();
  const history = registers
    .flatMap((r) => r.history)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (b.source ?? "").localeCompare(a.source ?? ""),
    );
  const ranks = ranksForInvestor(person.slug);
  return (
    <DashboardLayout>
      <div className="mx-auto min-w-0 max-w-6xl space-y-5 sm:space-y-6">
        <Breadcrumbs
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Traders", href: TRADERS_PATH },
            { label: "Australian investors", href: AUSTRALIAN_INVESTORS_PATH },
            { label: person.name, href: investorHref(person.slug) },
          ]}
          prefetch={false}
        />
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className={pageTitle}>{person.name}</h1>
            <p className={lede}>{person.description}</p>
          </div>
          <FollowInvestor showInbox slug={person.slug} name={person.name} />
        </header>
        {registers.length > 0 && (
          <section
            aria-label="Disclosed voting interests"
            className="space-y-3"
          >
            <h2 className={sectionTitle}>Disclosed voting interests</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Includes the associates named in each notice. Voting power can
              also change when the issuer’s share count changes.
            </p>
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,1.8fr)_minmax(9rem,0.65fr)_minmax(12rem,0.8fr)] gap-x-5 border-t bg-muted/40 py-2 text-xs text-muted-foreground md:grid"
            >
              <span>Issuer / filed name</span>
              <span className="text-right">Reported voting power</span>
              <span className="pl-4">Latest source</span>
            </div>
            <ul className="!mt-0 divide-y border-y">
              {registers.map(({ filing, company, asOf, current }) => (
                <li
                  key={filing.code}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 py-3.5 md:grid-cols-[minmax(0,1.8fr)_minmax(9rem,0.65fr)_minmax(12rem,0.8fr)]"
                >
                  <div className="min-w-0 max-md:col-span-2">
                    <Link
                      href={registerHref(filing.code)}
                      prefetch={false}
                      className={link}
                    >
                      {filing.code}
                      {company && ` · ${company}`}
                    </Link>
                    <p className="my-0.5 break-words text-xs text-muted-foreground">
                      {current?.name ?? filing.filedName}
                    </p>
                    <a href={filing.source} className={`text-xs ${link}`}>
                      {filing.basis === "annual"
                        ? "Annual register naming this shareholder"
                        : "Filing establishing this link"}
                    </a>
                  </div>
                  <div className="text-sm md:text-right">
                    {current ? (
                      <>
                        <span className="block text-xs text-muted-foreground md:hidden">
                          Reported voting power
                        </span>
                        <p className="text-xl font-semibold leading-tight tabular-nums">
                          {investorPct(current.pct)}
                        </p>
                        {current.votes && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {current.votes} votes
                          </p>
                        )}
                      </>
                    ) : (
                      <p>
                        {asOf
                          ? "No current matching substantial interest in this register."
                          : "Company register temporarily unavailable."}
                      </p>
                    )}
                  </div>
                  <div className="text-xs md:border-l md:pl-4">
                    {current && (
                      <p>
                        Filed{" "}
                        <time dateTime={current.date}>{current.date}</time>
                        {current.source && (
                          <>
                            {" "}
                            ·{" "}
                            <a className={link} href={current.source}>
                              Notice
                            </a>
                          </>
                        )}
                      </p>
                    )}
                    {asOf && (
                      <p className="mt-1 text-muted-foreground">
                        Register read to {asOf}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {ranks.length > 0 && (
          <section
            aria-label="Annual shareholder ranks"
            className="min-w-0 space-y-3"
          >
            <h2 className={sectionTitle}>Annual shareholder ranks</h2>
            <p className="text-sm text-muted-foreground">
              Registered accounts at the date of each annual report. Each entry
              retains its printed rank in the issuer’s top 20.
            </p>
            <AnnualRanks rows={ranks} />
          </section>
        )}
        {registers.length > 0 && (
          <section aria-label="Filing history" className="space-y-3">
            <h2 className={sectionTitle}>Filing history</h2>
            {history.length > 0 ? (
              <FilingHistory rows={history} />
            ) : (
              <p className="text-sm">
                No matching notices in the available filing history.
              </p>
            )}
            {registers.some((r) => !r.asOf) && (
              <p className="text-sm text-muted-foreground">
                Some company filing history is currently unavailable.
              </p>
            )}
            {registers.some((r) => r.historyLimited) && (
              <p className="text-sm text-muted-foreground">
                History covers the latest 100 notices per issuer. Earlier
                releases may be available on the issuer register.
              </p>
            )}
          </section>
        )}
        {publicAccounts[person.slug] && (
          <TraderPublicAccounts
            trader={person}
            path={investorHref(person.slug)}
            joint={person.slug === "wesley-and-emma-maas"}
          />
        )}
      </div>
    </DashboardLayout>
  );
}
