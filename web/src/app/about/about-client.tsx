"use client";

import Link from "next/link";
import { Button } from "~/@/components/ui/button";
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
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
                  <span className="block text-foreground">Decode Market</span>
                  <span className="block bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent bg-[length:200%_auto] animate-gradient">
                    Sentiment
                  </span>
                </h1>
                <p className="text-lg md:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0 leading-relaxed">
                  Track short positions across the ASX with data sourced directly from ASIC. 
                  Gain institutional-grade insights to inform smarter investment decisions.
                </p>
              </div>

              {/* CTA Buttons */}
              <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                <Link href="/">
                  <Button
                    size="lg"
                    className="text-base px-8 py-6 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-300 hover:shadow-xl hover:shadow-primary/30"
                  >
                    Explore Short Positions
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/stocks">
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-8 py-6 border-2 hover:bg-muted/50 transition-all duration-300"
                  >
                    <Search className="w-5 h-5 mr-2" />
                    Search Stocks
                  </Button>
                </Link>
              </div>

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

      {/* Value Proposition Section */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Why Short Position Data Matters
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Short interest reveals what institutional investors are betting against—crucial 
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
              color="blue"
            />
            <FeatureCard
              icon={<BarChart3 className="w-6 h-6" />}
              title="Industry Heatmaps"
              description="Visualize short interest across sectors with our industry treemap to spot sector-wide trends."
              color="purple"
            />
            <FeatureCard
              icon={<Search className="w-6 h-6" />}
              title="Smart Search"
              description="Instantly find any ASX-listed company and view their complete short position history."
              color="emerald"
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
              color="rose"
            />
            <FeatureCard
              icon={<Zap className="w-6 h-6" />}
              title="Fast Performance"
              description="Optimized infrastructure delivers lightning-fast queries and daily data updates."
              color="cyan"
            />
            <FeatureCard
              icon={<Lock className="w-6 h-6" />}
              title="Secure Platform"
              description="Google sign-in and industry-standard encryption protect your account and watchlist data."
              color="indigo"
            />
            <FeatureCard
              icon={<Activity className="w-6 h-6" />}
              title="Live Updates"
              description="Data synced daily from ASIC ensuring you always have the latest information."
              color="teal"
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

      {/* Team & Founder Section */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
                <User className="w-4 h-4" />
                Our Team
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
                Built by an Engineer, for Investors
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Shorted was born from a simple frustration: ASIC publishes daily short position data,
                but there was no easy way to explore, visualize, or track it over time.
              </p>
            </div>

            <div className="grid lg:grid-cols-5 gap-8 items-start">
              {/* Founder Card */}
              <div className="lg:col-span-2">
                <SpotlightCard className="p-8">
                  <div className="flex flex-col items-center text-center">
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center mb-4">
                      <User className="w-12 h-12 text-primary-foreground" />
                    </div>
                    <h3 className="text-xl font-semibold text-foreground">Ben Ebsworth</h3>
                    <p className="text-sm text-primary font-medium mb-3">Founder & Engineer</p>
                    <p className="text-sm text-muted-foreground mb-4">
                      Software engineer with experience in cloud infrastructure, data pipelines,
                      and AI/ML systems. Building Shorted as a solo founder to democratize
                      short selling data access in Australia.
                    </p>
                    <a
                      href="https://www.linkedin.com/in/benebsworth/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                    >
                      <Linkedin className="w-4 h-4" />
                      LinkedIn Profile
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </SpotlightCard>
              </div>

              {/* Our Story + Tech Stack */}
              <div className="lg:col-span-3 space-y-6">
                <div className="bg-card rounded-2xl border p-6">
                  <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                    <Rocket className="w-5 h-5 text-primary" />
                    Our Story
                  </h3>
                  <p className="text-muted-foreground leading-relaxed">
                    ASIC requires short sellers to report positions of 0.01% of total shares on issue
                    or $100,000 (whichever is less), but the raw CSV files they publish are difficult
                    to work with. Shorted transforms this regulatory data into an intuitive platform
                    with historical charts, industry heatmaps, AI-powered analysis, and daily
                    alerts — making institutional-grade short selling intelligence accessible to everyone.
                  </p>
                </div>

                <div className="bg-card rounded-2xl border p-6">
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
                  description="Launch of Shorted AI — a conversational assistant powered by Gemini LLM with 8 API tools for real-time stock analysis."
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
                  description="Public API with developer tiers (free, paid), Upstash Redis rate limiting, and comprehensive documentation."
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
                <Link href="/docs/api" className="text-center group">
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
            {/* Decorative background */}
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-accent/10 to-primary/10 rounded-3xl blur-xl" />
            
            <div className="relative bg-card/50 backdrop-blur-sm rounded-3xl border p-8 md:p-12 lg:p-16 text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-6">
                Ready to Gain the Edge?
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
                Start tracking short positions on the ASX today. Discover which stocks institutional 
                investors are betting against and use that intelligence to inform your decisions.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/">
                  <Button
                    size="lg"
                    className="text-base px-10 py-7 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-300 hover:shadow-xl hover:shadow-primary/30"
                  >
                    View Top Shorts
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/stocks">
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-10 py-7 border-2 hover:bg-muted/50 transition-all duration-300"
                  >
                    Search All Stocks
                  </Button>
                </Link>
              </div>

              {/* Bottom accent */}
              <div className="mt-12 pt-8 border-t border-border/50">
                <p className="text-sm text-muted-foreground">
                  Free to use. No sign-up required to explore short position data.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

// Value Proposition Card Component
interface ValueCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  gradient: string;
}

function ValueCard({ icon, title, description, gradient }: ValueCardProps) {
  return (
    <div className="group relative bg-card rounded-2xl border p-8 transition-all duration-300 hover:shadow-xl hover:-translate-y-1">
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
  color: "blue" | "purple" | "emerald" | "amber" | "rose" | "cyan" | "indigo" | "teal";
}

// Theme-aware color styles using CSS variables
const colorStyles = {
  blue: "bg-primary/10 text-primary group-hover:bg-primary/20",
  purple: "bg-accent/10 text-accent group-hover:bg-accent/20",
  emerald: "bg-secondary/20 text-secondary-foreground group-hover:bg-secondary/30",
  amber: "bg-primary/10 text-primary group-hover:bg-primary/20",
  rose: "bg-accent/10 text-accent group-hover:bg-accent/20",
  cyan: "bg-secondary/20 text-secondary-foreground group-hover:bg-secondary/30",
  indigo: "bg-muted text-muted-foreground group-hover:bg-muted/80",
  teal: "bg-secondary/20 text-secondary-foreground group-hover:bg-secondary/30",
};

function FeatureCard({ icon, title, description, color }: FeatureCardProps) {
  return (
    <div className="group bg-card rounded-xl border p-6 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5">
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
    <div className="bg-card rounded-2xl border p-6 transition-all duration-300 hover:shadow-lg">
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
        <div className="bg-card rounded-xl border p-4 transition-all hover:shadow-md">
          <span className="text-xs font-medium text-primary">{period}</span>
          <h4 className="text-base font-semibold text-foreground mt-1">{title}</h4>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
      </div>
    </div>
  );
}

export default AboutClient;
