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
      <div className="mx-auto min-w-0 max-w-6xl space-y-8">
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
          <FollowInvestor slug={person.slug} name={person.name} />
        </header>
        {registers.length > 0 && (
          <section
            aria-label="Disclosed voting interests"
            className="space-y-3"
          >
            <h2 className={sectionTitle}>Disclosed voting interests</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Each percentage belongs to the filer and associates identified in
              that notice. A change in voting power can also follow a change in
              the company’s shares on issue.
            </p>
            <ul className="divide-y border-y">
              {registers.map(({ filing, company, asOf, current }) => (
                <li
                  key={filing.code}
                  className="grid gap-2 py-4 sm:grid-cols-[1fr_auto]"
                >
                  <div>
                    <Link
                      href={registerHref(filing.code)}
                      prefetch={false}
                      className={link}
                    >
                      {filing.code}
                      {company && ` · ${company}`}
                    </Link>
                    <p className="mt-1 text-sm">
                      {current?.name ?? filing.filedName}
                    </p>
                    <a href={filing.source} className={`text-xs ${link}`}>
                      {filing.basis === "annual"
                        ? "Annual register naming this shareholder"
                        : "Filing establishing this link"}
                    </a>
                  </div>
                  <div className="text-sm sm:text-right">
                    {current ? (
                      <>
                        <p className="font-semibold tabular-nums">
                          {investorPct(current.pct)}
                        </p>
                        <p>
                          Filed {current.date}
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
                      </>
                    ) : (
                      <p>
                        {asOf
                          ? "No current matching substantial interest in this register."
                          : "Company register temporarily unavailable."}
                      </p>
                    )}
                    {asOf && (
                      <p className="text-xs text-muted-foreground">
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
