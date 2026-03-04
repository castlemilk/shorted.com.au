"use client";

import Link from "next/link";
import { Button } from "~/@/components/ui/button";
import {
  Activity,
  BarChart3,
  ChevronRight,
  Clock,
  Cloud,
  Code2,
  CreditCard,
  Database,
  Globe,
  Layers,
  Newspaper,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { FinanceGridBackground } from "~/@/components/marketing/finance-grid-background";
import { SpotlightCard } from "~/@/components/marketing/spotlight-card";
import { CountUp } from "~/@/components/marketing/count-up";
import { type AboutPageStatistics } from "~/lib/statistics";



interface MetricsClientProps {
  statistics: AboutPageStatistics;
}

export default function MetricsClient({ statistics }: MetricsClientProps) {
  return (
    <div className="flex flex-col min-h-screen bg-background relative">
      <FinanceGridBackground className="fixed inset-0 z-0 pointer-events-none" />

      {/* Hero Section */}
      <section className="relative w-full pt-16 pb-20 md:pt-24 md:pb-28 overflow-hidden z-10">
        <div className="container px-4 md:px-6 relative">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
              <BarChart3 className="w-4 h-4" />
              Platform Metrics
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl mb-6">
              <span className="block text-foreground">Traction &</span>
              <span className="block bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent bg-[length:200%_auto] animate-gradient">
                Growth
              </span>
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Real numbers from a production platform serving daily short position
              intelligence for the Australian stock market.
            </p>
          </div>
        </div>
      </section>

      {/* Platform Statistics (live data) */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Platform Statistics
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Live data coverage and historical depth
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 max-w-4xl mx-auto">
            <MetricCard
              icon={<Globe className="w-6 h-6" />}
              value={statistics.companyCount}
              suffix="+"
              label="Companies Tracked"
              sublabel="All reportable ASX positions"
            />
            <MetricCard
              icon={<Layers className="w-6 h-6" />}
              value={statistics.industryCount}
              suffix="+"
              label="Industries Covered"
              sublabel="Full sector breakdown"
            />
            <MetricCard
              icon={<Clock className="w-6 h-6" />}
              value={5}
              suffix="+"
              label="Years of History"
              sublabel="Deep historical data"
            />
            <MetricCard
              icon={<Activity className="w-6 h-6" />}
              value={0}
              label="Daily Updates"
              sublabel="Automated ASIC sync"
              displayText="Daily"
            />
          </div>
        </div>
      </section>

      {/* Data Pipeline Metrics */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Data Pipeline
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Automated processing from raw regulatory filings to actionable insights
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
            <PipelineCard
              icon={<Database className="w-6 h-6" />}
              title="ASIC File Processing"
              stat="Daily"
              description="Automated ingestion of short position CSV files from ASIC with validation and deduplication."
            />
            <PipelineCard
              icon={<Newspaper className="w-6 h-6" />}
              title="News Aggregation"
              stat="300+/day"
              description="50+ articles per run across 6 daily runs, with AI-powered sentiment classification."
            />
            <PipelineCard
              icon={<Sparkles className="w-6 h-6" />}
              title="Enrichment Coverage"
              stat="80%+"
              description="AI-generated company profiles covering summaries, risk factors, and competitive analysis."
            />
            <PipelineCard
              icon={<Shield className="w-6 h-6" />}
              title="API Uptime"
              stat="99.9%"
              description="Production API availability with health probes and automatic container restarts."
            />
          </div>
        </div>
      </section>

      {/* Growth Indicators */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Growth Indicators
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Building a sustainable platform with multiple revenue streams
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            <SpotlightCard className="p-6">
              <div className="w-12 h-12 rounded-xl bg-secondary/20 text-secondary-foreground flex items-center justify-center mb-4">
                <Users className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">Open Data Model</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Free tier access for all users. Browse short positions, charts, and company data
                without any paywall — lowering the barrier to entry for retail investors.
              </p>
            </SpotlightCard>

            <SpotlightCard className="p-6">
              <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-4">
                <Code2 className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">Developer API</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Public API with tiered rate limits — anonymous, free authenticated, and paid tiers.
                Developers can build integrations, alerts, and custom dashboards.
              </p>
            </SpotlightCard>

            <SpotlightCard className="p-6">
              <div className="w-12 h-12 rounded-xl bg-accent/10 text-accent flex items-center justify-center mb-4">
                <CreditCard className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">Premium Subscription</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                $4/month premium tier launched with enhanced features: unlimited API calls,
                AI chat access, custom dashboards, and portfolio tracking.
              </p>
            </SpotlightCard>
          </div>
        </div>
      </section>

      {/* Infrastructure Scale */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Infrastructure Scale
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Production-grade cloud infrastructure managed entirely with Terraform
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 max-w-4xl mx-auto">
            <InfraCard icon={<Server className="w-8 h-8" />} value="10+" label="Cloud Run Services" />
            <InfraCard icon={<Clock className="w-8 h-8" />} value="6" label="Scheduled Jobs" />
            <InfraCard icon={<Cloud className="w-8 h-8" />} value="GCP" label="Cloud Provider" />
            <InfraCard icon={<Code2 className="w-8 h-8" />} value="IaC" label="Terraform Managed" />
          </div>

          <div className="mt-12 max-w-3xl mx-auto">
            <div className="bg-card rounded-2xl border p-6">
              <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                <Rocket className="w-5 h-5 text-primary" />
                Technical Highlights
              </h3>
              <div className="grid sm:grid-cols-2 gap-3">
                {[
                  "Go microservices with Connect-RPC",
                  "Next.js 14 with App Router",
                  "Protobuf service definitions",
                  "PostgreSQL with materialized views",
                  "Upstash Redis rate limiting",
                  "CI/CD via GitHub Actions",
                  "Docker multi-stage builds",
                  "Firebase Authentication",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Zap className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="w-full py-24 md:py-32 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="relative max-w-4xl mx-auto">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-accent/10 to-primary/10 rounded-3xl blur-xl" />
            <div className="relative bg-card/50 backdrop-blur-sm rounded-3xl border p-8 md:p-12 lg:p-16 text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-6">
                Explore the Platform
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
                See the technology and data in action. Browse short positions,
                explore AI-powered analysis, or dive into the API.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/">
                  <Button
                    size="lg"
                    className="text-base px-8 py-6 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-300 hover:shadow-xl hover:shadow-primary/30"
                  >
                    View Top Shorts
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/technology">
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-8 py-6 border-2 hover:bg-muted/50 transition-all duration-300"
                  >
                    View Technology
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// --- Sub-components ---

interface MetricCardProps {
  icon: React.ReactNode;
  value: number;
  label: string;
  sublabel: string;
  suffix?: string;
  displayText?: string;
}

function MetricCard({ icon, value, label, sublabel, suffix = "", displayText }: MetricCardProps) {
  return (
    <div className="bg-card rounded-2xl border p-6 text-center">
      <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
        {icon}
      </div>
      <div className="text-3xl font-bold text-foreground mb-1 tabular-nums">
        {displayText ? (
          displayText
        ) : (
          <CountUp end={value} suffix={suffix} />
        )}
      </div>
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="text-xs text-muted-foreground mt-1">{sublabel}</div>
    </div>
  );
}

interface PipelineCardProps {
  icon: React.ReactNode;
  title: string;
  stat: string;
  description: string;
}

function PipelineCard({ icon, title, stat, description }: PipelineCardProps) {
  return (
    <div className="bg-card rounded-2xl border p-6 transition-all duration-300 hover:shadow-lg">
      <div className="flex items-center justify-between mb-4">
        <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          {icon}
        </div>
        <span className="text-lg font-bold text-primary">{stat}</span>
      </div>
      <h3 className="text-base font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

interface InfraCardProps {
  icon: React.ReactNode;
  value: string;
  label: string;
}

function InfraCard({ icon, value, label }: InfraCardProps) {
  return (
    <div className="text-center p-6 rounded-xl bg-card border">
      <div className="text-primary mx-auto mb-3 flex justify-center">{icon}</div>
      <div className="text-2xl font-bold text-foreground mb-1">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
