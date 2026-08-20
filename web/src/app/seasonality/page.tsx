import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle } from "~/@/lib/typography";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";

export const metadata: Metadata = {
  title: "ASX Short Interest Seasonality — Calendar Patterns in Short Selling",
  description:
    "Seasonal patterns in ASX short interest explained: earnings season spikes, dividend-date dislocations, commodity cycles, tax-loss selling, and end-of-financial-year effects. Reference guide with ASIC data context.",
  keywords: [
    "ASX short interest seasonality",
    "seasonal short selling ASX",
    "short interest calendar patterns",
    "ASX earnings season short interest",
    "dividend seasonality short selling",
    "tax-loss selling short positions",
    "EOFY short interest ASX",
  ],
  openGraph: {
    title:
      "ASX Short Interest Seasonality — Calendar Patterns in Short Selling",
    description:
      "Seasonal patterns in ASX short interest: earnings, dividends, commodity cycles, and tax-loss windows.",
    url: `${siteConfig.url}/seasonality`,
    siteName: siteConfig.name,
    type: "article",
    locale: "en_AU",
    // No `images` key: this route ships its own opengraph-image.tsx and an
    // explicit `images` here would SHADOW the file convention.
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "ASX Short Interest Seasonality",
    description:
      "Calendar patterns in ASX short selling: earnings, dividends, tax-loss, commodity cycles.",
  },
  alternates: {
    canonical: `${siteConfig.url}/seasonality`,
    languages: {
      "en-AU": `${siteConfig.url}/seasonality`,
      "x-default": `${siteConfig.url}/seasonality`,
    },
  },
};

const articleSchema = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline:
    "ASX Short Interest Seasonality: Calendar Patterns in Short Selling",
  description:
    "Reference guide to seasonal patterns in short interest on the ASX — earnings windows, dividend dislocations, commodity cycles, tax-loss selling, and EOFY effects.",
  url: `${siteConfig.url}/seasonality`,
  datePublished: "2026-04-24",
  dateModified: "2026-04-24",
  inLanguage: "en-AU",
  author: [
    {
      "@type": "Person",
      name: "Shorted AI Research",
      jobTitle: "Market Research",
      worksFor: {
        "@type": "Organization",
        name: siteConfig.name,
        url: siteConfig.url,
      },
    },
    {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
  ],
  publisher: {
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    logo: { "@type": "ImageObject", url: siteConfig.ogImage },
  },
  mainEntityOfPage: `${siteConfig.url}/seasonality`,
  about: [
    { "@type": "Thing", name: "ASX short interest" },
    { "@type": "Thing", name: "Seasonality" },
    { "@type": "Thing", name: "ASIC short position reports" },
  ],
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is seasonality in short interest?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Seasonality describes recurring, calendar-driven patterns in short interest — for example, a tendency for short positions in retail stocks to rise ahead of a first-half or full-year earnings report, or for resource stocks to track commodity-demand cycles. Seasonality is a tendency, not a rule; it can be overwhelmed by stock-specific news in any given cycle.",
      },
    },
    {
      "@type": "Question",
      name: "Why does short interest rise during ASX earnings season?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "ASX full-year results cluster in August and half-year results in February. Funds taking directional views ahead of results often build short positions in the weeks leading in, which shows up in ASIC's daily short position reports as elevated short interest percentages over July–August and January–February.",
      },
    },
    {
      "@type": "Question",
      name: "How do dividend dates affect short interest?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Holders of short positions on the ex-dividend date are liable to pay the dividend to the lender. Some funds close shorts before ex-date to avoid this cost, while arbitrage strategies may open positions around ex-date to capture franking and timing inefficiencies. ASX index heavyweights with large semi-annual dividends (banks, Telstra, Woolworths) tend to show the clearest effect.",
      },
    },
    {
      "@type": "Question",
      name: "What is tax-loss selling and how does it interact with short interest?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Australian investors commonly crystallise capital losses before 30 June to offset gains in the same financial year. Stocks that have underperformed year-to-date often see elevated selling pressure in May–June, and short sellers may pile into known weak names anticipating further weakness. Short interest on poorly performing stocks tends to peak in late June before unwinding into July.",
      },
    },
    {
      "@type": "Question",
      name: "Do commodity cycles drive seasonality in resource stocks?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes — ASX-listed miners, energy producers, and agricultural companies often have short interest that moves with the underlying commodity's own seasonality. Iron ore, thermal coal, LNG, wheat, and beef all have demand cycles tied to Chinese steel production, northern-hemisphere winter, or harvest windows, and short positioning in ASX stocks tends to echo those cycles.",
      },
    },
    {
      "@type": "Question",
      name: "How do I see seasonality for a specific stock?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Open the stock's page on Shorted — the short position trend chart shows multi-year history from ASIC reports. Look for repeating peaks and troughs around the same months each year. Shorted also publishes weekly and monthly reports that aggregate movers in each window so you can see sector-level seasonal effects over time.",
      },
    },
    {
      "@type": "Question",
      name: "Is seasonality reliable enough to trade on?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Seasonality is a statistical tendency, not a guarantee. Past patterns do not guarantee future behaviour, and individual stock fundamentals or macro shocks routinely override seasonal effects. Shorted publishes ASIC data as reference material only and does not provide financial advice — see our disclaimer.",
      },
    },
  ],
};

export default function SeasonalityPage() {
  const breadcrumbItems = [
    { label: "Seasonality", href: "/seasonality" },
  ];

  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />

      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <article className="prose prose-neutral dark:prose-invert max-w-none">
          <h1 className={pageTitle}>
            ASX Short Interest Seasonality
          </h1>
          <p className="mt-2 text-muted-foreground">
            Calendar patterns in short selling on the ASX — earnings windows,
            dividend dates, commodity cycles, tax-loss selling, and
            end-of-financial-year effects. Reference guide published by the
            Shorted team.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            Why seasonality exists
          </h2>
          <p>
            Short interest is not a random walk. Many of the fund flows that
            drive short positioning are tied to the calendar: companies report
            results on fixed schedules, dividends go ex on known dates, the
            Australian financial year ends 30 June, RBA meetings cluster on
            the first Tuesday of most months, and commodity demand follows
            northern-hemisphere winter, Chinese New Year, and harvest seasons.
            The result is a set of recurring patterns visible in ASIC's daily
            short position reports.
          </p>
          <p>
            Seasonality is a <em>tendency</em>, not a rule. Stock-specific
            news, macro shocks, and regime changes routinely override the
            pattern in any given cycle. We reference seasonality as one lens
            among many, not as a trading signal — see our{" "}
            <Link href="/disclaimer">disclaimer</Link>.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            1. Earnings season
          </h2>
          <p>
            ASX-listed companies reporting on the standard June balance date
            publish full-year results in August and half-year results in
            February. In the weeks before each reporting window, funds taking
            a directional view on results commonly build short positions in
            names they expect to miss, cut guidance, or disappoint on outlook.
            This shows up as a <strong>pre-earnings drift higher</strong> in
            reported short interest across the 4–6 weeks leading into the
            company's report date.
          </p>
          <p>
            The pattern is most visible in consumer-facing stocks with
            elevated narrative risk (retail, discretionary, travel, consumer
            tech) and in banks during the half-year reporting windows (May
            and November for the big four). Index heavyweights with split
            reporting dates can pull sector-level aggregates in multiple
            directions at once.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            2. Dividend dates
          </h2>
          <p>
            A short seller holding a position on the ex-dividend date is
            contractually liable to pay the dividend to the stock lender. For
            franked dividends this creates additional complication because
            franking credits are not transferable. Some funds therefore close
            short positions a day or two before ex-date and reopen after the
            dividend drop; others hold through for strategy reasons.
          </p>
          <p>
            The practical effect is visible in ASX index heavyweights with
            large semi-annual dividends — banks and Telstra in particular —
            where short interest tends to dip in the week of ex-date and
            recover into the following week. Because ASIC data is reported
            T+4, the dip may show up a few trading days after the calendar
            ex-date.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            3. Tax-loss selling and EOFY
          </h2>
          <p>
            The Australian financial year ends 30 June. Investors who hold
            losing positions often sell before year end to realise capital
            losses they can net against capital gains — "tax-loss selling."
            Stocks that have underperformed year-to-date therefore tend to
            see extra selling pressure in late May and June, and short
            sellers often position for continued weakness.
          </p>
          <p>
            The ASIC reports usually show <strong>elevated short interest
            peaks in June</strong> for the worst-performing names of the
            financial year, which then unwind into July once the tax
            incentive disappears and the stocks sometimes snap back on
            short-covering. Shorted's monthly reports typically highlight
            this pattern in the June and July issues.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            4. Commodity cycles in resource stocks
          </h2>
          <p>
            Iron ore prices have a well-documented cycle tied to Chinese
            steel production — weaker demand over Lunar New Year (late
            January to mid-February) and a traditional pick-up into the
            construction build-out through Q2 and Q3. LNG and thermal coal
            demand spikes with northern-hemisphere winter. Agricultural
            commodities move with southern-hemisphere harvest windows.
          </p>
          <p>
            ASX-listed miners, energy producers, and agribusinesses often
            have short interest that tracks the underlying commodity's own
            seasonality. The pattern is strongest in pure-play producers
            with single-commodity exposure and weakest in diversified
            conglomerates where multiple cycles offset.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            5. Index rebalances and end-of-quarter effects
          </h2>
          <p>
            S&amp;P/ASX index rebalances happen quarterly and can trigger
            mechanical flows around inclusion and exclusion dates as passive
            funds adjust. Stocks promoted into the ASX 200 or 300 sometimes
            see short interest compress as index demand absorbs available
            float; stocks demoted sometimes see it expand.
          </p>
          <p>
            End-of-quarter and end-of-month windows can also produce
            short-interest drift from portfolio-level risk rebalancing by
            institutional funds. These effects are usually second-order
            compared to the patterns above.
          </p>

          <h2 className={cn(sectionTitle, "mt-10")}>
            How to read seasonality on Shorted
          </h2>
          <p>
            Every{" "}
            <Link href="/shorts/BHP">stock page</Link> on Shorted renders a
            multi-year short position chart from ASIC data. Scrub the chart
            and look for peaks and troughs that recur in the same month each
            year. Our{" "}
            <Link href="/reports">weekly and monthly reports</Link> also
            flag movers within each window so the sector-level effects are
            easy to see over time.
          </p>
          <p>
            If you want to understand the underlying mechanics in more
            detail, see our learn articles:
          </p>
          <ul>
            <li>
              <Link href="/learn/reading-short-interest-changes">
                Interpreting short interest changes over time
              </Link>
            </li>
            <li>
              <Link href="/learn/sector-analysis-short-selling">
                Sector analysis for short selling
              </Link>
            </li>
            <li>
              <Link href="/learn/understanding-t4-delay">
                Understanding ASIC's T+4 delay
              </Link>
            </li>
            <li>
              <Link href="/learn/short-squeeze-mechanics">
                Short squeeze mechanics explained
              </Link>
            </li>
          </ul>

          <h2 className={cn(sectionTitle, "mt-10")}>Caveats</h2>
          <ul>
            <li>
              Past seasonal patterns do not guarantee future behaviour.
            </li>
            <li>
              ASIC data is delayed T+4 — intra-event fine timing is not
              resolvable.
            </li>
            <li>
              Short positions below the{" "}
              <Link href="/methodology">reporting threshold</Link> do not
              appear in ASIC's dataset and are invisible to seasonality
              analysis on this site.
            </li>
            <li>
              Shorted does not provide personal financial advice. See our{" "}
              <Link href="/disclaimer">disclaimer</Link>.
            </li>
          </ul>

          <p className="mt-10 text-sm text-muted-foreground">
            Questions about this guide? Email{" "}
            <a href="mailto:support@shorted.com.au">support@shorted.com.au</a>.
            See also our <Link href="/methodology">methodology</Link>.
          </p>
        </article>
      </div>
    </main>
  );
}
