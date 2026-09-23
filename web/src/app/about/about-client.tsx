"use client";

import Image from "next/image";
import Link from "next/link";
import { Button } from "~/@/components/ui/button";
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Building2,
  ChevronRight,
  Code2,
  Database,
  ExternalLink,
  FileText,
  Globe,
  Key,
  LineChart,
  Linkedin,
  Lock,
  Mail,
  Newspaper,
  Rocket,
  Search,
  Shield,
  Sparkles,
  TrendingDown,
  User,
  Zap,
} from "lucide-react";
import { FinanceGridBackground } from "~/@/components/marketing/finance-grid-background";
import { AnimatedChartDisplay } from "~/@/components/marketing/animated-chart-display";
import { SpotlightCard } from "~/@/components/marketing/spotlight-card";
import { type AboutPageStatistics } from "~/lib/statistics";
import { cn } from "~/@/lib/utils";
import { siteConfig } from "~/@/config/site";
import { PLANS, planPricePerMonth } from "~/@/config/pricing";

interface AboutClientProps {
  initialStatistics: AboutPageStatistics;
}

const AboutClient = ({ initialStatistics }: AboutClientProps) => {
  const statistics = initialStatistics;

  return (
    <div className="flex flex-col min-h-screen bg-background relative">
      {/* Background */}
      <FinanceGridBackground className="fixed inset-0 z-0 pointer-events-none" />

      {/* Hero Section */}
      <section className="relative w-full pt-16 pb-24 md:pt-24 md:pb-32 lg:pt-32 lg:pb-40 overflow-hidden z-10">
        <div className="container px-4 md:px-6 relative">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left content */}
            <div className="flex flex-col space-y-8 text-center lg:text-left">
              {/* Badge */}
              <div className="inline-flex items-center justify-center lg:justify-start">
                <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium">
                  <Activity className="w-4 h-4" />
                  ASX Short Position Intelligence
                </span>
              </div>

              {/* Headline */}
              <div className="space-y-4">
                <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
                  <span className="block font-semibold text-foreground">Decode Market</span>
                  <span className="block text-primary">Sentiment</span>
                </h1>
                <p className="text-lg md:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0 leading-relaxed">
                  Track short positions across the ASX with data sourced directly from ASIC. 
                  Follow daily crowding signals, sector context, and cited evidence surfaces
                  without digging through raw regulatory files.
                </p>
              </div>

              {/* CTA Buttons */}
              <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                <Link href="/top" prefetch={false}>
                  <Button
                    size="lg"
                    className="text-base px-8 py-6 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-colors"
                  >
                    Explore Short Positions
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/stocks" prefetch={false}>
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-8 py-6 border-2 hover:bg-muted/50 transition-colors"
                  >
                    <Search className="w-5 h-5 mr-2" />
                    Search Stocks
                  </Button>
                </Link>
              </div>

              <p className="text-sm text-muted-foreground">
                Founded by{" "}
                <a
                  href="#founder"
                  className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
                >
                  {siteConfig.founder.name}
                </a>{" "}
                · Built in {siteConfig.company.city}, {siteConfig.company.countryName} ·
                Available worldwide
              </p>

              {/* Quick stats */}
              <div className="flex flex-wrap gap-8 justify-center lg:justify-start pt-4">
                <div className="text-center lg:text-left">
                  <div className="text-3xl font-bold text-foreground tabular-nums">
                    {statistics.companyCount.toLocaleString()}+
                  </div>
                  <div className="text-sm text-muted-foreground">Companies Tracked</div>
                </div>
                <div className="w-px h-12 bg-border hidden sm:block" />
                <div className="text-center lg:text-left">
                  <div className="text-3xl font-bold text-foreground tabular-nums">
                    {statistics.industryCount}+
                  </div>
                  <div className="text-sm text-muted-foreground">Industries Covered</div>
                </div>
                <div className="w-px h-12 bg-border hidden sm:block" />
                <div className="text-center lg:text-left">
                  <div className="text-3xl font-bold text-foreground">Daily</div>
                  <div className="text-sm text-muted-foreground">Data Updates</div>
                </div>
              </div>
            </div>

            {/* Right content - Chart Display */}
            <div className="relative lg:pl-8">
              <AnimatedChartDisplay />
            </div>
          </div>
        </div>
      </section>

      {/* Company & Founder Section — who runs Shorted, where, and how it
          makes money. Kept directly under the hero: this is what startup
          programs, partners and YMYL raters look for first. */}
      <section
        id="company"
        aria-labelledby="company-heading"
        className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm scroll-mt-20"
      >
        <div className="container px-4 md:px-6">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
                <Building2 className="w-4 h-4" />
                The Company
              </div>
              <h2
                id="company-heading"
                className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4 text-balance"
              >
                Who&apos;s Behind Shorted
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-pretty">
                Shorted is an independent, founder-led software company based in{" "}
                {siteConfig.company.city}, {siteConfig.company.countryName}. We build
                an online data product — a web app, API and AI tools — that turns
                ASIC&apos;s daily short-position filings into something investors
                can actually use. It is delivered entirely online and available
                worldwide.
              </p>
            </div>

            <div className="grid lg:grid-cols-5 gap-8 items-start">
              {/* Founder Card */}
              <div id="founder" className="lg:col-span-2 scroll-mt-20">
                <SpotlightCard className="p-8">
                  <div className="flex flex-col items-center text-center">
                    <Image
                      src="/assets/blog/authors/ben-ebsworth.jpg"
                      alt={`${siteConfig.founder.name}, founder of Shorted`}
                      width={112}
                      height={112}
                      sizes="112px"
                      className="w-28 h-28 rounded-full object-cover bg-muted border-2 border-primary/30 mb-4"
                    />
                    <h3 className="text-xl font-semibold text-foreground">
                      {siteConfig.founder.name}
                    </h3>
                    <p className="text-sm text-primary font-medium mb-3">
                      {siteConfig.founder.jobTitle}
                    </p>
                    <p className="text-sm text-muted-foreground mb-5">
                      Software engineer with a background in cloud infrastructure,
                      data pipelines and AI/ML systems. Ben designed and built
                      Shorted end to end — the ASIC ingestion pipeline, the Go API,
                      the web app and the AI tooling — and runs the business.
                    </p>
                    <ul className="flex flex-col gap-2 w-full">
                      <FounderLink
                        href={siteConfig.founder.website}
                        icon={<Globe className="w-4 h-4" />}
                        label="benebsworth.com"
                        external
                      />
                      <FounderLink
                        href={siteConfig.founder.linkedin}
                        icon={<Linkedin className="w-4 h-4" />}
                        label="LinkedIn"
                        external
                      />
                      <FounderLink
                        href={siteConfig.founder.profilePath}
                        icon={<User className="w-4 h-4" />}
                        label="Author profile"
                      />
                    </ul>
                  </div>
                </SpotlightCard>
              </div>

              {/* Company facts + story */}
              <div className="lg:col-span-3 space-y-6">
                <div className="bg-card rounded-2xl border p-6">
                  <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-primary" />
                    At a Glance
                  </h3>
                  <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
                    <CompanyFact label="Company" value="Shorted (shorted.com.au)" />
                    <CompanyFact
                      label="Founded"
                      value={`${siteConfig.company.foundingDate}, ${siteConfig.company.city}, ${siteConfig.company.countryName}`}
                    />
                    <CompanyFact
                      label="Founder"
                      value={`${siteConfig.founder.name} (${siteConfig.founder.jobTitle})`}
                    />
                    <CompanyFact
                      label="Product"
                      value="Web app, public API and MCP server for AI assistants"
                    />
                    <CompanyFact
                      label="Business model"
                      value="Freemium SaaS: free tier, paid subscriptions and API plans"
                    />
                    <CompanyFact label="Availability" value="Online, worldwide" />
                    <div className="sm:col-span-2">
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                        Contact
                      </dt>
                      <dd className="mt-1 font-medium text-foreground">
                        <a
                          href={`mailto:${siteConfig.contact.email}`}
                          className="inline-flex items-center gap-1.5 text-primary hover:underline"
                        >
                          <Mail className="w-4 h-4" />
                          {siteConfig.contact.email}
                        </a>
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="bg-card rounded-2xl border p-6">
                  <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                    <Rocket className="w-5 h-5 text-primary" />
                    Our Story
                  </h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Shorted was born from a simple frustration: ASIC publishes daily
                    short position data, but only as raw CSV files with no easy way to
                    explore, visualise or track it over time. Shorted transforms that
                    regulatory data into an intuitive platform with historical charts,
                    industry heatmaps, AI-powered analysis and daily alerts, making
                    institutional-grade short selling intelligence accessible to
                    everyone.
                  </p>
                </div>
              </div>
            </div>

            {/* Business model */}
            <div className="mt-12">
              <h3 className="text-2xl font-semibold tracking-tight text-foreground text-center mb-2">
                How Shorted Makes Money
              </h3>
              <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-8">
                Core short-position data stays free to browse. Revenue comes from
                self-serve online subscriptions, billed through Stripe.
              </p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <PlanCard
                  name={PLANS.free.name}
                  price={planPricePerMonth("free")}
                  description={PLANS.free.tagline}
                  href="/signup"
                />
                <PlanCard
                  name={PLANS.premium.name}
                  price={planPricePerMonth("premium")}
                  description={PLANS.premium.tagline}
                  href="/pricing"
                />
                <PlanCard
                  name={PLANS.apiAccess.name}
                  price={planPricePerMonth("apiAccess")}
                  description={PLANS.apiAccess.tagline}
                  href="/docs/api#authentication"
                />
                <PlanCard
                  name="Commercial"
                  price="Custom"
                  description="Commercial licensing, bulk data and enterprise API limits."
                  href={`mailto:${siteConfig.contact.email}`}
                />
              </div>
            </div>

            {/* Tech stack */}
            <div className="mt-12 bg-card rounded-2xl border p-6">
              <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                <Code2 className="w-5 h-5 text-primary" />
                Tech Stack
              </h3>
              <div className="flex flex-wrap gap-2">
                {[
                  "Go",
                  "Next.js",
                  "TypeScript",
                  "GCP Cloud Run",
                  "Gemini AI",
                  "PostgreSQL",
                  "Terraform",
                  "Connect-RPC",
                  "Protobuf",
                  "Docker",
                ].map((tech) => (
                  <span
                    key={tech}
                    className="px-3 py-1.5 text-xs font-medium rounded-full bg-primary/10 text-primary border border-primary/20"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Value Proposition Section */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Why Short Position Data Matters
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Short interest reveals what institutional investors are betting against, giving
              intelligence for understanding market sentiment and potential price movements.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {/* Value Card 1 */}
            <ValueCard
              icon={<TrendingDown className="w-8 h-8" />}
              title="Sentiment Indicator"
              description="High short interest often signals bearish institutional sentiment, while covering can trigger short squeezes and rapid price increases."
              gradient="from-accent to-primary"
            />

            {/* Value Card 2 */}
            <ValueCard
              icon={<Shield className="w-8 h-8" />}
              title="ASIC-Sourced Data"
              description="Official regulatory data reported by short sellers themselves, providing the most accurate and reliable short position information available."
              gradient="from-secondary to-primary"
            />

            {/* Value Card 3 */}
            <ValueCard
              icon={<Activity className="w-8 h-8" />}
              title="Daily Tracking"
              description="Monitor position changes daily as they're reported (T+4 delay). Spot trends early and stay ahead of market movements."
              gradient="from-primary to-accent"
            />
          </div>
        </div>
      </section>

      {/* Industry Intelligence Section */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)] lg:items-start">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary/10 border border-primary/20 text-primary text-xs font-medium uppercase tracking-[0.16em] mb-5">
                <Sparkles className="w-4 h-4" />
                Industry Intelligence
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground text-balance">
                Industry Intelligence connects sectors to stocks
              </h2>
              <p className="mt-5 text-lg text-muted-foreground leading-relaxed text-pretty">
                Start with ASIC short-interest crowding, then jump into the
                ranked companies, stock pages, and alert workflow for each sector.
              </p>

              <div className="mt-7 grid gap-3 sm:grid-cols-3">
                {["Industry crowding", "Ranked companies", "Alert monitors"].map((label) => (
                  <div
                    key={label}
                    className="rounded-lg border border-border/60 bg-card/70 px-4 py-3"
                  >
                    <div className="text-sm font-semibold text-foreground">{label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Built into the explorer
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Link href="/industry-intelligence" prefetch={false}>
                  <Button size="lg" className="min-h-11 px-7">
                    Open Industry Intelligence
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/top" prefetch={false}>
                  <Button
                    size="lg"
                    variant="outline"
                    className="min-h-11 px-7 border-2 hover:bg-muted/50"
                  >
                    Compare top shorts
                  </Button>
                </Link>
              </div>

              <p className="mt-5 text-sm text-muted-foreground">
                Public short-interest views stay free. Alerts are available for
                users who want ongoing monitoring.
              </p>
            </div>

            <div className="rounded-lg border border-border/60 bg-card/75 p-5 shadow-lg shadow-primary/5 backdrop-blur-sm">
              <div className="flex items-start justify-between gap-4 border-b border-border/60 pb-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
                    Industry board
                  </p>
                  <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                    From sector signal to stock detail
                  </h3>
                </div>
                <div className="rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-right">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-primary">
                    Update
                  </div>
                  <div className="font-mono text-sm font-semibold text-foreground">
                    Daily
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-3">
                <IndustryStoryRow
                  icon={<BarChart3 className="w-5 h-5" />}
                  title="Crowding"
                  description="Rank industries by average short interest and surface concentrated pressure."
                />
                <IndustryStoryRow
                  icon={<TrendingDown className="w-5 h-5" />}
                  title="Top Stocks"
                  description="Jump from an industry view to the top shorted companies and detail pages."
                />
                <IndustryStoryRow
                  icon={<FileText className="w-5 h-5" />}
                  title="Stock Pages"
                  description="Move from an industry signal into company-level short-interest detail."
                />
                <IndustryStoryRow
                  icon={<Bell className="w-5 h-5" />}
                  title="Alerts"
                  description="Create daily or weekly alerts when a sector signal changes."
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Powerful Analysis Tools
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Everything you need to analyze short positions and make informed decisions
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <FeatureCard
              icon={<LineChart className="w-6 h-6" />}
              title="Historical Charts"
              description="Track short interest changes over time with interactive historical charts and trend analysis."
              color="amber"
            />
            <FeatureCard
              icon={<BarChart3 className="w-6 h-6" />}
              title="Industry Heatmaps"
              description="Visualize short interest across sectors with our industry treemap to spot sector-wide trends."
              color="rust"
            />
            <FeatureCard
              icon={<Search className="w-6 h-6" />}
              title="Smart Search"
              description="Instantly find any ASX-listed company and view their complete short position history."
              color="olive"
            />
            <FeatureCard
              icon={<Bell className="w-6 h-6" />}
              title="Position Alerts"
              description="Get notified when significant changes occur in the stocks you're watching."
              color="amber"
            />
            <FeatureCard
              icon={<Database className="w-6 h-6" />}
              title="Comprehensive Data"
              description="Access complete short position data for every reportable position on the ASX."
              color="rust"
            />
            <FeatureCard
              icon={<Zap className="w-6 h-6" />}
              title="Fast Performance"
              description="Optimized infrastructure delivers lightning-fast queries and daily data updates."
              color="olive"
            />
            <FeatureCard
              icon={<Lock className="w-6 h-6" />}
              title="Secure Platform"
              description="Google sign-in and industry-standard encryption protect your account and watchlist data."
              color="neutral"
            />
            <FeatureCard
              icon={<Activity className="w-6 h-6" />}
              title="Live Updates"
              description="Data synced daily from ASIC ensuring you always have the latest information."
              color="olive"
            />
          </div>
        </div>
      </section>

      {/* Data Trust Section */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary/20 border border-secondary/30 text-secondary-foreground text-sm font-medium mb-6">
                <Shield className="w-4 h-4" />
                Official Data Source
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
                Data You Can Trust
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Our short position data is sourced directly from the Australian Securities and 
                Investments Commission (ASIC), ensuring accuracy and reliability.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <TrustMetric label="Data Source" value="ASIC" />
              <TrustMetric label="Update Frequency" value="Daily" />
              <TrustMetric label="Historical Data" value="Since 2010" />
              <TrustMetric label="Reporting Lag" value="T+4 days" />
            </div>

            <div className="mt-12 p-6 rounded-2xl bg-card border">
              <div className="flex flex-col md:flex-row items-center gap-6 text-center md:text-left">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center flex-shrink-0">
                  <Database className="w-8 h-8 text-primary-foreground" />
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    Regulatory-Grade Data Pipeline
                  </h3>
                  <p className="text-muted-foreground">
                    Short positions of 0.01% of issued capital or $100,000 (whichever is less) must be reported to ASIC.
                    We process these daily filings and transform them into actionable insights,
                    enriched with company metadata and historical context.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Company Timeline Section */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="max-w-3xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-foreground mb-4">
                Platform Milestones
              </h2>
              <p className="text-lg text-muted-foreground">
                Key moments in building Australia&apos;s short position intelligence platform
              </p>
            </div>

            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-4 md:left-1/2 top-0 bottom-0 w-px bg-border md:-translate-x-px" />

              <div className="space-y-8">
                <TimelineItem
                  icon={<Database className="w-4 h-4" />}
                  title="Platform Launch"
                  description="Shorted.com.au goes live with daily ASIC short position data ingestion, historical charts, and industry heatmaps."
                  period="2024"
                  align="left"
                />
                <TimelineItem
                  icon={<Globe className="w-4 h-4" />}
                  title="500+ Companies Tracked"
                  description="Coverage expands to track short positions across all reportable ASX-listed companies with full historical data."
                  period="2024"
                  align="right"
                />
                <TimelineItem
                  icon={<Bot className="w-4 h-4" />}
                  title="AI-Powered Chat (Gemini)"
                  description="Launch of Shorted AI, a conversational assistant powered by Gemini LLM with 8 API tools for real-time stock analysis."
                  period="2025"
                  align="left"
                />
                <TimelineItem
                  icon={<Newspaper className="w-4 h-4" />}
                  title="News Sentiment Analysis"
                  description="Automated RSS aggregation with Gemini 2.0 Flash batch sentiment classification, matching articles to ASX stocks."
                  period="2025"
                  align="right"
                />
                <TimelineItem
                  icon={<Key className="w-4 h-4" />}
                  title="API Launch with Rate Limiting"
                  description="Public API with free and paid developer tiers, per-tier rate limiting, and comprehensive documentation."
                  period="2025"
                  align="left"
                />
                <TimelineItem
                  icon={<Sparkles className="w-4 h-4" />}
                  title="Company Enrichment Engine"
                  description="GPT-4 powered metadata extraction with competitive analysis, risk factors, and AI-generated company summaries."
                  period="2026"
                  align="right"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Data Access & Usage Policy Section */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
                <Key className="w-4 h-4" />
                Usage Policy
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
                Data Access &amp; Usage Policy
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Shorted sources short position data from ASIC and makes it available through our
                web dashboard and authenticated API. Please review our data usage guidelines below.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              <PolicyCard
                icon={<Globe className="w-6 h-6" />}
                title="Web Dashboard"
                description="Free access for personal research and analysis. Browse short positions, charts, and insights directly on shorted.com.au."
              />
              <PolicyCard
                icon={<Key className="w-6 h-6" />}
                title="API Access"
                description="Requires authentication via API token. A free tier is available for developers building integrations and tools."
              />
              <PolicyCard
                icon={<Shield className="w-6 h-6" />}
                title="Automated Scraping"
                description="Prohibited without API authentication. All programmatic access must use a valid API token."
              />
              <PolicyCard
                icon={<Lock className="w-6 h-6" />}
                title="Commercial Use"
                description="Requires a Pro or Enterprise subscription. Contact us for commercial licensing and bulk data arrangements."
              />
              <PolicyCard
                icon={<FileText className="w-6 h-6" />}
                title="Redistribution"
                description="Not permitted without written consent. Data may not be resold, republished, or redistributed in any form."
              />
              <div className="flex items-center justify-center p-8 rounded-2xl border border-dashed border-primary/30 bg-primary/5">
                <Link href="/docs/api" prefetch={false} className="text-center group">
                  <div className="text-primary font-semibold mb-2 group-hover:underline flex items-center justify-center gap-2">
                    View API Documentation
                    <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Full details on rate limits, authentication, and endpoints.
                  </p>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="w-full py-24 md:py-32 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="relative max-w-4xl mx-auto">
            <div className="relative overflow-hidden bg-card/70 backdrop-blur-sm rounded-lg border border-border/60 p-8 md:p-12 lg:p-16 text-center shadow-lg shadow-primary/5">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-6">
                Start with the industry story
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
                See where short interest is crowding, which stocks are driving the
                move, and where alerts can help you keep watch.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/industry-intelligence" prefetch={false}>
                  <Button
                    size="lg"
                    className="text-base px-10 py-7 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-colors"
                  >
                    Explore Industry Intelligence
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/top" prefetch={false}>
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-10 py-7 border-2 hover:bg-muted/50 transition-colors"
                  >
                    View Top Shorts
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/stocks" prefetch={false}>
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-10 py-7 border-2 hover:bg-muted/50 transition-colors"
                  >
                    Search All Stocks
                  </Button>
                </Link>
              </div>

              {/* Bottom accent */}
              <div className="mt-12 pt-8 border-t border-border/50">
                <p className="text-sm text-muted-foreground">
                  Public short-interest data remains free to browse. Alerts help
                  users monitor the industries they care about.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

// Founder profile link
interface FounderLinkProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
}

function FounderLink({ href, icon, label, external }: FounderLinkProps) {
  const className =
    "flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary";
  return (
    <li>
      {external ? (
        <a href={href} target="_blank" rel="noopener me" className={className}>
          {icon}
          {label}
          <ExternalLink className="w-3 h-3" />
        </a>
      ) : (
        <Link href={href} prefetch={false} className={className}>
          {icon}
          {label}
        </Link>
      )}
    </li>
  );
}

// Company fact (definition list row)
function CompanyFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium text-foreground">{value}</dd>
    </div>
  );
}

// Pricing plan summary card
interface PlanCardProps {
  name: string;
  price: string;
  description: string;
  href: string;
}

function PlanCard({ name, price, description, href }: PlanCardProps) {
  const content = (
    <>
      <div className="text-sm font-semibold text-foreground">{name}</div>
      <div className="mt-1 text-2xl font-bold text-primary tabular-nums">{price}</div>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{description}</p>
    </>
  );
  const className =
    "block h-full rounded-xl border bg-card p-5 transition-shadow duration-200 hover:shadow-lg";
  return href.startsWith("mailto:") ? (
    <a href={href} className={className}>
      {content}
    </a>
  ) : (
    <Link href={href} prefetch={false} className={className}>
      {content}
    </Link>
  );
}

// Industry story row component
interface IndustryStoryRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function IndustryStoryRow({ icon, title, description }: IndustryStoryRowProps) {
  return (
    <div className="flex gap-4 rounded-lg border border-border/60 bg-background/60 p-4">
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </div>
      <div>
        <h4 className="font-semibold text-foreground">{title}</h4>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

// Value Proposition Card Component
interface ValueCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  gradient: string;
}

function ValueCard({ icon, title, description, gradient }: ValueCardProps) {
  return (
    <div className="group relative bg-card rounded-xl border p-8 transition-[box-shadow,transform] duration-200 hover:shadow-xl hover:-translate-y-1">
      <div 
        className={cn(
          "w-16 h-16 rounded-2xl flex items-center justify-center mb-6 text-white bg-gradient-to-br",
          gradient
        )}
      >
        {icon}
      </div>
      <h3 className="text-xl font-semibold text-foreground mb-3">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

// Feature Card Component
interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: "amber" | "rust" | "olive" | "neutral";
}

// Theme-aware color styles using CSS variables
const colorStyles = {
  amber: "bg-primary/10 text-primary group-hover:bg-primary/20",
  rust: "bg-accent/10 text-accent group-hover:bg-accent/20",
  olive: "bg-secondary/20 text-secondary-foreground group-hover:bg-secondary/30",
  neutral: "bg-muted text-muted-foreground group-hover:bg-muted/80",
};

function FeatureCard({ icon, title, description, color }: FeatureCardProps) {
  return (
    <div className="group bg-card rounded-xl border p-6 transition-[box-shadow,transform] duration-200 hover:shadow-lg hover:-translate-y-0.5">
      <div 
        className={cn(
          "w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-colors",
          colorStyles[color]
        )}
      >
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

// Trust Metric Component
interface TrustMetricProps {
  label: string;
  value: string;
}

function TrustMetric({ label, value }: TrustMetricProps) {
  return (
    <div className="text-center p-6 rounded-xl bg-card border">
      <div className="text-3xl font-bold text-foreground mb-1">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
}

// Policy Card Component
interface PolicyCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function PolicyCard({ icon, title, description }: PolicyCardProps) {
  return (
    <div className="bg-card rounded-xl border p-6 transition-shadow duration-200 hover:shadow-lg">
      <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

// Timeline Item Component
interface TimelineItemProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  period: string;
  align: "left" | "right";
}

function TimelineItem({ icon, title, description, period, align }: TimelineItemProps) {
  return (
    <div className={cn(
      "relative flex items-start gap-6",
      "md:gap-0",
      align === "right" ? "md:flex-row-reverse" : ""
    )}>
      {/* Dot on the line */}
      <div className="absolute left-4 md:left-1/2 w-8 h-8 -translate-x-1/2 rounded-full bg-primary/10 border-2 border-primary flex items-center justify-center z-10 text-primary">
        {icon}
      </div>

      {/* Content */}
      <div className={cn(
        "ml-16 md:ml-0 md:w-1/2",
        align === "left" ? "md:pr-12 md:text-right" : "md:pl-12"
      )}>
        <div className="bg-card rounded-xl border p-4 transition-shadow hover:shadow-md">
          <span className="text-xs font-medium text-primary">{period}</span>
          <h4 className="text-base font-semibold text-foreground mt-1">{title}</h4>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
      </div>
    </div>
  );
}

export default AboutClient;
