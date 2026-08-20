import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";

export const metadata: Metadata = {
  title: "Disclaimer — General Information, Not Financial Advice",
  description:
    "Shorted.com.au provides general information about ASX short selling based on official ASIC data. It is not financial advice, not a recommendation, and no personal circumstances are considered.",
  keywords: [
    "Shorted disclaimer",
    "not financial advice",
    "general information only",
    "ASX data accuracy",
    "investment disclaimer",
  ],
  openGraph: {
    title: "Disclaimer — General Information, Not Financial Advice",
    description:
      "Terms of reliance for Shorted.com.au content: general information only, not personal financial advice.",
    url: `${siteConfig.url}/disclaimer`,
    siteName: siteConfig.name,
    type: "article",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Shorted disclaimer — not financial advice",
      },
    ],
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Disclaimer — General Information, Not Financial Advice",
    description:
      "Terms of reliance for Shorted.com.au content: general information only, not personal financial advice.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/disclaimer`,
    languages: {
      "en-AU": `${siteConfig.url}/disclaimer`,
      "en": `${siteConfig.url}/disclaimer`,
      "x-default": `${siteConfig.url}/disclaimer`,
    },
  },
};

export default function DisclaimerPage() {
  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData
        items={[{ label: "Disclaimer", href: "/disclaimer" }]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebPage",
            name: "Disclaimer — General Information, Not Financial Advice",
            url: `${siteConfig.url}/disclaimer`,
            description:
              "Terms of reliance for Shorted.com.au content: general information only, not personal financial advice per Corporations Act 2001 s766B.",
            datePublished: "2026-04-22",
            dateModified: "2026-04-22",
            inLanguage: "en-AU",
            isPartOf: {
              "@type": "WebSite",
              name: siteConfig.name,
              url: siteConfig.url,
            },
            author: {
              "@type": "Organization",
              name: siteConfig.name,
              url: siteConfig.url,
            },
            publisher: {
              "@type": "Organization",
              name: siteConfig.name,
              url: siteConfig.url,
              logo: { "@type": "ImageObject", url: siteConfig.ogImage },
            },
            about: {
              "@type": "Thing",
              name: "Financial product advice disclaimer under Corporations Act 2001 (Cth) s766B",
            },
            specialty: "FinancialRegulation",
            significantLink: [
              `${siteConfig.url}/methodology`,
              `${siteConfig.url}/terms`,
              `${siteConfig.url}/privacy`,
            ],
          }),
        }}
      />
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <Breadcrumbs items={[{ label: "Disclaimer", href: "/disclaimer" }]} />
        </div>

        <article className="prose prose-neutral dark:prose-invert max-w-none">
          <h1 className={pageTitle}>
            Disclaimer
          </h1>
          <p className="mt-2 text-muted-foreground">
            Please read before relying on anything published on this site.
            Last updated 22 April 2026.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            General information only
          </h2>
          <p>
            Content on Shorted.com.au — including stock pages, screener
            results, weekly and monthly reports, blog posts, AI-generated
            commentary, and the Shorted AI chat — is published for general
            information and educational purposes only. It is{" "}
            <strong>not financial product advice</strong> within the meaning
            of section 766B of the <em>Corporations Act 2001</em> (Cth) and
            does not take into account your personal objectives, financial
            situation, or needs.
          </p>
          <p>
            Before acting on any information on this site you should
            consider whether it is appropriate for your circumstances and,
            where relevant, obtain independent financial, legal, and
            taxation advice from a licensed professional.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            Not a recommendation
          </h2>
          <p>
            Short interest data, screener outputs, rankings, sector
            aggregates, and any labels such as "short squeeze candidate",
            "dividend pressure", or "hard to cover" are descriptive, not
            prescriptive. They are not recommendations to buy, sell, hold,
            or short any security. Shorted does not manage client money and
            does not hold an Australian Financial Services Licence.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">Data accuracy</h2>
          <p>
            We take care to reproduce ASIC short position data faithfully
            (see our <Link href="/methodology">methodology</Link>), but:
          </p>
          <ul>
            <li>
              Data is delayed by at least four trading days (T+4) as
              published by ASIC.
            </li>
            <li>
              Short positions below ASIC's reporting threshold (0.01% of
              issued capital or A$100,000, whichever is less) are not
              included and cannot be inferred.
            </li>
            <li>
              ASIC may restate historical figures; we reflect the current
              ASIC record and do not retain superseded values.
            </li>
            <li>
              Company metadata, prices, news, and derived metrics may
              contain errors, gaps, or processing lag.
            </li>
          </ul>
          <p>
            If you believe a specific number is wrong, please email{" "}
            <a href="mailto:support@shorted.com.au">support@shorted.com.au</a>{" "}
            with the stock code and date and we will investigate.
          </p>

          {/* Anchor target for CaveatNote on every /politicians surface, which
              asserts "corrections are annotated, not silently applied". That
              claim needs somewhere to point or it is an unbacked promise. */}
          <h2 id="corrections" className="mt-10 text-2xl font-semibold">
            Corrections policy — register of interests
          </h2>
          <p>
            Pages that reproduce the federal{" "}
            <Link href="/politicians">Registers of Members&rsquo; and Senators&rsquo; Interests</Link>{" "}
            concern named individuals, so we hold them to a stricter standard than
            derived market data.
          </p>
          <ul>
            <li>
              The registers record <strong>what</strong> is declared — never quantity,
              value, purchase price or income. We publish no figure of that kind, and
              nothing on those pages should be read as implying one.
            </li>
            <li>
              Entries are extracted from the primary PDFs published by the Parliament
              of Australia and always link back to the original document. Where our
              extraction is incomplete for a period, we say so rather than showing an
              empty list.
            </li>
            <li>
              Corrections are <strong>annotated, not silently applied</strong>. If we
              change or withdraw an entry about a named person we record that it
              changed and why.
            </li>
            <li>
              A member, their representative, or any reader may dispute an entry using
              the &ldquo;Report an error&rdquo; link carried on every one of those
              surfaces, or by emailing{" "}
              <a href="mailto:support@shorted.com.au">support@shorted.com.au</a>. We
              will review against the source PDF and, where an entry is contested
              pending review, suppress it.
            </li>
          </ul>

          <h2 className="mt-10 text-2xl font-semibold">
            AI-generated content
          </h2>
          <p>
            Weekly reports, enrichment summaries, director-trade commentary,
            and responses from the Shorted AI chat are produced by large
            language models operating over the ASIC dataset and public
            sources. AI outputs can be incomplete, outdated, or wrong. Do
            not rely on AI-generated text without independent verification
            against the primary source (ASIC, company announcements, or
            your broker). Where an AI summary cites a fact, prefer the
            underlying data on the stock page over the summary.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            Past performance
          </h2>
          <p>
            Historical short positions, price movements, and any
            back-tested examples do not indicate future performance. Short
            selling carries unlimited downside risk and is not suitable for
            all investors.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            No liability
          </h2>
          <p>
            To the maximum extent permitted by Australian law, Shorted, its
            operators, and contributors exclude all liability for any loss
            or damage (including indirect, consequential, or incidental
            loss) arising from use of, or reliance on, any content on this
            site.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">
            Regulatory context
          </h2>
          <p>
            Shorted.com.au publishes data pursuant to the short-selling
            reporting regime established under the <em>Corporations Act
            2001</em> (Cth) — in particular sections 1020B (naked short
            selling), 1020AB (transaction reporting), and 1020AC (position
            reporting) — and administered by ASIC under Regulatory Guide
            196. See our <Link href="/methodology">methodology</Link> for
            source links.
          </p>

          <h2 className="mt-10 text-2xl font-semibold">Contact</h2>
          <p>
            Data corrections, complaints, or general enquiries:{" "}
            <a href="mailto:support@shorted.com.au">support@shorted.com.au</a>.
          </p>

          <p className="mt-10 text-sm text-muted-foreground">
            See also: <Link href="/methodology">methodology</Link> ·{" "}
            <Link href="/terms">terms</Link> ·{" "}
            <Link href="/privacy">privacy</Link>.
          </p>
        </article>
      </div>
    </main>
  );
}
