import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { ReportErrorLink } from "@/components/politicians/compliance";
import { AboutThisData } from "@/components/politicians/explorer/about-this-data";
import { DonationsExplorer } from "@/components/politicians/donations-explorer";
import {
  clampDonationsQuery,
  loadDonationsExplorer,
} from "~/app/actions/donationsExplorer";
import { bailOnEmptyRender } from "~/app/actions/config";
import { formatCount } from "@/lib/politics/funding-money";
import { REPORT_ERROR_EMAIL } from "@/lib/report-error";
import { pageTitle, sectionTitle, eyebrow, lede } from "@/lib/typography";

const URL = "https://shorted.com.au/politicians/donations";
const TITLE = "Political Donations and Party Funding — AEC Transparency Register";
const DESCRIPTION =
  "What Australian political parties declared receiving, who the payers were, and which of them are ASX-listed companies, as lodged with the AEC.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    type: "website",
    url: URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Shorted",
    locale: "en_AU",
  },
  twitter: { card: "summary_large_image", creator: "@shorted___" },
};

/**
 * The AEC funding explorer.
 *
 * A SERVER PAGE THAT NEVER READS `searchParams`. This is a static-ISR route, and
 * reading the query string here silently flips it to dynamic and kills the ISR —
 * the trap /price-drops already paid for. Filter state therefore lives in the
 * island below, which re-queries through a server action; the DEFAULT year's
 * bars, payer page and listed-company rail are rendered into this HTML, so a
 * crawler and a reader with JavaScript off still get the real thing.
 *
 * WHY THE METHODOLOGY BAND COMES FIRST. This page publishes amounts beside named
 * parties and named payers, and the single most misleading thing this data can
 * do is look complete. Below the disclosure threshold in force for a year, the
 * source simply has no rows — so a small total is a fact about disclosure, not
 * about funding — and the scheme changes entirely on 1 January 2027. A reader
 * who meets the charts before those two sentences has already misread them, so
 * the band sits above the explorer rather than in a footer.
 *
 * EVERY CAVEAT ON THIS PAGE IS SERVED, NOT WRITTEN HERE. The censoring note, the
 * reform note, the member-coverage note (including the fact that senators'
 * funding returns are not yet linked to member pages) and the
 * verbatim-as-lodged note are response strings from the API's own constants.
 * That is deliberate: one set of words, one place to fix them, and no surface
 * can paraphrase a caveat into a claim the returns do not support.
 *
 * NO AEC LOGO OR MARK APPEARS ANYWHERE ON THIS PAGE. The AEC's copyright terms
 * permit reuse with attribution and forbid anything implying its endorsement; a
 * mark beside our own analysis is exactly that implication. The attribution is
 * a credit line and stays a credit line.
 */
export default async function DonationsPage() {
  // The default view: the latest year held, every party group, the first page.
  const query = await clampDonationsQuery({});
  const page = await loadDonationsExplorer(query);

  // `bailOnEmptyRender` for the same reason the changes page uses it: this is an
  // ISR route, so whatever renders now is BAKED for an hour. A transient failure
  // during a regen would otherwise freeze the outage copy into a static page
  // long after the rpc recovered — honest live, stale within minutes. Bailing
  // keeps the last good page instead.
  if (!page.overviewOk || page.parties.length === 0) bailOnEmptyRender();

  const corpus = page.corpus;
  const yearsCovered =
    corpus && corpus.firstFinancialYearEnd > 0 && corpus.lastFinancialYearEnd > 0
      ? `${corpus.firstFinancialYearEnd - 1}–${corpus.lastFinancialYearEnd}`
      : "";

  return (
    <>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="AEC Transparency Register, Australian Electoral Commission"
        dataFrequency="annual returns published each February, amended continuously"
      />
      <DashboardLayout>
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
          <header className="space-y-3">
            <p className={eyebrow}>
              <Link href="/politicians" className="hover:underline">
                Parliament&rsquo;s Portfolio
              </Link>
            </p>
            <h1 className={pageTitle}>Party funding and declared donations</h1>
            <p className={lede}>
              What registered political parties declared receiving in each financial year, who the
              payers were, and which of those payers are ASX-listed companies — as lodged with the
              Australian Electoral Commission.
            </p>
          </header>

          {/* THE METHODOLOGY BAND, ABOVE THE FIGURES. See the file docblock. */}
          <section
            aria-labelledby="how-to-read-these-figures"
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <h2 id="how-to-read-these-figures" className={sectionTitle}>
              How to read these figures
            </h2>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A <strong>return</strong> is a disclosure form lodged with the AEC. Parties lodge an
              annual return of what they received, paid and owed; party branches itemise the
              receipts above the year&rsquo;s threshold; donors lodge their own return of what
              they gave; and candidates lodge a return after each election. Each of those is a
              separate form, filled in by a different person, and this page keeps them separate.
            </p>
            {page.notes.censoring ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {page.notes.censoring}
              </p>
            ) : null}
            {page.notes.reform ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {page.notes.reform}
              </p>
            ) : null}
            {page.notes.verbatim ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {page.notes.verbatim}
              </p>
            ) : null}
            {page.notes.coverage ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {page.notes.coverage}
              </p>
            ) : null}
            {corpus ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                What is loaded here: <span className="tabular-nums">{formatCount(corpus.partyReturnCount)}</span>{" "}
                party returns, <span className="tabular-nums">{formatCount(corpus.receiptCount)}</span>{" "}
                itemised receipts and{" "}
                <span className="tabular-nums">{formatCount(corpus.donationMadeCount)}</span>{" "}
                donor-declared donations{yearsCovered ? `, covering ${yearsCovered}` : ""}. The
                member layer is far thinner:{" "}
                <span className="tabular-nums">{formatCount(corpus.mpReturnCount)}</span> annual
                member and senator returns exist in the whole corpus, of which{" "}
                <span className="tabular-nums">{formatCount(corpus.mpReturnResolvedCount)}</span>{" "}
                are linked to a member page here, alongside{" "}
                <span className="tabular-nums">
                  {formatCount(corpus.candidateReturnResolvedCount)}
                </span>{" "}
                linked election returns.{" "}
                <span className="tabular-nums">{formatCount(corpus.matchedPayerNameCount)}</span>{" "}
                payer or donor names across the corpus match an ASX listing by exact name or a
                human-verified alias.
              </p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Party funding is not attributable to any individual parliamentarian. Money declared
              as given to a party, a branch or an associated entity appears here and never on a
              member&rsquo;s page.
            </p>
          </section>

          <DonationsExplorer initialPage={page} loadPage={loadDonationsExplorer} />

          <AboutThisData
            sourceLabel="AEC Transparency Register (transparency.aec.gov.au)"
            sourceHref="https://transparency.aec.gov.au/"
            licence={
              page.notes.licence
                ? `${page.notes.licence} — ${page.notes.attribution}`
                : page.notes.attribution
            }
            asAt={page.asAt}
            updateCadence="Annual returns publish each February; the AEC amends them continuously"
            methodologyHref="#how-to-read-these-figures"
            reportErrorHref={`mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(
              "AEC funding data — party funding explorer",
            )}`}
          />

          <footer className="space-y-3 border-t pt-6">
            {/*
              The licence obligation, in its own line rather than folded into a
              caption. CC BY 4.0 requires the Crown-copyright credit; the AEC's
              own terms require that nothing imply its endorsement, which is why
              no AEC mark or logo appears anywhere on this page.
            */}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {page.notes.attribution || "© Commonwealth of Australia — AEC Transparency Register"}
              {page.asAt ? (
                <>
                  , as at{" "}
                  <time dateTime={page.asAt.slice(0, 10)}>
                    {new Date(page.asAt).toLocaleDateString("en-AU", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                      timeZone: "UTC",
                    })}
                  </time>
                </>
              ) : null}
              . Reused under {page.notes.licence || "CC-BY-4.0"}. The AEC does not endorse this
              site or its analysis. <ReportErrorLink surface="AEC party funding" />
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Method: every figure is a sum or a count over returns lodged with the AEC, ordered
              only by an amount the AEC itself published. Nothing here is a ratio, a share, a rank
              or a score, and no figure is adjusted for inflation or restated. Payer names are
              reproduced as lodged; the source is not normalised, so one organisation can appear
              under several spellings, and we group only spellings that normalise identically.
              Payers are linked to an ASX listing on an exact normalised name or a human-verified
              alias only — a name that collides across stock codes is left unlinked entirely.
            </p>
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
