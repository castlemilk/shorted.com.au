import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import {
  HelpCircle,
  ExternalLink,
  BookOpen,
  TrendingDown,
  BarChart3,
  Shield,
  Clock,
  Users,
  Zap,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/@/components/ui/accordion";
import { Badge } from "~/@/components/ui/badge";
import { BreadcrumbListSchema, FAQStructuredData } from "~/@/components/seo/enhanced-structured-data";

export const metadata: Metadata = {
  title: "Frequently Asked Questions | Short Selling & ASIC Data",
  description:
    "Get answers to common questions about ASX short selling, ASIC short position data, T+4 delay, short squeezes, and how to use Shorted.com.au to track short interest.",
  keywords: [
    "short selling FAQ",
    "ASIC short position questions",
    "ASX short interest FAQ",
    "short selling help",
    "T+4 delay explained",
    "short squeeze questions",
    "Shorted.com.au help",
    "Australian short selling guide",
  ],
  openGraph: {
    title: "Frequently Asked Questions | Short Selling & ASIC Data",
    description:
      "Get answers to common questions about ASX short selling and ASIC data.",
    url: `${siteConfig.url}/faq`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    // No `images` key: this route ships its own opengraph-image.tsx and an
    // explicit `images` here would SHADOW the file convention.
  },
  twitter: {
    card: "summary_large_image",
    title: "Frequently Asked Questions | Short Selling & ASIC Data",
    description:
      "Get answers to common questions about ASX short selling and ASIC data.",
  },
  alternates: {
    canonical: `${siteConfig.url}/faq`,
  },
};

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "FAQ", url: `${siteConfig.url}/faq` },
];

// FAQ categories with questions
const faqCategories = [
  {
    id: "basics",
    title: "Short Selling Basics",
    icon: BookOpen,
    description: "Fundamental concepts about short selling",
    faqs: [
      {
        question: "What is short selling?",
        answer:
          "Short selling is a trading strategy where an investor borrows shares from a broker, sells them immediately at the current market price, and hopes to buy them back later at a lower price. The investor profits if the stock price falls and returns the borrowed shares, keeping the difference. Short selling is legal and regulated in Australia.",
      },
      {
        question: "Why do investors short sell stocks?",
        answer:
          "Investors short sell for several reasons: (1) To profit from expected price declines if they believe a stock is overvalued, (2) To hedge existing long positions against market downturns, (3) To exploit arbitrage opportunities, and (4) Market makers may short sell as part of their liquidity provision activities. Professional investors and hedge funds are the primary short sellers on the ASX.",
      },
      {
        question: "Is short selling legal in Australia?",
        answer:
          "Yes, short selling is legal in Australia and is regulated by ASIC (Australian Securities and Investments Commission). However, 'naked' short selling—selling shares without first arranging to borrow them—is illegal. All short sellers must have a securities lending arrangement in place before selling.",
      },
      {
        question: "What are the risks of short selling?",
        answer:
          "Short selling carries significant risks: (1) Unlimited loss potential—unlike buying shares where losses are capped at your investment, short sellers can lose more than their initial margin if the stock price rises indefinitely, (2) Short squeeze risk where rapid price increases force covering at losses, (3) Borrowing costs can be substantial for hard-to-borrow stocks, (4) Margin calls may force position closure at unfavorable prices, and (5) Dividend payments must be paid to the lender.",
      },
      {
        question: "What is a short squeeze?",
        answer:
          "A short squeeze occurs when a heavily shorted stock's price rises rapidly, forcing short sellers to buy shares to cover their positions and limit losses. This buying pressure drives the price even higher, creating a feedback loop that can cause parabolic price movements. Famous examples include GameStop (US) and some ASX mining stocks. High short interest combined with positive catalysts can trigger squeezes.",
      },
    ],
  },
  {
    id: "asic-data",
    title: "ASIC Data & Reporting",
    icon: Shield,
    description: "Understanding official short position data",
    faqs: [
      {
        question: "What is ASIC short position data?",
        answer:
          "ASIC (Australian Securities and Investments Commission) collects and publishes aggregated short position data for ASX-listed securities. Market participants must report their short positions to ASIC, which then publishes the total short positions daily. This data helps investors understand market sentiment and identify heavily shorted stocks.",
      },
      {
        question: "What is the T+4 delay and why does it exist?",
        answer:
          "The T+4 delay means ASIC publishes short position data 4 trading days after the positions are reported. For example, Friday's publication shows Monday's positions. This delay exists to: (1) Protect reporters' trading strategies from front-running, (2) Allow time for accurate data compilation, (3) Prevent potential market manipulation, and (4) Maintain fair markets where no party has immediate access to position changes.",
      },
      {
        question: "How often is short position data updated?",
        answer:
          "ASIC publishes short position data every trading day, typically in the late afternoon Australian Eastern time. The data reflects positions from 4 trading days prior (T+4). On Shorted.com.au, we update our database as soon as ASIC releases new data, typically within minutes of publication.",
      },
      {
        question: "What is the reporting threshold for short positions?",
        answer:
          "Market participants must report short positions to ASIC when they exceed $100,000 AUD or 0.01% of the company's total issued capital, whichever threshold is reached first. This ensures significant positions are captured while avoiding administrative burden for small positions.",
      },
      {
        question: "Why might short position data be incomplete?",
        answer:
          "Short position data may not capture all short activity because: (1) Positions below the reporting threshold aren't included, (2) Some synthetic short positions via derivatives may not be captured, (3) Intraday short positions that are covered before reporting time aren't recorded, and (4) International short selling through offshore entities may have different reporting requirements.",
      },
      {
        question: "What is ASIC Regulatory Guide 196?",
        answer:
          "ASIC Regulatory Guide 196 (RG 196) is the primary guidance document for short selling disclosure and reporting in Australia. It outlines the requirements for reporting net short positions to ASIC, including the 0.01% of issued capital or $100,000 reporting threshold (whichever is less), the T+4 publication delay, daily reporting obligations, and the distinction between covered and naked short selling. RG 196 implements the short selling transparency framework established under the Corporations Act 2001.",
      },
      {
        question:
          "What does the Corporations Act 2001 say about short selling?",
        answer:
          "The Corporations Act 2001 is the primary legislation governing short selling in Australia. Section 1020B prohibits naked short selling — selling securities without first arranging to borrow them. Section 1020AB requires short sale transactions to be flagged and reported to the ASX at execution. Section 1020AC requires holders of net short positions to report their positions to ASIC. Together, these sections create a comprehensive framework ensuring all short selling is covered (backed by a securities lending arrangement) and transparent.",
      },
      {
        question: "What is the ASX short sales report?",
        answer:
          "The ASX short sales report is the daily publication by ASIC containing aggregated short position data for all ASX-listed securities. It includes the product code (ASX ticker), full product name, total reported short positions, total shares in issue, and the short position percentage. The data is published with a T+4 trading day delay and covers all ASX approved short sell products. This daily short selling data is the foundation of short interest analysis in Australia and the primary data source used by Shorted.com.au.",
      },
      {
        question:
          "What is the difference between covered and naked short selling?",
        answer:
          "Covered short selling means the seller has a securities lending arrangement in place before executing the short sale — they have borrowed or arranged to borrow the shares. This is the only legal form of short selling in Australia. Naked short selling means selling securities without first arranging to borrow them, creating a risk of settlement failure. Naked short selling is prohibited under section 1020B of the Corporations Act 2001 and can result in civil and criminal penalties.",
      },
      {
        question: "What are ASX approved short sell products?",
        answer:
          "ASX approved short sell products are securities that meet ASX liquidity and market capitalisation criteria for short selling eligibility. The list typically includes all S&P/ASX 200 index constituents, other sufficiently liquid securities, and exchange-traded funds (ETFs) listed on the ASX. The approved list is reviewed periodically. Only these approved products can be legally short sold on the ASX.",
      },
    ],
  },
  {
    id: "interpreting",
    title: "Interpreting Short Data",
    icon: BarChart3,
    description: "How to analyze short position information",
    faqs: [
      {
        question: "What does high short interest indicate?",
        answer:
          "High short interest indicates that many investors are betting against a stock, expecting its price to fall. It can signal: (1) Professional investors see fundamental problems, (2) The stock may be overvalued, (3) Sector headwinds are expected, or (4) Specific company issues are anticipated. However, high short interest can also indicate short squeeze potential if positive catalysts emerge.",
      },
      {
        question: "What is considered 'high' short interest?",
        answer:
          "On the ASX, short interest levels are typically interpreted as: Below 5% = Low (normal levels), 5-10% = Moderate (some bearish sentiment), 10-15% = Elevated (significant bearish interest), 15-20% = High (heavily shorted), Above 20% = Very High (extreme bearish sentiment, potential squeeze candidate). Context matters—some sectors like mining naturally have higher short interest.",
      },
      {
        question: "How should I use short interest in my investment decisions?",
        answer:
          "Short interest should be one factor among many in your analysis. Consider: (1) Combine with fundamental analysis—are shorts justified by company issues? (2) Look at trends over time, not just current levels, (3) Check industry context—is the whole sector being shorted? (4) Consider potential catalysts that could prove shorts wrong, (5) Be aware that following short sellers isn't always profitable as they can be wrong.",
      },
      {
        question: "What is 'days to cover' and why does it matter?",
        answer:
          "Days to cover is calculated by dividing the total short interest by the average daily trading volume. It estimates how many days it would take for all short sellers to cover their positions. A high days-to-cover ratio (above 10-15 days) suggests shorts would struggle to exit quickly, increasing short squeeze potential. Low ratios indicate shorts can cover easily without significantly moving the price.",
      },
      {
        question: "Can short interest predict stock price movements?",
        answer:
          "Short interest has mixed predictive value. Research shows: (1) Heavily shorted stocks do tend to underperform slightly on average, (2) However, short squeezes can cause significant short-term outperformance, (3) Shorts are sometimes wrong about fundamentals, (4) The market can remain irrational longer than shorts can stay solvent. Use short interest as one input, not a crystal ball.",
      },
    ],
  },
  {
    id: "platform",
    title: "Using Shorted.com.au",
    icon: Zap,
    description: "Getting the most from our platform",
    faqs: [
      {
        question: "Is Shorted.com.au free to use?",
        answer:
          "Yes! Shorted.com.au provides free access to ASIC short position data, historical charts, industry analysis, and basic features. We believe market transparency should be accessible to all Australian investors. Premium features for advanced analysis may be available in the future, but core functionality will always remain free.",
      },
      {
        question: "Where does Shorted.com.au get its data?",
        answer:
          "All short position data comes directly from official ASIC (Australian Securities and Investments Commission) publications. Stock price data is sourced from reputable market data providers. Company metadata is sourced from ASX announcements and public filings. We do not create or estimate short position data—everything is based on official regulatory filings.",
      },
      {
        question: "How do I find the most shorted stocks?",
        answer:
          "Visit our Top 100 page at shorted.com.au/top to see live rankings of the most shorted ASX stocks. You can filter by time period, view biggest movers (increases and decreases), and see industry breakdowns. Each stock links to a detailed page with historical charts and company information.",
      },
      {
        question: "Can I track specific stocks I'm interested in?",
        answer:
          "Yes! Create a free account to use our Portfolio feature at shorted.com.au/portfolio. Add your stock holdings to monitor short interest across your portfolio. You can see aggregate exposure to short selling and track how short positions in your holdings change over time.",
      },
      {
        question: "How do I use the industry analysis features?",
        answer:
          "Visit shorted.com.au/industry to explore short positions organized by ASX industry sectors. You can see which industries have the highest average short interest, compare sectors, and drill down to see individual stocks within each industry. The treemap visualization on the Top page also provides a visual industry breakdown.",
      },
      {
        question: "Is there an API available for developers?",
        answer:
          "Yes! We provide API access for developers and researchers. Visit our API documentation at shorted.com.au/docs/api-reference for endpoint details, authentication information, and usage examples. We also provide LLM-optimized documentation for AI applications at shorted.com.au/docs/llm-context.",
      },
    ],
  },
  {
    id: "account",
    title: "Account & Features",
    icon: Users,
    description: "Account management and premium features",
    faqs: [
      {
        question: "Do I need an account to use Shorted.com.au?",
        answer:
          "No account is required to view short position data, charts, and analysis. However, creating a free account unlocks additional features like custom dashboards, portfolio tracking, and saved preferences. Account creation is optional and takes less than a minute.",
      },
      {
        question: "What authentication methods are supported?",
        answer:
          "We support secure authentication via Google and email/password. We use industry-standard OAuth 2.0 for social logins and never store your social media passwords. All authentication is handled securely through our authentication provider.",
      },
      {
        question: "How do custom dashboards work?",
        answer:
          "Custom dashboards allow you to create personalized views of short selling data. Add widgets for top shorts, industry treemaps, specific stock charts, and more. Arrange and resize widgets to create your ideal layout. Dashboards auto-save and sync across devices when you're logged in.",
      },
      {
        question: "Is my data and portfolio information secure?",
        answer:
          "Yes. We take security seriously: (1) All connections use HTTPS encryption, (2) We don't store sensitive financial data—portfolio holdings are optional and self-reported, (3) We never share or sell user data, (4) Authentication uses secure, industry-standard protocols, (5) We comply with Australian privacy laws.",
      },
    ],
  },
  {
    id: "technical",
    title: "Technical Questions",
    icon: Clock,
    description: "Data accuracy and technical details",
    faqs: [
      {
        question: "Why might there be discrepancies with other data sources?",
        answer:
          "Minor discrepancies can occur due to: (1) Different data update timing—we update within minutes of ASIC publication, (2) Rounding differences in percentage calculations, (3) Different treatment of edge cases like stock splits or corporate actions, (4) Historical data corrections by ASIC that may not be reflected everywhere. Our source is always official ASIC data.",
      },
      {
        question: "How is short interest percentage calculated?",
        answer:
          "Short interest percentage = (Total Reported Short Positions ÷ Total Shares on Issue) × 100. For example, if a company has 100 million shares on issue and 10 million are reported as short positions, the short interest is 10%. We use the shares on issue figure from the ASIC report, which may differ slightly from other sources.",
      },
      {
        question: "What time zone is used for dates and timestamps?",
        answer:
          "All dates and times on Shorted.com.au are displayed in Australian Eastern Time (AEST/AEDT), which is the time zone of the ASX. The T+4 delay is calculated based on ASX trading days, excluding weekends and Australian public holidays.",
      },
      {
        question: "How far back does historical data go?",
        answer:
          "Our database contains ASIC short position data going back several years, covering the full available history of ASIC's public short position reports. Historical charts allow you to view trends over various time periods from 1 month to maximum available history.",
      },
      {
        question: "Can I download or export data?",
        answer:
          "Currently, data can be accessed through our web interface and API. We're exploring options for CSV/Excel exports for premium users. For bulk data needs or research purposes, please contact us to discuss data licensing options.",
      },
    ],
  },
];

export default function FAQPage() {
  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <FAQStructuredData
        faqs={faqCategories.flatMap((category) => category.faqs)}
      />

      <div className="space-y-8">
        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <HelpCircle className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className={pageTitle}>
                Frequently Asked Questions
              </h1>
              <p className="text-muted-foreground mt-1">
                Everything you need to know about short selling and Shorted.com.au
              </p>
            </div>
          </div>
          <p className="text-muted-foreground text-lg max-w-2xl">
            Find answers to common questions about ASX short selling, ASIC short position data,
            and how to use our platform effectively.
          </p>
        </section>

        {/* Quick Navigation */}
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {faqCategories.map((category) => {
            const Icon = category.icon;
            return (
              <a
                key={category.id}
                href={`#${category.id}`}
                className="flex flex-col items-center gap-2 p-4 rounded-lg border border-border/60 hover:border-primary/50 hover:bg-muted/50 transition-colors duration-200 ease-out text-center"
              >
                <Icon className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">{category.title}</span>
              </a>
            );
          })}
        </section>

        {/* FAQ Categories */}
        {faqCategories.map((category) => {
          const Icon = category.icon;
          return (
            <section
              key={category.id}
              id={category.id}
              className="scroll-mt-20"
            >
              <Card>
                <CardHeader className="pb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-xl">{category.title}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {category.description}
                      </p>
                    </div>
                    <Badge variant="secondary" className="ml-auto">
                      {category.faqs.length} questions
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Accordion type="single" collapsible className="w-full">
                    {category.faqs.map((faq, index) => (
                      <AccordionItem key={index} value={`${category.id}-${index}`}>
                        <AccordionTrigger className="text-left hover:no-underline">
                          <span className="font-medium">{faq.question}</span>
                        </AccordionTrigger>
                        <AccordionContent className="text-muted-foreground leading-relaxed">
                          {faq.answer}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </CardContent>
              </Card>
            </section>
          );
        })}

        {/* Related Resources */}
        <section className="mt-12 pt-8 border-t border-border/40">
          <h2 className="text-xl font-semibold mb-4">Still Have Questions?</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link href="/learn">
              <Card className="h-full hover:shadow-md transition-[box-shadow,border-color] duration-200 ease-out hover:border-primary/50">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <BookOpen className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">Educational Guides</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        In-depth tutorials on short selling concepts
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/glossary">
              <Card className="h-full hover:shadow-md transition-[box-shadow,border-color] duration-200 ease-out hover:border-primary/50">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <TrendingDown className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">Glossary</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        Key terms and definitions explained
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/about">
              <Card className="h-full hover:shadow-md transition-[box-shadow,border-color] duration-200 ease-out hover:border-primary/50">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <ExternalLink className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">About Us</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        Learn more about Shorted.com.au
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>
        </section>

        {/* Contact CTA */}
        <section className="bg-muted/30 rounded-lg p-6 text-center">
          <h3 className="font-semibold text-lg mb-2">Can&apos;t find what you&apos;re looking for?</h3>
          <p className="text-sm text-muted-foreground mb-4">
            We&apos;re constantly improving our FAQ. If you have a question that isn&apos;t answered here,
            let us know and we&apos;ll add it.
          </p>
          <a
            href={`mailto:${siteConfig.contact.email}`}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Contact Us
          </a>
        </section>
      </div>
    </DashboardLayout>
  );
}
