import { type Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";

export const metadata: Metadata = {
  title: "Methodology — How Shorted Processes ASIC Short Position Data",
  description:
    "How Shorted.com.au ingests, validates, and publishes ASIC short position data for ASX-listed securities. T+4 delay, data coverage, refresh cadence, calculation methods, and known limitations.",
  keywords: [
    "Shorted methodology",
    "ASIC short position methodology",
    "how Shorted calculates short interest",
    "T+4 delay explained",
    "ASX short position reporting",
    "ASIC data processing",
    "reportable short position threshold",
    "percent of total product in issue",
  ],
  openGraph: {
    title:
      "Methodology — How Shorted Processes ASIC Short Position Data",
    description:
      "Data sources, T+4 delay, calculation methods, and limitations behind Shorted.com.au's ASIC short position tracking.",
    url: `${siteConfig.url}/methodology`,
    siteName: siteConfig.name,
    type: "article",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Shorted methodology — ASIC short position data processing",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title:
      "Methodology — How Shorted Processes ASIC Short Position Data",
    description:
      "Data sources, T+4 delay, calculation methods, and limitations.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/methodology`,
    languages: {
      "en-AU": `${siteConfig.url}/methodology`,
      "en": `${siteConfig.url}/methodology`,
      "x-default": `${siteConfig.url}/methodology`,
    },
  },
};

const articleSchema = {
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline:
    "Methodology: How Shorted Processes ASIC Short Position Data",
  description:
    "Complete reference for how Shorted.com.au ingests, validates, and publishes ASIC short position data for ASX-listed securities.",
  url: `${siteConfig.url}/methodology`,
  datePublished: "2026-04-22",
  dateModified: "2026-04-22",
  author: {
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
  },
  publisher: {
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    logo: {
      "@type": "ImageObject",
      url: siteConfig.ogImage,
    },
  },
  about: {
    "@type": "Dataset",
    name: "ASIC Short Position Reports",
    description:
      "Daily aggregated net short position reports for ASX-listed securities, published by the Australian Securities and Investments Commission (ASIC) under Regulatory Guide 196. Each record covers reported short positions, total product in issue, and the percentage of issued capital held short. Coverage begins 1 June 2010.",
    url: "https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports/",
    creator: {
      "@type": "GovernmentOrganization",
      name: "Australian Securities and Investments Commission",
      alternateName: "ASIC",
      url: "https://asic.gov.au",
    },
    temporalCoverage: "2010-06-01/..",
    license: "https://creativecommons.org/licenses/by/4.0/",
  },
  mainEntityOfPage: `${siteConfig.url}/methodology`,
};

export default function MethodologyPage() {
  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData
        items={[{ label: "Methodology", href: "/methodology" }]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "Where does Shorted.com.au get its short position data?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "All short position data is sourced directly from the Australian Securities and Investments Commission (ASIC) short position reports. ASIC aggregates individual net short position reports submitted under section 1020AC of the Corporations Act 2001 (Cth) and publishes daily totals for ASX-listed securities.",
                },
              },
              {
                "@type": "Question",
                name: "What is the T+4 delay on ASIC short position data?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "ASIC publishes short position data with a four trading day delay, mandated by Regulatory Guide 196. A position held at close of business on day T appears in ASIC's dataset on T+4. This delay is outside Shorted's control; every Shorted page shows the actual ASIC report date, not the date we received it.",
                },
              },
              {
                "@type": "Question",
                name: "How is short interest percentage calculated?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Short interest % = reported short positions divided by total product in issue, multiplied by 100. Both numerator and denominator come directly from ASIC; Shorted republishes the percentage as reported, without recalculation.",
                },
              },
              {
                "@type": "Question",
                name: "What is the reporting threshold for ASIC short positions?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Short positions are only reportable above 0.01% of a company's total issued capital or A$100,000, whichever is less. Positions below this threshold are not included in ASIC's published dataset and therefore do not appear on Shorted.",
                },
              },
              {
                "@type": "Question",
                name: "How often does Shorted refresh data?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Our pipeline runs once per ASX trading day, typically within 60 minutes of ASIC publishing a new daily report. Stock pages, screener, top-shorts ranking, and the industry treemap all refresh automatically.",
                },
              },
              {
                "@type": "Question",
                name: "How far back does Shorted's coverage go?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Historical coverage begins 1 June 2010, when ASIC first published daily aggregated short position data following post-GFC reforms. All ASX-listed securities included in the ASX Approved Short Sell Products list are covered.",
                },
              },
            ],
          }),
        }}
      />
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <Breadcrumbs items={[{ label: "Methodology", href: "/methodology" }]} />
        </div>

        <article className="prose prose-neutral dark:prose-invert max-w-none">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Methodology
          </h1>
          <p className="mt-2 text-muted-foreground">
            How Shorted ingests, validates, and publishes short position data
            for ASX-listed securities. Updated 22 April 2026.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">Data source</h2>
          <p>
            All short position data published on Shorted.com.au is sourced
            directly from the{" "}
            <a
              href="https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Australian Securities and Investments Commission (ASIC) short
              position reports
            </a>
            . ASIC aggregates individual net short position reports submitted
            by holders under section 1020AC of the{" "}
            <em>Corporations Act 2001</em> (Cth) and publishes daily totals
            broken down by ASX-listed product.
          </p>
          <p>
            Historical price data is sourced from ASX end-of-day feeds. Company
            metadata (name, industry, sector, market capitalisation) is
            maintained in our own database and periodically enriched from
            public sources including ASX company announcements, ASIC company
            records, and third-party reference data.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">The T+4 delay</h2>
          <p>
            ASIC publishes short position data with a four trading day delay.
            A position held at the close of business on day <strong>T</strong>{" "}
            appears in ASIC's published dataset on day <strong>T+4</strong>.
            This delay is mandated by ASIC Regulatory Guide 196 and is not
            within Shorted's control. Every page on Shorted shows the
            report date the data corresponds to, not the date we received it.
          </p>
          <p>
            Practical consequence: the "latest" short position figure on any
            stock page is a snapshot as of four trading days ago. Market-
            moving events inside the T+4 window are not yet reflected.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            Reporting threshold
          </h2>
          <p>
            Short positions are only reportable above a threshold set out in
            ASIC Regulatory Guide 196: <strong>0.01%</strong> of a company's
            total issued capital, or <strong>A$100,000</strong>, whichever is
            less. Positions below this threshold are not included in ASIC's
            published dataset and therefore do not appear on Shorted.
            A stock with "0%" or "—" on our interface means there were no
            reportable short positions, not necessarily that no short
            positions exist.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            How short interest % is calculated
          </h2>
          <p>
            The short interest percentage we display is the ASIC-reported
            figure, calculated as:
          </p>
          <pre className="mt-4 rounded-md bg-muted p-4 text-sm overflow-x-auto">
{`short_interest_% = reported_short_positions / total_product_in_issue × 100`}
          </pre>
          <p>
            Both the numerator (aggregated reportable short positions) and
            the denominator (total shares on issue) are supplied by ASIC. We
            do not recompute the percentage; we republish it as reported so
            our figures match ASIC's source data exactly.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            Derived metrics
          </h2>
          <p>
            Where Shorted displays derived metrics not published by ASIC, the
            calculation is stated below:
          </p>
          <ul>
            <li>
              <strong>Days to cover</strong> = reported short positions ÷
              average daily trading volume (20-day simple average).
            </li>
            <li>
              <strong>1-week delta</strong> = current short % − short % on
              the ASIC report five trading days prior.
            </li>
            <li>
              <strong>Industry aggregates</strong> = share-weighted average
              of short % across stocks classified in the same industry, using
              issued-shares weighting unless stated otherwise.
            </li>
          </ul>

          <h2 className="mt-10 text-2xl font-semibold">Refresh cadence</h2>
          <p>
            Our pipeline runs once per ASX trading day, typically within 60
            minutes of ASIC publishing a new daily report. Stock pages,
            screener, top-shorts ranking, and industry treemap refresh with
            the new data automatically. Weekly reports generate each Monday
            morning Australian Eastern Time using the previous week's ASIC
            reports.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">Coverage</h2>
          <p>
            Shorted covers all ASX-listed securities included in the ASX
            Approved Short Sell Products list and therefore eligible for
            short reporting under RG 196. Historical coverage begins 1 June
            2010, when ASIC first published daily aggregated short position
            data following post-GFC reforms.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            Corrections and restatements
          </h2>
          <p>
            ASIC occasionally restates historical short position figures.
            When a restatement is published we overwrite the affected dates
            in our database and do not retain the superseded values, so
            Shorted always reflects the current ASIC record. If you believe
            a figure on our site is incorrect, email{" "}
            <a href="mailto:support@shorted.com.au">support@shorted.com.au</a>{" "}
            with the stock code and date and we will investigate.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">Limitations</h2>
          <ul>
            <li>
              Short positions below the 0.01% / A$100,000 threshold are not
              reported and cannot be inferred from our data.
            </li>
            <li>
              The T+4 delay means data is not real-time and should not be
              used to time trades.
            </li>
            <li>
              Ticker changes, consolidations, and delistings can interrupt
              time-series continuity; we attempt to maintain a stable stock
              code mapping but cannot guarantee historical joins in all
              cases.
            </li>
            <li>
              AI-generated commentary (weekly reports, enrichment summaries)
              is derived from the underlying data and public sources and
              should be treated as analysis, not advice — see our{" "}
              <Link href="/disclaimer">disclaimer</Link>.
            </li>
          </ul>

          <h2 className="mt-10 text-2xl font-semibold">References</h2>
          <ul>
            <li>
              <a
                href="https://asic.gov.au/regulatory-resources/markets/short-selling/"
                target="_blank"
                rel="noopener noreferrer"
              >
                ASIC — Short selling (overview)
              </a>
            </li>
            <li>
              <a
                href="https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports/"
                target="_blank"
                rel="noopener noreferrer"
              >
                ASIC — Daily short position reports
              </a>
            </li>
            <li>
              <a
                href="https://asic.gov.au/regulatory-resources/find-a-document/regulatory-guides/rg-196-short-selling/"
                target="_blank"
                rel="noopener noreferrer"
              >
                ASIC Regulatory Guide 196: Short selling
              </a>
            </li>
            <li>
              <a
                href="https://www.legislation.gov.au/C2004A00818/latest/text"
                target="_blank"
                rel="noopener noreferrer"
              >
                Corporations Act 2001 (Cth), Part 7.9 Division 5A
              </a>
            </li>
          </ul>

          <p className="mt-10 text-sm text-muted-foreground">
            Questions about methodology? Email{" "}
            <a href="mailto:support@shorted.com.au">support@shorted.com.au</a>.
            See also our <Link href="/disclaimer">disclaimer</Link>.
          </p>
        </article>
      </div>
    </main>
  );
}
