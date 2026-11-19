import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  AnnualRanks,
  AnnualRankSummary,
} from "~/@/components/ownership/traders/annual-ranks";
import { JsonLd } from "~/@/components/seo/json-ld";
import { FilingHistory } from "~/@/components/ownership/traders/filing-history";
import { FollowInvestor } from "~/@/components/ownership/traders/investor-follow";
import { TraderPublicAccounts } from "~/@/components/ownership/traders/trader-public-accounts";
import {
  InvestorPhotoCredit,
  InvestorProfileHeader,
} from "~/@/components/ownership/traders/investor-profile-header";
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
import { sectionTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getStockOwnership } from "~/app/actions/getOwnership";
import { publicAccounts } from "~/server/traders/public-accounts";
import {
  investorPageMetadata,
  investorPageSchema,
  professionalRecord,
} from "~/server/traders/profile-metadata";

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const person = investorBySlug((await params).slug);
  if (!person) notFound();
  return investorPageMetadata(person);
}

const link = "text-primary underline underline-offset-4 hover:decoration-2";

export default async function AustralianInvestorPage({ params }: Props) {
  const person = investorBySlug((await params).slug);
  if (!person) notFound();
  const registers = await Promise.all(
    person.filings.map(async (f) =>
      readFilingIdentity(f, await getStockOwnership(f.code)),
    ),
  );
  if (registers.some((r) => !r.asOf)) await bailOnEmptyRender();
  registers.sort((a, b) =>
    (b.current?.date ?? "").localeCompare(a.current?.date ?? ""),
  );
  const history = registers
    .flatMap((r) => r.history)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (b.source ?? "").localeCompare(a.source ?? ""),
    );
  const ranks = ranksForInvestor(person.slug);
  const annualOnly =
    ranks.length > 0 &&
    registers.every(
      (r) => r.filing.basis === "annual" && !r.current && !r.history.length,
    );
  const accounts = publicAccounts[person.slug];
  const record = professionalRecord(person);
  return (
    <DashboardLayout>
      <JsonLd
        data={investorPageSchema(
          person,
          registers.flatMap((r) =>
            r.current?.source ? [r.current.source] : [],
          ),
        )}
      />
      <div className="mx-auto min-w-0 max-w-6xl space-y-5 max-[359px]:-mx-5 sm:space-y-6">
        <InvestorProfileHeader
          person={person}
          description={person.description}
          record={record}
          crumbs={[
            { label: "Ownership", href: "/ownership" },
            { label: "Traders", href: TRADERS_PATH },
            { label: "Australian investors", href: AUSTRALIAN_INVESTORS_PATH },
            { label: person.name, href: investorHref(person.slug) },
          ]}
        >
          <FollowInvestor showInbox slug={person.slug} name={person.name} />
        </InvestorProfileHeader>
        <div
          className={
            accounts
              ? "grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-8"
              : "min-w-0"
          }
        >
          <div
            id="investor-filings"
            tabIndex={-1}
            role="region"
            aria-label="Investor filings"
            className="min-w-0 scroll-mt-32 space-y-6"
          >
            {registers.length > 0 && !annualOnly && (
              <section
                id="voting-interests"
                tabIndex={-1}
                aria-label="Disclosed voting interests"
                className="scroll-mt-32 space-y-3"
              >
                <h2 className={sectionTitle}>Disclosed voting interests</h2>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  {record
                    ? person.description
                    : "Includes the associates named in each notice. Voting power can also change when the issuer’s share count changes."}
                </p>
                <div
                  aria-hidden="true"
                  className="hidden grid-cols-[minmax(0,1.8fr)_minmax(9rem,0.65fr)_minmax(14rem,0.85fr)] gap-x-5 border-t bg-muted/40 py-2 text-xs text-muted-foreground md:grid"
                >
                  <span>Issuer / filed name</span>
                  <span className="text-right">Reported voting power</span>
                  <span className="pl-4">Latest source</span>
                </div>
                <ul className="!mt-0 divide-y border-y">
                  {registers.map(({ filing, company, asOf, current }) => (
                    <li
                      key={filing.code}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 py-3.5 md:grid-cols-[minmax(0,1.8fr)_minmax(9rem,0.65fr)_minmax(14rem,0.85fr)]"
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
                        <p className="my-0.5 text-pretty break-words text-xs text-muted-foreground">
                          {current?.name ?? filing.filedName}
                        </p>
                        {filing.source !== current?.source && (
                          <a
                            href={filing.source}
                            className={`inline-flex min-h-6 items-center text-xs ${link}`}
                          >
                            {filing.sourceLabel ??
                              (filing.basis === "annual"
                                ? "Annual register naming this shareholder"
                                : "Filing establishing this link")}
                          </a>
                        )}
                      </div>
                      <div
                        className={
                          current
                            ? "text-sm md:text-right"
                            : "text-sm max-md:col-span-2 md:text-right"
                        }
                      >
                        {current ? (
                          <>
                            <span className="block text-xs text-muted-foreground md:sr-only">
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
                        {current &&
                          (current.source ? (
                            <a
                              className={`inline-flex min-h-10 flex-wrap items-center gap-x-1 ${link}`}
                              href={current.source}
                              aria-label={`${current.form ? "Form " + current.form : "ASX notice"} · ${current.date}, ${filing.code} filing`}
                            >
                              {current.form
                                ? `Form ${current.form}`
                                : "ASX notice"}{" "}
                              ·{" "}
                              <time
                                dateTime={current.date}
                                className="whitespace-nowrap"
                              >
                                {current.date}
                              </time>
                            </a>
                          ) : (
                            <p>
                              Filed{" "}
                              <time dateTime={current.date}>
                                {current.date}
                              </time>
                            </p>
                          ))}
                        {asOf && (
                          <p className="mt-1 text-muted-foreground">
                            Register read to{" "}
                            <time dateTime={asOf} className="whitespace-nowrap">
                              {asOf}
                            </time>
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {(history.length > 0 || ranks.length > 0) && (
                  <nav
                    aria-label="Related investor records"
                    className="flex flex-wrap gap-x-5 text-xs"
                  >
                    {history.length > 0 && (
                      <a
                        href="#filing-history"
                        className={`inline-flex min-h-10 items-center ${link}`}
                      >
                        Filing history ({history.length}) ↓
                      </a>
                    )}
                    {ranks.length > 0 && (
                      <a
                        href="#annual-register"
                        className={`inline-flex min-h-10 items-center ${link}`}
                      >
                        Annual register ↓
                      </a>
                    )}
                  </nav>
                )}
              </section>
            )}
            {ranks.length > 0 && (
              <section
                id="annual-register"
                tabIndex={-1}
                aria-label="Annual shareholder ranks"
                className="min-w-0 scroll-mt-32 space-y-3"
              >
                <h2 className={sectionTitle}>Annual shareholder ranks</h2>
                {annualOnly &&
                  record &&
                  person.filings.some((f) => f.sourceLabel) && (
                    <p className="max-w-3xl text-sm text-muted-foreground">
                      {person.description}
                    </p>
                  )}
                <AnnualRankSummary rows={ranks} />
                <AnnualRanks rows={ranks} />
                {annualOnly && (
                  <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                    {registers.map(({ filing, asOf, historyLimited }) => (
                      <li key={filing.code}>
                        {filing.sourceLabel && (
                          <>
                            <a href={filing.source} className={link}>
                              {filing.sourceLabel}
                            </a>
                            {" · "}
                          </>
                        )}
                        <Link
                          href={registerHref(filing.code)}
                          className={link}
                          prefetch={false}
                        >
                          {filing.code} notice register
                        </Link>
                        {" · "}
                        {asOf ? (
                          <>
                            No matching notice in{" "}
                            {historyLimited
                              ? "the latest 100 releases"
                              : "the records"}{" "}
                            through{" "}
                            <time dateTime={asOf} className="whitespace-nowrap">
                              {asOf}
                            </time>
                            .
                          </>
                        ) : (
                          "Register temporarily unavailable."
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {registers.length > 0 && !annualOnly && (
              <section
                id="filing-history"
                tabIndex={-1}
                aria-label="Filing history"
                className="scroll-mt-32 space-y-3"
              >
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
          </div>
          {accounts && (
            <aside className="min-w-0 space-y-5 lg:border-l lg:pl-5">
              <TraderPublicAccounts
                trader={person}
                joint={!!person.jointNames}
              />
              <InvestorPhotoCredit slug={person.slug} />
            </aside>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
